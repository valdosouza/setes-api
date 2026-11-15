/// <reference types="jest" />
// setes-api:AUTH.E6.P1 (D-AU3, D-AU16, D-AU19 — Vault prompts/prompt_frente_auth_api.md §5; ficha
// projetos/setes-api/SUBJECT/ENTIDADE_UNICA/ficha-auth-e6-p1-token-sem-role.md). O setes-api aceita o token da auth-api:
//  - o VETOR DE CONTRATO publicado pela auth-api (`contract/token-vector.json`, kid SÓ DE TESTE) é lido do repositório irmão
//    (`AUTH_API_DIR` ou a pasta `auth-api` ao lado — não achado = REPROVA: cerca que pula em silêncio não cerca);
//  - a chave pública do vetor entra por `JWT_PUBLIC_KEYS` com o kid dele — a mesma porta da chave real na janela (D-AU16);
//  - token SEM `role` é aceito e o `role` LEGADO é ignorado: o perfil que chega às guardas é o VIVO (sessão REAL aqui, como no
//    adversarial-a1-gate — o setup global a dubla para o resto da suíte).
// E o achado do gate socrático do auth-api:AUTH.E2.P3: o vetor da política de senha é cópia gêmea nos dois repositórios — enquanto as
// duas cópias existirem, são IGUAIS byte a byte.
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { findSiblingRepo } from '../test-setup/privilege-fence'

jest.mock('@shared/access', () => jest.requireActual('@shared/access'))
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFE6'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import app from '../app'
import {
  resetJwtKeyRing, verifyFinalToken, verifyFinalTokenWithIat, verifySelectionToken, signFinalToken, signSelectionToken, assertJwtKeys,
} from '../shared/auth/product-token'
import { testToken } from '../test-setup/test-token'

const ROOT = path.resolve(__dirname, '..', '..')
const AUTH_API = findSiblingRepo(ROOT, 'auth-api', path.join('contract', 'token-vector.json'))

interface Vector {
  alg: string; kid: string; publicKeyPem: string
  claims: { institutionId: number; userId: number; schemaName: string }
  iat: number; exp: number
  cases: Record<'final_sem_role' | 'final_com_role_legado' | 'selecao' | 'final_sem_iat', { token: string; expect: string }>
}

describe('o repositório irmão auth-api existe (senão a prova do contrato não roda — REPROVA)', () => {
  it('achado em AUTH_API_DIR ou ao lado', () => {
    expect(AUTH_API).not.toBeNull()
  })
})

const V: Vector = AUTH_API ? JSON.parse(fs.readFileSync(path.join(AUTH_API, 'contract', 'token-vector.json'), 'utf8')) : ({} as Vector)
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e6-'))
const ENV0 = { ...process.env }

const q = (pool as any).query as jest.Mock
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const SESSION_RE = /FROM setes_central\.vw_user_link WHERE tb_user_id = \? AND tb_institution_id = \? AND schema_name = \?/
/** O vínculo VIVO do usuário do vetor (userId 2 na institution 1 = a própria Setes): perfil que o teste escolhe. */
let liveProfile: string
let sessionReads: number

function answer(sql: string, params: any[] = []): any {
  if (SESSION_RE.test(norm(sql))) {
    sessionReads++
    if (params[0] !== V.claims.userId || params[1] !== V.claims.institutionId || params[2] !== V.claims.schemaName) return [[], []]
    return [[{ profile: liveProfile, vendor: 'S' }], []]
  }
  return [[], []]
}

