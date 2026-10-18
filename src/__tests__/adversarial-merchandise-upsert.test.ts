/// <reference types="jest" />
// GATE ADVERSARIAL — cadastro de produtos (mercadoria), onda 1 (2026-10-18). Achados ADV-01/ADV-02/ADV-08 do relatório.
//
// `tb_merchandise_trade_unit` (migration 071) tem TRÊS chaves únicas: a PK (institution, mercadoria, nível), `uq_mtu_live_gtin`
// (institution, GTIN vivo) e `uq_mtu_live_unit_factor` (institution, mercadoria, unidade, fator, vivo). Num `INSERT … ON DUPLICATE KEY
// UPDATE`, a colisão em QUALQUER chave única vira UPDATE da linha que colidiu — não erro. Provado em schema descartável com as funções
// reais do repositório (MariaDB 10.4, roteiro `probe-merchandise.ts` do gate):
//   · V6: PUT /:id/trade-units do produto B com o GTIN G enquanto o produto A grava G (transação ainda aberta) → B responde ok:true,
//         B fica SEM o nível novo e o nível 2 de A passa a ter a unidade/fator de B.
//   · V7: POST de C com G na base, na mesma corrida → 201, C nasce SEM unidade-base e o nível de A recebe a medida de C.
//   · V4: UMA requisição [novo KG×12, 1, 2→KG×24] (nível 2 era KG×12) → ok:true e o nível novo SOME (o upsert dele atualizou o 2).
//   · V3: dois níveis novos KG×12 e KG×12.0000001 (o DECIMAL(14,6) arredonda) → ok:true, um nível some e o GTIN do outro é trocado.
// A "rede de segurança" (`mapTradeUnitDup`) só dispara quando a colisão nasce do UPDATE de uma linha que JÁ existe — nunca no nível
// novo. O teste existente "UNIQUE da 071 que estourar vira 409 tipado" simula um INSERT que lança ER_DUP_ENTRY, coisa que o banco real
// NÃO faz para esse SQL (o mock afirma o que o banco não produz).
//
// Semântica fixada aqui: nível que NASCE é gravado por INSERT puro (a colisão vira ER_DUP_ENTRY → 409 tipado); só o nível que JÁ existe
// é atualizado pela PK. E o 409 da colisão (unidade, fator) ancora no campo do FATOR, não no do GTIN.
// Estado em 2026-10-18: os testes marcados [BUG] FALHAM — demonstram o defeito; passam quando a correção entrar.
import pool from '../shared/db/connection'
import { tradeUnitsDto, merchandiseDto } from '../modules/merchandise/merchandise.dto'
import * as repo from '../modules/merchandise/merchandise.repository'

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

const TU_INSERT = /INSERT INTO `setes_setes`\.tb_merchandise_trade_unit/
const productOk: Route = [/SELECT p\.id FROM `setes_setes`\.tb_product p/, () => [[{ id: 5 }]]]
const linkedOk: Route = [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]]
// (correção dos gates, 2026-10-18) a leitura dos níveis traz a linha inteira (o que MUDA é estacionado e regravado pela PK) e a ficha
// fiscal (`tb_merchandise`) é lida antes — dona das designações.
const existing = (rows: Array<{ level: number; measureId?: number; factor?: number; gtin?: string | null; deleted?: string }>): Route =>
  [/SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted/,
    () => [rows.map(r => ({ measureId: 1, packageId: null, factor: r.level === 1 ? 1 : r.level * 6, gtin: null, deleted: 'N', ...r }))]]
const facts: Route = [/SELECT taxable_trade_level AS t, default_sale_trade_level AS d/, () => [[{ t: null, d: null }]]]
const save = (body: unknown) => repo.saveTradeUnits(5, tradeUnitsDto.parse(body), 'setes_setes', 1)

beforeEach(() => jest.clearAllMocks())

