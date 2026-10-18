/// <reference types="jest" />
// GATE ADVERSARIAL — delta D-PR41/D-PR43 do cadastro de produtos (2026-10-18; skill testar-adversarial.md;
// prompt_modulo_products.md §19.1). Alvo: o interruptor `PUT /api/institutions/:id/sync-api-key/active` (D-PR43) e o lookup de
// categorias do serviço pelo MODO do estabelecimento (D-PR41), pelo app REAL (auth RS256 de teste → feature flag → rate limit →
// router → superGuard → controller → service → repository), com o banco num MODELO em memória (estado das chaves) e o serviço do
// merchandise MOCKADO (o que se prova é se a ESCRITA chega). `it('[RESISTIU] …')` = o ataque foi barrado / a promessa vale;
// `it('[ACHADO] …')` = fixa o comportamento observado que vira questão para o dono.
// Rodada 6 (2026-10-18): o modelo passou a atender a TRANSAÇÃO do ato (trava, chaves FOR UPDATE, categoria padrão, webBornSince) e o
// lookup do serviço vai pelo FATO (Q-PR49 (a)) — o ACHADO MEDIUM do lookup esvaziado virou [CORRIGIDO].
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVSW'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../modules/merchandise/merchandise.service', () => ({
  __esModule: true,
  MERCHANDISE_SEARCH_CRITERIA: [],
  fetchMerchandiseSearchCriteria: jest.fn().mockResolvedValue([]),
  fetchMerchandiseList: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchMerchandise: jest.fn().mockResolvedValue({ id: 5 }),
  createMerchandise: jest.fn().mockResolvedValue(77),
  editMerchandise: jest.fn().mockResolvedValue(undefined), removeMerchandise: jest.fn().mockResolvedValue(undefined),
  fetchTradeUnits: jest.fn().mockResolvedValue({ levels: [] }), putTradeUnits: jest.fn().mockResolvedValue(undefined),
  fetchLinks: jest.fn().mockResolvedValue({ tradeUnits: 0, taxRules: 0 }),
  fetchCategoriesLookup: jest.fn().mockResolvedValue([]), fetchFinancialPlansLookup: jest.fn().mockResolvedValue([]),
  fetchPriceListsLookup: jest.fn().mockResolvedValue([]), fetchBrandsLookup: jest.fn().mockResolvedValue([]),
  fetchMeasuresLookup: jest.fn().mockResolvedValue([]), fetchPackagesLookup: jest.fn().mockResolvedValue([]),
  createBrand: jest.fn().mockResolvedValue({ id: 900, reused: false }),
  createMeasure: jest.fn().mockResolvedValue({ id: 901, reused: false }),
  createPackage: jest.fn().mockResolvedValue({ id: 902, reused: false }),
}))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import * as merch from '../modules/merchandise/merchandise.service'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const q = (pool as any).query as jest.Mock
const MERCH_IFACE = 40
const KEY = 'k'.repeat(48)

