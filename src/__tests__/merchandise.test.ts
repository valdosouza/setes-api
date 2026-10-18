/// <reference types="jest" />
// Módulo merchandise — cadastro de PRODUTOS (mercadoria), onda 1 (Infra-IA/prompts/prompt_modulo_products.md §16; D-PR1…D-PR31).
// Mercadoria = tb_product kind P/M (D-PR4) + tb_merchandise + unidades de venda (migration 071). Prova: o módulo nunca enxerga serviço;
// o id sai da peça `@shared/product-id` com a trava da institution como 1º statement (D-PR2); código e GTIN únicos (D-PR7/D-PR19, só
// quando nascem ou mudam — A-PR1); níveis: base obrigatória, (unidade, fator) único (D-PR31), nível designado não sai (D-PR30).
import fs from 'fs'
import path from 'path'
import pool from '../shared/db/connection'
import { NO_CRITERIA } from '../shared/list'
import { isGtin } from '../shared/validation'
import { merchandiseDto, tradeUnitsDto } from '../modules/merchandise/merchandise.dto'
import * as repo from '../modules/merchandise/merchandise.repository'
import { ensureCatalogItem, linkCatalogItem, BRAND_CATALOG, MEASURE_CATALOG } from '../shared/central-catalog'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

type Route = [RegExp, (params: any[]) => any]

/** Conexão falsa que RESPONDE pelo texto do SQL (a ordem de consultas pode mudar sem quebrar o teste — o que se prova é o efeito). */
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

const sqlsOf = (conn: any): string[] => conn.query.mock.calls.map((c: any[]) => c[0] as string)

/** Rotas que satisfazem as referências do form (categoria P, marca/medida vinculadas, tabela de preço viva). */
const refsOk: Route[] = [
  [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
  [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]],
  [/FROM `setes_setes`\.tb_price_list WHERE id = \?/, () => [[{ 1: 1 }]]],
]

const input = (over: Record<string, unknown> = {}) => merchandiseDto.parse({
  description: 'Parafuso 8mm', categoryId: 3, brandId: 1, baseUnit: { measureId: 1 }, ...over,
})

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// DTO + validação (peça @shared/validation — vetor único TS × Dart)
// ---------------------------------------------------------------------

describe('merchandise dto', () => {
  it('mínimo válido; defaults P / origem 0 / finalidade 1 / ativo / grade vazia', () => {
    const d = input()
    expect(d.kind).toBe('P')
    expect(d.origin).toBe('0')
    expect(d.purpose).toBe('1')
    expect(d.active).toBe('S')
    expect(d.prices).toEqual([])
  })

  it('serviço nunca entra por aqui (kind S recusado — D5/D-PR4)', () => {
    expect(merchandiseDto.safeParse({ ...input(), kind: 'S' }).success).toBe(false)
  })

  it('NCM só pleno (8), CEST só 7; GTIN com DV GS1 na unidade-base', () => {
    expect(merchandiseDto.safeParse({ ...input(), ncm: '8471301' }).success).toBe(false)
    expect(merchandiseDto.safeParse({ ...input(), ncm: '84713012' }).success).toBe(true)
    expect(merchandiseDto.safeParse({ ...input(), cest: '010010' }).success).toBe(false)
    expect(merchandiseDto.safeParse({ ...input(), baseUnit: { measureId: 1, gtin: '7891234567894' } }).success).toBe(false)
    expect(merchandiseDto.safeParse({ ...input(), baseUnit: { measureId: 1, gtin: '7891234567895' } }).success).toBe(true)
  })

  it('marca e unidade-base obrigatórias (D-PR5/D-PR1)', () => {
    const { brandId: _b, ...noBrand } = input()
    expect(merchandiseDto.safeParse(noBrand).success).toBe(false)
    const { baseUnit: _u, ...noBase } = input()
    expect(merchandiseDto.safeParse(noBase).success).toBe(false)
  })

  it('grade de níveis: nível repetido ou vazia recusadas', () => {
    expect(tradeUnitsDto.safeParse({ levels: [] }).success).toBe(false)
    expect(tradeUnitsDto.safeParse({ levels: [
      { level: 1, measureId: 1, factor: 1 }, { level: 1, measureId: 2, factor: 2 },
    ] }).success).toBe(false)
  })

  it('isGtin bate o vetor único (gtin.vector.json — o espelho Dart lê o MESMO arquivo)', () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'validation', 'gtin.vector.json'), 'utf8')) as { valid: string[]; invalid: string[] }
    for (const g of vector.valid) expect([g, isGtin(g)]).toEqual([g, true])
    for (const g of vector.invalid) expect([g, isGtin(g)]).toEqual([g, false])
  })
})

