/// <reference types="jest" />
// GATE ADVERSARIAL r3 — delta D-PR32/D-PR33/D-PR40 do cadastro de produtos (2026-10-18; skill testar-adversarial.md).
// Rodada 7 (2026-10-20, D-PR47): a guarda passou a ler o FATO `tb_institution.source_kind`. Rodadas 10 e 11 (2026-11-22 — D-OI10,
// D-PR70, D-PR77): o fato só tem W e D (D = o ERP Desktop é dono do catálogo; era L) e a guarda `catalogOwnerGuard` SAIU — com origem
// D a escrita do /api/merchandise PASSA (o app só orienta; o risco de colisão de id foi aceito). O código CATALOG_LEGACY_OWNED não existe.
// Alvo deste arquivo: que nenhuma camada do roteador intercepta a escrita do /api/merchandise (D-PR77) e D-PR33 (CATALOGAR nas
// criações da central — a barreira que FICA), pelo app REAL (auth RS256 de teste → feature flag → rate limit → router), com o serviço do
// módulo MOCKADO (o que se prova é se a ESCRITA chega).
// `it('[RESISTIU] …')` = a promessa vale.
import net from 'net'
import { AddressInfo } from 'net'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVM3'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../modules/merchandise/merchandise.service', () => {
  const ok = () => jest.fn().mockResolvedValue(undefined)
  return {
    __esModule: true,
    MERCHANDISE_SEARCH_CRITERIA: [],
    fetchMerchandiseSearchCriteria: jest.fn().mockResolvedValue([]),
    fetchMerchandiseList: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    fetchMerchandise: jest.fn().mockResolvedValue({ id: 5 }),
    createMerchandise: jest.fn().mockResolvedValue(77),
    editMerchandise: ok(), removeMerchandise: ok(),
    fetchTradeUnits: jest.fn().mockResolvedValue({ levels: [] }), putTradeUnits: ok(),
    fetchLinks: jest.fn().mockResolvedValue({ tradeUnits: 0, taxRules: 0 }),
    fetchCategoriesLookup: jest.fn().mockResolvedValue([]), fetchFinancialPlansLookup: jest.fn().mockResolvedValue([]),
    fetchPriceListsLookup: jest.fn().mockResolvedValue([]), fetchBrandsLookup: jest.fn().mockResolvedValue([]),
    fetchMeasuresLookup: jest.fn().mockResolvedValue([]), fetchPackagesLookup: jest.fn().mockResolvedValue([]),
    createBrand: jest.fn().mockResolvedValue({ id: 900, reused: false }),
    createMeasure: jest.fn().mockResolvedValue({ id: 901, reused: false }),
    createPackage: jest.fn().mockResolvedValue({ id: 902, reused: false }),
  }
})

import pool from '../shared/db/connection'
import * as service from '../modules/merchandise/merchandise.service'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const q = (pool as any).query as jest.Mock
const MERCH_IFACE = 40, SERVICES_IFACE = 34
let desktop: Set<number>                       // institutions cujo catálogo é do ERP Desktop (source_kind D — era L)
let contracted: Set<number>
let privileged: Set<string>                     // `${userId}:${interfaceId}:${privilegeId}`
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/SELECT source_kind AS kind FROM setes_central\.tb_institution/.test(sql)) return [[{ kind: desktop.has(Number(params[0])) ? 'D' : 'W' }]]
    if (/tb_sync_api_key/.test(sql)) throw new Error('nenhuma camada da escrita do catálogo consulta a chave (D-PR47/D-PR77)')
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) {
      const id = ({ merchandise: MERCH_IFACE, services: SERVICES_IFACE } as Record<string, number>)[String(params[0])]
      return [id ? [{ id }] : []]
    }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    throw new Error(`SQL inesperado: ${String(sql).slice(0, 90)}`)
  })
}

const SETES_ADMIN = { institutionId: 1, userId: 1, role: 'admin', schemaName: 'setes_setes' }
const SETES_SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const ADMIN = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER = { institutionId: 2, userId: 10, role: 'user', schemaName: 'setes_x' }
const bearer = (p: object) => `Bearer ${testToken(p)}`
const WRITES = ['createMerchandise', 'editMerchandise', 'removeMerchandise', 'putTradeUnits', 'createBrand', 'createMeasure', 'createPackage'] as const
const writesReached = () => WRITES.filter(w => ((service as any)[w] as jest.Mock).mock.calls.length > 0)
const factRead = () => q.mock.calls.some(c => /source_kind|tb_sync_api_key/.test(c[0]))
const brand = { description: 'MARCA ADV3' }

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  desktop = new Set([1]); contracted = new Set([MERCH_IFACE]); privileged = new Set()
  routeDb()
})