// ---- modelo do banco (só o que o delta toca) ----
// Rodada 6: o ato vira UMA transação (getConnection) — o modelo atende o pool E a conexão com o mesmo estado.
const NOW = new Date(Date.UTC(2026, 9, 18, 12, 0, 0))
const SCHEMA_OF: Record<number, string> = { 1: 'setes_setes', 2: 'setes_x' }
type Key = { active: 'S' | 'N'; deleted: 'S' | 'N'; updatedAt?: Date | null }
type Cat = { id: number; kind: 'P' | 'S'; deleted: 'S' | 'N'; createdAt: Date }
let institutions: Set<number>
let keys: Map<number, Key[]>        // institution → chaves (sem UNIQUE por institution no DDL real)
let cats: Map<number, Cat[]>         // institution → categorias
let webBorn: Map<number, { table: string; createdAt: Date }[]>
let updates: any[][]
function db(sql: string, params: any[] = []): any {
  const s = String(sql)
  if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s)) return [institutions.has(Number(params[0])) ? [{ id: params[0] }] : []]
  if (/SELECT schema_name AS schemaName FROM setes_central\.tb_institution/.test(s)) {
    const id = Number(params[0])
    return [institutions.has(id) ? [{ schemaName: SCHEMA_OF[id] }] : []]
  }
  if (/FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    return [(keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N')
      .map((k, i) => ({ id: i + 1, active: k.active, createdAt: new Date(0), updatedAt: k.updatedAt ?? null }))]
  }
  if (/SELECT NOW\(\) AS now/.test(s)) return [[{ now: NOW }]]
  if (/UPDATE setes_central\.tb_sync_api_key SET active/.test(s)) {
    updates.push(params)
    const [active, at, inst] = params
    const hit = (keys.get(Number(inst)) ?? []).filter(k => k.deleted === 'N' && k.active !== active)
    hit.forEach(k => { k.active = active; k.updatedAt = at ?? NOW })
    return [{ affectedRows: hit.length }]
  }
  if (/SELECT 1 FROM setes_central\.tb_sync_api_key/.test(s)) {
    const any = (keys.get(Number(params[0])) ?? []).some(k => k.active === 'S' && k.deleted === 'N')
    return [any ? [{ 1: 1 }] : []]
  }
  if (/api_key AS apiKey/.test(s)) {
    const first = (keys.get(Number(params[0])) ?? []).find(k => k.deleted === 'N')
    return [first ? [{ apiKey: KEY, establishmentCode: 'SETES_SETES', active: first.active }] : []]
  }
  // @shared/category-kind (ato de desligar)
  if (/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/.test(s)) {
    return [(cats.get(Number(params[0])) ?? []).filter(c => c.kind === params[1] && c.deleted === 'N').slice(0, 1).map(c => ({ id: c.id }))]
  }
  if (/MAX\(id\), 0\) \+ 1 AS nextId FROM `\w+`\.tb_category/.test(s)) {
    return [[{ nextId: Math.max(0, ...(cats.get(Number(params[0])) ?? []).map(c => c.id)) + 1 }]]
  }
  if (/INSERT INTO `\w+`\.tb_category/.test(s)) {
    const [id, inst, , , kind, at] = params
    const list = cats.get(Number(inst)) ?? []
    list.push({ id: Number(id), kind, deleted: 'N', createdAt: at ?? NOW })
    cats.set(Number(inst), list)
    return [{}]
  }
  // @shared/sync-key webBornSince (religar)
  if (/SELECT COUNT\(\*\) AS n FROM `\w+`\.(tb_\w+) WHERE tb_institution_id = \? AND created_at >= \?/.test(s)) {
    const table = /\.(tb_\w+) WHERE/.exec(s)![1]
    const since = params[1] as Date
    const fromCats = table === 'tb_category' ? (cats.get(Number(params[0])) ?? []).filter(c => c.createdAt >= since).length : 0
    const fromWeb = (webBorn.get(Number(params[0])) ?? []).filter(r => r.table === table && r.createdAt >= since).length
    return [[{ n: fromCats + fromWeb }]]
  }
  if (/SELECT id FROM `\w+`\.(tb_\w+) WHERE tb_institution_id = \? AND created_at >= \? ORDER BY id/.test(s)) return [[{ id: 99 }]]
  // lookup de categorias do serviço pelo FATO (Q-PR49 (a))
  if (/FROM `\w+`\.tb_category c/.test(s) && /c\.kind = 'S' OR NOT EXISTS/.test(s)) {
    const list = (cats.get(Number(params[0])) ?? []).filter(c => c.deleted === 'N')
    const hasS = list.some(c => c.kind === 'S')                       // o modelo não tem inativas: viva = não excluída
    return [list.filter(c => (hasS ? c.kind === 'S' : true)).map(c => ({ id: c.id, description: `C${c.id}`, name: `C${c.id}` }))]
  }
  if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(s)) return [String(params[0]) === 'merchandise' ? [{ id: MERCH_IFACE }] : []]
  if (/tb_institution_has_interface/.test(s)) return [Number(params[1]) === MERCH_IFACE ? [{ 1: 1 }] : []]
  if (/tb_user_has_privilege/.test(s)) return [[]]
  throw new Error(`SQL inesperado: ${s.slice(0, 100)}`)
}
let txConns: any[]
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => db(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => {
    const c = { query: jest.fn(async (sql: string, params: any[] = []) => db(sql, params)),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    txConns.push(c)
    return c
  })
}