// ---------------------------------------------------------------------
// repository — lista, ficha, criar/editar/excluir
// ---------------------------------------------------------------------

describe('merchandise repository', () => {
  it("lista: kind IN ('P','M'), página e COUNT com a MESMA where, GTIN exato no filtro rápido", async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await repo.listMerchandise({ filter: '7891234567895', page: 1, pageSize: 25, offset: 0, criteria: NO_CRITERIA } as any, 'setes_setes', 1)
    const [page, count] = mockQuery.mock.calls
    expect(page[0]).toContain("p.kind IN ('P', 'M')")
    // pela identidade GS1 (A-PR3): o GTIN-13 digitado procura a forma de 14 dígitos no `live_gtin`
    expect(page[0]).toContain('tu.live_gtin = ?')
    expect(page[1]).toContain('07891234567895')
    expect(count[0]).toContain("p.kind IN ('P', 'M')")
    expect(count[1]).toEqual(page[1].slice(0, count[1].length))
  })

  it('ficha: ST DERIVADA da presença do CEST (R5-Q5) e unidade-base pelo nível 1', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 9, cest: '0100100', buMeasureId: 1, buMeasureAbbreviation: 'UN', buGtin: null,
                                buPackageId: null, origin: '0', purpose: '1' }]])
      .mockResolvedValueOnce([[]]) // grade de preços
    const full = await repo.getMerchandise(9, 'setes_setes', 1)
    expect(full!.st).toBe(true)
    expect(full!.baseUnit).toMatchObject({ measureId: 1, measureAbbreviation: 'UN', gtin: null })
    expect(mockQuery.mock.calls[0][0]).toContain("p.kind IN ('P', 'M')")
  })

  it('criar: trava da institution é o 1º statement; MAX sem FOR UPDATE; nível base (1, fator 1); publicado nasce N', async () => {
    const conn = routedConn([
      [/setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ id: 1 }]]],
      [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_product/, () => [[{ nextId: 42 }]]],
      ...refsOk,
    ])
    const id = await repo.insertMerchandise(input({ kind: 'M', baseUnit: { measureId: 1, gtin: '7891234567895' } }), 'setes_setes', 1)
    expect(id).toBe(42)
    const sqls = sqlsOf(conn)
    expect(sqls[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)
    const max = sqls.find(s => s.includes('MAX(id)'))!
    expect(max).not.toContain('FOR UPDATE')
    const productInsert = conn.query.mock.calls.find((c: any[]) => (c[0] as string).includes('INSERT INTO `setes_setes`.tb_product'))
    expect(productInsert[0]).toContain("'N', 'N', 'N'")                  // promoção/destaque/publicado (D-PR27/D-PR29)
    expect(productInsert[1]).toEqual(expect.arrayContaining([42, '42', 'M'])) // identifier em branco = o id
    const base = conn.query.mock.calls.find((c: any[]) => (c[0] as string).includes('INSERT INTO `setes_setes`.tb_merchandise_trade_unit'))
    expect(base[0]).toContain('VALUES (?, ?, 1, ?, ?, 1, ?')
    expect(conn.commit).toHaveBeenCalled()
  })

  it('criar com código já usado: 409 PRODUCT_IDENTIFIER_TAKEN com o id do outro (D-PR7) e rollback', async () => {
    const conn = routedConn([
      [/MAX\(id\)/, () => [[{ nextId: 43 }]]],
      ...refsOk,
      [/WHERE tb_institution_id = \? AND identifier = \?/, () => [[{ id: 7 }]]],
    ])
    await expect(repo.insertMerchandise(input({ identifier: 'PAR-8' }), 'setes_setes', 1)).rejects.toMatchObject({
      statusCode: 409, code: 'PRODUCT_IDENTIFIER_TAKEN',
      fields: [{ field: 'identifier' }, { field: 'id', message: '7' }],
    })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('criar com GTIN vivo em OUTRO produto: 409 GTIN_TAKEN com o id do outro (D-PR19)', async () => {
    routedConn([
      [/MAX\(id\)/, () => [[{ nextId: 44 }]]],
      ...refsOk,
      // a identidade GS1 (A-PR3): a busca é pelo `live_gtin` (= LPAD(gtin, 14, '0') na 071) com o GTIN em 14 dígitos
      [/tb_merchandise_trade_unit\s+WHERE tb_institution_id = \? AND live_gtin = \?/,
        (params) => (params[1] === '07891234567895' ? [[{ id: 8 }]] : [[]])],
    ])
    await expect(repo.insertMerchandise(input({ baseUnit: { measureId: 1, gtin: '7891234567895' } }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'baseUnit.gtin' }, { message: '8' }] })
  })

  it('unidade não vinculada à institution: 422 CATALOG_ITEM_NOT_LINKED no campo do payload', async () => {
    routedConn([
      [/MAX\(id\)/, () => [[{ nextId: 45 }]]],
      [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
      [/tb_institution_has_brand l/, () => [[{ 1: 1 }]]],
      [/tb_institution_has_measure l/, () => [[]]],
    ])
    await expect(repo.insertMerchandise(input(), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_ITEM_NOT_LINKED', fields: [{ field: 'baseUnit.measureId' }] })
  })

  it('categoria de SERVIÇO não serve à mercadoria (a conferência exige kind P)', async () => {
    const conn = routedConn([[/MAX\(id\)/, () => [[{ nextId: 46 }]]]])
    await expect(repo.insertMerchandise(input(), 'setes_setes', 1)).rejects.toMatchObject({ statusCode: 400 })
    expect(sqlsOf(conn).find(s => s.includes('tb_category'))).toContain("kind = 'P'")
  })

  it("editar id de SERVIÇO devolve false (kind P/M no WHERE — nunca toca serviço)", async () => {
    const conn = routedConn([])
    expect(await repo.updateMerchandise(5, input(), 'setes_setes', 1)).toBe(false)
    expect(sqlsOf(conn)[0]).toContain("kind IN ('P', 'M') FOR UPDATE")
  })

  it('editar sem mudar o código: nenhuma trava da institution nem conferência (A-PR1)', async () => {
    const conn = routedConn([
      [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: 'PAR-8', categoryId: 3, financialPlansId: null }]]],
      [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]],
      ...refsOk,
    ])
    expect(await repo.updateMerchandise(5, input({ identifier: 'PAR-8' }), 'setes_setes', 1)).toBe(true)
    const sqls = sqlsOf(conn)
    expect(sqls.some(s => s.includes('setes_central.tb_institution'))).toBe(false)
    expect(sqls.some(s => s.includes('AND identifier = ?'))).toBe(false)
    // A-PR1 também nas referências: categoria e marca gravadas e inalteradas não são reconferidas (ADV-10 — legado com vínculo velho)
    expect(sqls.some(s => s.includes('.tb_category WHERE'))).toBe(false)
    expect(sqls.some(s => s.includes('tb_institution_has_brand'))).toBe(false)
    // PADROES §9 regra 9: uma leitura travante por TABELA (nunca LEFT JOIN travante), na ordem do escritor
    const lockedReads = sqls.filter(s => /FOR UPDATE/.test(s))
    expect(lockedReads.some(s => /LEFT JOIN/.test(s))).toBe(false)
    expect(lockedReads.findIndex(s => s.includes('.tb_product p'))).toBeLessThan(lockedReads.findIndex(s => s.includes('.tb_merchandise WHERE')))
  })

  it('editar mudando o código: trava da institution DEPOIS da própria linha e ANTES das leituras do form', async () => {
    const conn = routedConn([
      [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: 'VELHO', categoryId: 9, financialPlansId: null, brandId: 1 }]]],
      ...refsOk,
    ])
    await repo.updateMerchandise(5, input({ identifier: 'NOVO' }), 'setes_setes', 1)
    const sqls = sqlsOf(conn)
    const lock = sqls.findIndex(s => s.includes('setes_central.tb_institution'))
    const category = sqls.findIndex(s => s.includes('.tb_category WHERE'))
    expect(lock).toBeGreaterThan(0)
    expect(lock).toBeLessThan(category)
    expect(sqls.find(s => s.includes('AND identifier = ?'))).toContain('AND id <> ?')
  })

  it('D-PR40: a ficha não troca a unidade-base enquanto houver outro nível vivo (409 TRADE_UNIT_BASE_LOCKED)', async () => {
    const conn = routedConn([
      [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: 'PAR-8', categoryId: 3, financialPlansId: null }]]],
      [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]],
      [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, gtin, deleted/,
        () => [[{ level: 1, measureId: 1, packageId: null, gtin: null, deleted: 'N' }, { level: 2, measureId: 2, packageId: null, gtin: null, deleted: 'N' }]]],
      ...refsOk,
    ])
    await expect(repo.updateMerchandise(5, input({ identifier: 'PAR-8', baseUnit: { measureId: 3 } }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED', fields: [{ field: 'baseUnit.measureId' }] })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('excluir: soft delete do produto E dos níveis (o GTIN volta a ficar livre — D-PR11/D-PR19)', async () => {
    const conn = routedConn([[/UPDATE `setes_setes`\.tb_product SET deleted = 'S'/, () => [{ affectedRows: 1 }]]])
    expect(await repo.softDeleteMerchandise(5, 'setes_setes', 1)).toBe(true)
    const sqls = sqlsOf(conn)
    expect(sqls[0]).toContain("kind IN ('P', 'M')")
    expect(sqls.some(s => s.includes("tb_merchandise_trade_unit SET deleted = 'S'"))).toBe(true)
  })

  it('UNIQUE da 071 que estourar no INSERT puro do nível base vira 409 tipado com o dono do GTIN (corrida — nunca 500)', async () => {
    routedConn([
      [/live_gtin = \?.*LOCK IN SHARE MODE/s, () => [[{ id: 31 }]]],
      [/MAX\(id\)/, () => [[{ nextId: 47 }]]],
      ...refsOk,
      [/INSERT INTO `setes_setes`\.tb_merchandise_trade_unit/, () => {
        throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry '1-789' for key 'uq_mtu_live_gtin'" })
      }],
    ])
    await expect(repo.insertMerchandise(input({ baseUnit: { measureId: 1, gtin: '7891234567895' } }), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'baseUnit.gtin' }, { message: '31' }] })
  })
})