describe('ADV-01/ADV-02 — nível que NASCE nunca por upsert (3 chaves únicas na 071)', () => {
  it('[BUG] sub-rota: o nível NOVO é gravado por INSERT puro — sem ON DUPLICATE KEY UPDATE (senão atualiza o nível de OUTRO produto)', async () => {
    const conn = routedConn([productOk, facts, existing([{ level: 1 }]), linkedOk])
    expect(await save({ levels: [{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 12, gtin: '7891234567895' }] })).toBe(true)
    const insertNew = (conn.query.mock.calls as any[][]).find(c => TU_INSERT.test(c[0]) && c[1][2] === 2)
    expect(insertNew).toBeDefined()
    expect(insertNew![0]).not.toMatch(/ON DUPLICATE KEY UPDATE/)
  })

  it('[BUG] criar produto: o nível base (linha nova) é gravado por INSERT puro — corrida de GTIN vira 409, nunca 201 sem unidade-base', async () => {
    const conn = routedConn([
      [/MAX\(id\), 0\) \+ 1 AS nextId/, () => [[{ nextId: 42 }]]],
      [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
      linkedOk,
    ])
    await repo.insertMerchandise(merchandiseDto.parse({
      description: 'X', categoryId: 3, brandId: 1, baseUnit: { measureId: 1, gtin: '7891234567895' },
    }), 'setes_setes', 1)
    const baseInsert = (conn.query.mock.calls as any[][]).find(c => TU_INSERT.test(c[0]))
    expect(baseInsert).toBeDefined()
    expect(baseInsert![0]).not.toMatch(/ON DUPLICATE KEY UPDATE/)
  })

  it('[BUG] ADV-08: colisão (unidade, fator) que o banco acusar ancora no campo do FATOR do nível — não no GTIN', async () => {
    // o nível 2 JÁ existe (KG×12 gravado como UN×12 — muda): é regravado por UPDATE pela PK — a colisão que o banco acusar vem DESSE
    // statement (o último parâmetro é o nível)
    routedConn([productOk, facts, existing([{ level: 1 }, { level: 2 }]), linkedOk,
      [/UPDATE `setes_setes`\.tb_merchandise_trade_unit\s+SET tb_measure_id/, (params) => {
        if (params[params.length - 1] === 2) {
          throw Object.assign(new Error('dup'), {
            code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry '1-5-2-12.000000-1' for key 'uq_mtu_live_unit_factor'",
          })
        }
        return [{ affectedRows: 1 }]
      }],
    ])
    await expect(save({ levels: [{ level: 1, measureId: 1, factor: 1 }, { level: 2, measureId: 2, factor: 12 }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRADE_UNIT_DUPLICATE', fields: [{ field: 'levels.1.factor' }] })
  })
})

describe('guardas que SE SUSTENTARAM no ataque (fixam a semântica correta)', () => {
  it('troca de GTIN entre dois níveis do MESMO produto: os níveis que mudam são ESTACIONADOS antes da regravação (sem colisão transitória)', async () => {
    const A = '7891234567895', B = '7891000315507'
    const conn = routedConn([productOk, facts, existing([{ level: 1 }, { level: 2, gtin: A }, { level: 3, gtin: B }]), linkedOk])
    expect(await save({ levels: [
      { level: 1, measureId: 1, factor: 1 }, { level: 2, measureId: 2, factor: 12, gtin: B }, { level: 3, measureId: 2, factor: 24, gtin: A },
    ] })).toBe(true)
    const calls = conn.query.mock.calls as any[][]
    // (correção dos gates) antes "soltava o GTIN" (SET gtin = NULL); agora estaciona a linha inteira (deleted = 'S' tira GTIN e
    // (unidade, fator) dos UNIQUE) e regrava cada uma pela PK — cobre também a troca de (unidade, fator) entre níveis (ADV-08)
    const park = calls.findIndex(c => /SET deleted = 'S'\s+WHERE/.test(c[0]) && !/updated_at/.test(c[0]))
    const firstWrite = calls.findIndex(c => /UPDATE `setes_setes`\.tb_merchandise_trade_unit\s+SET tb_measure_id/.test(c[0]))
    expect(park).toBeGreaterThan(-1)
    expect(calls[park][1]).toEqual([1, 5, [2, 3]])
    expect(park).toBeLessThan(firstWrite)
    expect(calls.some(c => TU_INSERT.test(c[0]))).toBe(false)
  })

  it('id de SERVIÇO na sub-rota e no painel: 404 (o existe-mercadoria filtra kind P/M)', async () => {
    mockQuery.mockResolvedValue([[]])
    expect(await repo.getTradeUnits(5000, 'setes_setes', 1)).toBeNull()
    expect(await repo.getLinks(5000, 'setes_setes', 1)).toBeNull()
    expect(mockQuery.mock.calls[0][0]).toContain("p.kind IN ('P', 'M')")
    routedConn([])
    expect(await save({ levels: [{ level: 1, measureId: 1, factor: 1 }] })).toBe(false)
  })
})
