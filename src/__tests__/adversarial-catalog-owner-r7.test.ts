/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 7 do cadastro de produtos (2026-10-20; skill testar-adversarial.md; prompt_modulo_products.md "Rodada 7"),
// revisto pelas D-OI10/D-PR70/D-PR77 (Rodadas 10 e 11, 2026-11-22): a guarda do dono do catálogo SAIU (D-PR77 — "decidi retirar a
// guarda"): com origem D (o ERP Desktop é dono do catálogo — era L) a web ESCREVE nos 6 cadastros que o ERP Desktop alimenta; o app só
// orienta pelo bloco `context` da sessão. A letra P não existe mais (D-OI10). O que fica provado aqui: a escrita CHEGA ao serviço do
// módulo em D e em W, nenhuma camada do roteador lê o fato `tb_institution.source_kind` nem a chave para decidir, e as rotas próprias
// (D-PR45: enquadramento fiscal do serviço; canal API da conta bancária) seguem com o privilégio delas —
// pelo app REAL (auth RS256 de teste → feature flag → rate limit → router → privilégio → controller), com os SERVIÇOS dos
// módulos MOCKADOS (o que se prova é se a ESCRITA chega) e o banco num modelo mínimo (o fato por institution + privilégios).
// `it('[RESISTIU] …')` = a promessa vale. Substitui `adversarial-sync-guard-r6.test.ts`.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR7'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
  editServiceTaxRule: jest.fn().mockResolvedValue(undefined), editServiceIbscbs: jest.fn().mockResolvedValue(undefined),
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
jest.mock('../modules/financial-plans/financial-plans.service', () => ({
  __esModule: true,
  fetchFinancialPlans: jest.fn().mockResolvedValue([]), fetchFinancialPlan: jest.fn().mockResolvedValue({ id: 3 }),
  createFinancialPlan: jest.fn().mockResolvedValue(13), editFinancialPlan: jest.fn().mockResolvedValue(undefined),
  removeFinancialPlan: jest.fn().mockResolvedValue(undefined), resolveMovedPath: jest.fn(),
}))
jest.mock('../modules/bank-accounts/bank-accounts.service', () => ({
  __esModule: true,
  BANK_ACCOUNT_SEARCH_CRITERIA: [],
  fetchBankAccountSearchCriteria: jest.fn().mockResolvedValue([]),
  fetchBankAccounts: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchBankAccount: jest.fn().mockResolvedValue({ id: 5 }),
  createBankAccount: jest.fn().mockResolvedValue(6), editBankAccount: jest.fn().mockResolvedValue(undefined),
  removeBankAccount: jest.fn().mockResolvedValue(undefined), fetchBanksLookup: jest.fn().mockResolvedValue([]),
}))
// o canal API da conta (Inter) não é o alvo: cada handler só prova que foi ALCANÇADO
jest.mock('../modules/bank-accounts/bank-accounts.channel.controller', () => {
  const reached = (name: string) => jest.fn(async (_req: any, res: any) => res.json({ ok: true, reached: name }))
  return {
    __esModule: true,
    getChannel: reached('getChannel'), putChannel: reached('putChannel'), deleteChannel: reached('deleteChannel'),
    rotateToken: reached('rotateToken'), putSecrets: reached('putSecrets'), deleteSecrets: reached('deleteSecrets'),
    test: reached('test'), getWebhook: reached('getWebhook'), putWebhook: reached('putWebhook'), deleteWebhook: reached('deleteWebhook'),
  }
})

import pool from '../shared/db/connection'
import * as services from '../modules/services/services.service'
import * as priceLists from '../modules/price-lists/price-lists.service'
import * as categories from '../modules/categories/categories.service'
import * as financialPlans from '../modules/financial-plans/financial-plans.service'
import * as bankAccounts from '../modules/bank-accounts/bank-accounts.service'
import * as channel from '../modules/bank-accounts/bank-accounts.channel.controller'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { ErrorCodes } from '../shared/errors/error-codes'
import app from '../app'