const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const SETES_ADMIN = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }
const ADMIN2 = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER2 = { institutionId: 2, userId: 10, role: 'user', schemaName: 'setes_x' }
const FAKE_SUPER2 = { institutionId: 2, userId: 11, role: 'super', schemaName: 'setes_x' }   // "super" fora da Setes
const bearer = (p: object) => `Bearer ${testToken(p)}`
const switchUrl = (id: string | number) => `/api/institutions/${id}/sync-api-key/active`

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  institutions = new Set([1, 2])
  keys = new Map([[1, [{ active: 'S', deleted: 'N' }]]])
  // fato do dev (setes_setes, 2026-10-18): só 2 categorias, ambas kind 'P'; nenhuma 'S'
  cats = new Map([[1, [{ id: 8, kind: 'P', deleted: 'N', createdAt: new Date(0) }, { id: 9, kind: 'P', deleted: 'N', createdAt: new Date(0) }]]])
  webBorn = new Map()
  updates = []
  txConns = []
  routeDb()
})

describe('D-PR43 — quem alcança o interruptor', () => {
  it('[RESISTIU] sem token 401; usuário, admin do PRÓPRIO estabelecimento, admin da Setes e "super" fora da Setes = 403 — nada chega ao UPDATE', async () => {
    const anon = await request(app).put(switchUrl(1)).send({ active: 'N' })
    expect(anon.status).toBe(401)
    for (const [who, target] of [[USER2, 2], [ADMIN2, 2], [ADMIN2, 1], [SETES_ADMIN, 1], [FAKE_SUPER2, 1]] as const) {
      keys.set(2, [{ active: 'S', deleted: 'N' }])
      const res = await request(app).put(switchUrl(target)).set('Authorization', bearer(who)).send({ active: 'N' })
      expect([who.role, who.institutionId, target, res.status]).toEqual([who.role, who.institutionId, target, 403])
    }
    expect(updates).toEqual([])
  })

  it('[RESISTIU] forma da URL (caixa, barra final, barra dupla) não contorna o superGuard para o admin', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).put('/api/INSTITUTIONS/1/SYNC-API-KEY/ACTIVE').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api/institutions/1/sync-api-key/active/').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api/institutions//1/sync-api-key/active').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api//institutions/1/sync-api-key/active').set('Authorization', auth).send({ active: 'N' }),
    ])
    for (const r of res) expect([403, 404]).toContain(r.status)
    expect(updates).toEqual([])
  })

  it('[RESISTIU] método errado (POST/PATCH/DELETE) e override por cabeçalho não ligam/desligam — nem para o super', async () => {
    const auth = bearer(SUPER)
    const res = await Promise.all([
      request(app).post(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).patch(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).delete(switchUrl(1)).set('Authorization', auth),
      request(app).post(switchUrl(1)).set('Authorization', auth).set('X-HTTP-Method-Override', 'PUT').send({ active: 'N' }),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404])
    expect(updates).toEqual([])
    expect(keys.get(1)![0].active).toBe('S')
  })
})

