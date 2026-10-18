/// <reference types="jest" />
// GATE ADVERSARIAL — delta da Rodada 6 do cadastro de produtos (2026-10-18; skill testar-adversarial.md; prompt_modulo_products.md
// "Rodada 6 — DECIDIDA"). Alvo: o `syncWriteGuard` em /services, /price-lists e /categories (D-PR41 revista), o interruptor
// `PUT /api/institutions/:id/sync-api-key/active` com a "Serviços" do ato e o 409 do religar (Q-PR47/Q-PR49), a 072 no onboarding e a
// trava da unidade-base (D-PR42). Pelo app REAL (auth RS256 de teste → feature flag → rate limit → router → guardas → controller →
// service → repository) com o banco num MODELO em memória e o serviço do módulo `services` MOCKADO (o que se prova é se a ESCRITA chega).
// `it('[RESISTIU] …')` = o ataque foi barrado / a promessa vale; `it.failing('[ACHADO SEVERIDADE] …')` = achado REPRODUZIDO — o corpo
// descreve o comportamento CERTO (falha hoje; quando o autor corrigir, vira `it`).
// As bordas da D-PR42 e o predicado do lookup do serviço foram provados com as funções REAIS num schema DESCARTÁVEL (script temporário
// do gate, apagado; resultado no relatório do gate) — aqui fica o que o app real com o modelo prova.
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVG6'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
// a cadeia fiscal do estabelecimento (getInstitution) não é o alvo — devolve um cadastro mínimo
jest.mock('../shared/entity', () => ({
  ...jest.requireActual('../shared/entity'),
  getEntityFiscalFull: jest.fn(async (id: number) => ({ id, nameCompany: 'CLIENTE NOVO' })),
}))
jest.mock('../modules/services/services.service', () => ({
  __esModule: true,
  SERVICE_SEARCH_CRITERIA: [],
  fetchServiceSearchCriteria: jest.fn().mockResolvedValue([]),
  fetchServices: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchService: jest.fn().mockResolvedValue({ id: 2 }),
  createService: jest.fn().mockResolvedValue(80), editService: jest.fn().mockResolvedValue(undefined),
  removeService: jest.fn().mockResolvedValue(undefined),
  fetchCategoriesLookup: jest.fn().mockResolvedValue([]),
  fetchFinancialPlansLookup: jest.fn().mockResolvedValue([]), fetchServiceTaxRulesLookup: jest.fn().mockResolvedValue([]),
  fetchPriceListsLookup: jest.fn().mockResolvedValue([]), fetchNbsLookup: jest.fn().mockResolvedValue([]),
  fetchIbscbsClassificationsLookup: jest.fn().mockResolvedValue([]), fetchIbscbsPlaceIndicatorsLookup: jest.fn().mockResolvedValue([]),
}))

import pool from '../shared/db/connection'
import * as services from '../modules/services/services.service'
import { allocateProductId } from '../shared/product-id'
import app from '../app'

const q = (pool as any).query as jest.Mock
const KEY = 'k'.repeat(48)

// ---- modelo do banco (só o que o delta toca) ----
const NOW = new Date(Date.UTC(2026, 9, 18, 12, 0, 0))
const HOUR = 3600_000
type Key = { active: 'S' | 'N'; deleted: 'S' | 'N'; updatedAt?: Date | null; createdAt?: Date | null }
type Cat = { id: number; kind: 'P' | 'S'; deleted: 'S' | 'N'; createdAt: Date }
type Born = { table: string; id: number; createdAt: Date }
let schemaOf: Map<number, string>
let keys: Map<number, Key[]>
let cats: Map<number, Cat[]>
let born: Map<number, Born[]>
let updates: any[][]
let failOn: RegExp | null
let txConns: any[]
let raceKeyOnInTx: boolean
let deadlockOnce: boolean