const q = (pool as any).query as jest.Mock
const SERVICES_IFACE = 34
let facts: Map<number, string>                  // o fato gravado por institution ('W' | 'D'; letra antiga só para provar que é ilegível)
let factQueries: number
let contracted: Set<number>
let privileged: Set<string>                     // `${userId}:${interfaceId}:${privilegeId}`
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = String(sql)
    if (/SELECT source_kind AS kind FROM setes_central\.tb_institution/.test(s)) {
      factQueries++
      const k = facts.get(Number(params[0]))
      return [k ? [{ kind: k }] : []]
    }
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(s)) return [String(params[0]) === 'services' ? [{ id: SERVICES_IFACE }] : []]
    if (/tb_institution_has_interface/.test(s)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(s)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    if (/tb_sync_api_key/.test(s)) throw new Error('nenhuma camada da escrita do catálogo consulta a chave (D-PR47/D-PR77)')
    if (/^\s*SELECT/i.test(s)) return [[]]                         // catálogo de campos configuráveis etc. — vazio
    throw new Error(`SQL inesperado: ${s.slice(0, 90)}`)
  })
}

const SETES_ADMIN = { institutionId: 1, userId: 1, role: 'admin', schemaName: 'setes_setes' }
const SETES_SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const SETES_USER  = { institutionId: 1, userId: 5, role: 'user', schemaName: 'setes_setes' }
const OTHER_ADMIN = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const bearer = (p: object) => `Bearer ${testToken(p)}`
const WRITES = [
  [services, 'createService'], [services, 'editService'], [services, 'removeService'],
  [priceLists, 'createPriceList'], [priceLists, 'editPriceList'], [priceLists, 'removePriceList'],
  [categories, 'createCategory'], [categories, 'editCategory'], [categories, 'removeCategory'],
  [financialPlans, 'createFinancialPlan'], [financialPlans, 'editFinancialPlan'], [financialPlans, 'removeFinancialPlan'],
  [bankAccounts, 'createBankAccount'], [bankAccounts, 'editBankAccount'], [bankAccounts, 'removeBankAccount'],
] as const
const reached = () => WRITES.filter(([m, f]) => ((m as any)[f] as jest.Mock).mock.calls.length > 0).map(([, f]) => f)
const ALL_REACHED = WRITES.map(([, f]) => f)
const WRITE_STATUSES = [201, 200, 200, 201, 200, 200, 201, 200, 200, 201, 200, 200, 201, 200, 200]
const service = { description: 'Suporte', categoryId: 8 }
const priceList = { description: 'VAREJO' }
const category = { description: 'Serviços', kind: 'S' }
const plan = { description: 'Receitas', kind: 'R' }
const account = { description: 'Conta', bankId: 1, agency: '1', number: '1' }

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
  request(app).post('/api/financial-plans').set('Authorization', auth).send(plan),
  request(app).put('/api/financial-plans/3').set('Authorization', auth).send({ description: 'Y' }),
  request(app).delete('/api/financial-plans/3').set('Authorization', auth),
  request(app).post('/api/bank-accounts').set('Authorization', auth).send(account),
  request(app).put('/api/bank-accounts/5').set('Authorization', auth).send(account),
  request(app).delete('/api/bank-accounts/5').set('Authorization', auth),
])

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  facts = new Map([[1, 'D'], [2, 'W']]); factQueries = 0
  contracted = new Set([SERVICES_IFACE]); privileged = new Set()
  routeDb()
})

