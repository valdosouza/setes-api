/// <reference types="jest" />
// setes-api:IBS.E9.P5 (D-IB139, A-IB138b, A-IB138d): a ATIVIDADE do Simples (cAtivSN) — o padrão do estabelecimento
// (`tb_entity_tax.simples_activity`), a exceção da mercadoria (`tb_merchandise.simples_activity`) e a resolução do item.
// Quatro camadas: (i) a peça, (ii) o serviço do estabelecimento, (iii) o repository da mercadoria com o pool falso,
// (iv) o serviço da mercadoria (a recusa sai antes de qualquer escrita).
import {
  SIMPLES_ACTIVITIES, SIMPLES_ACTIVITY_DEFAULT, isSimplesActivity, assertSimplesActivity, resolveSimplesActivity,
} from '../shared/ibscbs-simples-activity'
import { ErrorCodes } from '../shared/errors/error-codes'
import { EntityFiscalFull } from '@shared/entity'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../modules/establishment/establishment.repository')
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({
  getEntityTax: jest.fn().mockResolvedValue(null),
  upsertEntityTax: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/tax-rule', () => ({
  ...jest.requireActual('../shared/tax-rule'),
  clearIcmsCodesForRegime: jest.fn().mockResolvedValue(0),
}))
jest.mock('../shared/ibscbs-assessment', () => ({
  ...jest.requireActual('../shared/ibscbs-assessment'),
  firstFutureRegularAssessmentFrom: jest.fn().mockResolvedValue(null),
}))

import pool from '../shared/db/connection'
import * as estabRepo from '../modules/establishment/establishment.repository'
import { editEstablishment, fetchEstablishment } from '../modules/establishment/establishment.service'
import * as merchRepo from '../modules/merchandise/merchandise.repository'
import { createMerchandise, editMerchandise } from '../modules/merchandise/merchandise.service'
import { merchandiseDto } from '../modules/merchandise/merchandise.dto'
import { establishmentUpdateDto } from '../modules/establishment/establishment.dto'

