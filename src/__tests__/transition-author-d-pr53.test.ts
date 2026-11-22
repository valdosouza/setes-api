/// <reference types="jest" />
// D-PR53/D-PR57 (setes-api:PROD.E6.P2, 2026-11-20), revistas pelas D-PR73/D-PR75/D-PR76 (setes-api:PROD.E10.P1, 2026-11-22) — QUEM e
// QUANDO trocou a origem dos cadastros de D para W viram FATO do objeto (`tb_institution.transition_ended_by`, migration 079;
// `transition_end_reason` fica nulo — sem motivo desde a D-PR75, CHECK refeito pela 081), gravados no MESMO UPDATE condicionado do PUT; o `GET /api/institutions/:id` devolve os dois; o boot confere colunas, constraints e FK
// pelo NOME e sonda o motor. Pelo app REAL (auth RS256 de teste → superGuard → controller → service → repository), banco dublado.
// A semântica das constraints no motor é provada em schema descartável: scripts/prove-079-institution-transition-author.ts e
// scripts/prove-081-institution-source-kind-w-d.ts (domínio W/D — D-OI10; ato D → W com corpo só { reason } — D-PR70).
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFDPR53'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/entity', () => ({
  ...jest.requireActual('../shared/entity'),
  getEntityFiscalFull: jest.fn(async (id: number) => ({ id, nickTrade: 'SETES' })),
  saveEntityFiscalChain: jest.fn(async (_c: unknown, id: number) => ({ id })),
}))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import app from '../app'
import {
  assertInstitutionSourceKindSchema, CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED,
  CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON, FK_INSTITUTION_TRANSITION_ENDED_BY,
} from '../shared/catalog-owner'

const q = (pool as any).query as jest.Mock
const ENDED = new Date(Date.UTC(2026, 10, 20, 13, 0, 0))
const SUPER = { institutionId: 1, userId: 7, role: 'super', schemaName: 'setes_setes' }
const bearer = (p: object) => `Bearer ${testToken(p)}`

// ---- modelo: UMA institution D (a Setes) ----
type Row = { kind: 'W' | 'D'; endedAt: Date | null; by: number | null; reason: string | null }
let row: Row
let activeKeys: number
let instUpdates: any[][]
let txSql: string[]
function db(sql: string, params: any[] = []): any {
  const s = String(sql)
  if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s)) return [[{ id: params[0] }]]
  if (/^SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'$/.test(s)) return [[{ sourceKind: row.kind }]]
  if (/SELECT schema_name AS schemaName, source_kind AS sourceKind FROM setes_central\.tb_institution\s+WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    return [[{ schemaName: 'setes_setes', sourceKind: row.kind }]]
  }
  if (/SELECT id FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' AND active = 'S' FOR UPDATE/.test(s)) {
    return [Array.from({ length: activeKeys }, (_, i) => ({ id: i + 1 }))]
  }
  if (/i\.transition_ended_by AS transitionEndedBy, i\.transition_end_reason AS transitionEndReason,\s+COALESCE\(NULLIF\(ea\.nick_trade, ''\), ea\.name_company\) AS transitionEndedByName\s+FROM setes_central\.tb_institution i\s+LEFT JOIN setes_central\.tb_entity ea ON ea\.id = i\.transition_ended_by/.test(s)) {
    return [[{
      schemaName: 'setes_setes', active: 'S', sourceKind: row.kind, transitionEndedAt: row.endedAt, transitionEndedBy: row.by,
      transitionEndReason: row.reason, transitionEndedByName: row.by === 7 ? 'VALDO' : null,
    }]]
  }
  if (/UPDATE setes_central\.tb_institution\s+SET source_kind = 'W', transition_ended_at = NOW\(\), transition_ended_by = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/.test(s)) {
    instUpdates.push(params)
    if (row.kind !== 'D' || row.endedAt) return [{ affectedRows: 0 }]
    row = { kind: 'W', endedAt: ENDED, by: params[0], reason: null }
    return [{ affectedRows: 1 }]
  }
  if (/UPDATE setes_central\.tb_institution SET active = \?/.test(s)) return [{ affectedRows: 1 }]
  if (/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/.test(s)) return [[{ id: 1 }]]
  if (/^\s*SELECT/i.test(s)) return [[{ id: 1 }]]
  throw new Error(`SQL inesperado: ${s.slice(0, 100)}`)
}