describe('D-PR77 — SEM guarda: com origem D (ERP Desktop dono do catálogo) a web ESCREVE nos 6 cadastros que o ERP Desktop alimenta', () => {
  it('[RESISTIU] a guarda saiu de verdade: o arquivo catalog-owner.guard não existe e os códigos CATALOG_LEGACY_OWNED/CATALOG_DESKTOP_OWNED não existem', () => {
    expect(() => require.resolve('../gateway/catalog-owner.guard')).toThrow()
    expect(ErrorCodes).not.toHaveProperty('CATALOG_LEGACY_OWNED')
    expect(ErrorCodes).not.toHaveProperty('CATALOG_DESKTOP_OWNED')
  })

  it('[RESISTIU] as 15 escritas dos cinco cadastros PASSAM em D — admin E super; todas chegam ao serviço; nenhuma camada lê o fato nem a chave', async () => {
    for (const who of [SETES_ADMIN, SETES_SUPER]) {
      jest.clearAllMocks()
      const res = await allWrites(bearer(who))
      expect(res.map(r => r.status)).toEqual(WRITE_STATUSES)
      expect(res.some(r => /^CATALOG_/.test(String(r.body.code ?? '')))).toBe(false)
      expect(reached()).toEqual(ALL_REACHED)
      expect((services.createService as jest.Mock).mock.calls[0][1]).toMatchObject({ institutionId: 1, schemaName: 'setes_setes' })
    }
    expect(factQueries).toBe(0)
  })

  it('[RESISTIU] forma da URL (caixa, barra final, barra dupla) chega ao MESMO handler — nenhum 409 do dono do catálogo, nenhuma camada lê o fato', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).post('/api/SERVICES').set('Authorization', auth).send(service),
      request(app).post('/api/services/').set('Authorization', auth).send(service),
      request(app).post('/api//price-lists').set('Authorization', auth).send(priceList),
      request(app).put('/api/Price-Lists/1').set('Authorization', auth).send(priceList),
      request(app).post('/api/categories/').set('Authorization', auth).send(category),
      request(app).delete('/api/CATEGORIES/8').set('Authorization', auth),
      request(app).post('/api/Financial-Plans/').set('Authorization', auth).send(plan),
      request(app).put('/api/BANK-ACCOUNTS/5').set('Authorization', auth).send(account),
    ])
    expect(res.map(r => r.status)).toEqual([201, 201, 201, 200, 201, 200, 201, 200])
    expect(res.some(r => r.status === 409)).toBe(false)
    expect(reached()).toEqual(['createService', 'createPriceList', 'editPriceList', 'createCategory', 'removeCategory', 'createFinancialPlan', 'editBankAccount'])
    expect(factQueries).toBe(0)
  })

  it('[RESISTIU] método fora do CRUD (PATCH, override por cabeçalho) não escreve — 404, sem guarda para dizer outra coisa', async () => {
    const auth = bearer(SETES_SUPER)
    const res = await Promise.all([
      request(app).patch('/api/services/5').set('Authorization', auth).send(service),
      request(app).post('/api/price-lists/1').set('Authorization', auth).set('X-HTTP-Method-Override', 'PUT').send(priceList),
      request(app).post('/api/categories/8').set('Authorization', auth).set('X-HTTP-Method-Override', 'DELETE'),
      request(app).patch('/api/bank-accounts/5').set('Authorization', auth).send(account),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404])
    expect(reached()).toEqual([])
  })

  it('[RESISTIU] a CONSULTA segue aberta em D (lista, ficha, lookups) — e sem consultar o fato nem a chave', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).get('/api/services').set('Authorization', auth),
      request(app).get('/api/services/5').set('Authorization', auth),
      request(app).get('/api/services/categories').set('Authorization', auth),
      request(app).get('/api/price-lists').set('Authorization', auth),
      request(app).get('/api/price-lists/search-criteria').set('Authorization', auth),
      request(app).get('/api/categories?kind=S').set('Authorization', auth),
      request(app).get('/api/financial-plans').set('Authorization', auth),
      request(app).get('/api/bank-accounts').set('Authorization', auth),
      request(app).get('/api/bank-accounts/banks').set('Authorization', auth),
    ])
    expect(res.map(r => r.status)).toEqual(Array(9).fill(200))
    expect(factQueries).toBe(0)
  })

  it('[RESISTIU] W (nativo web) e D escrevem igual: o fato não muda a resposta; cada escrita vai ao estabelecimento do JWT', async () => {
    for (const who of [OTHER_ADMIN, SETES_ADMIN]) {
      jest.clearAllMocks()
      const res = await allWrites(bearer(who))
      expect(res.map(r => r.status)).toEqual(WRITE_STATUSES)
      expect(reached()).toHaveLength(15)
      expect((services.createService as jest.Mock).mock.calls[0][1]).toMatchObject({ institutionId: who.institutionId, schemaName: who.schemaName })
    }
  })

  it('[RESISTIU] trocar o fato D → W no banco não muda nada na escrita do catálogo (passa antes e depois)', async () => {
    const auth = bearer(SETES_ADMIN)
    const before = await request(app).post('/api/categories').set('Authorization', auth).send(category)
    facts.set(1, 'W')
    const after = await request(app).post('/api/categories').set('Authorization', auth).send(category)
    expect([before.status, after.status]).toEqual([201, 201])
    expect((categories.createCategory as jest.Mock).mock.calls).toHaveLength(2)
  })

  it("[RESISTIU] nenhuma camada do roteador depende do fato: erro do banco ao lê-lo, institution sem linha ou letra antiga ('L'/'P', ilegível desde a D-OI10) — a escrita passa igual", async () => {
    q.mockImplementation(async (sql: string) => {
      if (/SELECT source_kind AS kind/.test(String(sql))) throw new Error('pool esgotado')
      return [[]]
    })
    const r = await request(app).post('/api/price-lists').set('Authorization', bearer(SETES_ADMIN)).send(priceList)
    expect(r.status).toBe(201)
    routeDb()
    for (const gone of [null, 'L', 'P']) {
      if (gone === null) facts.delete(1); else facts.set(1, gone)
      const w = await request(app).post('/api/price-lists').set('Authorization', bearer(SETES_ADMIN)).send(priceList)
      expect([String(gone), w.status]).toEqual([String(gone), 201])
    }
    expect((priceLists.createPriceList as jest.Mock).mock.calls).toHaveLength(4)
    expect(factQueries).toBe(0)
  })
})