beforeAll(() => {
  if (!AUTH_API) return
  const pub = path.join(DIR, 'auth-api-contract.public.pem')
  fs.writeFileSync(pub, V.publicKeyPem)
  process.env.JWT_PUBLIC_KEYS = `${V.kid}=${pub}`      // D-AU16: a chave da auth-api pela rotação que já existe
  resetJwtKeyRing()
})
afterAll(() => {
  process.env = { ...ENV0 }
  resetJwtKeyRing()
  fs.rmSync(DIR, { recursive: true, force: true })
})
beforeEach(() => {
  liveProfile = 'user'
  sessionReads = 0
  q.mockReset()
  q.mockImplementation(async (sql: string, params?: any[]) => answer(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => ({
    query: async (sql: string, params?: any[]) => answer(sql, params), release: () => undefined,
    beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => undefined,
  }))
})

const itV = AUTH_API ? it : it.skip   // sem o irmão o 1º describe já reprovou

describe('vetor de contrato do token da auth-api (D-AU19) — verificador', () => {
  itV('o vetor é o esperado: RS256, kid próprio (nunca o do setes-api), os 4 casos', () => {
    expect(V.alg).toBe('RS256')
    expect(assertJwtKeys()).toMatch(/^RS256, kid '([^']+)' \+ 1 chave\(s\) anterior\(es\)$/)
    expect(assertJwtKeys()).not.toContain(`kid '${V.kid}'`)     // o kid do vetor nunca é o de assinatura deste processo
    expect(Object.keys(V.cases).sort()).toEqual(['final_com_role_legado', 'final_sem_iat', 'final_sem_role', 'selecao'])
  })
  itV('final_sem_role → ACEITO como token final (a identidade do vetor e o iat)', () => {
    const r = verifyFinalTokenWithIat(V.cases.final_sem_role.token)
    expect(r).toEqual({ payload: { ...V.claims, role: '' }, iat: V.iat })
  })
  itV('final_com_role_legado → ACEITO; o role segue só como texto que a sessão viva SOBRESCREVE', () => {
    expect(verifyFinalToken(V.cases.final_com_role_legado.token)).toEqual({ ...V.claims, role: 'super' })
  })
  itV('selecao → RECUSADO como token final', () => {
    expect(() => verifyFinalToken(V.cases.selecao.token)).toThrow(/Token inválido/)
  })
  itV('selecao da auth-api também NÃO vale como seleção aqui: só o kid de assinatura do setes-api emite seleção (gate, MEDIUM)', () => {
    expect(() => verifySelectionToken(V.cases.selecao.token)).toThrow(/Token inválido/)
    expect(verifySelectionToken(signSelectionToken(7))).toEqual({ userId: 7, iat: expect.any(Number) })
  })
  itV('role que não é texto (número, objeto, lista, vazio) é aceito e vira texto vazio — nunca decide', () => {
    const base = { institutionId: 1, userId: 2, schemaName: 'setes_contrato' }
    for (const role of [7, { r: 'super' }, ['super'], '', null]) {
      expect(verifyFinalToken(testToken({ ...base, role }))).toEqual({ ...base, role: '' })
    }
  })
  itV('final_sem_iat → RECUSADO (D-EA7)', () => {
    expect(() => verifyFinalTokenWithIat(V.cases.final_sem_iat.token)).toThrow(/Token inválido/)
  })
  itV('sem a chave da auth-api em JWT_PUBLIC_KEYS o mesmo token é recusado (o kid decide quem emitiu)', () => {
    const keys = process.env.JWT_PUBLIC_KEYS
    delete process.env.JWT_PUBLIC_KEYS
    resetJwtKeyRing()
    try {
      expect(() => verifyFinalToken(V.cases.final_sem_role.token)).toThrow(/Token inválido/)
    } finally {
      process.env.JWT_PUBLIC_KEYS = keys
      resetJwtKeyRing()
    }
  })
  itV('o setes-api segue EMITINDO com role até a janela (D-AU19)', () => {
    const t = signFinalToken({ ...V.claims, role: 'admin' })
    expect(verifyFinalToken(t)).toEqual({ ...V.claims, role: 'admin' })
  })
})

describe('vetor de contrato pela rota — o perfil que decide é o VIVO (D-AU3/D-UC9)', () => {
  const me = (t: string) => request(app).get('/api/core/me').set('Authorization', `Bearer ${t}`)
  itV('sem role: o /api/core/me responde com o perfil VIVO', async () => {
    liveProfile = 'admin'
    const r = await me(V.cases.final_sem_role.token)
    expect([r.status, r.body.data?.role]).toEqual([200, 'admin'])
    expect(sessionReads).toBe(1)
  })
  itV("role 'super' legado de quem é 'user' vivo: /api/core/me diz 'user' e o superGuard NEGA (403)", async () => {
    liveProfile = 'user'
    const r = await me(V.cases.final_com_role_legado.token)
    expect([r.status, r.body.data?.role]).toEqual([200, 'user'])
    const g = await request(app).get('/api/interfaces').set('Authorization', `Bearer ${V.cases.final_com_role_legado.token}`)
    expect(g.status).toBe(403)
  })
  itV('sem role, perfil vivo super: o superGuard deixa passar (o super sai da leitura viva, não do token)', async () => {
    liveProfile = 'super'
    const g = await request(app).get('/api/interfaces').set('Authorization', `Bearer ${V.cases.final_sem_role.token}`)
    // o banco dublado não monta a lista (a rota responde 500 depois da guarda); o que se prova é que a GUARDA deixou passar: nada de
    // 401/403 e o controller chegou a consultar o banco além da leitura da sessão
    expect([401, 403]).not.toContain(g.status)
    expect(sessionReads).toBe(1)
    expect(q.mock.calls.length).toBeGreaterThan(1)
  })
  itV('vínculo morto → 401 SESSION_REVOKED também para o token da auth-api', async () => {
    q.mockImplementation(async () => [[], []])     // nenhuma linha: nem o vínculo existe
    const r = await me(V.cases.final_sem_role.token)
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })
  itV('seleção e sem iat → 401 na rota', async () => {
    for (const t of [V.cases.selecao.token, V.cases.final_sem_iat.token]) {
      expect((await me(t)).status).toBe(401)
    }
  })
})

describe('vetor da política de senha = o da auth-api (achado do gate socrático do auth-api:AUTH.E2.P3)', () => {
  // o fim de linha da cópia de trabalho depende do git de cada máquina (autocrlf): compara-se o texto com LF, todo o resto byte a byte
  const text = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
  itV('as duas cópias são iguais enquanto coexistirem', () => {
    const ours = text(path.join(ROOT, 'src', 'shared', 'auth', 'password-policy.vector.json'))
    const theirs = text(path.join(AUTH_API!, 'src', 'credential', 'password-policy.vector.json'))
    expect(theirs).toBe(ours)
    expect(ours.length).toBeGreaterThan(0)
  })
})
