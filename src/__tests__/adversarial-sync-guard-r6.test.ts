/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 6 do cadastro de produtos (2026-10-18; skill testar-adversarial.md; prompt_modulo_products.md "Rodada 6").
// Alvo: D-PR41 revista — o `syncWriteGuard` agora também em `/api/services`, `/api/price-lists` e `/api/categories` — pelo app REAL
// (auth RS256 de teste → feature flag → rate limit → router → guarda → controller), com os SERVIÇOS dos três módulos MOCKADOS (o que se
// prova é se a ESCRITA chega) e o banco num modelo mínimo (estado das chaves). `it('[RESISTIU] …')` = o ataque foi barrado / a promessa
// vale; `it('[ACHADO …]')` = fixa o comportamento observado que vira questão para o dono.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR6'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../modules/services/services.service', () => ({
  __esModule: true,
  SERVICE_SEARCH_CRITERIA: [],
  fetchServiceSearchCriteria: jest.fn().mockResolvedValue([]),
  fetchServices: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchService: jest.fn().mockResolvedValue({ id: 5 }),
  createService: jest.fn().mockResolvedValue(80), editService: jest.fn().mockResolvedValue(undefined),
  removeService: jest.fn().mockResolvedValue(undefined),
  fetchCategoriesLookup: jest.fn().mockResolvedValue([{ id: 8, description: 'GERAL', name: 'GERAL' }]),
  fetchFinancialPlansLookup: jest.fn().mockResolvedValue([]), fetchServiceTaxRulesLookup: jest.fn().mockResolvedValue([]),
  fetchPriceListsLookup: jest.fn().mockResolvedValue([]), fetchNbsLookup: jest.fn().mockResolvedValue([]),
  fetchIbscbsClassificationsLookup: jest.fn().mockResolvedValue([]), fetchIbscbsPlaceIndicatorsLookup: jest.fn().mockResolvedValue([]),
}))
jest.mock('../modules/price-lists/price-lists.service', () => ({
  __esModule: true,
  PRICE_LIST_SEARCH_CRITERIA: [],
  fetchPriceListSearchCriteria: jest.fn().mockResolvedValue([]),
  fetchPriceLists: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchPriceList: jest.fn().mockResolvedValue({ id: 1 }),
  createPriceList: jest.fn().mockResolvedValue(5), editPriceList: jest.fn().mockResolvedValue(undefined),
  removePriceList: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../modules/categories/categories.service', () => ({
  __esModule: true,
  fetchCategories: jest.fn().mockResolvedValue([]), fetchCategory: jest.fn().mockResolvedValue({ id: 8 }),
  createCategory: jest.fn().mockResolvedValue(12), editCategory: jest.fn().mockResolvedValue(undefined),
  removeCategory: jest.fn().mockResolvedValue(undefined), resolveMovedPath: jest.fn(),
}))

import pool from '../shared/db/connection'
import * as services from '../modules/services/services.service'
import * as priceLists from '../modules/price-lists/price-lists.service'
import * as categories from '../modules/categories/categories.service'
import app from '../app'

const q = (pool as any).query as jest.Mock
let synced: Set<number>
let syncQueries: number
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = String(sql)
    if (/setes_central\.tb_sync_api_key/.test(s)) { syncQueries++; return [synced.has(Number(params[0])) ? [{ 1: 1 }] : []] }
    if (/^\s*SELECT/i.test(s)) return [[]]                         // catálogo de campos configuráveis etc. — vazio
    throw new Error(`SQL inesperado: ${s.slice(0, 90)}`)
  })
}

const SETES_ADMIN = { institutionId: 1, userId: 1, role: 'admin', schemaName: 'setes_setes' }
const SETES_SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const OTHER_ADMIN = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const bearer = (p: object) => `Bearer ${testToken(p)}`
const WRITES = [
  [services, 'createService'], [services, 'editService'], [services, 'removeService'],
  [priceLists, 'createPriceList'], [priceLists, 'editPriceList'], [priceLists, 'removePriceList'],
  [categories, 'createCategory'], [categories, 'editCategory'], [categories, 'removeCategory'],
] as const
const reached = () => WRITES.filter(([m, f]) => ((m as any)[f] as jest.Mock).mock.calls.length > 0).map(([, f]) => f)
const service = { description: 'Suporte', categoryId: 8 }
const priceList = { description: 'VAREJO' }
const category = { description: 'Serviços', kind: 'S' }