describe('D-PR45 — o ENQUADRAMENTO FISCAL do serviço é da web em qualquer origem (rota própria, privilégio ALTERAR)', () => {
  const taxRule = { serviceTaxRuleId: 2 }
  const ibscbs = { nbs: '115013000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' } }

  it('[RESISTIU] a Setes (D) vincula a regra de ISS e classifica o serviço pelas rotas próprias; o PUT do cadastro também passa (D-PR77)', async () => {
    const auth = bearer(SETES_ADMIN)
    const [tr, ib, put] = await Promise.all([
      request(app).put('/api/services/2/tax-rule').set('Authorization', auth).send(taxRule),
      request(app).put('/api/services/2/ibscbs').set('Authorization', auth).send(ibscbs),
      request(app).put('/api/services/2').set('Authorization', auth).send({ ...service, ...taxRule }),
    ])
    expect([tr.status, ib.status, put.status]).toEqual([200, 200, 200])
    expect((services.editServiceTaxRule as jest.Mock).mock.calls[0].slice(0, 2)).toEqual([2, 2])
    expect((services.editServiceIbscbs as jest.Mock).mock.calls[0][1]).toEqual(ibscbs)
    expect((services.editService as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('[RESISTIU] só PUT vive na rota própria: POST/DELETE/PATCH/GET nas mesmas URLs caem no roteador do cadastro e não acham rota (404)', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).post('/api/services/2/tax-rule').set('Authorization', auth).send(taxRule),
      request(app).delete('/api/services/2/ibscbs').set('Authorization', auth),
      request(app).patch('/api/services/2/tax-rule').set('Authorization', auth).send(taxRule),
      request(app).get('/api/services/2/tax-rule').set('Authorization', auth),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404, 404])
    expect((services.editServiceTaxRule as jest.Mock).mock.calls).toHaveLength(0)
    expect(reached()).toEqual([])
  })

  it('[RESISTIU] privilégio ALTERAR em services: usuário sem o vínculo = 403 PRIVILEGE_REQUIRED; com ele grava; interface não contratada = 403 INTERFACE_NOT_ALLOWED (também para o admin — D-F37)', async () => {
    const denied = await request(app).put('/api/services/2/tax-rule').set('Authorization', bearer(SETES_USER)).send(taxRule)
    expect([denied.status, denied.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    privileged.add(`${SETES_USER.userId}:${SERVICES_IFACE}:2`)
    const ok = await request(app).put('/api/services/2/tax-rule').set('Authorization', bearer(SETES_USER)).send(taxRule)
    expect(ok.status).toBe(200)
    contracted = new Set(); resetPrivilegeCache()
    const noIface = await request(app).put('/api/services/2/ibscbs').set('Authorization', bearer(SETES_ADMIN)).send(ibscbs)
    expect([noIface.status, noIface.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect((services.editServiceTaxRule as jest.Mock).mock.calls).toHaveLength(1)
    expect((services.editServiceIbscbs as jest.Mock).mock.calls).toHaveLength(0)
  })

  it('[RESISTIU] bordas do corpo: nbs/ibscbs ausentes = 400 (nada a gravar); regra não inteira = 400; regra null = "sem regra" passa', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).put('/api/services/2/ibscbs').set('Authorization', auth).send({}),
      request(app).put('/api/services/2/ibscbs').set('Authorization', auth).send({ nbs: '12' }),
      request(app).put('/api/services/2/tax-rule').set('Authorization', auth).send({ serviceTaxRuleId: '2' }),
      request(app).put('/api/services/2/tax-rule').set('Authorization', auth).send({}),
      request(app).put('/api/services/2/tax-rule').set('Authorization', auth).send({ serviceTaxRuleId: null }),
      request(app).put('/api/services/abc/tax-rule').set('Authorization', auth).send(taxRule),
    ])
    expect(res.map(r => r.status)).toEqual([400, 400, 400, 400, 200, 400])
    expect((services.editServiceTaxRule as jest.Mock).mock.calls.map(c => c[1])).toEqual([null])
  })
})