describe('D-PR43 — bordas do corpo e do id (super)', () => {
  it('[RESISTIU] active fora de S/N (minúscula, espaço, lista, null, número, ausente, corpo-lista, corpo-texto) = 400 sem UPDATE', async () => {
    const auth = bearer(SUPER)
    const bodies: any[] = [{ active: 'n' }, { active: 'N ' }, { active: ['N'] }, { active: null }, { active: 0 }, {}, [{ active: 'N' }]]
    for (const b of bodies) {
      const r = await request(app).put(switchUrl(1)).set('Authorization', auth).send(b)
      expect([JSON.stringify(b), r.status]).toEqual([JSON.stringify(b), 400])
    }
    const txt = await request(app).put(switchUrl(1)).set('Authorization', auth).set('Content-Type', 'text/plain').send('N')
    expect(txt.status).toBe(400)
    expect(updates).toEqual([])
  })

  it('[RESISTIU] campo extra é ignorado (não vira coluna): só active vai ao UPDATE, com placeholders', async () => {
    const r = await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER))
      .send({ active: 'N', deleted: 'S', tb_institution_id: 2, api_key: "x'; DROP TABLE t; --" })
    expect(r.status).toBe(200)
    expect(updates).toEqual([['N', NOW, 1, 'N']])
    expect(keys.get(1)![0]).toEqual({ active: 'N', deleted: 'N', updatedAt: NOW })
  })

  it('[RESISTIU] id inválido = 400; estabelecimento inexistente = 404; existente sem chave = 404 (nada criado)', async () => {
    const auth = bearer(SUPER)
    const bad = await Promise.all(['abc', '-1', '1.5'].map(id => request(app).put(switchUrl(id)).set('Authorization', auth).send({ active: 'N' })))
    expect(bad.map(r => r.status)).toEqual([400, 400, 400])
    const missing = await request(app).put(switchUrl(999)).set('Authorization', auth).send({ active: 'N' })
    const noKey = await request(app).put(switchUrl(2)).set('Authorization', auth).send({ active: 'N' })
    expect([missing.status, noKey.status]).toEqual([404, 404])
    expect(noKey.body.fields?.[0]?.field).toBe('active')
    expect(keys.has(2)).toBe(false)
  })

  it('[ACHADO LOW] o id da rota aceita formas não canônicas do Number(): "0x1" e "1e0" desligam o estabelecimento 1 (só super; parseId compartilhado)', async () => {
    const auth = bearer(SUPER)
    const hex = await request(app).put(switchUrl('0x1')).set('Authorization', auth).send({ active: 'N' })
    const exp = await request(app).put(switchUrl('1e0')).set('Authorization', auth).send({ active: 'S' })
    expect([hex.status, exp.status]).toEqual([200, 200])
    expect(updates).toEqual([['N', NOW, 1, 'N'], ['S', null, 1, 'S']])
  })
})

describe('D-PR43 — semântica do interruptor', () => {
  it('[RESISTIU] idempotente: N duas vezes = 200 nas duas e a 2ª NÃO regrava (o instante do desligamento fica — Rodada 6); religar devolve a MESMA chave; nunca DELETE/REPLACE', async () => {
    const auth = bearer(SUPER)
    const a = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'N' })
    const b = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'N' })
    const c = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'S' })
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect([a.body.data.active, b.body.data.active, c.body.data.active]).toEqual(['N', 'N', 'S'])
    expect(c.body.data.apiKey).toBe(KEY)
    expect(updates.map(u => u[0])).toEqual(['N', 'S'])               // o 2º 'N' não chegou ao UPDATE
    const all = [...q.mock.calls, ...txConns.flatMap(t => t.query.mock.calls)].map(call => call[0] as string)
    expect(all.some(sql => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bINSERT\s+INTO\s+setes_central\.tb_sync_api_key/i.test(sql))).toBe(false)
  })

  it('[RESISTIU] chave soft-deletada não é religada pelo interruptor (o estabelecimento "sem chave" = 404)', async () => {
    keys.set(1, [{ active: 'N', deleted: 'S' }])
    const r = await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect(r.status).toBe(404)
    expect(keys.get(1)![0]).toEqual({ active: 'N', deleted: 'S' })
  })

  it('[RESISTIU] duas chaves vivas no MESMO estabelecimento (DDL sem UNIQUE por institution): o interruptor desliga TODAS — a guarda concorda', async () => {
    keys.set(1, [{ active: 'S', deleted: 'N' }, { active: 'S', deleted: 'N' }])
    await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    expect(keys.get(1)!.map(k => k.active)).toEqual(['N', 'N'])
    const w = await request(app).post('/api/merchandise/brands').set('Authorization', bearer(SETES_ADMIN)).send({ description: 'MARCA' })
    expect(w.status).toBe(201)
  })

  it('[RESISTIU] o log do ato leva autor e estabelecimento — nunca a chave', async () => {
    await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    const info = (logger.info as jest.Mock).mock.calls.find(c => /Sincronizador DESATIVADO/.test(c[0]))
    expect(info?.[1]).toEqual({ institutionId: 1, actorUserId: 1 })
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(KEY)
  })
})

