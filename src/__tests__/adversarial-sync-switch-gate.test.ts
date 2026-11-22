/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 7 do cadastro de produtos (2026-10-20; skill testar-adversarial.md; prompt_modulo_products.md "Rodada 7"),
// revisto pelas Rodadas 10 e 11 (2026-11-22 — D-OI10, D-PR70, D-PR73, D-PR75, D-PR76, D-PR77).
// Alvo: os DOIS atos do cadastro de Institutions sobre a origem dos cadastros — o interruptor `PUT /api/institutions/:id/sync-api-key/
// active` (D-PR43 + D-PR48 item 1: só PAUSA, reversível, não decide dono) e a TROCA D → W no próprio `PUT /api/institutions/:id` com
// `sourceKind: 'W'` (D-PR73/D-PR76: só com a chave do sincronizador BLOQUEADA; grava data e autor, sem motivo — D-PR75; cria as
// categorias padrão que faltarem; nunca volta a D). O ato "encerrar a transição" e as rotas end-legacy-transition/end-desktop-transition
// SAÍRAM (D-PR76 — 404); a guarda do dono do catálogo também (D-PR77 — a escrita do catálogo passa em D e em W).
// Pelo app REAL (auth RS256 de teste → feature flag → rate limit → router → superGuard → controller → service → repository), com o banco
// num MODELO em memória (fato por institution, chaves, categorias), a cadeia fiscal dublada e o serviço do merchandise MOCKADO (o que
// se prova é se a ESCRITA chega). `it('[RESISTIU] …')` = o ataque foi barrado / a promessa vale.
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

