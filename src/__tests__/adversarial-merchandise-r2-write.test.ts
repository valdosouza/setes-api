/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA de correção — cadastro de produtos (mercadoria), onda 1 (2026-10-18, 2ª rodada).
//
// Alvo: o caminho de GRAVAÇÃO reescrito depois dos HIGH ADV-01/ADV-02 (sem upsert na 071): `saveTradeUnits` em duas fases (estaciona +
// regrava pela PK / INSERT puro), `writeBaseUnit` (INSERT puro × UPDATE pela PK, revive do nível 1 excluído), `mapTradeUnitDup`, o filtro
// rápido pela identidade GS1 — e a peça COMPARTILHADA de preços (`@shared/price`). Tudo provado também com as funções REAIS em schema
// descartável (roteiros `probe-merchandise-r2.ts` / `probe-merchandise-r2b.ts` do gate):
//   · S3: a regravação falha NO MEIO (o GTIN de outro produto comitou durante a espera) → 409 GTIN_TAKEN com o id do dono e as linhas
//         estacionadas VOLTAM (rollback) — nos dois casos (nível existente e nível novo);
//   · S4a/S5c: a ficha muda a base para (unidade, 1) de um nível existente (vivo ou revivendo a base) → 409 TRADE_UNIT_DUPLICATE no
//         campo da unidade; S4b: GTIN da base = GTIN de outro nível do MESMO produto → 409 "repetido na grade";
//   · S5a: base soft-deletada (legado) é REVIVIDA pelo PUT da ficha; S5b: se o GTIN dela foi tomado nesse meio-tempo → 409 com o dono;
//   · S12 [BUG]: preço removido (priceTag null) e re-adicionado SEM `aliqKickback` → a linha revivida HERDA a comissão da linha MORTA
//         (gravado 5 → removido → volta 12 sem comissão → aliq_kickback = 5 e o GET mostra 5); `resolveCommissionAliq` lê essa coluna das
//         linhas vivas quando o vendedor comissiona por produto (o salesmen da web liga `kickbackProduct`).
// Os testes sem [BUG] fixam a semântica correta e PASSAM; o [BUG] FALHA hoje — demonstra o defeito.
import pool from '../shared/db/connection'
import { NO_CRITERIA } from '../shared/list'
import { merchandiseDto, tradeUnitsDto } from '../modules/merchandise/merchandise.dto'
import * as repo from '../modules/merchandise/merchandise.repository'
import { syncProductPrices } from '../shared/price'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockGetConnection = (pool as any).getConnection as jest.Mock
const mockQuery = (pool as any).query as jest.Mock

type Route = [RegExp, (params: any[], sql: string) => any]

function routedConn(routes: Route[]) {
  const conn: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      for (const [re, fn] of routes) if (re.test(sql)) return fn(params, sql)
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
    }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}