const entityTaxRepo = require('../shared/entity-tax/entity-tax.repository')
const mockGetConnection = (pool as any).getConnection as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  entityTaxRepo.getEntityTax.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (i) a peça
// ---------------------------------------------------------------------------------------------------------------------------------
describe('peça @shared/ibscbs-simples-activity', () => {
  it('o domínio é 01 a 04 (RF-SN-16); o padrão é 01 (A-IB138b); a 90 e o resto ficam de fora (A-IB138d)', () => {
    expect([...SIMPLES_ACTIVITIES]).toEqual(['01', '02', '03', '04'])
    expect(SIMPLES_ACTIVITY_DEFAULT).toBe('01')
    for (const ok of ['01', '02', '03', '04']) expect(isSimplesActivity(ok)).toBe(true)
    for (const bad of ['90', '1', '001', '05', '', ' 01', 1, null, undefined]) expect(isSimplesActivity(bad)).toBe(false)
  })

  it('assertSimplesActivity: null e undefined passam (sem atividade própria); 90 e 1 → 400 IBSCBS_SIMPLES_ACTIVITY_INVALID', () => {
    expect(() => assertSimplesActivity(null)).not.toThrow()
    expect(() => assertSimplesActivity(undefined)).not.toThrow()
    expect(() => assertSimplesActivity('03')).not.toThrow()
    for (const bad of ['90', '1', 'AB']) {
      expect(() => assertSimplesActivity(bad)).toThrow(expect.objectContaining({
        statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_ACTIVITY_INVALID,
      }))
    }
    try { assertSimplesActivity('90') } catch (e: any) { expect(e.fields[0].message).toMatch(/90 \(não tributável\)/) }
  })

  it('a resolução do item: a da mercadoria, senão a do estabelecimento, senão 01', () => {
    expect(resolveSimplesActivity('03', '02')).toBe('03')
    expect(resolveSimplesActivity(null, '02')).toBe('02')
    expect(resolveSimplesActivity(undefined, '04')).toBe('04')
    expect(resolveSimplesActivity(null, null)).toBe('01')
    expect(resolveSimplesActivity(undefined, undefined)).toBe('01')
  })

  it('valor gravado fora do domínio falha ALTO (nunca vira 01 em silêncio)', () => {
    expect(() => resolveSimplesActivity('90', '02')).toThrow(/fora do domínio/)
    expect(() => resolveSimplesActivity(null, 'XX')).toThrow(/fora do domínio/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (ii) o estabelecimento
// ---------------------------------------------------------------------------------------------------------------------------------
function fakeChainJ(): EntityFiscalFull {
  return {
    id: 5,
    entity: { nameCompany: 'Acme Ltda', nickTrade: 'Acme', aniversary: null },
    personType: 'J', person: null,
    company: { cnpj: '12345678000199', ie: '111222333', im: '999', dtFoundation: null },
    noDoc: null,
    addresses: [{ kind: 'main', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '01000000',
      tbCountryId: 1, tbStateId: 1, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'SP', cityName: 'São Paulo' }],
    phones: [{ kind: 'main', contact: 'Fulano', number: '11999998888' }],
    socialMedia: [],
  }
}
const baseInput = { nameCompany: 'Acme Ltda', nickTrade: 'Acme', addresses: [], phones: [], socials: [] }

describe('estabelecimento — atividade padrão (D-IB139)', () => {
  beforeEach(() => {
    ;(estabRepo.getEstablishmentChain as jest.Mock).mockResolvedValue(fakeChainJ())
    ;(estabRepo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)
  })

  it('o DTO aceita o campo (texto ou null) e a conferência do código é do serviço', () => {
    expect(establishmentUpdateDto.safeParse({ ...baseInput, simplesActivity: '02' }).success).toBe(true)
    expect(establishmentUpdateDto.safeParse({ ...baseInput, simplesActivity: null }).success).toBe(true)
    expect(establishmentUpdateDto.safeParse({ ...baseInput, simplesActivity: 2 }).success).toBe(false)
  })

  it('o GET devolve a atividade gravada, ou null (= 01)', async () => {
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional', simplesActivity: '03' })
    expect((await fetchEstablishment(5, 'setes_acme')).simplesActivity).toBe('03')
    entityTaxRepo.getEntityTax.mockResolvedValue(null)
    expect((await fetchEstablishment(5, 'setes_acme')).simplesActivity).toBeNull()
  })

  it('o PUT com a atividade faz o MERGE sobre a linha viva e grava só ela a mais', async () => {
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional', issRetido: 'S', simplesActivity: '01' })
    await editEstablishment(5, 'setes_acme', { ...baseInput, simplesActivity: '04' }, 1)
    expect(entityTaxRepo.upsertEntityTax).toHaveBeenCalledTimes(1)
    const input = entityTaxRepo.upsertEntityTax.mock.calls[0][4]
    expect(input.simplesActivity).toBe('04')
    expect(input.issRetido).toBe('S')                       // o merge preserva o resto
    expect(input.taxRegime).toBe('1 - Simples Nacional')
  })

  it('o PUT sem a atividade (a tela que ainda não a manda) não toca a tributação nem apaga a gravada', async () => {
    await editEstablishment(5, 'setes_acme', baseInput, 1)
    expect(entityTaxRepo.upsertEntityTax).not.toHaveBeenCalled()
    entityTaxRepo.getEntityTax.mockResolvedValue({ taxRegime: '1 - Simples Nacional', simplesActivity: '02' })
    await editEstablishment(5, 'setes_acme', { ...baseInput, taxRegime: '1 - Simples Nacional' }, 1)
    expect(entityTaxRepo.upsertEntityTax.mock.calls[0][4].simplesActivity).toBe('02')   // vem do merge
  })

  it('o PUT com null limpa o padrão (volta ao 01); com 90 ou 1 → 400 IBSCBS_SIMPLES_ACTIVITY_INVALID, ANTES de gravar qualquer parte', async () => {
    entityTaxRepo.getEntityTax.mockResolvedValue({ simplesActivity: '02' })
    await editEstablishment(5, 'setes_acme', { ...baseInput, simplesActivity: null }, 1)
    expect(entityTaxRepo.upsertEntityTax.mock.calls[0][4].simplesActivity).toBeNull()

    jest.clearAllMocks()
    for (const bad of ['90', '1']) {
      await expect(editEstablishment(5, 'setes_acme', { ...baseInput, simplesActivity: bad }, 1)).rejects.toMatchObject({
        statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_ACTIVITY_INVALID,
      })
    }
    expect(estabRepo.saveEstablishmentChain).not.toHaveBeenCalled()
    expect(entityTaxRepo.upsertEntityTax).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (iii) a mercadoria — o repository com o pool falso
// ---------------------------------------------------------------------------------------------------------------------------------
type Route = [RegExp, (params: any[]) => any]
function routedConn(routes: Route[]) {
  const conn: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      for (const [re, fn] of routes) if (re.test(sql)) return fn(params)
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
    }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}
const callsOf = (conn: any, re: RegExp): Array<[string, any[]]> =>
  conn.query.mock.calls.filter((c: any[]) => re.test(c[0])).map((c: any[]) => [c[0] as string, c[1] as any[]])
const refsOk: Route[] = [
  [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
  [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]],
]
const insertRoutes: Route[] = [
  [/setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ id: 1 }]]],
  [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_product/, () => [[{ nextId: 42 }]]],
  ...refsOk,
]
const updateRoutes: Route[] = [
  [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: '5', categoryId: 3, financialPlansId: null }]]],
  [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]],
  ...refsOk,
]
const MERCH = /INSERT INTO `setes_setes`\.tb_merchandise\s*\(/
const base = { description: 'Parafuso 8mm', categoryId: 3, brandId: 1, baseUnit: { measureId: 1 } }
const input = (over: Record<string, unknown> = {}) => merchandiseDto.parse({ ...base, ...over })

describe('mercadoria — exceção de atividade (D-IB139): o repository', () => {
  it('criar com a atividade grava a coluna e o parâmetro; criar sem ela grava NULL (= herda)', async () => {
    let conn = routedConn(insertRoutes)
    await merchRepo.insertMerchandise(input({ simplesActivity: '03' }), 'setes_setes', 1)
    let [[sql, params]] = callsOf(conn, MERCH)
    expect(sql).toMatch(/simples_activity/)
    expect(params[params.length - 1]).toBe('03')
    expect(sql).toMatch(/simples_activity = VALUES\(simples_activity\)/)

    conn = routedConn(insertRoutes)
    await merchRepo.insertMerchandise(input(), 'setes_setes', 1);
    [[sql, params]] = callsOf(conn, MERCH)
    expect(params[params.length - 1]).toBeNull()
    expect(sql).not.toMatch(/simples_activity = VALUES/)   // criar sem a chave: nada de UPDATE da coluna (a linha que já existe mantém)
  })

  it('editar SEM a chave não toca a coluna (a tela que ainda não a manda não a apaga)', async () => {
    const conn = routedConn(updateRoutes)
    await merchRepo.updateMerchandise(42, input(), 'setes_setes', 1)
    const [[sql]] = callsOf(conn, MERCH)
    expect(sql).not.toMatch(/simples_activity = VALUES/)
  })

  it('editar COM a chave grava; com null volta a herdar', async () => {
    let conn = routedConn(updateRoutes)
    await merchRepo.updateMerchandise(42, input({ simplesActivity: '04' }), 'setes_setes', 1)
    let [[sql, params]] = callsOf(conn, MERCH)
    expect(sql).toMatch(/simples_activity = VALUES\(simples_activity\)/)
    expect(params[params.length - 1]).toBe('04')

    conn = routedConn(updateRoutes)
    await merchRepo.updateMerchandise(42, input({ simplesActivity: null }), 'setes_setes', 1);
    [[sql, params]] = callsOf(conn, MERCH)
    expect(sql).toMatch(/simples_activity = VALUES\(simples_activity\)/)
    expect(params[params.length - 1]).toBeNull()
  })

  it('a leitura traz a atividade própria (null = herda)', async () => {
    ;(pool as any).query.mockResolvedValue([[{ id: 42, simplesActivity: '02' }]])
    const found: any = await merchRepo.getMerchandise(42, 'setes_setes', 1).catch(() => null)
    const select = String((pool as any).query.mock.calls[0]?.[0] ?? '')
    expect(select).toMatch(/m\.simples_activity\s+AS simplesActivity/)
    void found
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (iv) a mercadoria — o serviço (a recusa sai antes de qualquer escrita)
// ---------------------------------------------------------------------------------------------------------------------------------
describe('mercadoria — o serviço recusa a atividade fora do domínio', () => {
  it('90 e 1 no cadastro e na edição → 400 IBSCBS_SIMPLES_ACTIVITY_INVALID, sem abrir transação', async () => {
    const scope = { schemaName: 'setes_setes', institutionId: 1 }
    for (const bad of ['90', '1']) {
      await expect(createMerchandise(input({ simplesActivity: bad }), scope)).rejects.toMatchObject({
        statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_ACTIVITY_INVALID,
      })
      await expect(editMerchandise(42, input({ simplesActivity: bad }), scope)).rejects.toMatchObject({
        statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_ACTIVITY_INVALID,
      })
    }
    expect(mockGetConnection).not.toHaveBeenCalled()
  })
})