// a cadeia fiscal do PUT não é o alvo: grava "nada" (o que se prova é a troca da origem na MESMA transação)
jest.mock('../shared/entity', () => ({
  ...jest.requireActual('../shared/entity'),
  getEntityFiscalFull: jest.fn(async (id: number) => ({ id, nickTrade: 'SETES' })),
  saveEntityFiscalChain: jest.fn(async (_c: unknown, id: number) => ({ id })),
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
const NOW = new Date(Date.UTC(2026, 10, 22, 12, 0, 0))
type Inst = { schemaName: string; kind: 'W' | 'D'; endedAt: Date | null; by: number | null }
type Key = { active: 'S' | 'N'; deleted: 'S' | 'N'; pausedSecondsAgo?: number }   // relógio simulado da pausa (D-PR78)
type Cat = { id: number; kind: 'P' | 'S'; deleted: 'S' | 'N'; active: 'S' | 'N' }
let institutions: Map<number, Inst>
let keys: Map<number, Key[]>        // institution → chaves (sem UNIQUE por institution no DDL real)
let cats: Map<number, Cat[]>         // institution → categorias
let keyUpdates: any[][]
let instUpdates: any[][]
let failOn: RegExp | null
let deadlockOnce: boolean
function db(sql: string, params: any[] = []): any {
  const s = String(sql)
  if (failOn && failOn.test(s)) {
    throw Object.assign(new Error("Table 'setes_setes.tb_category' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
  }
  // deadlock no MAX+1 da categoria (o InnoDB desfaz a transação INTEIRA — o modelo também, no rollback)
  if (deadlockOnce && /MAX\(id\), 0\) \+ 1 AS nextId FROM `\w+`\.tb_category/.test(s)) {
    deadlockOnce = false
    throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
  }
  if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s)) return [institutions.has(Number(params[0])) ? [{ id: params[0] }] : []]
  if (/SELECT id FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'/.test(s)) return [institutions.has(Number(params[0])) ? [{ id: params[0] }] : []]
  if (/SELECT source_kind AS kind FROM setes_central\.tb_institution/.test(s)) {
    const i = institutions.get(Number(params[0])); return [i ? [{ kind: i.kind }] : []]
  }
  if (/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'/.test(s)) {
    const i = institutions.get(Number(params[0])); return [i ? [{ sourceKind: i.kind }] : []]
  }
  // a troca do PUT: o fato travado (2º statement, depois da trava da institution)
  if (/SELECT schema_name AS schemaName, source_kind AS sourceKind FROM setes_central\.tb_institution\s+WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    const i = institutions.get(Number(params[0])); return [i ? [{ schemaName: i.schemaName, sourceKind: i.kind }] : []]
  }
  if (/SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt/.test(s)) {
    const i = institutions.get(Number(params[0]))
    return [i ? [{ schemaName: i.schemaName, sourceKind: i.kind, transitionEndedAt: i.endedAt }] : []]
  }
  if (/UPDATE setes_central\.tb_institution\s+SET source_kind = 'W', transition_ended_at = NOW\(\), transition_ended_by = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/.test(s)) {
    instUpdates.push(params)                                  // [autor, id] — data e autor no MESMO UPDATE condicionado, sem motivo (D-PR75)
    const i = institutions.get(Number(params[1]))
    if (!i || i.kind !== 'D' || i.endedAt) return [{ affectedRows: 0 }]
    i.kind = 'W'; i.endedAt = NOW; i.by = params[0]
    return [{ affectedRows: 1 }]
  }
  if (/UPDATE setes_central\.tb_institution SET active = \?/.test(s)) return [{ affectedRows: 1 }]
  // a troca do PUT: chave ATIVA trava a troca (D-PR73) — lida FOR UPDATE, nunca escrita
  if (/SELECT id FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' AND active = 'S' FOR UPDATE/.test(s)) {
    return [(keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N' && k.active === 'S').map((_k, i) => ({ id: i + 1 }))]
  }
  // D-PR78: há quanto tempo a chave está bloqueada (a pausa grava updated_at) — null = nenhuma chave bloqueada
  if (/SELECT TIMESTAMPDIFF\(SECOND, MAX\(updated_at\), NOW\(\)\) AS pausedFor FROM setes_central\.tb_sync_api_key/.test(s)) {
    const paused = (keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N' && k.active === 'N')
    return [[{ pausedFor: paused.length === 0 ? null : Math.min(...paused.map(k => k.pausedSecondsAgo ?? 3600)) }]]
  }
  if (/FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    return [(keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N').map((k, i) => ({ id: i + 1, active: k.active }))]
  }
  if (/UPDATE setes_central\.tb_sync_api_key SET active = \?, updated_at = NOW\(\)/.test(s)) {
    keyUpdates.push(params)
    const [active, inst] = params
    const hit = (keys.get(Number(inst)) ?? []).filter(k => k.deleted === 'N' && k.active !== active)
    hit.forEach(k => { k.active = active; k.pausedSecondsAgo = 0 })
    return [{ affectedRows: hit.length }]
  }
  if (/api_key AS apiKey/.test(s)) {
    const first = (keys.get(Number(params[0])) ?? []).find(k => k.deleted === 'N')
    return [first ? [{ apiKey: KEY, establishmentCode: 'SETES_SETES', active: first.active }] : []]
  }
  if (/MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_sync_api_key/.test(s)) return [[{ nextId: 1 }]]
  if (/INSERT INTO setes_central\.tb_sync_api_key/.test(s)) {
    const inst = Number(params[2])
    keys.set(inst, [...(keys.get(inst) ?? []), { active: 'S', deleted: 'N' }])
    return [{}]
  }
  // @shared/category-kind (a troca D → W cria as categorias padrão que faltarem)
  if (/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/.test(s)) {
    return [(cats.get(Number(params[0])) ?? []).filter(c => c.kind === params[1] && c.deleted === 'N' && c.active === 'S').slice(0, 1).map(c => ({ id: c.id }))]
  }
  if (/MAX\(id\), 0\) \+ 1 AS nextId FROM `\w+`\.tb_category/.test(s)) {
    return [[{ nextId: Math.max(0, ...(cats.get(Number(params[0])) ?? []).map(c => c.id)) + 1 }]]
  }
  if (/INSERT INTO `\w+`\.tb_category/.test(s)) {
    const [id, inst, , , kind] = params
    cats.set(Number(inst), [...(cats.get(Number(inst)) ?? []), { id: Number(id), kind, deleted: 'N', active: 'S' }])
    return [{}]
  }
  // lookup de categorias do serviço pelo FATO (Q-PR49 (a))
  if (/FROM `\w+`\.tb_category c/.test(s) && /c\.kind = 'S' OR NOT EXISTS/.test(s)) {
    const list = (cats.get(Number(params[0])) ?? []).filter(c => c.deleted === 'N')
    const hasS = list.some(c => c.kind === 'S' && c.active === 'S')
    return [list.filter(c => (hasS ? c.kind === 'S' : true)).map(c => ({ id: c.id, description: `C${c.id}`, name: `C${c.id}` }))]
  }
  if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(s)) return [String(params[0]) === 'merchandise' ? [{ id: MERCH_IFACE }] : []]
  if (/tb_institution_has_interface/.test(s)) return [Number(params[1]) === MERCH_IFACE ? [{ 1: 1 }] : []]
  if (/tb_user_has_privilege/.test(s)) return [[]]
  if (/^\s*SELECT/i.test(s)) return [[]]
  throw new Error(`SQL inesperado: ${s.slice(0, 100)}`)
}
let txConns: any[]
// o modelo DESFAZ em rollback o que a transação escreveu (retrato no beginTransaction) — como o InnoDB
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => db(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => {
    let snap: any = null
    const c = {
      query: jest.fn(async (sql: string, params: any[] = []) => db(sql, params)),
      beginTransaction: jest.fn(async () => { snap = structuredClone({ institutions, keys, cats, keyUpdates, instUpdates }) }),
      commit: jest.fn(async () => { snap = null }),
      rollback: jest.fn(async () => {
        if (!snap) return
        institutions = snap.institutions; keys = snap.keys; cats = snap.cats; keyUpdates = snap.keyUpdates; instUpdates = snap.instUpdates
        snap = null
      }),
      release: jest.fn(),
    }
    txConns.push(c)
    return c
  })
}

const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const SUPER_B = { institutionId: 1, userId: 3, role: 'super', schemaName: 'setes_setes' }   // outro Super da Setes
const SETES_ADMIN = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }
const ADMIN2 = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER2 = { institutionId: 2, userId: 10, role: 'user', schemaName: 'setes_x' }
const FAKE_SUPER2 = { institutionId: 2, userId: 11, role: 'super', schemaName: 'setes_x' }   // "super" fora da Setes
const bearer = (p: object) => `Bearer ${testToken(p)}`
const switchUrl = (id: string | number) => `/api/institutions/${id}/sync-api-key/active`
// corpo do PUT que passa no institutionUpdateDto (a cadeia fiscal é dublada)
const BODY = {
  entity: { nameCompany: 'SETES LTDA', nickTrade: 'SETES' }, personType: 'J', company: { cnpj: '11222333000181' },
  addresses: [], phones: [], socialMedia: [],
}
const put = (id: number | string, extra: object, who: object = SUPER) =>
  request(app).put(`/api/institutions/${id}`).set('Authorization', bearer(who)).send({ ...BODY, ...extra })
const toWeb = (id: number | string = 1, who: object = SUPER) => put(id, { sourceKind: 'W' }, who)
const blockKey = (id: number = 1) => request(app).put(switchUrl(id)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
/** O relógio passa do cache do setes-sync (5 min — D-PR78): as chaves bloqueadas ficam 'velhas'. */
const ageKeys = (seconds = 301) => { for (const list of keys.values()) for (const k of list) if (k.active === 'N') k.pausedSecondsAgo = seconds }
const brandWrite = (who: object = SETES_ADMIN) => request(app).post('/api/merchandise/brands').set('Authorization', bearer(who)).send({ description: 'MARCA' })
const txSql = (c: any): string[] => c.query.mock.calls.map((x: any[]) => String(x[0]))
const trocaTx = () => txConns.find(c => txSql(c).some(s => /SELECT schema_name AS schemaName, source_kind AS sourceKind FROM/.test(s)))

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  // fato do dev (2026-11-22): a Setes é D (chave ativa); 2 = cliente nativo web; 3 = outro cliente do ERP Desktop (chave ativa)
  institutions = new Map([[1, { schemaName: 'setes_setes', kind: 'D', endedAt: null, by: null }],
    [2, { schemaName: 'setes_x', kind: 'W', endedAt: null, by: null }], [3, { schemaName: 'setes_y', kind: 'D', endedAt: null, by: null }]])
  keys = new Map([[1, [{ active: 'S', deleted: 'N' }]], [3, [{ active: 'S', deleted: 'N' }]]])
  // dev: só 2 categorias na Setes, ambas kind 'P' (ids 8 e 9 do gerador do ERP Desktop); nenhuma 'S'
  cats = new Map([[1, [{ id: 8, kind: 'P', deleted: 'N', active: 'S' }, { id: 9, kind: 'P', deleted: 'N', active: 'S' }]]])
  keyUpdates = []; instUpdates = []
  failOn = null; deadlockOnce = false
  txConns = []
  routeDb()
})

describe('quem alcança o interruptor e a troca (superGuard do módulo)', () => {
  it('[RESISTIU] sem token 401; usuário, admin do PRÓPRIO estabelecimento, admin da Setes e "super" fora da Setes = 403 — nada chega ao UPDATE (interruptor E troca)', async () => {
    const anon = await Promise.all([
      request(app).put(switchUrl(1)).send({ active: 'N' }), request(app).put('/api/institutions/1').send({ ...BODY, sourceKind: 'W' })])
    expect(anon.map(r => r.status)).toEqual([401, 401])
    for (const [who, target] of [[USER2, 2], [ADMIN2, 2], [ADMIN2, 1], [SETES_ADMIN, 1], [FAKE_SUPER2, 1]] as const) {
      const a = await request(app).put(switchUrl(target)).set('Authorization', bearer(who)).send({ active: 'N' })
      const b = await toWeb(target, who)
      expect([who.role, who.institutionId, target, a.status, b.status]).toEqual([who.role, who.institutionId, target, 403, 403])
    }
    expect(keyUpdates).toEqual([]); expect(instUpdates).toEqual([])
    expect(institutions.get(1)!.kind).toBe('D')
  })

  it('[RESISTIU] forma da URL (caixa, barra final, barra dupla) não contorna o superGuard para o admin — interruptor, PUT e as rotas velhas do ato', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).put('/api/INSTITUTIONS/1/SYNC-API-KEY/ACTIVE').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api/institutions/1/sync-api-key/active/').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api/INSTITUTIONS/1').set('Authorization', auth).send({ ...BODY, sourceKind: 'W' }),
      request(app).put('/api/institutions//1/').set('Authorization', auth).send({ ...BODY, sourceKind: 'W' }),
      request(app).post('/api/INSTITUTIONS/1/END-LEGACY-TRANSITION').set('Authorization', auth).send({ destination: 'W', reason: 'caixa alta' }),
      request(app).post('/api/institutions//1/end-desktop-transition').set('Authorization', auth).send({ reason: 'barra' }),
    ])
    for (const r of res) expect([403, 404]).toContain(r.status)
    expect(keyUpdates).toEqual([]); expect(instUpdates).toEqual([])
    expect(institutions.get(1)!.kind).toBe('D')
  })

  it('[RESISTIU] método errado e override por cabeçalho não acionam o interruptor nem a troca — nem para o super', async () => {
    const auth = bearer(SUPER)
    const res = await Promise.all([
      request(app).post(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).patch(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).patch('/api/institutions/1').set('Authorization', auth).send({ ...BODY, sourceKind: 'W' }),
      request(app).post('/api/institutions/1').set('Authorization', auth).set('X-HTTP-Method-Override', 'PUT').send({ ...BODY, sourceKind: 'W' }),
      request(app).put(switchUrl(1)).set('Authorization', auth).set('X-HTTP-Method-Override', 'POST').send({ sourceKind: 'W' }),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404, 400])      // o último é o PUT do interruptor sem `active` = 400
    expect(instUpdates).toEqual([])
    expect(institutions.get(1)!.kind).toBe('D')
  })

  it('[RESISTIU] D-PR76: o ato saiu — end-legacy-transition e end-desktop-transition = 404 para o super (POST, PUT, GET; caixa alta e barra dupla); nada gravado', async () => {
    const auth = bearer(SUPER)
    const res = await Promise.all([
      request(app).post('/api/institutions/1/end-legacy-transition').set('Authorization', auth).send({ destination: 'W', reason: 'rota velha' }),
      request(app).post('/api/institutions/1/end-desktop-transition').set('Authorization', auth).send({ reason: 'rota velha' }),
      request(app).post('/api/INSTITUTIONS/1/END-DESKTOP-TRANSITION').set('Authorization', auth).send({ reason: 'caixa alta' }),
      request(app).post('/api/institutions//1/end-legacy-transition').set('Authorization', auth).send({ destination: 'W', reason: 'barra dupla' }),
      request(app).put('/api/institutions/1/end-desktop-transition').set('Authorization', auth).send({ reason: 'put' }),
      request(app).get('/api/institutions/1/end-legacy-transition').set('Authorization', auth),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404, 404, 404])
    expect(instUpdates).toEqual([]); expect(keyUpdates).toEqual([])
    expect(institutions.get(1)).toMatchObject({ kind: 'D', endedAt: null })
    expect(keys.get(1)![0].active).toBe('S')
  })
})