describe('D-PR43 × D-PR32 × D-PR41 — o efeito do interruptor na web (sem cache)', () => {
  it('[RESISTIU] desligar libera a escrita do merchandise NA HORA e religar trava NA HORA (mesmo processo, sem reinício)', async () => {
    const admin = bearer(SETES_ADMIN), sup = bearer(SUPER)
    const before = await request(app).post('/api/merchandise/brands').set('Authorization', admin).send({ description: 'MARCA' })
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'N' })
    const off = await request(app).post('/api/merchandise/brands').set('Authorization', admin).send({ description: 'MARCA' })
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'S' })
    const on = await request(app).post('/api/merchandise/brands').set('Authorization', admin).send({ description: 'MARCA' })
    expect([before.status, before.body.code, off.status, on.status, on.body.code]).toEqual([409, 'SYNC_MANAGED_CATALOG', 201, 409, 'SYNC_MANAGED_CATALOG'])
    expect((merch.createBrand as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('[RESISTIU] Q-PR49 (a): o lookup do serviço vai pelo FATO — sem categoria S viva aparecem as P (as 2 do legado); estabelecimento sem categoria → vazio', async () => {
    const admin = bearer(SETES_ADMIN)
    const synced = await request(app).get('/api/services/categories').set('Authorization', admin)
    expect(synced.status).toBe(200)
    expect(synced.body.data.map((c: any) => c.id)).toEqual([8, 9])
    const other = await request(app).get('/api/services/categories').set('Authorization', bearer(ADMIN2))
    expect(other.body.data).toEqual([])
    const sqls = q.mock.calls.filter(c => /tb_category/.test(c[0])).map(c => c[0])
    expect(sqls).toHaveLength(2)
    for (const sql of sqls) expect(sql).toContain("c.kind = 'S' OR NOT EXISTS")
    expect(q.mock.calls.filter(c => /tb_sync_api_key/.test(c[0]))).toHaveLength(0)       // nunca pelo MODO
  })

  it('[CORRIGIDO — era ACHADO MEDIUM do delta R5] desligar o sincronizador da Setes cria "Serviços" (kind S) e o lookup passa a mostrar SÓ ela — o "Novo serviço" volta a ser possível', async () => {
    const admin = bearer(SETES_ADMIN)
    const before = await request(app).get('/api/services/categories').set('Authorization', admin)
    const off = await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    const after = await request(app).get('/api/services/categories').set('Authorization', admin)
    expect(before.body.data.map((c: any) => c.id)).toEqual([8, 9])
    expect(off.body.data).toMatchObject({ active: 'N', defaultServiceCategoryId: 10 })
    expect(off.body.data.notice).toMatch(/ANTES/)
    expect(after.body.data.map((c: any) => c.id)).toEqual([10])
    expect(cats.get(1)!.find(c => c.id === 10)).toMatchObject({ kind: 'S', createdAt: new Date(NOW.getTime() - 1000) })
  })

  it('[RESISTIU] Q-PR47 (a): a "Serviços" do PRÓPRIO ato não impede religar; uma categoria criada pela web no segundo do desligamento (mesmo já excluída) impede (409 SYNC_KEY_WEB_ROWS)', async () => {
    const sup = bearer(SUPER)
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'N' })
    const on = await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'S' })
    expect(on.status).toBe(200)
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'N' })      // novo desligamento (instante = NOW)
    cats.get(1)!.push({ id: 11, kind: 'P', deleted: 'S', createdAt: NOW })                  // nascida no MESMO segundo e já excluída
    const refused = await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'S' })
    expect([refused.status, refused.body.code]).toEqual([409, 'SYNC_KEY_WEB_ROWS'])
    expect(refused.body.fields[0].field).toBe('active')
    expect(keys.get(1)![0].active).toBe('N')
  })
})
