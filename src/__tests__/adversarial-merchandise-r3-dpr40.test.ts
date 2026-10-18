/// <reference types="jest" />
// GATE ADVERSARIAL r3 — delta D-PR32/D-PR33/D-PR40 do cadastro de produtos (2026-10-18; skill testar-adversarial.md).
// Alvo deste arquivo: D-PR40 ("a unidade-base não muda enquanto houver outro nível vivo — os fatores são em unidades-base").
// Convenção: `it.failing('[ACHADO …]')` descreve o comportamento CERTO e hoje FALHA; `it('[RESISTIU] …')` = o ataque foi barrado / a
// semântica pedida vale. Provado também com as funções REAIS em schema descartável (roteiro `probe-dpr40.ts` do gate, scratchpad):
//   V1  base EXCLUÍDA (estado "legado" que a própria casa trata como alcançável — ADV2-04 e S5a) + nível 2 vivo "LT×12" → PUT da ficha com
//       a base em KG = ok; resultado 1:KG×1 2:LT×12 — o nível 2 passou a valer "12 KG" em silêncio (qTrib da NF-e).
//   V1b SEM linha de base (produto de antes da 071) + nível 2 vivo → a ficha CRIA a base em KG — mesmo efeito.
//   V2/V3 (resistiu): só embalagem/GTIN da base com outro nível vivo passa nos dois caminhos; a unidade = 409.
//   V4  corrida ficha (UN→KG) × sub-rota com retrato velho (base UN + nível novo LT×12), 40 rodadas: 0 violação (as duas travam a linha do
//       produto primeiro); limite: quando a ficha vence, a sub-rota DESFAZ a troca da ficha (perda de atualização — base volta a UN, 19/40).
import pool from '../shared/db/connection'
import { merchandiseDto, tradeUnitsDto } from '../modules/merchandise/merchandise.dto'
import * as repo from '../modules/merchandise/merchandise.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockGetConnection = (pool as any).getConnection as jest.Mock
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

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
const callsOf = (conn: any): any[][] => conn.query.mock.calls

const TU = '`setes_setes`\\.tb_merchandise_trade_unit'
const linkedOk: Route = [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]]
const refsOk: Route[] = [
  [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
  linkedOk,
  [/FROM `setes_setes`\.tb_price_list WHERE id = \?/, () => [[{ 1: 1 }]]],
]
const productRow: Route = [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: 'PAR-8', categoryId: 3, financialPlansId: null }]]]
const factsRow: Route = [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]]
type Lv = { level: number; measureId: number; packageId?: number | null; gtin?: string | null; deleted?: string }
const levels = (rows: Lv[]): Route => [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, gtin, deleted/,
  () => [rows.map(r => ({ packageId: null, gtin: null, deleted: 'N', ...r }))]]
const ficha = (baseUnit: Record<string, unknown>) => merchandiseDto.parse({
  identifier: 'PAR-8', description: 'Parafuso', categoryId: 3, brandId: 1, baseUnit,
})
const baseWrites = (conn: any) => callsOf(conn).filter(c =>
  new RegExp(`(UPDATE ${TU}\\s+SET tb_measure_id|INSERT INTO ${TU})`).test(c[0] as string))

const UN = 1, KG = 2, LT = 3

beforeEach(() => jest.clearAllMocks())

describe('D-PR40 na FICHA — estados em que a base não está viva', () => {
  it('[CORRIGIDO ADV3-01] base EXCLUÍDA + nível 2 vivo: a ficha não revive a base em OUTRA unidade (409 TRADE_UNIT_BASE_LOCKED)', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk,
      levels([{ level: 1, measureId: UN, deleted: 'S' }, { level: 2, measureId: LT }])])
    await expect(repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED', fields: [{ field: 'baseUnit.measureId' }] })
    expect(conn.commit).not.toHaveBeenCalled()
  })

  it('[CORRIGIDO ADV3-01b] SEM linha de base + nível 2 vivo: a ficha não cria a base numa unidade arbitrária (409)', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk, levels([{ level: 2, measureId: LT }])])
    await expect(repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED' })
    expect(conn.commit).not.toHaveBeenCalled()
  })

  it('[RESISTIU — fixa a saída] base EXCLUÍDA + nível 2 vivo: reviver a base na MESMA unidade passa (é a saída da sub-rota — ADV2-04)', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk,
      levels([{ level: 1, measureId: UN, deleted: 'S' }, { level: 2, measureId: LT }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: UN }), 'setes_setes', 1)).toBe(true)
    const w = baseWrites(conn)
    expect(w).toHaveLength(1)
    expect(w[0][0]).toMatch(/deleted = 'N'/)
    expect(w[0][1][0]).toBe(UN)
    expect(conn.commit).toHaveBeenCalled()
  })
})