describe('D-PR77 — SEM guarda no /api/merchandise: institution com origem D (ERP Desktop dono do catálogo) ESCREVE', () => {
  it('[RESISTIU] toda escrita do módulo (ficha, níveis, exclusão, criação na central) chega ao handler — admin e super; nenhum 409 do dono do catálogo; o fato nem é lido', async () => {
    for (const who of [SETES_ADMIN, SETES_SUPER]) {
      jest.clearAllMocks()
      const auth = bearer(who)
      const res = await Promise.all([
        request(app).post('/api/merchandise').set('Authorization', auth).send({}),
        request(app).put('/api/merchandise/5').set('Authorization', auth).send({}),
        request(app).delete('/api/merchandise/5').set('Authorization', auth),
        request(app).put('/api/merchandise/5/trade-units').set('Authorization', auth).send({ levels: [{ level: 1, measureId: 999, factor: 1 }] }),
        request(app).post('/api/merchandise/brands').set('Authorization', auth).send(brand),
        request(app).post('/api/merchandise/measures').set('Authorization', auth).send({ description: 'X', abbreviation: 'X' }),
        request(app).post('/api/merchandise/packages').set('Authorization', auth).send(brand),
      ])
      // ficha vazia = 400 do PRÓPRIO controller (o DTO do módulo, não o dono do catálogo); o resto grava
      expect(res.map(r => r.status)).toEqual([400, 400, 200, 200, 201, 201, 201])
      expect(res.some(r => r.status === 409 || /^CATALOG_/.test(String(r.body.code ?? '')))).toBe(false)
      expect(writesReached()).toEqual(['removeMerchandise', 'putTradeUnits', 'createBrand', 'createMeasure', 'createPackage'])
    }
    expect(factRead()).toBe(false)
  })

  it('[RESISTIU] caixa/forma da URL: /api/MERCHANDISE, /Merchandise/Brands, barra final — chegam ao MESMO handler (montagem case-insensitive), sem camada no meio', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).post('/api/MERCHANDISE').set('Authorization', auth).send({}),
      request(app).post('/api/Merchandise/Brands').set('Authorization', auth).send(brand),
      request(app).post('/api/merchandise/brands/').set('Authorization', auth).send(brand),
      request(app).put('/api/merchandise/5/').set('Authorization', auth).send({}),
    ])
    expect(res.map(r => r.status)).toEqual([400, 201, 201, 400])
    expect((service.createBrand as jest.Mock).mock.calls).toHaveLength(2)
    expect(factRead()).toBe(false)
  })

  it('[RESISTIU] PATCH e métodos fora do router (PURGE/LOCK) não acham rota (404) — nada chega ao serviço', async () => {
    const auth = bearer(SETES_ADMIN)
    const res = await Promise.all([
      request(app).patch('/api/merchandise/5').set('Authorization', auth).send({}),
      request(app).purge('/api/merchandise/5').set('Authorization', auth),
      request(app).lock('/api/merchandise/5').set('Authorization', auth),
    ])
    expect(res.map(r => r.status)).toEqual([404, 404, 404])
    expect(writesReached()).toEqual([])
  })

  it('[RESISTIU] override de método por cabeçalho/consulta não existe: GET com X-HTTP-Method-Override: DELETE / ?_method=PUT só LÊ', async () => {
    const auth = bearer(SETES_ADMIN)
    const a = await request(app).get('/api/merchandise/5').set('Authorization', auth).set('X-HTTP-Method-Override', 'DELETE')
    const b = await request(app).get('/api/merchandise/5?_method=PUT').set('Authorization', auth).set('X-Method-Override', 'PUT')
    expect([a.status, b.status]).toEqual([200, 200])
    expect((service.fetchMerchandise as jest.Mock).mock.calls).toHaveLength(2)
    expect(writesReached()).toEqual([])
  })

  it('[RESISTIU] HEAD cai no handler de GET (leitura) e OPTIONS é respondido pelo CORS sem rota — nenhum toca escrita nem a chave', async () => {
    const auth = bearer(SETES_ADMIN)
    const h = await request(app).head('/api/merchandise/brands').set('Authorization', auth)
    const o = await request(app).options('/api/merchandise/brands').set('Authorization', auth)
    expect([h.status, o.status]).toEqual([200, 204])
    expect(writesReached()).toEqual([])
    expect(factRead()).toBe(false)
  })

  it('[RESISTIU] método em minúsculas na linha de requisição ("post") é recusado pelo parser HTTP do Node (400) antes do Express', async () => {
    const server = app.listen(0)
    try {
      const port = (server.address() as AddressInfo).port
      const raw = await new Promise<string>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.write(`post /api/merchandise/brands HTTP/1.1\r\nHost: x\r\nAuthorization: ${bearer(SETES_ADMIN)}\r\n` +
            `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)
        })
        let buf = ''
        s.on('data', d => { buf += d.toString() })
        s.on('end', () => resolve(buf)); s.on('error', reject)
      })
      expect(raw.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/)
      expect(writesReached()).toEqual([])
    } finally { server.close() }
  })

  it('[RESISTIU] a consulta segue liberada para a institution em D (lista de apoio e ficha)', async () => {
    const auth = bearer(SETES_ADMIN)
    const [a, b] = await Promise.all([
      request(app).get('/api/merchandise/brands').set('Authorization', auth),
      request(app).get('/api/merchandise/5').set('Authorization', auth),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
  })

  it('[RESISTIU] D e W escrevem igual: trocar o fato D → W no banco não muda a resposta (nada lê o fato na escrita)', async () => {
    const auth = bearer(SETES_ADMIN)
    const before = await request(app).post('/api/merchandise/brands').set('Authorization', auth).send(brand)
    desktop = new Set()
    const after = await request(app).post('/api/merchandise/brands').set('Authorization', auth).send(brand)
    expect([before.status, after.status]).toEqual([201, 201])
    expect((service.createBrand as jest.Mock).mock.calls).toHaveLength(2)
    expect(factRead()).toBe(false)
  })
})

describe('D-PR33 — CATALOGAR (10) nas criações da central (o privilégio segue sendo a ÚNICA barreira, em W e em D)', () => {
  it('[RESISTIU] usuário regular sem o privilégio: 403 PRIVILEGE_REQUIRED nas três (inclusive /Brands e barra final)', async () => {
    const auth = bearer(USER)
    const res = await Promise.all([
      request(app).post('/api/merchandise/brands').set('Authorization', auth).send(brand),
      request(app).post('/api/merchandise/measures').set('Authorization', auth).send({ description: 'X', abbreviation: 'X' }),
      request(app).post('/api/merchandise/packages').set('Authorization', auth).send(brand),
      request(app).post('/api/merchandise/Brands').set('Authorization', auth).send(brand),
      request(app).post('/api/merchandise/brands/').set('Authorization', auth).send(brand),
    ])
    expect(res.map(r => [r.status, r.body.code])).toEqual(res.map(() => [403, 'PRIVILEGE_REQUIRED']))
    expect(writesReached()).toEqual([])
  })

  it('[RESISTIU] CATALOGAR em OUTRA interface (services) não vale para merchandise', async () => {
    contracted.add(SERVICES_IFACE)
    privileged.add(`${USER.userId}:${SERVICES_IFACE}:10`)
    const r = await request(app).post('/api/merchandise/brands').set('Authorization', bearer(USER)).send(brand)
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('[RESISTIU] outro privilégio da tela (INSERIR=1) não substitui CATALOGAR', async () => {
    privileged.add(`${USER.userId}:${MERCH_IFACE}:1`)
    const r = await request(app).post('/api/merchandise/brands').set('Authorization', bearer(USER)).send(brand)
    expect(r.status).toBe(403)
  })

  it('[RESISTIU] interface NÃO contratada: 403 INTERFACE_NOT_ALLOWED para admin e para usuário com o vínculo (D-F37)', async () => {
    contracted = new Set()
    privileged.add(`${USER.userId}:${MERCH_IFACE}:10`)
    const [a, u] = await Promise.all([
      request(app).post('/api/merchandise/brands').set('Authorization', bearer(ADMIN)).send(brand),
      request(app).post('/api/merchandise/brands').set('Authorization', bearer(USER)).send(brand),
    ])
    expect([a.status, a.body.code, u.status, u.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED', 403, 'INTERFACE_NOT_ALLOWED'])
    expect(writesReached()).toEqual([])
  })

  it('[RESISTIU] com CATALOGAR na interface contratada (ou admin) cria; o super na Setes (origem D) também cria — sem guarda (D-PR77)', async () => {
    privileged.add(`${USER.userId}:${MERCH_IFACE}:10`)
    const [u, a, s] = await Promise.all([
      request(app).post('/api/merchandise/brands').set('Authorization', bearer(USER)).send(brand),
      request(app).post('/api/merchandise/measures').set('Authorization', bearer(ADMIN)).send({ description: 'X', abbreviation: 'X' }),
      request(app).post('/api/merchandise/packages').set('Authorization', bearer(SETES_SUPER)).send(brand),
    ])
    expect([u.status, a.status, s.status]).toEqual([201, 201, 201])
    expect(writesReached()).toEqual(['createBrand', 'createMeasure', 'createPackage'])
  })

  it('[RESISTIU] a ficha e as unidades NÃO criam item na central por tabela: o PUT/POST só referenciam (sem CATALOGAR, sem criação)', async () => {
    // a criação na central só existe nas três rotas com CATALOGAR; as demais rotas de escrita não chamam createBrand/Measure/Package
    const auth = bearer(USER)
    await request(app).put('/api/merchandise/5/trade-units').set('Authorization', auth).send({ levels: [{ level: 1, measureId: 999, factor: 1 }] })
    expect(['createBrand', 'createMeasure', 'createPackage'].filter(w => ((service as any)[w] as jest.Mock).mock.calls.length)).toEqual([])
  })
})