// ---------------------------------------------------------------------
// sub-rota "Unidades e GTIN" (§12.1)
// ---------------------------------------------------------------------

describe('merchandise trade units', () => {
  type Stored = { level: number; measureId?: number; packageId?: number | null; factor?: number; gtin?: string | null; deleted?: string }
  const existing = (rows: Stored[]): Route =>
    [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted/,
      () => [rows.map(r => ({ measureId: 1, packageId: null, factor: r.level === 1 ? 1 : r.level * 6, gtin: null, deleted: 'N', ...r }))]]
  const facts = (t: number | null = null, d: number | null = null): Route =>
    [/SELECT taxable_trade_level AS t, default_sale_trade_level AS d/, () => [[{ t, d }]]]
  const productOk: Route = [/SELECT p\.id FROM `setes_setes`\.tb_product p/, () => [[{ id: 5 }]]]
  const linkedOk: Route = [/tb_institution_has_(measure|package) l/, () => [[{ 1: 1 }]]]
  const save = (body: unknown) => repo.saveTradeUnits(5, tradeUnitsDto.parse(body), 'setes_setes', 1)

  it('a unidade-base (nível 1, fator 1) não sai da grade (D-PR15)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2 }]), linkedOk])
    await expect(save({ levels: [{ level: 2, measureId: 2, factor: 12 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_REQUIRED' })
  })

  it('mesma unidade E mesmo fator no produto: 409 TRADE_UNIT_DUPLICATE (D-PR31)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }]), linkedOk])
    await expect(save({ levels: [
      { level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 12 }, { measureId: 2, factor: 12 },
    ] })).rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_DUPLICATE', fields: [{ field: 'levels.2.factor' }] })
  })

  it('designação apontando nível que sai da grade: 409 TRADE_UNIT_DESIGNATED (D-PR30)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2 }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }], taxableTradeLevel: 2 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_DESIGNATED', fields: [{ field: 'taxableTradeLevel' }] })
  })

  it('nível numerado que não existe vivo: 422 TRADE_UNIT_NOT_FOUND', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2, deleted: 'S' }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }, { level: 2, measureId: 2, factor: 6 }] }))
      .rejects.toMatchObject({ statusCode: 422, code: 'TRADE_UNIT_NOT_FOUND' })
  })

  it('caminho feliz: nível NOVO numera depois do maior já usado (nunca reaproveita), o que saiu é soft-deletado, designações por último', async () => {
    const conn = routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2 }, { level: 3, deleted: 'S' }]), linkedOk])
    expect(await save({
      levels: [{ level: 1, measureId: 1, factor: 1, gtin: '7891234567895' }, { measureId: 2, factor: 12 }],
      taxableTradeLevel: 1, defaultSaleTradeLevel: 4,
    })).toBe(true)
    const calls = conn.query.mock.calls as any[][]
    const removed = calls.find(c => (c[0] as string).includes("SET deleted = 'S'"))!
    expect(removed[1]).toEqual([1, 5, [2]])
    // nunca upsert (conhecimento negativo da 071): o nível 1 que MUDA (ganhou GTIN) é UPDATE pela PK; o NOVO é INSERT puro
    const inserts = calls.filter(c => (c[0] as string).includes('INSERT INTO `setes_setes`.tb_merchandise_trade_unit'))
    expect(inserts.map(c => c[1][2])).toEqual([4])              // o novo é o 4 (o 3 excluído não volta)
    expect(inserts[0][0]).not.toContain('ON DUPLICATE KEY UPDATE')
    const updates = calls.filter(c => /UPDATE `setes_setes`\.tb_merchandise_trade_unit\s+SET tb_measure_id/.test(c[0] as string))
    expect(updates.map(c => c[1][c[1].length - 1])).toEqual([1])
    const last = calls[calls.length - 1]
    expect(last[0]).toContain('SET taxable_trade_level = ?, default_sale_trade_level = ?')
    expect(last[1].slice(0, 2)).toEqual([1, 4])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('produto sem ficha fiscal (legado sem tb_merchandise): 409 MERCHANDISE_FACTS_MISSING — nunca a FK em 500', async () => {
    routedConn([productOk, existing([{ level: 1 }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MERCHANDISE_FACTS_MISSING' })
  })

  it('designação AUSENTE no corpo = a gravada (A-PR2): o nível designado continua protegido pela D-PR30', async () => {
    routedConn([productOk, facts(2, null), existing([{ level: 1 }, { level: 2 }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_DESIGNATED', fields: [{ field: 'taxableTradeLevel' }] })
  })

  it('GTIN 13 × 14 dígitos na MESMA grade = o mesmo GTIN (identidade GS1 — A-PR3)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }]), linkedOk])
    await expect(save({ levels: [
      { level: 1, measureId: 1, factor: 1, gtin: '7891234567895' }, { measureId: 2, factor: 12, gtin: '07891234567895' },
    ] })).rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'levels.1.gtin' }] })
  })

  it('base excluída (legado): a sub-rota aponta a saída — salvar a ficha (ADV2-04)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1, deleted: 'S' }, { level: 2 }]), linkedOk])
    await expect(save({ levels: [{ level: 2, measureId: 2, factor: 12 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_REQUIRED', message: expect.stringContaining('salve a ficha') })
  })

  it('designação para nível que nunca existiu: 422 TRADE_UNIT_NOT_FOUND (não é "remoção" — ADV2-05)', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }], taxableTradeLevel: 99 }))
      .rejects.toMatchObject({ statusCode: 422, code: 'TRADE_UNIT_NOT_FOUND', fields: [{ field: 'taxableTradeLevel' }] })
  })

  it('nível novo com "level": null é aceito (o serializador manda a chave — ADV2-02)', () => {
    expect(tradeUnitsDto.safeParse({ levels: [{ level: 1, measureId: 1, factor: 1 }, { level: null, measureId: 2, factor: 12 }] }).success)
      .toBe(true)
  })

  it('D-PR40: trocar a unidade-BASE com outro nível existente mantido na grade = 409 TRADE_UNIT_BASE_LOCKED', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2, measureId: 2, factor: 12 }]), linkedOk])
    await expect(save({ levels: [{ level: 1, measureId: 3, factor: 1 }, { level: 2, measureId: 2, factor: 12 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_BASE_LOCKED', fields: [{ field: 'levels.0.measureId' }] })
  })

  it('D-PR40: trocar a base REMOVENDO os outros níveis na mesma grade passa (nível novo já nasce na base nova)', async () => {
    const conn = routedConn([productOk, facts(), existing([{ level: 1 }, { level: 2, measureId: 2, factor: 12 }]), linkedOk])
    expect(await save({ levels: [{ level: 1, measureId: 3, factor: 1 }, { measureId: 2, factor: 6 }] })).toBe(true)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('GTIN repetido dentro da própria grade: 409 GTIN_TAKEN', async () => {
    routedConn([productOk, facts(), existing([{ level: 1 }]), linkedOk])
    await expect(save({ levels: [
      { level: 1, measureId: 1, factor: 1, gtin: '7891234567895' }, { measureId: 2, factor: 12, gtin: '7891234567895' },
    ] })).rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN' })
  })
})

// ---------------------------------------------------------------------
// @shared/central-catalog (D-PR5/D-PR28)
// ---------------------------------------------------------------------

describe('central catalog (marca, unidade, embalagem)', () => {
  it('unidade: dedupe pela ABREVIAÇÃO (uCom/uTrib) — existente é reusada', async () => {
    const conn = routedConn([[/FROM setes_central\.tb_measure\s+WHERE UPPER\(TRIM\(abbreviation\)\) COLLATE utf8mb4_bin = UPPER\(TRIM\(\?\)\)/, () => [[{ id: 3 }]]]])
    expect(await ensureCatalogItem(conn, MEASURE_CATALOG, { description: 'Unidade nova', abbreviation: 'UN' }))
      .toEqual({ id: 3, reused: true })
    expect(sqlsOf(conn).some(s => s.includes('INSERT INTO'))).toBe(false)
  })

  it('marca nova: dedupe pela descrição não acha → MAX + 1 na central', async () => {
    const conn = routedConn([[/COALESCE\(MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_brand/, () => [[{ nextId: 12 }]]]])
    expect(await ensureCatalogItem(conn, BRAND_CATALOG, { description: 'Ciser' })).toEqual({ id: 12, reused: false })
    expect(sqlsOf(conn).some(s => s.includes('INSERT INTO setes_central.tb_brand'))).toBe(true)
  })

  it('vínculo: upsert ressuscita o desativado/excluído', async () => {
    const conn = routedConn([])
    await linkCatalogItem(conn, BRAND_CATALOG, 'setes_setes', 1, 12)
    expect(sqlsOf(conn)[0]).toContain("ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N'")
  })
})