describe('bordas do corpo e do id (super)', () => {
  it('[RESISTIU] interruptor: active fora de S/N = 400 sem UPDATE; campo extra é ignorado (só active vai ao UPDATE, com placeholders)', async () => {
    const auth = bearer(SUPER)
    for (const b of [{ active: 'n' }, { active: 'N ' }, { active: ['N'] }, { active: null }, { active: 0 }, {}, [{ active: 'N' }]] as any[]) {
      const r = await request(app).put(switchUrl(1)).set('Authorization', auth).send(b)
      expect([JSON.stringify(b), r.status]).toEqual([JSON.stringify(b), 400])
    }
    const r = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'N', deleted: 'S', api_key: "x'; DROP TABLE t; --" })
    expect(r.status).toBe(200)
    expect(keyUpdates).toEqual([['N', 1, 'N']])
  })

  it("[RESISTIU] troca: sourceKind fora de W/D (as letras antigas 'L' e 'P' — D-OI10 —, minúscula, espaço, lista, null, número) = 400 sem tocar no fato, nem com a chave bloqueada", async () => {
    await blockKey()
    for (const sk of ['L', 'P', 'w', 'd', ' W', ['W'], null, 0] as any[]) {
      const r = await put(1, { sourceKind: sk })
      expect([JSON.stringify(sk), r.status]).toEqual([JSON.stringify(sk), 400])
    }
    expect(instUpdates).toEqual([])
    expect(institutions.get(1)).toMatchObject({ kind: 'D', endedAt: null, by: null })
    expect(cats.get(1)!.map(c => c.id)).toEqual([8, 9])
  })

  it('[RESISTIU] id inválido = 400; estabelecimento inexistente = 404 (interruptor e troca); existente sem chave = 404 só no interruptor', async () => {
    const bad = await Promise.all(['abc', '-1', '1.5'].flatMap(id => [
      request(app).put(switchUrl(id)).set('Authorization', bearer(SUPER)).send({ active: 'N' }), toWeb(id)]))
    expect(bad.map(r => r.status)).toEqual([400, 400, 400, 400, 400, 400])
    const missing = await Promise.all([request(app).put(switchUrl(999)).set('Authorization', bearer(SUPER)).send({ active: 'N' }), toWeb(999)])
    expect(missing.map(r => r.status)).toEqual([404, 404])
    const noKey = await request(app).put(switchUrl(2)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    expect([noKey.status, noKey.body.code]).toEqual([404, 'SYNC_KEY_MISSING'])
    expect(instUpdates).toEqual([])
  })
})