describe('D-PR40 — o que NÃO é troca da unidade-base passa com outro nível vivo', () => {
  it('[RESISTIU] ficha: só embalagem e GTIN da base mudam (unidade igual) com nível 2 vivo → grava e comita', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk,
      levels([{ level: 1, measureId: UN }, { level: 2, measureId: LT }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: UN, packageId: 1, gtin: '7891234567895' }), 'setes_setes', 1)).toBe(true)
    const w = baseWrites(conn)
    expect(w).toHaveLength(1)
    expect(w[0][1].slice(0, 3)).toEqual([UN, 1, '7891234567895'])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('[RESISTIU] ficha: tirar embalagem e GTIN da base (unidade igual) com nível 2 vivo → passa', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk,
      levels([{ level: 1, measureId: UN, packageId: 1, gtin: '7891234567895' }, { level: 2, measureId: LT }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: UN }), 'setes_setes', 1)).toBe(true)
    expect(baseWrites(conn)[0][1].slice(0, 3)).toEqual([UN, null, null])
  })

  it('[RESISTIU] ficha: nível 2 EXCLUÍDO não trava a troca da unidade da base (só nível VIVO conta)', async () => {
    const conn = routedConn([productRow, factsRow, ...refsOk,
      levels([{ level: 1, measureId: UN }, { level: 2, measureId: LT, deleted: 'S' }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1)).toBe(true)
    expect(baseWrites(conn)[0][1][0]).toBe(KG)
  })

  it('[RESISTIU] sub-rota: base muda só embalagem/GTIN com o nível 2 mantido → passa (UPDATE pela PK do nível 1)', async () => {
    const conn = routedConn([
      [/SELECT p\.id FROM `setes_setes`\.tb_product p/, () => [[{ id: 5 }]]],
      [/SELECT taxable_trade_level AS t, default_sale_trade_level AS d/, () => [[{ t: null, d: null }]]],
      [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted/,
        () => [[{ level: 1, measureId: UN, packageId: null, factor: 1, gtin: null, deleted: 'N' },
                { level: 2, measureId: LT, packageId: null, factor: 12, gtin: null, deleted: 'N' }]]],
      linkedOk,
    ])
    expect(await repo.saveTradeUnits(5, tradeUnitsDto.parse({ levels: [
      { level: 1, measureId: UN, packageId: 1, factor: 1, gtin: '7891234567895' }, { level: 2, measureId: LT, factor: 12 },
    ] }), 'setes_setes', 1)).toBe(true)
    const upd = callsOf(conn).filter(c => new RegExp(`UPDATE ${TU}\\s+SET tb_measure_id`).test(c[0] as string))
    expect(upd.map(c => c[1][c[1].length - 1])).toEqual([1])
    expect(conn.commit).toHaveBeenCalled()
  })
})