describe('D-PR51 — o CANAL API da conta bancária (fato só da web) tem roteador próprio; o cadastro da conta também escreve em D (D-PR77)', () => {
  it('[RESISTIU] em D o admin opera o canal (GET/PUT/DELETE, segredos, token, teste, webhook) E edita a conta', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).get('/api/bank-accounts/5/channel').set('Authorization', auth),
      request(app).put('/api/bank-accounts/5/channel').set('Authorization', auth).send({}),
      request(app).put('/api/bank-accounts/5/channel/secrets').set('Authorization', auth).send({}),
      request(app).post('/api/bank-accounts/5/channel/rotate-token').set('Authorization', auth),
      request(app).post('/api/bank-accounts/5/channel/test').set('Authorization', auth),
      request(app).put('/api/bank-accounts/5/channel/webhook').set('Authorization', auth).send({}),
      request(app).delete('/api/bank-accounts/5/channel').set('Authorization', auth),
      request(app).put('/api/bank-accounts/5').set('Authorization', auth).send(account),
    ])
    expect(res.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200])
    expect(res.slice(0, 7).map(r => r.body.reached)).toEqual(['getChannel', 'putChannel', 'putSecrets', 'rotateToken', 'test', 'putWebhook', 'deleteChannel'])
    expect((bankAccounts.editBankAccount as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('[RESISTIU] o canal segue só do admin (adminGuard próprio): usuário regular em D = 403 antes de qualquer coisa', async () => {
    const r = await request(app).put('/api/bank-accounts/5/channel').set('Authorization', bearer(SETES_USER)).send({})
    expect(r.status).toBe(403)
    expect((channel.putChannel as jest.Mock).mock.calls).toHaveLength(0)
  })
})