function rowsBorn(inst: number, table: string, since: Date | null): { id: number }[] {
  const fromCats = table === 'tb_category' ? (cats.get(inst) ?? []).filter(c => since == null || c.createdAt >= since).map(c => ({ id: c.id })) : []
  const fromBorn = (born.get(inst) ?? []).filter(r => r.table === table && (since == null || r.createdAt >= since)).map(r => ({ id: r.id }))
  return [...fromCats, ...fromBorn].sort((a, b) => a.id - b.id)
}

function db(sql: string, params: any[] = []): any {
  const s = String(sql)
  if (failOn && failOn.test(s)) {
    throw Object.assign(new Error("Table 'setes_x.tb_category' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
  }
  if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s)) return [schemaOf.has(Number(params[0])) ? [{ id: params[0] }] : []]
  if (/SELECT schema_name AS schemaName, active\s+FROM setes_central\.tb_institution/.test(s)) {
    const id = Number(params[0])
    return [schemaOf.has(id) ? [{ schemaName: schemaOf.get(id), active: 'S' }] : []]
  }
  if (/SELECT schema_name AS schemaName FROM setes_central\.tb_institution/.test(s)) {
    const id = Number(params[0])
    return [schemaOf.has(id) ? [{ schemaName: schemaOf.get(id) }] : []]
  }
  if (/FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
    return [(keys.get(Number(params[0])) ?? []).filter(k => k.deleted === 'N').map((k, i) => ({
      id: i + 1, active: k.active,
      createdAt: 'createdAt' in k ? k.createdAt : new Date(0),
      updatedAt: k.updatedAt ?? null,
    }))]
  }
  // re-check: deadlock na 1ª tentativa do ato (antes de qualquer escrita do modelo — o modelo não desfaz em rollback)
  if (deadlockOnce && /SELECT NOW\(\) AS now/.test(s)) {
    deadlockOnce = false
    throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
  }
  if (/SELECT NOW\(\) AS now/.test(s)) return [[{ now: NOW }]]
  if (/UPDATE setes_central\.tb_sync_api_key SET active/.test(s)) {
    updates.push(params)
    const [active, at, inst] = params
    const hit = (keys.get(Number(inst)) ?? []).filter(k => k.deleted === 'N' && k.active !== active)
    hit.forEach(k => { k.active = active; k.updatedAt = at ?? NOW })
    return [{ affectedRows: hit.length }]
  }
  // re-check: o super religou ENTRE a guarda (pool, sem trava) e a transação do escritor (reconferência travante)
  if (raceKeyOnInTx && /SELECT 1 FROM setes_central\.tb_sync_api_key[\s\S]*LOCK IN SHARE MODE/.test(s)) return [[{ 1: 1 }]]
  if (/SELECT 1 FROM setes_central\.tb_sync_api_key/.test(s)) {
    const any = (keys.get(Number(params[0])) ?? []).some(k => k.active === 'S' && k.deleted === 'N')
    return [any ? [{ 1: 1 }] : []]
  }
  if (/api_key AS apiKey/.test(s)) {
    const first = (keys.get(Number(params[0])) ?? []).find(k => k.deleted === 'N')
    return [first ? [{ apiKey: KEY, establishmentCode: 'X', active: first.active }] : []]
  }
  if (/MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_sync_api_key/.test(s)) return [[{ nextId: 1 }]]
  if (/INSERT INTO setes_central\.tb_sync_api_key/.test(s)) {
    const inst = Number(params[2])
    keys.set(inst, [...(keys.get(inst) ?? []), { active: 'S', deleted: 'N', createdAt: NOW, updatedAt: NOW }])
    return [{}]
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
    cats.set(Number(inst), [...(cats.get(Number(inst)) ?? []), { id: Number(id), kind, deleted: 'N', createdAt: at ?? NOW }])
    return [{}]
  }
  // @shared/sync-key webBornSince (religar) — e uma eventual conferência sem instante (1ª ligação)
  {
    const m = /SELECT COUNT\(\*\) AS n FROM `\w+`\.(tb_\w+) WHERE tb_institution_id = \?( AND created_at >= \?)?/.exec(s)
    if (m) return [[{ n: rowsBorn(Number(params[0]), m[1], m[2] ? params[1] as Date : null).length }]]
  }
  {
    const m = /SELECT id FROM `\w+`\.(tb_\w+) WHERE tb_institution_id = \?( AND created_at >= \?)?/.exec(s)
    if (m) return [rowsBorn(Number(params[0]), m[1], m[2] ? params[1] as Date : null).slice(0, 20)]
  }
  if (/^\s*SELECT/i.test(s)) return [[]]          // catálogo de campos configuráveis etc. — vazio
  throw new Error(`SQL inesperado: ${s.slice(0, 100)}`)
}
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
const bearer = (p: object) => `Bearer ${testToken(p)}`
const switchUrl = (id: number) => `/api/institutions/${id}/sync-api-key/active`
const turn = (id: number, active: 'S' | 'N') => request(app).put(switchUrl(id)).set('Authorization', bearer(SUPER)).send({ active })

