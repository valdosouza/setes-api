/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 7 do cadastro de produtos (2026-10-20; skill testar-adversarial.md; prompt_modulo_products.md "Rodada 7").
// Alvo: os DOIS atos do cadastro de Institutions sobre o sincronizador — o interruptor `PUT /api/institutions/:id/sync-api-key/active`
// (D-PR43 + D-PR48 item 1: só PAUSA, reversível, não decide dono) e o ato ÚNICO e IRREVERSÍVEL `POST /api/institutions/:id/
// end-legacy-transition` (D-PR48/D-PR49: L → W ou L → P) — e o efeito deles na guarda do dono do catálogo (D-PR47), pelo app REAL
// (auth RS256 de teste → feature flag → rate limit → router → superGuard → controller → service → repository), com o banco num MODELO em
// memória (fato por institution, chaves, categorias) e o serviço do merchandise MOCKADO (o que se prova é se a ESCRITA chega).
// `it('[RESISTIU] …')` = o ataque foi barrado / a promessa vale; `it('[ACHADO] …')` = fixa o comportamento observado que vira questão.
// Rodada 6 → 7: caíram a "Serviços" do desligar, o 409 SYNC_KEY_WEB_ROWS do religar e a reconferência na transação (não há religar).
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
const NOW = new Date(Date.UTC(2026, 9, 20, 12, 0, 0))
type Inst = { schemaName: string; kind: 'W' | 'L' | 'P'; endedAt: Date | null }
type Key = { active: 'S' | 'N'; deleted: 'S' | 'N' }
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
  if (/SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt/.test(s)) {
    const i = institutions.get(Number(params[0]))
    return [i ? [{ schemaName: i.schemaName, sourceKind: i.kind, transitionEndedAt: i.endedAt }] : []]
  }
  if (/SELECT i\.schema_name AS schemaName, i\.active, i\.source_kind AS sourceKind, i\.transition_ended_at/.test(s)) {
    const i = institutions.get(Number(params[0]))
    return [i ? [{ schemaName: i.schemaName, active: 'S', sourceKind: i.kind, transitionEndedAt: i.endedAt }] : []]
  }
  if (/UPDATE setes_central\.tb_institution\s+SET source_kind = \?, transition_ended_at = NOW\(\), transition_ended_by = \?, transition_end_reason = \?/.test(s)) {
    instUpdates.push(params)                                  // [destino, autor, motivo, id] — as quatro marcas no MESMO UPDATE (D-PR53)
    const i = institutions.get(Number(params[3]))
    if (!i || i.kind !== 'L' || i.endedAt) return [{ affectedRows: 0 }]
    i.kind = params[0]; i.endedAt = NOW
    return [{ affectedRows: 1 }]
  }
  if (/FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    return [(keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N').map((k, i) => ({ id: i + 1, active: k.active }))]
  }
  if (/UPDATE setes_central\.tb_sync_api_key SET active = \?, updated_at = NOW\(\)/.test(s)) {
    keyUpdates.push(params)
    const [active, inst] = params
    const hit = (keys.get(Number(inst)) ?? []).filter(k => k.deleted === 'N' && k.active !== active)
    hit.forEach(k => { k.active = active })
    return [{ affectedRows: hit.length }]
  }
  if (/UPDATE setes_central\.tb_sync_api_key SET active = 'N', updated_at = NOW\(\)/.test(s)) {
    keyUpdates.push(['N(ato)', params[0]])
    const hit = (keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N' && k.active === 'S')
    hit.forEach(k => { k.active = 'N' })
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
  // @shared/category-kind (o ato "encerrar a transição")
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
const SETES_ADMIN = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }
const ADMIN2 = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER2 = { institutionId: 2, userId: 10, role: 'user', schemaName: 'setes_x' }
const FAKE_SUPER2 = { institutionId: 2, userId: 11, role: 'super', schemaName: 'setes_x' }   // "super" fora da Setes
const bearer = (p: object) => `Bearer ${testToken(p)}`
const switchUrl = (id: string | number) => `/api/institutions/${id}/sync-api-key/active`
const endUrl = (id: string | number) => `/api/institutions/${id}/end-legacy-transition`
const end = (id: number | string, body: object, who: object = SUPER) => request(app).post(endUrl(id)).set('Authorization', bearer(who)).send(body)
const brandWrite = (who: object = SETES_ADMIN) => request(app).post('/api/merchandise/brands').set('Authorization', bearer(who)).send({ description: 'MARCA' })

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  // fato do dev (2026-10-20): a Setes é L (chave ativa); 2 = cliente nativo web; 3 = cliente PDV
  institutions = new Map([[1, { schemaName: 'setes_setes', kind: 'L', endedAt: null }], [2, { schemaName: 'setes_x', kind: 'W', endedAt: null }],
    [3, { schemaName: 'setes_pdv', kind: 'P', endedAt: null }]])
  keys = new Map([[1, [{ active: 'S', deleted: 'N' }]], [3, [{ active: 'S', deleted: 'N' }]]])
  // dev: só 2 categorias na Setes, ambas kind 'P' (ids 8 e 9 do gerador do legado); nenhuma 'S'
  cats = new Map([[1, [{ id: 8, kind: 'P', deleted: 'N', active: 'S' }, { id: 9, kind: 'P', deleted: 'N', active: 'S' }]]])
  keyUpdates = []; instUpdates = []
  failOn = null; deadlockOnce = false
  txConns = []
  routeDb()
})

describe('quem alcança os dois atos (superGuard do módulo)', () => {
  it('[RESISTIU] sem token 401; usuário, admin do PRÓPRIO estabelecimento, admin da Setes e "super" fora da Setes = 403 — nada chega ao UPDATE (interruptor E ato)', async () => {
    const anon = await Promise.all([request(app).put(switchUrl(1)).send({ active: 'N' }), request(app).post(endUrl(1)).send({ destination: 'W', reason: 'sem token' })])
    expect(anon.map(r => r.status)).toEqual([401, 401])
    for (const [who, target] of [[USER2, 2], [ADMIN2, 2], [ADMIN2, 1], [SETES_ADMIN, 1], [FAKE_SUPER2, 1]] as const) {
      const a = await request(app).put(switchUrl(target)).set('Authorization', bearer(who)).send({ active: 'N' })
      const b = await end(target, { destination: 'W', reason: 'tentativa' }, who)
      expect([who.role, who.institutionId, target, a.status, b.status]).toEqual([who.role, who.institutionId, target, 403, 403])
    }
    expect(keyUpdates).toEqual([]); expect(instUpdates).toEqual([])
    expect(institutions.get(1)!.kind).toBe('L')
  })

  it('[RESISTIU] forma da URL (caixa, barra final, barra dupla) não contorna o superGuard para o admin', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).put('/api/INSTITUTIONS/1/SYNC-API-KEY/ACTIVE').set('Authorization', auth).send({ active: 'N' }),
      request(app).put('/api/institutions/1/sync-api-key/active/').set('Authorization', auth).send({ active: 'N' }),
      request(app).post('/api/INSTITUTIONS/1/END-LEGACY-TRANSITION').set('Authorization', auth).send({ destination: 'W', reason: 'caixa alta' }),
      request(app).post('/api/institutions//1/end-legacy-transition').set('Authorization', auth).send({ destination: 'W', reason: 'barra' }),
    ])
    for (const r of res) expect([403, 404]).toContain(r.status)
    expect(keyUpdates).toEqual([]); expect(instUpdates).toEqual([])
  })

  it('[RESISTIU] método errado e override por cabeçalho não acionam nenhum dos atos — nem para o super', async () => {
    const auth = bearer(SUPER)
    const res = await Promise.all([
      request(app).post(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).patch(switchUrl(1)).set('Authorization', auth).send({ active: 'N' }),
      request(app).put(endUrl(1)).set('Authorization', auth).send({ destination: 'W', reason: 'put em vez de post' }),
      request(app).get(endUrl(1)).set('Authorization', auth),
      request(app).put(switchUrl(1)).set('Authorization', auth).set('X-HTTP-Method-Override', 'POST').send({ destination: 'W', reason: 'override' }),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404, 400])      // o último é o PUT do interruptor sem `active` = 400
    expect(instUpdates).toEqual([])
    expect(institutions.get(1)!.kind).toBe('L')
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

  it('[RESISTIU] ato: destino fora de W/P (inclusive L e minúscula), motivo ausente/curto/branco, corpo-lista = 400 sem tocar no fato', async () => {
    const bodies: any[] = [{ destination: 'L', reason: 'voltar ao legado' }, { destination: 'w', reason: 'minúscula' }, { destination: 'W' },
      { destination: 'W', reason: '   ' }, { destination: 'W', reason: 'abc' }, { destination: 'W', reason: 'x'.repeat(256) }, [{ destination: 'W', reason: 'lista' }], {}]
    for (const b of bodies) {
      const r = await end(1, b)
      expect([JSON.stringify(b).slice(0, 40), r.status]).toEqual([JSON.stringify(b).slice(0, 40), 400])
    }
    expect(instUpdates).toEqual([])
    expect(institutions.get(1)).toMatchObject({ kind: 'L', endedAt: null })
  })

  it('[RESISTIU] id inválido = 400; estabelecimento inexistente = 404 (nos dois atos); existente sem chave = 404 só no interruptor', async () => {
    const bad = await Promise.all(['abc', '-1', '1.5'].flatMap(id => [
      request(app).put(switchUrl(id)).set('Authorization', bearer(SUPER)).send({ active: 'N' }), end(id, { destination: 'W', reason: 'id ruim' })]))
    expect(bad.map(r => r.status)).toEqual([400, 400, 400, 400, 400, 400])
    const missing = await Promise.all([request(app).put(switchUrl(999)).set('Authorization', bearer(SUPER)).send({ active: 'N' }), end(999, { destination: 'W', reason: 'não existe' })])
    expect(missing.map(r => r.status)).toEqual([404, 404])
    const noKey = await request(app).put(switchUrl(2)).set('Authorization', bearer(SUPER)).send({ active: 'N' })
    expect([noKey.status, noKey.body.code]).toEqual([404, 'SYNC_KEY_MISSING'])
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

  it('[RESISTIU] pausar NÃO libera a escrita do catálogo em L (o dono é o fato, não a chave) — antes 409, pausado 409, retomado 409', async () => {
    const sup = bearer(SUPER)
    const before = await brandWrite()
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'N' })
    const paused = await brandWrite()
    await request(app).put(switchUrl(1)).set('Authorization', sup).send({ active: 'S' })
    const resumed = await brandWrite()
    expect([before.status, paused.status, resumed.status].concat([before.body.code, paused.body.code, resumed.body.code]))
      .toEqual([409, 409, 409, 'CATALOG_LEGACY_OWNED', 'CATALOG_LEGACY_OWNED', 'CATALOG_LEGACY_OWNED'])
    expect((merch.createBrand as jest.Mock).mock.calls).toHaveLength(0)
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

  it('[RESISTIU] retomar em W = 409 SYNC_KEY_NOT_FOR_SOURCE (nativo web não tem sincronizador); gerar chave em W = 409 pelo mesmo código; em P gera', async () => {
    keys.set(2, [{ active: 'N', deleted: 'N' }])
    const resume = await request(app).put(switchUrl(2)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect([resume.status, resume.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.get(2)![0].active).toBe('N')
    keys.delete(2)
    const gen = await request(app).post('/api/institutions/2/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect([gen.status, gen.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.has(2)).toBe(false)
    keys.delete(3)
    const pdv = await request(app).post('/api/institutions/3/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect(pdv.status).toBe(201)
    expect(keys.get(3)).toEqual([{ active: 'S', deleted: 'N' }])
  })
})

describe('D-PR48/D-PR49 — "encerrar a transição": ato único e irreversível, com destino', () => {
  it('[RESISTIU] L → W: o fato vira W com a data, a chave fica INATIVA, "Produtos" (já havia P viva: nada) e "Serviços" (10) nascem; a resposta diz tudo; log com autor e motivo', async () => {
    const r = await end(1, { destination: 'W', reason: 'servidor desktop desligado em 20/10' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ sourceKind: 'W', transitionEndedAt: NOW.toISOString(), defaultCategories: { P: null, S: 10 }, syncKeysInactivated: 1 })
    expect(institutions.get(1)).toEqual({ schemaName: 'setes_setes', kind: 'W', endedAt: NOW })
    expect(keys.get(1)![0].active).toBe('N')
    expect(cats.get(1)!.find(c => c.id === 10)).toMatchObject({ kind: 'S', active: 'S' })
    expect(instUpdates).toEqual([['W', 1, 'servidor desktop desligado em 20/10', 1]])   // autor = userId do SUPER (D-PR53)
    const log = (logger.info as jest.Mock).mock.calls.find(c => /ENCERRADA/.test(c[0]))
    expect(log?.[1]).toMatchObject({ institutionId: 1, destination: 'W', reason: 'servidor desktop desligado em 20/10', actorUserId: 1, syncKeysInactivated: 1 })
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(KEY)
  })

  it('[RESISTIU] L → P: barreira INTERINA (A-PR5/Q-PR62) — 409 LEGACY_TRANSITION_DESTINATION_PENDING, nada gravado, nenhuma transação aberta (o desktop ainda autentica pela chave viva: dois escritores)', async () => {
    const r = await end(1, { destination: 'P', reason: 'servidor desktop desativado; ficam os PDVs' })
    expect([r.status, r.body.code]).toEqual([409, 'LEGACY_TRANSITION_DESTINATION_PENDING'])
    expect(r.body.fields).toEqual([{ field: 'destination', message: 'destinos abertos: W' }])
    expect(institutions.get(1)).toMatchObject({ kind: 'L', endedAt: null })
    expect(keys.get(1)![0].active).toBe('S')
    expect(instUpdates).toEqual([]); expect(keyUpdates).toEqual([])
    expect(txConns).toHaveLength(0)
  })

  it('[RESISTIU] depois do ato a web escreve NA HORA (sem cache) e o interruptor em W recusa retomar: a chave de L encerrado nunca reativa', async () => {
    const before = await brandWrite()
    await end(1, { destination: 'W', reason: 'encerrando a transição' })
    const after = await brandWrite()
    expect([before.status, after.status]).toEqual([409, 201])
    const resume = await request(app).put(switchUrl(1)).set('Authorization', bearer(SUPER)).send({ active: 'S' })
    expect([resume.status, resume.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
    expect(keys.get(1)![0].active).toBe('N')
    const gen = await request(app).post('/api/institutions/1/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect([gen.status, gen.body.code]).toEqual([409, 'SYNC_KEY_NOT_FOR_SOURCE'])
  })

  it('[RESISTIU] irreversível: repetir o ato (W → W de novo) = 409 LEGACY_TRANSITION_NOT_APPLICABLE "já foi encerrada" (instante em fields[], não na prosa); W nativo = 409 "só vale para L"; nada gravado', async () => {
    await end(1, { destination: 'W', reason: 'primeira vez' })
    const again = await end(1, { destination: 'W', reason: 'segunda vez' })
    expect([again.status, again.body.code]).toEqual([409, 'LEGACY_TRANSITION_NOT_APPLICABLE'])
    expect(again.body.error).toMatch(/já foi encerrada/)
    expect(again.body.error).not.toMatch(/\d{4}-\d{2}-\d{2}T/)                                   // nenhum instante UTC na prosa (PADROES §10)
    expect(again.body.fields).toEqual([{ field: 'destination', message: 'origem atual: W' }, { field: 'transitionEndedAt', message: NOW.toISOString() }])
    const native = await end(2, { destination: 'W', reason: 'nativo web' })
    expect([native.status, native.body.code]).toEqual([409, 'LEGACY_TRANSITION_NOT_APPLICABLE'])
    expect(native.body.error).toMatch(/só vale para estabelecimento em transição/)
    expect(instUpdates).toEqual([['W', 1, 'primeira vez', 1]])
    expect(institutions.get(1)!.kind).toBe('W'); expect(institutions.get(2)!.kind).toBe('W')
  })

  it('[RESISTIU] falha ao criar a categoria padrão desfaz o ato INTEIRO: 500 com ref, o fato segue L, a chave segue S, a guarda segue travando', async () => {
    failOn = /INSERT INTO `\w+`\.tb_category/
    const r = await end(1, { destination: 'W', reason: 'schema sem tb_category' })
    expect([r.status, r.body.ref]).toEqual([500, 'REFADVSW'])
    expect(txConns.some(c => c.rollback.mock.calls.length > 0)).toBe(true)
    expect(txConns.every(c => c.commit.mock.calls.length === 0)).toBe(true)
    expect(institutions.get(1)).toMatchObject({ kind: 'L', endedAt: null })
    expect(keys.get(1)![0].active).toBe('S')
    expect((logger.info as jest.Mock).mock.calls.some(c => /ENCERRADA/.test(c[0]))).toBe(false)
    const w = await brandWrite()
    expect([w.status, w.body.code]).toEqual([409, 'CATALOG_LEGACY_OWNED'])
  })

  it('[RESISTIU] deadlock na 1ª tentativa (o ato cunha id de categoria): reexecuta INTEIRO — 200, uma "Serviços", uma chave inativada', async () => {
    deadlockOnce = true
    const r = await end(1, { destination: 'W', reason: 'com deadlock no meio' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ sourceKind: 'W', syncKeysInactivated: 1, defaultCategories: { P: null, S: 10 } })
    expect(cats.get(1)!.filter(c => c.kind === 'S')).toHaveLength(1)
    expect(instUpdates).toEqual([['W', 1, 'com deadlock no meio', 1]])                 // a 1ª tentativa foi desfeita
    expect(txConns.length).toBeGreaterThanOrEqual(2)
    expect(txConns[0].rollback).toHaveBeenCalled()
    expect(txConns[0].commit).not.toHaveBeenCalled()
    expect(txConns[txConns.length - 1].commit).toHaveBeenCalled()
  })

  it('[RESISTIU] a transação do ato: trava da institution 1º, o fato FOR UPDATE 2º, o UPDATE com `source_kind = L` NO COMANDO, e só depois chave e categorias', async () => {
    await end(1, { destination: 'W', reason: 'ordem das travas' })
    const tx = txConns.find(c => c.query.mock.calls.some((x: any[]) => /UPDATE setes_central\.tb_institution/.test(x[0])))!
    const calls = tx.query.mock.calls.map((x: any[]) => String(x[0]))
    expect(calls[0]).toMatch(/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    expect(calls[1]).toMatch(/transition_ended_at AS transitionEndedAt[\s\S]*FOR UPDATE/)
    expect(calls[2]).toMatch(/UPDATE setes_central\.tb_institution[\s\S]*WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/)
    expect(calls.findIndex((s: string) => /tb_sync_api_key/.test(s))).toBeGreaterThan(2)
    expect(calls.findIndex((s: string) => /tb_category/.test(s))).toBeGreaterThan(calls.findIndex((s: string) => /tb_sync_api_key/.test(s)))
  })

  it('[RESISTIU] Q-PR49 (a) segue: o lookup do serviço vai pelo FATO — antes do ato as P do legado (8, 9); depois SÓ a "Serviços" (10); nunca pela chave', async () => {
    const admin = bearer(SETES_ADMIN)
    const before = await request(app).get('/api/services/categories').set('Authorization', admin)
    await end(1, { destination: 'W', reason: 'lookup pelo fato' })
    const after = await request(app).get('/api/services/categories').set('Authorization', admin)
    expect(before.body.data.map((c: any) => c.id)).toEqual([8, 9])
    expect(after.body.data.map((c: any) => c.id)).toEqual([10])
    expect(q.mock.calls.filter(c => /tb_category/.test(c[0]) && /tb_sync_api_key/.test(c[0]))).toHaveLength(0)
  })
})