describe('D-PR48 item 1 — o interruptor é PAUSA: reversível, idempotente, e NÃO mexe no dono do catálogo', () => {
  it('[RESISTIU] N, N, S: 200 nas três, o 2º N não regrava, a MESMA chave volta; nunca DELETE/REPLACE/INSERT na chave; nenhuma categoria nasce', async () => {
    const auth = bearer(SUPER)
    const a = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'N' })
    const b = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'N' })
    const c = await request(app).put(switchUrl(1)).set('Authorization', auth).send({ active: 'S' })
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect([a.body.data.active, b.body.data.active, c.body.data.active]).toEqual(['N', 'N', 'S'])
    expect(c.body.data.apiKey).toBe(KEY)
    expect(a.body.data).not.toHaveProperty('notice'); expect(a.body.data).not.toHaveProperty('defaultServiceCategoryId')
    expect(keyUpdates.map(u => u[0])).toEqual(['N', 'S'])
    const all = [...q.mock.calls, ...txConns.flatMap(t => t.query.mock.calls)].map(call => call[0] as string)
    expect(all.some(sql => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bINSERT\s+INTO\s+setes_central\.tb_sync_api_key|INSERT INTO `\w+`\.tb_category|COUNT\(\*\)/i.test(sql))).toBe(false)
    expect(cats.get(1)!.map(x => x.id)).toEqual([8, 9])
  })

  it('[RESISTIU] o interruptor não mexe no dono nem na escrita do catálogo: em D a escrita passa antes, pausada e retomada (sem guarda — D-PR77); o fato segue D', async () => {
    const sup = bearer(SUPER)
    const before = await brandWrite()
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'N' })
    const paused = await brandWrite()
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'S' })
    const resumed = await brandWrite()
    expect([before.status, paused.status, resumed.status]).toEqual([201, 201, 201])
    expect((merch.createBrand as jest.Mock).mock.calls).toHaveLength(3)
    expect(institutions.get(1)).toMatchObject({ kind: 'D', endedAt: null })
    expect(instUpdates).toEqual([])
  })

  it('[RESISTIU] chave soft-deletada não é retomada pelo interruptor (404); duas chaves vivas: pausa TODAS; o log leva autor e estabelecimento — nunca a chave', async () => {
    keys.set(3, [{ active: 'N', deleted: 'S' }])
    const r = await request(app).put(switchUrl(3)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect(r.status).toBe(404)
    keys.set(1, [{ active: 'S', deleted: 'N' }, { active: 'S', deleted: 'N' }])
    await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    expect(keys.get(1)!.map(k => k.active)).toEqual(['N', 'N'])
    const info = (logger.info as jest.Mock).mock.calls.find(c => /PAUSADO/.test(c[0]))
    expect(info?.[1]).toEqual({ institutionId: 1, actorUserId: 1, keys: 2 })
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(KEY)
  })

  it('[RESISTIU] retomar em W = 409 SYNC_KEY_NOT_FOR_SOURCE (nativo web não tem sincronizador); gerar chave em W = 409 pelo mesmo código; em D gera', async () => {
    keys.set(2, [{ active: 'N', deleted: 'N' }])
    const resume = await request(app).put(switchUrl(2)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect([resume.status, resume.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.get(2)![0].active).toBe('N')
    keys.delete(2)
    const gen = await request(app).post('/api/institutions/2/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect([gen.status, gen.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.has(2)).toBe(false)
    keys.delete(3)
    const desktop = await request(app).post('/api/institutions/3/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect(desktop.status).toBe(201)
    expect(keys.get(3)).toEqual([{ active: 'S', deleted: 'N' }])
  })
})

describe('D-PR73/D-PR75/D-PR76 — virar Web é a TROCA D → W no PUT do estabelecimento: só com a chave bloqueada, irreversível', () => {
  it('[RESISTIU] D-PR78: logo depois de bloquear a chave (dentro do cache de 5 min do setes-sync) = 409 SOURCE_KIND_SYNC_KEY_ACTIVE com o tempo que falta; passado o cache, a troca passa', async () => {
    await blockKey()
    const early = await toWeb()
    expect([early.status, early.body.code]).toEqual([409, 'SOURCE_KIND_SYNC_KEY_ACTIVE'])
    expect(early.body.fields).toEqual([{ field: 'sourceKind', message: 'aguarde 300 s' }])
    expect(institutions.get(1)).toMatchObject({ kind: 'D', endedAt: null })
    ageKeys(299)
    expect((await toWeb()).status).toBe(409)
    ageKeys(300)
    expect((await toWeb()).status).toBe(200)
    expect(institutions.get(1)!.kind).toBe('W')
  })

  it('[RESISTIU] D → W com a chave bloqueada: 200; o fato vira W com data e autor, SEM motivo; "Produtos" (já havia P viva: nada) e "Serviços" (10) nascem; a chave NÃO é tocada; log com autor', async () => {
    await blockKey(); ageKeys()
    const r = await toWeb()
    expect(r.status).toBe(200)
    expect(institutions.get(1)).toEqual({ schemaName: 'setes_setes', kind: 'W', endedAt: NOW, by: 1 })
    expect(instUpdates).toEqual([[1, 1]])                                                   // [autor = userId do SUPER, id] (D-PR53/D-PR75)
    expect(trocaTx() && txSql(trocaTx()).filter(s => /SET source_kind/.test(s)).every(s => !/transition_end_reason/.test(s))).toBe(true)
    expect(cats.get(1)!.map(c => [c.id, c.kind])).toEqual([[8, 'P'], [9, 'P'], [10, 'S']])
    expect(keys.get(1)![0].active).toBe('N')
    expect(keyUpdates).toEqual([['N', 1, 'N']])                                             // só o bloqueio do interruptor; a troca não escreve na chave
    const log = (logger.info as jest.Mock).mock.calls.find(c => /TROCADA/.test(c[0]))
    expect(log?.[1]).toEqual({ institutionId: 1, actorUserId: 1, defaultCategories: { P: null, S: 10 } })
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(KEY)
  })

  it('[RESISTIU] D → W com a chave ATIVA = 409 SOURCE_KIND_SYNC_KEY_ACTIVE: nada gravado (fato, autor, categorias), a transação desfeita, a chave segue S', async () => {
    const r = await toWeb()
    expect([r.status, r.body.code]).toEqual([409, 'SOURCE_KIND_SYNC_KEY_ACTIVE'])
    expect(institutions.get(1)).toEqual({ schemaName: 'setes_setes', kind: 'D', endedAt: null, by: null })
    expect(instUpdates).toEqual([])
    expect(cats.get(1)!.map(c => c.id)).toEqual([8, 9])
    expect(keys.get(1)![0].active).toBe('S')
    expect(trocaTx().rollback).toHaveBeenCalled()
    expect(trocaTx().commit).not.toHaveBeenCalled()
    expect((logger.info as jest.Mock).mock.calls.some(c => /TROCADA/.test(c[0]))).toBe(false)
  })

  it('[RESISTIU] depois da troca o interruptor em W recusa retomar e a geração recusa: a chave de quem virou Web nunca reativa; a escrita do catálogo segue passando', async () => {
    await blockKey(); ageKeys()
    const before = await brandWrite()
    await toWeb()
    const after = await brandWrite()
    expect([before.status, after.status]).toEqual([201, 201])
    const resume = await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect([resume.status, resume.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.get(1)![0].active).toBe('N')
    const gen = await request(app).post('/api/institutions/1/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect([gen.status, gen.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
  })

  it('[RESISTIU] irreversível: W → D = 409 SOURCE_KIND_IMMUTABLE (nativo e trocado); repetir W não reescreve o autor; igual ao gravado passa sem trava de chave; PUT sem sourceKind não trava nem lê o fato', async () => {
    const native = await put(2, { sourceKind: 'D' })
    expect([native.status, native.body.code]).toEqual([409, 'SOURCE_KIND_IMMUTABLE'])
    expect(native.body.fields).toEqual([{ field: 'sourceKind', message: 'gravado: W' }])
    await blockKey(); ageKeys()
    await toWeb()
    const again = await toWeb(1, SUPER_B)
    expect(again.status).toBe(200)
    const back = await put(1, { sourceKind: 'D' }, SUPER_B)
    expect([back.status, back.body.code]).toEqual([409, 'SOURCE_KIND_IMMUTABLE'])
    expect(instUpdates).toEqual([[1, 1]])
    expect(institutions.get(1)).toEqual({ schemaName: 'setes_setes', kind: 'W', endedAt: NOW, by: 1 })
    expect(institutions.get(2)!.kind).toBe('W')
    txConns = []
    const same = await put(3, { sourceKind: 'D' })                                         // 3 é D com chave ATIVA: igual ao gravado, sem troca
    expect(same.status).toBe(200)
    expect(txConns.flatMap(txSql).some(s => /tb_sync_api_key/.test(s))).toBe(false)
    txConns = []
    const plain = await put(3, {})
    expect(plain.status).toBe(200)
    expect(txConns.flatMap(txSql).some(s => /source_kind|FOR UPDATE/.test(s))).toBe(false)
    expect(institutions.get(3)).toMatchObject({ kind: 'D', endedAt: null })
  })

  it('[RESISTIU] falha ao criar a categoria padrão desfaz a troca INTEIRA: 500 com ref, o fato segue D sem data nem autor, nada de log', async () => {
    await blockKey(); ageKeys()
    failOn = /INSERT INTO `\w+`\.tb_category/
    const r = await toWeb()
    expect([r.status, r.body.ref]).toEqual([500, 'REFADVSW'])
    expect(trocaTx().rollback).toHaveBeenCalled()
    expect(trocaTx().commit).not.toHaveBeenCalled()
    expect(institutions.get(1)).toEqual({ schemaName: 'setes_setes', kind: 'D', endedAt: null, by: null })
    expect(instUpdates).toEqual([])
    expect(cats.get(1)!.map(c => c.id)).toEqual([8, 9])
    expect(keys.get(1)![0].active).toBe('N')
    expect((logger.info as jest.Mock).mock.calls.some(c => /TROCADA/.test(c[0]))).toBe(false)
  })

  it('[RESISTIU] deadlock na 1ª tentativa (a troca cunha id de categoria): reexecuta INTEIRA — 200, uma "Serviços", um UPDATE do fato', async () => {
    await blockKey(); ageKeys()
    txConns = []
    deadlockOnce = true
    const r = await toWeb()
    expect(r.status).toBe(200)
    expect(cats.get(1)!.filter(c => c.kind === 'S')).toHaveLength(1)
    expect(instUpdates).toEqual([[1, 1]])                                                   // a 1ª tentativa foi desfeita
    expect(institutions.get(1)).toMatchObject({ kind: 'W', by: 1 })
    expect(txConns.length).toBeGreaterThanOrEqual(2)
    expect(txConns[0].rollback).toHaveBeenCalled()
    expect(txConns[0].commit).not.toHaveBeenCalled()
    expect(txConns[txConns.length - 1].commit).toHaveBeenCalled()
  })

  it("[RESISTIU] a transação da troca: leitura sem trava, depois trava da institution 1º, o fato FOR UPDATE 2º, a chave ativa FOR UPDATE 3º, o UPDATE com `source_kind = 'D'` NO COMANDO 4º, e só depois as categorias", async () => {
    await blockKey(); ageKeys()
    await toWeb()
    const all = txSql(trocaTx())
    // 0º: a leitura SEM trava que decide se a origem muda (gates da PROD.E10.P1) — só então a trava é o 1º statement que trava
    expect(all[0]).toMatch(/^SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'$/)
    const calls = all.slice(1)
    expect(calls[0]).toMatch(/SELECT id FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    expect(calls[1]).toMatch(/SELECT schema_name AS schemaName, source_kind AS sourceKind FROM setes_central\.tb_institution\s+WHERE id = \? AND deleted = 'N' FOR UPDATE/)
    expect(calls[2]).toMatch(/SELECT id FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' AND active = 'S' FOR UPDATE/)
    expect(calls[3]).toMatch(/SELECT TIMESTAMPDIFF\(SECOND, MAX\(updated_at\), NOW\(\)\) AS pausedFor/)            // D-PR78: há quanto tempo está bloqueada
    expect(calls[4]).toMatch(/UPDATE setes_central\.tb_institution[\s\S]*WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/)
    const firstCat = calls.findIndex(s => /tb_category/.test(s))
    expect(firstCat).toBeGreaterThan(4)
    expect(calls.filter(s => /UPDATE setes_central\.tb_sync_api_key/.test(s))).toEqual([])
  })

  it('[RESISTIU] Q-PR49 (a) segue: o lookup do serviço vai pelo FATO das categorias — antes da troca as P do ERP Desktop (8, 9); depois SÓ a "Serviços" (10); nunca pela chave', async () => {
    const admin = bearer(SETES_ADMIN)
    await blockKey(); ageKeys()
    const before = await request(app).get('/api/services/categories').set('Authorization', admin)
    await toWeb()
    const after = await request(app).get('/api/services/categories').set('Authorization', admin)
    expect(before.body.data.map((c: any) => c.id)).toEqual([8, 9])
    expect(after.body.data.map((c: any) => c.id)).toEqual([10])
    expect(q.mock.calls.filter(c => /tb_category/.test(c[0]) && /tb_sync_api_key/.test(c[0]))).toHaveLength(0)
  })
})