beforeEach(() => {
  jest.clearAllMocks()
  row = { kind: 'D', endedAt: null, by: null, reason: null }
  activeKeys = 0
  instUpdates = []; txSql = []
  q.mockImplementation(async (sql: string, params: any[] = []) => db(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => ({
    query: jest.fn(async (sql: string, params: any[] = []) => { txSql.push(String(sql)); return db(sql, params) }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }))
})

const BODY = {
  entity: { nameCompany: 'SETES LTDA', nickTrade: 'SETES' }, personType: 'J', company: { cnpj: '11222333000181' },
  addresses: [], phones: [], socialMedia: [],
}
const put = (body: object, who: object = SUPER) =>
  request(app).put('/api/institutions/1').set('Authorization', bearer(who)).send(body)

describe('D-PR73/D-PR75/D-PR76 — virar Web é a troca D → W no PUT: grava quem e quando, sem motivo, no MESMO UPDATE condicionado', () => {
  it('PUT com sourceKind W (chave bloqueada): o UPDATE recebe (autor do TOKEN, id), com o destino e a condição no comando; o log segue', async () => {
    const r = await put({ ...BODY, sourceKind: 'W' })
    expect(r.status).toBe(200)
    expect(instUpdates).toEqual([[7, 1]])
    const upd = txSql.filter(s => /SET source_kind/.test(s))
    expect(upd).toHaveLength(1)                                                      // UM comando para as três marcas
    expect(upd[0]).toMatch(/source_kind = 'W', transition_ended_at = NOW\(\), transition_ended_by = \?/)
    expect(upd[0]).toMatch(/WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/)
    expect(upd[0]).not.toMatch(/transition_end_reason/)                              // D-PR75: sem motivo
    expect(row).toEqual({ kind: 'W', endedAt: ENDED, by: 7, reason: null })
    const log = (logger.info as jest.Mock).mock.calls.find(x => /TROCADA/.test(x[0]))
    expect(log?.[1]).toMatchObject({ institutionId: 1, actorUserId: 7 })
  })

  it('chave do sincronizador ATIVA = 409 SOURCE_KIND_SYNC_KEY_ACTIVE e nada gravado (bloqueie antes — D-PR73)', async () => {
    activeKeys = 1
    const r = await put({ ...BODY, sourceKind: 'W' })
    expect([r.status, r.body.code]).toEqual([409, 'SOURCE_KIND_SYNC_KEY_ACTIVE'])
    expect(instUpdates).toEqual([])
    expect(row.kind).toBe('D')
  })

  it('repetir não reescreve o autor (write-once); voltar a D = 409 SOURCE_KIND_IMMUTABLE e o fato fica como a 1ª troca deixou', async () => {
    await put({ ...BODY, sourceKind: 'W' })
    const again = await put({ ...BODY, sourceKind: 'W' }, { ...SUPER, userId: 8 })
    expect(again.status).toBe(200)                                                   // igual ao gravado: passa sem troca
    expect(instUpdates).toEqual([[7, 1]])
    const back = await put({ ...BODY, sourceKind: 'D' }, { ...SUPER, userId: 8 })
    expect([back.status, back.body.code]).toEqual([409, 'SOURCE_KIND_IMMUTABLE'])
    expect(row).toEqual({ kind: 'W', endedAt: ENDED, by: 7, reason: null })
  })

  it('D-PR76: o ato saiu — as rotas end-legacy-transition e end-desktop-transition = 404, nada chega ao banco', async () => {
    for (const path of ['end-legacy-transition', 'end-desktop-transition']) {
      const r = await request(app).post(`/api/institutions/1/${path}`).set('Authorization', bearer(SUPER)).send({ reason: 'rota velha' })
      expect([path, r.status]).toEqual([path, 404])
    }
    expect(instUpdates).toEqual([])
    expect(row.kind).toBe('D')
  })
})

describe('D-PR53/D-PR75 — o GET /:id devolve quem trocou e quando (o motivo só existe em linha antiga)', () => {
  it('antes da troca: tudo nulo; depois: o id e o NOME do autor (D-PR57), motivo nulo', async () => {
    const before = await request(app).get('/api/institutions/1').set('Authorization', bearer(SUPER))
    expect(before.status).toBe(200)
    expect(before.body.data).toMatchObject({
      sourceKind: 'D', transitionEndedAt: null, transitionEndedBy: null, transitionEndedByName: null, transitionEndReason: null,
    })
    await put({ ...BODY, sourceKind: 'W' })
    const after = await request(app).get('/api/institutions/1').set('Authorization', bearer(SUPER))
    expect(after.body.data).toMatchObject({
      sourceKind: 'W', transitionEndedAt: ENDED.toISOString(), transitionEndedBy: 7, transitionEndedByName: 'VALDO',
      transitionEndReason: null,
    })
  })
})

describe('D-PR53/D-PR57 — o boot confere a 079 pelo NOME e sonda o motor', () => {
  const ALL_COLS = [
    { c: 'source_kind', n: 'NO', d: null }, { c: 'transition_ended_at', n: 'YES', d: null },
    { c: 'transition_ended_by', n: 'YES', d: null }, { c: 'transition_end_reason', n: 'YES', d: null },
  ]
  const ALL_CKS = [CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED, CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON]
  /** Conexão dublada: o motor recusa cada sonda pela constraint que o modelo manda (null = grava). */
  const fakeConn = (o: { cols?: any[]; cks?: string[]; fk?: string | null; refuse?: (p: any[], sql?: string) => string | null } = {}) => {
    const calls: Array<[string, any[]]> = []
    const conn = {
      query: jest.fn(async (sql: string, p: any[] = []) => {
        calls.push([sql, p])
        if (/information_schema\.COLUMNS/.test(sql)) return [o.cols ?? ALL_COLS]
        if (/information_schema\.CHECK_CONSTRAINTS/.test(sql)) return [(o.cks ?? ALL_CKS).map(n => ({ n }))]
        if (/information_schema\.REFERENTIAL_CONSTRAINTS/.test(sql)) return [o.fk === null ? [] : [{ t: o.fk ?? 'tb_user' }]]
        if (/INSERT INTO setes_central\.tb_institution/.test(sql)) {
          const ck = (o.refuse ?? defaultRefuse)(p, sql)
          if (ck) throw Object.assign(new Error(`CONSTRAINT \`${ck}\` failed for \`setes_central\`.\`tb_institution\``), { errno: 4025 })
        }
        return [{}]
      }),
      beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    return { q: { getConnection: async () => conn as any }, calls, conn }
  }
  // o motor de verdade: [id, schema_name?, source_kind, by, reason] — params do INSERT da sonda: [id, sourceKind, by, reason]
  const defaultRefuse = (p: any[], sql = ''): string | null => {
    const [, kind, by, reason] = p
    const withDate = /'setes_sonda_boot', \?, NOW\(\)/.test(sql)
    if (!['W', 'D'].includes(kind)) return CK_INSTITUTION_SOURCE_KIND           // domínio da 081 (D-OI10): 'X', 'd', 'L', 'P' recusados
    if (kind === 'D' && by !== null) return CK_INSTITUTION_TRANSITION_ENDED      // a única sonda "D com data" leva autor e motivo
    if (by !== null && !withDate) return CK_INSTITUTION_TRANSITION_AUTHOR   // autor sem data (gate adversarial L7)
    if (by === null) return CK_INSTITUTION_TRANSITION_AUTHOR                    // W com data, sem autor (data e autor juntos — 081, D-PR75)
    if (typeof reason === 'string' && reason.trim() === '') return CK_INSTITUTION_TRANSITION_REASON   // motivo só branco
    return null
  }

  it('tudo certo = "ok"; as nove sondas rodam, cada uma numa transação desfeita; só as que levam autor criam o usuário de prova', async () => {
    const f = fakeConn()
    await expect(assertInstitutionSourceKindSchema(f.q as any)).resolves.toBe('ok')
    const inserts = f.calls.filter(([s]) => /INSERT INTO setes_central\.tb_institution/.test(s)).map(([, p]) => p)
    expect(inserts).toEqual([
      [-1, 'X', null, null], [-1, 'd', null, null], [-1, 'L', null, null], [-1, 'P', null, null],
      [-1, 'D', -1, 'sonda do boot (D-PR53)'], [-1, 'W', null, null], [-1, 'W', -1, null], [-1, 'W', -1, '   '], [-1, 'W', -1, null],
    ])
    expect(f.calls.filter(([s]) => /INSERT INTO setes_central\.tb_user/.test(s))).toHaveLength(4)
    expect(f.conn.rollback).toHaveBeenCalledTimes(9)
  })

  it.each(['L', 'P'])("a 081 não rodou: o CHECK com o NOME certo ainda aceita '%s' (domínio da 072) = o boot não sobe, apontando a 081", async (old) => {
    const f = fakeConn({ refuse: (p, sql) => (p[1] === old ? null : defaultRefuse(p, sql)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_SOURCE_KIND} NÃO aplicado.*migration 081`))
  })

  it('a 081 não rodou: o CHECK do autor ainda é o da 079 (recusa data e autor SEM motivo) = o boot não sobe, apontando a 081 (D-PR75)', async () => {
    const f = fakeConn({ refuse: (p, sql) => (p[1] === 'W' && p[2] === -1 && p[3] === null ? CK_INSTITUTION_TRANSITION_AUTHOR : defaultRefuse(p, sql)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/SEM motivo foi recusada pelo motor[\s\S]*migration 081 não rodou \(D-PR75\)/)
  })

  it('o motor ACEITA motivo só branco (CHECK do motivo frouxo com o mesmo nome) = o boot não sobe', async () => {
    const f = fakeConn({ refuse: (p, sql) => (p[3] === '   ' ? null : defaultRefuse(p, sql)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_TRANSITION_REASON} NÃO aplicado`))
  })

  it('a 079 não rodou (colunas ausentes) = o boot não sobe', async () => {
    const f = fakeConn({ cols: ALL_COLS.slice(0, 2) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/a migration 079 não rodou/)
  })

  it('coluna do autor NOT NULL = o boot não sobe (só o ato a preenche)', async () => {
    const f = fakeConn({ cols: [...ALL_COLS.slice(0, 2), { c: 'transition_ended_by', n: 'NO', d: null }, ALL_COLS[3]] })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/têm de ser anuláveis/)
  })

  it.each([CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON])('sem a constraint %s = o boot não sobe', async (ck) => {
    const f = fakeConn({ cks: ALL_CKS.filter(n => n !== ck) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`sem a constraint ${ck} \\(migration 079`))
  })

  it('sem a FK para tb_user (ou apontando para outra tabela) = o boot não sobe', async () => {
    await expect(assertInstitutionSourceKindSchema(fakeConn({ fk: null }).q as any)).rejects.toThrow(new RegExp(`sem a FK ${FK_INSTITUTION_TRANSITION_ENDED_BY}`))
    await expect(assertInstitutionSourceKindSchema(fakeConn({ fk: 'tb_entity' }).q as any)).rejects.toThrow(new RegExp(`sem a FK ${FK_INSTITUTION_TRANSITION_ENDED_BY}`))
  })

  it('o motor GRAVA o ato sem autor (CHECK da 079 não aplicado) = o boot não sobe', async () => {
    const f = fakeConn({ refuse: (p, sql) => (p[1] === 'W' && p[2] === null ? null : defaultRefuse(p, sql)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_TRANSITION_AUTHOR} NÃO aplicado`))
  })

  it('a sonda "W com data" recusada por OUTRA constraint = o boot não sobe', async () => {
    const f = fakeConn({ refuse: (p, sql) => (p[1] === 'W' && p[2] === null ? CK_INSTITUTION_TRANSITION_REASON : defaultRefuse(p, sql)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/recusada por OUTRA constraint/)
  })
})