beforeEach(() => {
  jest.clearAllMocks()
  schemaOf = new Map([[1, 'setes_setes'], [2, 'setes_x']])
  keys = new Map([[1, [{ active: 'S', deleted: 'N' }]]])
  // fato do dev (setes_setes, 2026-10-18): as 2 categorias vêm do LEGADO (ids 8 e 9 do gerador dele), ambas kind 'P'
  cats = new Map([[1, [{ id: 8, kind: 'P', deleted: 'N', createdAt: new Date(0) }, { id: 9, kind: 'P', deleted: 'N', createdAt: new Date(0) }]]])
  born = new Map()
  updates = []
  failOn = null
  txConns = []
  raceKeyOnInTx = false
  deadlockOnce = false
  routeDb()
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('D-PR41 revista — quem mais escreve nos cadastros que o legado alimenta', () => {
  it('[RESISTIU] cerca por varredura: só os 4 módulos guardados (e as peças deles) escrevem em tb_product/tb_price_list/tb_category/tb_price/tb_merchandise*/tb_service*; a "Serviços" do ato só pelo interruptor (super)', () => {
    const SRC = path.join(__dirname, '..')
    const T = '(tb_product|tb_price_list|tb_category|tb_price|tb_merchandise|tb_merchandise_trade_unit|tb_service|tb_service_ibscbs)'
    const direct = new RegExp('(INSERT\\s+(?:IGNORE\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+[^\\s(]*\\b' + T + '\\b', 'gi')
    const viaPlaceholder = /(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+\?\?/i
    const tableVar = new RegExp('\\.' + T + '[`\'"]', 'g')
    const writers: Record<string, string[]> = {}
    const walk = (dir: string): void => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f)
        if (fs.statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test-setup') walk(p); continue }
        if (!p.endsWith('.ts')) continue
        const c = fs.readFileSync(p, 'utf8')
        const hits = new Set<string>()
        let m: RegExpExecArray | null
        direct.lastIndex = 0
        while ((m = direct.exec(c))) hits.add(m[2].toLowerCase())
        if (viaPlaceholder.test(c)) { tableVar.lastIndex = 0; while ((m = tableVar.exec(c))) hits.add(m[1].toLowerCase()) }
        if (hits.size) writers[path.relative(SRC, p).split(path.sep).join('/')] = [...hits].sort()
      }
    }
    walk(SRC)
    expect(writers).toEqual({
      'modules/categories/categories.repository.ts':   ['tb_category'],
      'modules/merchandise/merchandise.repository.ts': ['tb_merchandise', 'tb_merchandise_trade_unit', 'tb_product'],
      'modules/price-lists/price-lists.repository.ts': ['tb_price_list'],
      'modules/services/services.repository.ts':       ['tb_product', 'tb_service', 'tb_service_ibscbs'],
      'shared/category-kind/index.ts':                 ['tb_category'],
      'shared/price/index.ts':                         ['tb_price'],
    })
    // quem chama as peças escritoras: @shared/price só pelos 2 cadastros guardados; ensureDefaultCategory só pelo interruptor
    const importers = (needle: RegExp) => Object.keys(writers).length && (() => {
      const found: string[] = []
      const scan = (dir: string): void => {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f)
          if (fs.statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test-setup') scan(p); continue }
          if (p.endsWith('.ts') && needle.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(SRC, p).split(path.sep).join('/'))
        }
      }
      scan(SRC)
      return found.sort()
    })()
    expect(importers(/\bsyncProductPrices\b/)).toEqual(['modules/merchandise/merchandise.repository.ts', 'modules/services/services.repository.ts', 'shared/price/index.ts'])
    expect(importers(/\bensureDefaultCategory\b/)).toEqual(['modules/institutions/institutions.repository.ts', 'shared/category-kind/index.ts'])
  })

  it.failing('[ACHADO HIGH] estabelecimento sincronizado (a Setes) grava a regra de ISS, a NBS e a classificação IBS/CBS do serviço do LEGADO — fatos que o legado NÃO envia (tb_service/tb_service_ibscbs só têm o PUT/POST de /api/services como escritor; no dev 11 dos 14 serviços do legado estão SEM linha em tb_service). Hoje: 409 SYNC_MANAGED_CATALOG — sem saída para o faturamento (serviço sem regra bloqueia) nem para a "liga" da IBS/CBS (D-IB98; batch-invoice de 01/2027 = 422 sem classificação — V2 da fase)', async () => {
    const body = {
      description: 'SUPORTE MENSAL', categoryId: 8,
      serviceTaxRuleId: 2, nbs: '115013000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' },
    }
    const r = await request(app).put('/api/services/2').set('Authorization', bearer(SETES_ADMIN)).send(body)
    expect(r.status).toBe(200)
    expect((services.editService as jest.Mock).mock.calls).toHaveLength(1)
    expect((services.editService as jest.Mock).mock.calls[0][1]).toMatchObject({ serviceTaxRuleId: 2, nbs: '115013000' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('Q-PR47 / Q-PR49 / Q-PR38\' — o ato, o onboarding e o id do gerador do legado', () => {
  it.failing('[ACHADO MEDIUM] religar com a "Serviços" que o PRÓPRIO ato criou no id seguinte ao maior do legado (8,9 → 10 = o próximo do gerador dele) passa CALADO — o legado a sobrescreve pela PK sem aviso, a mesma causa da Q-PR47 (o T−1 s a tira da conferência de propósito). O certo: 409 ou aviso na resposta (exige decisão do Valdo)', async () => {
    const off = await turn(1, 'N')
    expect(off.body.data.defaultServiceCategoryId).toBe(10)                     // MAX+1 = id que o gerador do legado vai alcançar
    const on = await turn(1, 'S')
    expect(on.status === 409 || typeof on.body?.data?.notice === 'string').toBe(true)
  })

  it.failing('[ACHADO MEDIUM] a 1ª LIGAÇÃO (POST /sync-api-key) num estabelecimento com linhas nascidas na web nas tabelas do legado passa calada — e todo cliente as tem: a 072 cria "Produtos"(1)/"Serviços"(2) no ONBOARDING (sempre "sem sincronizador": a chave só nasce depois do estabelecimento), nos ids que o gerador de categorias do legado emite primeiro. O certo: 409 ou aviso (mesma causa da Q-PR47; exige decisão)', async () => {
    cats.set(2, [{ id: 1, kind: 'P', deleted: 'N', createdAt: new Date(NOW.getTime() - 24 * HOUR) },
                 { id: 2, kind: 'S', deleted: 'N', createdAt: new Date(NOW.getTime() - 24 * HOUR) }])
    born.set(2, [{ table: 'tb_product', id: 1, createdAt: new Date(NOW.getTime() - 2 * HOUR) }])
    const r = await request(app).post('/api/institutions/2/sync-api-key').set('Authorization', bearer(SUPER)).send({})
    expect(r.status === 409 || typeof r.body?.data?.notice === 'string').toBe(true)
  })

  it('[RESISTIU] falha ao criar a "Serviços" (schema sem tb_category) DESFAZ o desligamento: 500 com ref, a chave segue S, nenhum UPDATE, a guarda segue travando', async () => {
    failOn = /INSERT INTO `\w+`\.tb_category/
    const r = await turn(1, 'N')
    expect([r.status, r.body.ref]).toEqual([500, 'REFADVG6'])
    expect(keys.get(1)![0].active).toBe('S')
    expect(updates).toHaveLength(0)
    expect(txConns.some(c => c.rollback.mock.calls.length > 0)).toBe(true)
    expect(txConns.every(c => c.commit.mock.calls.length === 0)).toBe(true)
    const w = await request(app).post('/api/services').set('Authorization', bearer(SETES_ADMIN)).send({ description: 'X', categoryId: 8 })
    expect([w.status, w.body.code]).toEqual([409, 'SYNC_MANAGED_CATALOG'])
  })

  it('[RESISTIU] falha ao conferir o que nasceu (religar) falha FECHADO: 500 com ref e a chave segue desligada', async () => {
    keys.set(1, [{ active: 'N', deleted: 'N', updatedAt: new Date(NOW.getTime() - HOUR) }])
    failOn = /COUNT\(\*\) AS n FROM `\w+`\.tb_price_list/
    const r = await turn(1, 'S')
    expect([r.status, r.body.ref]).toEqual([500, 'REFADVG6'])
    expect(keys.get(1)![0].active).toBe('N')
    expect(updates).toHaveLength(0)
  })

  it('[RESISTIU] duas chaves vivas com instantes diferentes: o religar confere desde o desligamento MAIS ANTIGO (falha fechado)', async () => {
    const t0 = new Date(NOW.getTime() - 48 * HOUR)
    keys.set(1, [{ active: 'N', deleted: 'N', updatedAt: t0 }, { active: 'S', deleted: 'N' }])
    const off = await turn(1, 'N')
    expect(off.status).toBe(200)
    expect(keys.get(1)!.map(k => k.updatedAt)).toEqual([t0, NOW])               // o 'N' antigo não é regravado
    born.set(1, [{ table: 'tb_product', id: 80, createdAt: new Date(NOW.getTime() - 24 * HOUR) }])
    const on = await turn(1, 'S')
    expect([on.status, on.body.code]).toEqual([409, 'SYNC_KEY_WEB_ROWS'])
    expect(on.body.error).toMatch(/1 produto\(s\)\/serviço\(s\) \(id 80\)/)
  })

  it('[RESISTIU] chave desligada sem updated_at NEM created_at: o instante é a época — qualquer linha da web (mesmo antiga) impede religar', async () => {
    keys.set(1, [{ active: 'N', deleted: 'N', updatedAt: null, createdAt: null }])
    born.set(1, [{ table: 'tb_price_list', id: 3, createdAt: new Date(Date.UTC(2020, 0, 1)) }])
    const on = await turn(1, 'S')
    expect([on.status, on.body.code]).toEqual([409, 'SYNC_KEY_WEB_ROWS'])
    expect(keys.get(1)![0].active).toBe('N')
  })

  it('[RESISTIU] religar não tropeça nas linhas do legado anteriores ao desligamento (8,9 da época) nem na "Serviços" do ato; o instante vem do BANCO (NOW), nunca do relógio do Node', async () => {
    const off = await turn(1, 'N')
    expect(updates[0][1]).toEqual(NOW)
    expect(cats.get(1)!.find(c => c.id === 10)!.createdAt).toEqual(new Date(NOW.getTime() - 1000))
    const on = await turn(1, 'S')
    expect([off.status, on.status]).toEqual([200, 200])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// RE-CHECK (correções pós-verdito, 2026-10-18): reconferência TRAVANTE da chave dentro da transação de quem cunha id no espaço do legado
// (`assertNoActiveSyncKey` depois de `lockInstitutionCounters`) e o ato com `withDeadlockRetry`.
describe('re-check — reconferência da chave na transação e retry do ato', () => {
  const txSql = () => txConns.flatMap(c => c.query.mock.calls.map((call: any[]) => String(call[0])))

  it('[RESISTIU] religado ENTRE a guarda e a transação: POST de categoria e de tabela de preço = 409 SYNC_MANAGED_CATALOG na reconferência — institution travada ANTES, nenhum MAX+1 nem INSERT, rollback', async () => {
    keys.set(1, [{ active: 'N', deleted: 'N', updatedAt: new Date(NOW.getTime() - HOUR) }])   // a guarda (pool) vê desligada
    raceKeyOnInTx = true                                                                          // a transação vê religada
    const auth = bearer(SETES_ADMIN)
    const cat = await request(app).post('/api/categories').set('Authorization', auth).send({ description: 'NOVA', kind: 'S' })
    const pl = await request(app).post('/api/price-lists').set('Authorization', auth).send({ description: 'VAREJO' })
    expect([cat.status, cat.body.code, pl.status, pl.body.code]).toEqual([409, 'SYNC_MANAGED_CATALOG', 409, 'SYNC_MANAGED_CATALOG'])
    const sql = txSql()
    for (const conn of txConns) {
      const calls = conn.query.mock.calls.map((c: any[]) => String(c[0]))
      const lockAt = calls.findIndex((s: string) => /FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s))
      const keyAt = calls.findIndex((s: string) => /tb_sync_api_key[\s\S]*LOCK IN SHARE MODE/.test(s))
      expect(lockAt).toBe(0)                                                                     // regra 7: a institution é a 1ª trava
      expect(keyAt).toBe(1)
      expect(conn.rollback).toHaveBeenCalled()
      expect(conn.commit).not.toHaveBeenCalled()
    }
    expect(txConns).toHaveLength(2)
    expect(sql.some(s => /MAX\(id\)|INSERT INTO/.test(s))).toBe(false)
  })

  it('[RESISTIU] allocateProductId: institution → reconferência (leitura TRAVANTE, não abre o snapshot antes do MAX) → MAX; chave ativa = 409 sem chegar ao MAX', async () => {
    const calls: string[] = []
    const fake = (keyActive: boolean) => ({
      query: jest.fn(async (sql: string) => {
        calls.push(String(sql))
        if (/tb_sync_api_key/.test(sql)) return [keyActive ? [{ 1: 1 }] : []]
        if (/MAX\(id\)/.test(sql)) return [[{ nextId: 81 }]]
        return [[{ id: 1 }]]
      }),
    }) as any
    await expect(allocateProductId(fake(true), 'setes_setes', 1)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_MANAGED_CATALOG' })
    expect(calls.some(s => /MAX\(id\)/.test(s))).toBe(false)
    calls.length = 0
    await expect(allocateProductId(fake(false), 'setes_setes', 1)).resolves.toBe(81)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    expect(calls[1]).toMatch(/LOCK IN SHARE MODE/)                                              // locking read: o snapshot nasce no MAX
    expect(calls[2]).toMatch(/MAX\(id\)/)
    expect(calls[2]).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)                               // o MAX segue sem next-key lock (D-PR2)
  })

  it('[RESISTIU] desligar com deadlock na 1ª tentativa: o ato reexecuta INTEIRO e grava UMA vez — uma "Serviços", um UPDATE, 200', async () => {
    deadlockOnce = true
    const r = await turn(1, 'N')
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ active: 'N', defaultServiceCategoryId: 10 })
    expect(updates).toHaveLength(1)
    expect(cats.get(1)!.filter(c => c.kind === 'S')).toHaveLength(1)
    expect(txConns.length).toBeGreaterThanOrEqual(2)
    expect(txConns[0].rollback).toHaveBeenCalled()
    expect(txConns[0].commit).not.toHaveBeenCalled()
  })
})