const sqlsOf = (conn: any): string[] => conn.query.mock.calls.map((c: any[]) => c[0] as string)
const dup = (key: string) => Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry 'x' for key '${key}'` })

const TU = '`setes_setes`\\.tb_merchandise_trade_unit'
const linkedOk: Route = [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]]
const refsOk: Route[] = [
  [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
  linkedOk,
  [/FROM `setes_setes`\.tb_price_list WHERE id = \?/, () => [[{ 1: 1 }]]],
]
/** dono do GTIN: leitura TRAVANTE (depois da colisão) × leitura do retrato (pré-conferência) */
const owner = (locking: number | null, snapshot: number | null = null): Route[] => [
  [/live_gtin = \?[\s\S]*LOCK IN SHARE MODE/, () => [locking == null ? [] : [{ id: locking }]]],
  [/live_gtin = \?/, () => [snapshot == null ? [] : [{ id: snapshot }]]],
]

beforeEach(() => jest.clearAllMocks())

describe('sub-rota: a regravação falha no meio (S3)', () => {
  const productOk: Route = [/SELECT p\.id FROM `setes_setes`\.tb_product p/, () => [[{ id: 5 }]]]
  const facts: Route = [/SELECT taxable_trade_level AS t, default_sale_trade_level AS d/, () => [[{ t: null, d: 3 }]]]
  const levels: Route = [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted/, () => [[
    { level: 1, measureId: 1, packageId: null, factor: 1, gtin: null, deleted: 'N' },
    { level: 2, measureId: 2, packageId: null, factor: 12, gtin: '7891234567895', deleted: 'N' },
    { level: 3, measureId: 2, packageId: null, factor: 24, gtin: '7891000315507', deleted: 'N' },
  ]]]
  const body = () => tradeUnitsDto.parse({ levels: [
    { level: 1, measureId: 1, factor: 1 },
    { level: 2, measureId: 2, factor: 24, gtin: '7891000315507' },     // troca 2 ↔ 3
    { level: 3, measureId: 2, factor: 12, gtin: '7891234567895' },
    { measureId: 3, factor: 36, gtin: '4006381333931' },               // nível NOVO — o GTIN comitou noutro produto durante a espera
  ] })

  it('INSERT do nível novo colide com o GTIN de OUTRO produto DEPOIS de estacionar: 409 com o dono (leitura travante), ROLLBACK, nunca COMMIT', async () => {
    const conn = routedConn([productOk, facts, levels, linkedOk, ...owner(9),
      [new RegExp(`INSERT INTO ${TU}`), () => { throw dup('uq_mtu_live_gtin') }]])
    await expect(repo.saveTradeUnits(5, body(), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'levels.3.gtin' }, { field: 'id', message: '9' }] })
    const sqls = sqlsOf(conn)
    const park = sqls.findIndex(s => /SET deleted = 'S'\s+WHERE/.test(s) && !/updated_at/.test(s))
    expect(park).toBeGreaterThan(-1)
    expect(park).toBeLessThan(sqls.findIndex(s => new RegExp(`INSERT INTO ${TU}`).test(s)))
    // as designações NÃO são gravadas e a transação é desfeita inteira (o estacionado volta)
    expect(sqls.some(s => /UPDATE `setes_setes`\.tb_merchandise SET taxable_trade_level/.test(s))).toBe(false)
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })

  it('designação apontando nível que MUDA (estacionado e regravado) é aceita — e só é gravada DEPOIS das regravações', async () => {
    const conn = routedConn([productOk, facts, levels, linkedOk, ...owner(null)])
    expect(await repo.saveTradeUnits(5, tradeUnitsDto.parse({ ...body(), defaultSaleTradeLevel: 3 }), 'setes_setes', 1)).toBe(true)
    const sqls = sqlsOf(conn)
    const designation = sqls.findIndex(s => /UPDATE `setes_setes`\.tb_merchandise SET taxable_trade_level/.test(s))
    const lastWrite = sqls.reduce((mx, s, i) => (new RegExp(`(INSERT INTO|UPDATE) ${TU}`).test(s) ? i : mx), -1)
    expect(designation).toBeGreaterThan(lastWrite)
    expect(conn.query.mock.calls[designation][1]).toEqual([null, 3, 5, 1])
    expect(conn.commit).toHaveBeenCalled()
  })
})

describe('ficha (PUT) × nível base', () => {
  const productRow: Route = [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: 'PAR-8', categoryId: 3, financialPlansId: null }]]]
  const factsRow: Route = [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]]
  // (D-PR40, 2026-10-18) a ficha lê TODOS os níveis do produto numa leitura travante — aqui só o nível 1 (sem outro nível vivo)
  const baseRow = (row: Record<string, unknown>): Route => [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, gtin, deleted/,
    () => [[{ level: 1, measureId: 1, packageId: null, gtin: null, deleted: 'N', ...row }]]]
  const input = (baseUnit: Record<string, unknown>) => merchandiseDto.parse({
    identifier: 'PAR-8', description: 'Parafuso', categoryId: 3, brandId: 1, baseUnit,
  })

  it('base muda para a (unidade, 1) de um nível existente: 409 TRADE_UNIT_DUPLICATE no campo da UNIDADE da base, rollback', async () => {
    const conn = routedConn([productRow, factsRow, baseRow({}), ...refsOk,
      [new RegExp(`UPDATE ${TU}\\s+SET tb_measure_id`), () => { throw dup('uq_mtu_live_unit_factor') }]])
    await expect(repo.updateMerchandise(5, input({ measureId: 2 }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_DUPLICATE', fields: [{ field: 'baseUnit.measureId' }] })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })

  it('GTIN da base = GTIN de outro nível do MESMO produto: 409 "repetido na grade" (o dono travante é o próprio produto)', async () => {
    routedConn([productRow, factsRow, baseRow({}), ...refsOk, ...owner(5),
      [new RegExp(`UPDATE ${TU}\\s+SET tb_measure_id`), () => { throw dup('uq_mtu_live_gtin') }]])
    await expect(repo.updateMerchandise(5, input({ measureId: 1, gtin: '7891234567895' }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'baseUnit.gtin', message: 'GTIN repetido na grade' }] })
  })

  it('base soft-deletada (legado) é REVIVIDA por UPDATE pela PK (nunca INSERT — a PK existe) e o GTIN dela é reconferido (morto não vale)', async () => {
    const conn = routedConn([productRow, factsRow, baseRow({ gtin: '7891234567895', deleted: 'S' }), ...refsOk, ...owner(null)])
    expect(await repo.updateMerchandise(5, input({ measureId: 1, gtin: '7891234567895' }), 'setes_setes', 1)).toBe(true)
    const sqls = sqlsOf(conn)
    expect(sqls.some(s => new RegExp(`INSERT INTO ${TU}`).test(s))).toBe(false)
    const revive = sqls.find(s => new RegExp(`UPDATE ${TU}\\s+SET tb_measure_id`).test(s))
    expect(revive).toMatch(/deleted = 'N'/)
    // a medida da base revivida também é reconferida (a gravada era de linha morta — A-PR1 só poupa o que está VIVO e não mudou)
    expect(sqls.some(s => /tb_institution_has_measure l/.test(s))).toBe(true)
    expect(sqls.some(s => /live_gtin = \?/.test(s) && !/LOCK IN SHARE MODE/.test(s))).toBe(true)
  })
})

describe('lista: filtro rápido pelo GTIN na identidade GS1 (A-PR3)', () => {
  it('UPC-A 036000291452 procurado como EAN-13 0036000291452 (o leitor de código manda 13 dígitos) → compara a forma de 14', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await repo.listMerchandise({ filter: ' 0036000291452 ', page: 1, pageSize: 10, offset: 0, criteria: NO_CRITERIA }, 'setes_setes', 1)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/tu\.live_gtin = \?/)
    expect(params).toContain('00036000291452')
  })

  it('filtro que não é número de GTIN não vira chave de GTIN', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await repo.listMerchandise({ filter: 'PARAFUSO', page: 1, pageSize: 10, offset: 0, criteria: NO_CRITERIA }, 'setes_setes', 1)
    const params = mockQuery.mock.calls[0][1] as any[]
    expect(params.filter(p => typeof p === 'string' && /^\d{14}$/.test(p))).toEqual([])
  })
})

describe('peça de preços — linha REVIVIDA × comissão por produto (D-PR9)', () => {
  it('[BUG] preço re-adicionado SEM aliqKickback sobre linha soft-deletada: a comissão da linha MORTA não pode voltar a valer', async () => {
    // o upsert de quem não manda `aliqKickback` (o app de serviços — sempre; qualquer cliente que siga "ausente = não mexe") revive a linha
    // (deleted 'S' → 'N') sem tocar aliq_kickback: a comissão que o usuário removeu junto com o preço (e que o GET não mostrava) volta.
    // Semântica esperada: "ausente = não mexe" vale para a linha VIVA; a linha que RENASCE não herda (molde: a revivida nunca herda).
    const conn = routedConn([])
    await syncProductPrices(conn, 'setes_setes', 1, 5, [{ priceListId: 1, priceTag: 12 }])
    const upsert = sqlsOf(conn).filter(s => /INSERT INTO `setes_setes`\.tb_price/.test(s))
    expect(upsert).toHaveLength(1)
    // a correção pode ser no próprio ON DUPLICATE (aliq_kickback condicionado a deleted) ou num statement que limpe a da linha morta
    const handlesDeadKickback = sqlsOf(conn).some(s => /aliq_kickback/.test(s) && /deleted/.test(s))
    expect(handlesDeadKickback).toBe(true)
  })
})