const allWrites = (auth: string) => Promise.all([
  request(app).post('/api/services').set('Authorization', auth).send(service),
  request(app).put('/api/services/5').set('Authorization', auth).send(service),
  request(app).delete('/api/services/5').set('Authorization', auth),
  request(app).post('/api/price-lists').set('Authorization', auth).send(priceList),
  request(app).put('/api/price-lists/1').set('Authorization', auth).send(priceList),
  request(app).delete('/api/price-lists/1').set('Authorization', auth),
  request(app).post('/api/categories').set('Authorization', auth).send(category),
  request(app).put('/api/categories/8').set('Authorization', auth).send({ description: 'X' }),
  request(app).delete('/api/categories/8').set('Authorization', auth),
])

beforeEach(() => {
  jest.clearAllMocks()
  synced = new Set([1]); syncQueries = 0
  routeDb()
})

describe('D-PR41 revista — estabelecimento com sincronizador ativo só CONSULTA serviços, tabelas de preço e categorias', () => {
  it('[RESISTIU] as 9 escritas dos três cadastros = 409 SYNC_MANAGED_CATALOG — admin E super (o problema é o 2º escritor, não o perfil)', async () => {
    for (const who of [SETES_ADMIN, SETES_SUPER]) {
      const res = await allWrites(bearer(who))
      expect(res.map(r => [r.status, r.body.code])).toEqual(Array(9).fill([409, 'SYNC_MANAGED_CATALOG']))
    }
    expect(reached()).toEqual([])
  })

  it('[RESISTIU] forma da URL (caixa, barra final, barra dupla) não contorna a guarda', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).post('/api/SERVICES').set('Authorization', auth).send(service),
      request(app).post('/api/services/').set('Authorization', auth).send(service),
      request(app).post('/api//price-lists').set('Authorization', auth).send(priceList),
      request(app).put('/api/Price-Lists/1').set('Authorization', auth).send(priceList),
      request(app).post('/api/categories/').set('Authorization', auth).send(category),
      request(app).delete('/api/CATEGORIES/8').set('Authorization', auth),
    ])
    for (const r of res) expect([404, 409]).toContain(r.status)
    expect(reached()).toEqual([])
  })

  it('[RESISTIU] método fora do CRUD (PATCH, override por cabeçalho) não escreve', async () => {
    const auth = bearer(SETES_SUPER)
    const res = await Promise.all([
      request(app).patch('/api/services/5').set('Authorization', auth).send(service),
      request(app).post('/api/price-lists/1').set('Authorization', auth).set('X-HTTP-Method-Override', 'PUT').send(priceList),
      request(app).post('/api/categories/8').set('Authorization', auth).set('X-HTTP-Method-Override', 'DELETE'),
    ])
    for (const r of res) expect([404, 409]).toContain(r.status)
    expect(reached()).toEqual([])
  })

  it('[RESISTIU] a CONSULTA segue aberta com a chave ativa (lista, ficha, lookups) — e sem consultar a chave', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).get('/api/services').set('Authorization', auth),
      request(app).get('/api/services/5').set('Authorization', auth),
      request(app).get('/api/services/categories').set('Authorization', auth),
      request(app).get('/api/price-lists').set('Authorization', auth),
      request(app).get('/api/price-lists/search-criteria').set('Authorization', auth),
      request(app).get('/api/categories?kind=S').set('Authorization', auth),
    ])
    expect(res.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(syncQueries).toBe(0)
  })

  it('[RESISTIU] a chave é a do estabelecimento do JWT: o ativo do 1 não trava o 2 (e o id na URL não muda isso)', async () => {
    const res = await allWrites(bearer(OTHER_ADMIN))
    expect(res.map(r => r.status)).toEqual([201, 200, 200, 201, 200, 200, 201, 200, 200])
    expect(reached()).toHaveLength(9)
    const scopes = ((services.createService as jest.Mock).mock.calls[0][1])
    expect(scopes).toMatchObject({ institutionId: 2, schemaName: 'setes_x' })
  })

  it('[RESISTIU] desligada a chave do 1, as escritas passam NA HORA (sem cache)', async () => {
    const auth = bearer(SETES_ADMIN)
    const before = await request(app).post('/api/categories').set('Authorization', auth).send(category)
    synced.delete(1)
    const after = await request(app).post('/api/categories').set('Authorization', auth).send(category)
    expect([before.status, after.status]).toEqual([409, 201])
    expect((categories.createCategory as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('[RESISTIU] erro do banco ao ler a chave NUNCA libera a escrita (500 com ref, sem chegar ao serviço)', async () => {
    q.mockImplementation(async (sql: string) => {
      if (/setes_central\.tb_sync_api_key/.test(String(sql))) throw new Error('pool esgotado')
      return [[]]
    })
    const res = await request(app).post('/api/price-lists').set('Authorization', bearer(SETES_ADMIN)).send(priceList)
    expect(res.status).toBe(500)
    expect(reached()).toEqual([])
  })
})