// D-PR42 (= Q-PR42' (a), Rodada 6 — Valdo 2026-10-18): a troca da unidade-base também é recusada quando o produto tem PREÇO vivo na grade
// ou item em pedido ABERTO (status 'A'); trocar só embalagem/GTIN segue livre; nível/preço/pedido fora do critério não trava.
describe('D-PR42 — preço vivo e pedido aberto também medem na unidade-base', () => {
  const PRICE = /SELECT pr\.tb_price_list_id AS listId FROM `setes_setes`\.tb_price pr/
  const ORDER = /SELECT i\.tb_order_id AS orderId FROM `setes_setes`\.tb_order_item i/
  const withPrice: Route = [PRICE, () => [[{ listId: 1 }]]]
  const noPrice: Route = [PRICE, () => [[]]]
  const openOrder: Route = [ORDER, () => [[{ orderId: 7801 }]]]
  const noOrder: Route = [ORDER, () => [[]]]
  const subRoute = (extra: Route[], levelsIn: any[]) => {
    const conn = routedConn([
      ...extra,
      [/SELECT p\.id FROM `setes_setes`\.tb_product p/, () => [[{ id: 5 }]]],
      [/SELECT taxable_trade_level AS t, default_sale_trade_level AS d/, () => [[{ t: null, d: null }]]],
      [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted/,
        () => [[{ level: 1, measureId: UN, packageId: null, factor: 1, gtin: null, deleted: 'N' }]]],
      linkedOk,
    ])
    return { conn, run: () => repo.saveTradeUnits(5, tradeUnitsDto.parse({ levels: levelsIn }), 'setes_setes', 1) }
  }

  it('[RESISTIU] ficha: UN → KG com preço gravado na grade = 409 TRADE_UNIT_BASE_LOCKED no campo da base; nada gravado', async () => {
    const conn = routedConn([withPrice, noOrder, productRow, factsRow, ...refsOk, levels([{ level: 1, measureId: UN }])])
    await expect(repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1)).rejects.toMatchObject({
      statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED', fields: [{ field: 'baseUnit.measureId', message: 'Produto com preço na unidade-base atual' }],
    })
    expect(baseWrites(conn)).toHaveLength(0)
    expect(conn.rollback).toHaveBeenCalled()
    const price = callsOf(conn).find(c => PRICE.test(c[0]))!
    expect(price[0]).toContain("pr.deleted = 'N'")
    expect(price[0]).toContain("l.deleted = 'N'")                     // preço de tabela EXCLUÍDA não aparece na grade e não trava (gate R6)
    expect(price[1]).toEqual([1, 5])
  })

  it('[RESISTIU] ficha: UN → KG com item em pedido ABERTO = 409 que diz o pedido; o critério é status A + vivos, casando o terminal', async () => {
    const conn = routedConn([noPrice, openOrder, productRow, factsRow, ...refsOk, levels([{ level: 1, measureId: UN }])])
    await expect(repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1)).rejects.toMatchObject({
      statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED', fields: [{ field: 'baseUnit.measureId', message: 'Produto no pedido aberto 7801' }],
    })
    const sql = callsOf(conn).find(c => ORDER.test(c[0]))![0] as string
    expect(sql).toContain("o.status = 'A'")
    expect(sql).toContain("i.deleted = 'N' AND o.deleted = 'N'")
    expect(sql).toContain('o.terminal = i.terminal')
    expect(baseWrites(conn)).toHaveLength(0)
  })

  it('[RESISTIU] ficha: sem preço e sem pedido aberto a troca passa; trocar SÓ embalagem/GTIN com preço vivo passa (nem consulta)', async () => {
    const free = routedConn([noPrice, noOrder, productRow, factsRow, ...refsOk, levels([{ level: 1, measureId: UN }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1)).toBe(true)
    expect(baseWrites(free)[0][1][0]).toBe(KG)
    const same = routedConn([withPrice, openOrder, productRow, factsRow, ...refsOk, levels([{ level: 1, measureId: UN }])])
    expect(await repo.updateMerchandise(5, ficha({ measureId: UN, packageId: 1, gtin: '7891234567895' }), 'setes_setes', 1)).toBe(true)
    expect(callsOf(same).some(c => PRICE.test(c[0]) || ORDER.test(c[0]))).toBe(false)
  })

  it('[RESISTIU] D-PR40 decide antes: com outro nível vivo a mensagem segue a dos níveis (não consulta preço/pedido)', async () => {
    const conn = routedConn([withPrice, openOrder, productRow, factsRow, ...refsOk, levels([{ level: 1, measureId: UN }, { level: 2, measureId: LT }])])
    await expect(repo.updateMerchandise(5, ficha({ measureId: KG }), 'setes_setes', 1)).rejects.toMatchObject({
      fields: [{ field: 'baseUnit.measureId', message: 'Remova os outros níveis antes de trocar a unidade-base' }],
    })
    expect(callsOf(conn).some(c => PRICE.test(c[0]))).toBe(false)
  })

  it('[RESISTIU] sub-rota: trocar a base (só nível 1) com preço vivo = 409 no campo do nível; com pedido aberto = 409; livre = grava', async () => {
    const a = subRoute([withPrice, noOrder], [{ level: 1, measureId: KG, factor: 1 }])
    await expect(a.run()).rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED',
      fields: [{ field: 'levels.0.measureId', message: 'Produto com preço na unidade-base atual' }] })
    const b = subRoute([noPrice, openOrder], [{ level: 1, measureId: KG, factor: 1 }])
    await expect(b.run()).rejects.toMatchObject({ fields: [{ field: 'levels.0.measureId', message: 'Produto no pedido aberto 7801' }] })
    const c = subRoute([noPrice, noOrder], [{ level: 1, measureId: KG, factor: 1 }])
    expect(await c.run()).toBe(true)
    expect(c.conn.commit).toHaveBeenCalled()
  })
})
