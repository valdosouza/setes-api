/// <reference types="jest" />
// setes-api:IBS.E9.P5 (D-IB138, D-IB140): o PERCENTUAL do Simples no IBS/CBS por estabelecimento e mês, na peça
// @shared/ibscbs-simples-rate, com o banco SIMULADO (a tabela é a da migration 084; ver ibscbs-simples-migration.test.ts).
import {
  isSimplesCompetence, simplesCompetenceOf, simplesRateAt, listSimplesRates, createSimplesRate, changeSimplesRate,
  removeSimplesRate, assertIbscbsSimplesChecks, simplesMissingChecks, SIMPLES_EXPECTED_CHECKS,
} from '../shared/ibscbs-simples-rate'
import { ErrorCodes } from '../shared/errors/error-codes'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
const pool = jest.requireMock('../shared/db/connection').default as { query: jest.Mock; getConnection: jest.Mock }

const TABLE = 'setes_acme.tb_establishment_simples_rate'

/** Conexão de transação simulada: INSERT/UPDATE/SELECT … FOR UPDATE respondem pelo `opts`. */
function fakeTxConn(opts: { insertError?: unknown; lockRow?: { deleted: string } | null; affectedRows?: number } = {}) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/^\s*INSERT/.test(sql)) { if (opts.insertError) throw opts.insertError; return [{ affectedRows: 1 }] }
      if (/FOR UPDATE/.test(sql)) return [opts.lockRow ? [opts.lockRow] : []]
      if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: opts.affectedRows ?? 1 }]
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  }
  pool.getConnection.mockResolvedValue(conn)
  return conn
}
const sqlOf = (conn: { query: jest.Mock }) => conn.query.mock.calls.map(c => String(c[0]))
const dup = { code: 'ER_DUP_ENTRY' }

beforeEach(() => jest.clearAllMocks())

describe('o mês', () => {
  it('só AAAA-MM com mês 01 a 12', () => {
    for (const ok of ['2027-01', '2027-12', '2026-11']) expect(isSimplesCompetence(ok)).toBe(true)
    for (const bad of ['2027-13', '2027-00', '27-01', '2027-1', '2027-01-15', '', null, 202701]) expect(isSimplesCompetence(bad)).toBe(false)
  })

  it('o mês da data de emissão (A-IB138a); data malformada falha fechado', () => {
    expect(simplesCompetenceOf('2027-01-15')).toBe('2027-01')
    expect(simplesCompetenceOf('2027-12-31')).toBe('2027-12')
    expect(() => simplesCompetenceOf('2027-02')).toThrow()
    expect(() => simplesCompetenceOf('15/01/2027')).toThrow()
  })
})

describe('simplesRateAt — a leitura do mês (D-IB140: sem linha = sem percentual)', () => {
  it('lê o texto exato do banco e devolve milionésimos: 0.1000 → 1000 e 0.9000 → 9000', async () => {
    const q = { query: jest.fn().mockResolvedValue([[{ competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000' }]]) }
    const rate = await simplesRateAt(q, 'setes_acme', 7, '2027-01')
    expect(rate).toEqual({ competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', ibsPpm: 1000, cbsPpm: 9000 })
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/CAST\(ibs_rate AS CHAR\)/)       // texto do banco, nunca número (decimalNumbers) em ponto flutuante
    expect(sql).toMatch(/deleted = 'N'/)
    expect(params).toEqual([TABLE, 7, '2027-01'])
  })

  it('percentuais com 4 casas e inteiros: 8.7000 → 87000; 12.3456 → 123456; 0.0000 → 0; 100.0000 → 1000000', async () => {
    const q = { query: jest.fn()
      .mockResolvedValueOnce([[{ competence: '2027-02', ibsRate: '8.7000', cbsRate: '12.3456' }]])
      .mockResolvedValueOnce([[{ competence: '2027-03', ibsRate: '0.0000', cbsRate: '100.0000' }]]) }
    expect(await simplesRateAt(q, 's', 1, '2027-02')).toMatchObject({ ibsPpm: 87000, cbsPpm: 123456 })
    expect(await simplesRateAt(q, 's', 1, '2027-03')).toMatchObject({ ibsPpm: 0, cbsPpm: 1_000_000 })
  })

  it('mês sem linha viva → null (o faturamento recusa); competência malformada falha fechado', async () => {
    const q = { query: jest.fn().mockResolvedValue([[]]) }
    expect(await simplesRateAt(q, 's', 1, '2027-01')).toBeNull()
    await expect(simplesRateAt(q, 's', 1, '2027-13')).rejects.toThrow()
    expect(q.query).toHaveBeenCalledTimes(1)
  })

  it('a lista traz os meses vivos do mais novo para o mais antigo', async () => {
    pool.query.mockResolvedValue([[
      { competence: '2027-02', ibsRate: '0.2000', cbsRate: '0.8000' },
      { competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000' },
    ]])
    const list = await listSimplesRates('setes_acme', 7)
    expect(list.map(r => r.competence)).toEqual(['2027-02', '2027-01'])
    expect(String(pool.query.mock.calls[0][0])).toMatch(/ORDER BY competence DESC/)
  })
})

describe('cadastro (createSimplesRate)', () => {
  const ok = { competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000' }

  it('grava com o texto do percentual, o usuário e as auditorias', async () => {
    const conn = fakeTxConn()
    await createSimplesRate('setes_acme', 7, 3, ok)
    const insert = conn.query.mock.calls.find(c => /INSERT/.test(String(c[0])))!
    expect(insert[1]).toEqual([TABLE, 7, '2027-01', '0.1000', '0.9000', 3])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('valor do banco como número (0.1) vira texto "0.1" e depois 1000 milionésimos — nunca conta em ponto flutuante', async () => {
    const conn = fakeTxConn()
    await createSimplesRate('setes_acme', 7, 3, { competence: '2027-01', ibsRate: 0.1, cbsRate: 0.9 })
    expect(conn.query.mock.calls.find(c => /INSERT/.test(String(c[0])))![1]).toEqual([TABLE, 7, '2027-01', '0.1', '0.9', 3])
    const q = { query: jest.fn().mockResolvedValue([[{ competence: '2027-01', ibsRate: '0.1', cbsRate: '0.9' }]]) }
    expect(await simplesRateAt(q, 's', 1, '2027-01')).toMatchObject({ ibsPpm: 1000, cbsPpm: 9000 })
  })

  const refusals: Array<[string, Record<string, unknown>]> = [
    ['mês 2027-13', { competence: '2027-13', ibsRate: '0.1', cbsRate: '0.9' }],
    ['mês 27-01', { competence: '27-01', ibsRate: '0.1', cbsRate: '0.9' }],
    ['percentual acima de 100 (100.0001)', { competence: '2027-01', ibsRate: '100.0001', cbsRate: '0.9' }],
    ['percentual negativo (-0.1)', { competence: '2027-01', ibsRate: '-0.1', cbsRate: '0.9' }],
    ['mais de 4 casas (0.12345)', { competence: '2027-01', ibsRate: 0.12345, cbsRate: '0.9' }],
    ['texto que não é número', { competence: '2027-01', ibsRate: 'abc', cbsRate: '0.9' }],
    ['CBS acima de 100', { competence: '2027-01', ibsRate: '0.1', cbsRate: 101 }],
  ]
  it.each(refusals)('recusa %s com 400 IBSCBS_SIMPLES_RATE_INVALID, sem abrir transação', async (_label, input) => {
    await expect(createSimplesRate('setes_acme', 7, 3, input as any)).rejects.toMatchObject({
      statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_RATE_INVALID,
    })
    expect(pool.getConnection).not.toHaveBeenCalled()
  })

  it('número JSON que o arredondamento a 10 casas mudaria (1e-11) é recusado, não vira 0% em silêncio; a cauda binária (0.1 + 0.2) é aceita como 0.3', async () => {
    await expect(createSimplesRate('setes_acme', 7, 3, { competence: '2027-01', ibsRate: 1e-11, cbsRate: '0.9' })).rejects.toMatchObject({
      statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_RATE_INVALID,
    })
    const conn = fakeTxConn()
    await createSimplesRate('setes_acme', 7, 3, { competence: '2027-01', ibsRate: 0.1 + 0.2, cbsRate: '0.9' })
    expect(conn.query.mock.calls.find(c => /INSERT/.test(String(c[0])))![1]).toEqual([TABLE, 7, '2027-01', '0.3', '0.9', 3])
  })

  it('aceita as bordas: 0, 100 e 99.9999', async () => {
    const conn = fakeTxConn()
    await createSimplesRate('setes_acme', 7, 3, { competence: '2027-01', ibsRate: 0, cbsRate: 100 })
    await createSimplesRate('setes_acme', 7, 3, { competence: '2027-02', ibsRate: '99.9999', cbsRate: '0.0001' })
    expect(conn.query.mock.calls.filter(c => /INSERT/.test(String(c[0])))).toHaveLength(2)
  })

  it('mês já cadastrado e vivo → 409 IBSCBS_SIMPLES_RATE_DUPLICATE (e a transação desfaz)', async () => {
    const conn = fakeTxConn({ insertError: dup, lockRow: { deleted: 'N' } })
    await expect(createSimplesRate('setes_acme', 7, 3, ok)).rejects.toMatchObject({
      statusCode: 409, code: ErrorCodes.IBSCBS_SIMPLES_RATE_DUPLICATE,
    })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('mês excluído (soft) é REVIVIDO na mesma linha, regravando tudo (PADROES §3.1)', async () => {
    const conn = fakeTxConn({ insertError: dup, lockRow: { deleted: 'S' } })
    await createSimplesRate('setes_acme', 7, 3, ok)
    const update = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(String(update[0])).toMatch(/created_at = NOW\(\).*deleted = 'N'/s)
    expect(String(update[0])).toMatch(/deleted = 'S'$/)   // só revive linha excluída
    expect(update[1]).toEqual([TABLE, '0.1000', '0.9000', 3, 7, '2027-01'])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('erro de banco que não é chave duplicada sobe como veio', async () => {
    fakeTxConn({ insertError: new Error('boom') })
    await expect(createSimplesRate('setes_acme', 7, 3, ok)).rejects.toThrow('boom')
  })
})

describe('alterar e excluir (qualquer mês, A-IB138g)', () => {
  it('altera o mês vivo; mês sem linha viva → 404 IBSCBS_SIMPLES_RATE_NOT_FOUND', async () => {
    const conn = fakeTxConn()
    await changeSimplesRate('setes_acme', 7, 3, { competence: '2026-12', ibsRate: '0.5', cbsRate: '0.5' })   // mês passado é permitido
    expect(sqlOf(conn).some(s => /^\s*UPDATE/.test(s) && /deleted = 'N'/.test(s))).toBe(true)
    fakeTxConn({ affectedRows: 0 })
    await expect(changeSimplesRate('setes_acme', 7, 3, { competence: '2027-05', ibsRate: '0.5', cbsRate: '0.5' }))
      .rejects.toMatchObject({ statusCode: 404, code: ErrorCodes.IBSCBS_SIMPLES_RATE_NOT_FOUND })
  })

  it('exclui por soft-delete (nunca DELETE); mês sem linha viva → 404; mês malformado → 400', async () => {
    const conn = fakeTxConn()
    await removeSimplesRate('setes_acme', 7, 3, '2027-01')
    expect(sqlOf(conn).join('\n')).toMatch(/SET deleted = 'S'/)
    expect(sqlOf(conn).join('\n')).not.toMatch(/DELETE\s+FROM/i)
    fakeTxConn({ affectedRows: 0 })
    await expect(removeSimplesRate('setes_acme', 7, 3, '2027-05')).rejects.toMatchObject({ statusCode: 404 })
    await expect(removeSimplesRate('setes_acme', 7, 3, '2027-5')).rejects.toMatchObject({
      statusCode: 400, code: ErrorCodes.IBSCBS_SIMPLES_RATE_INVALID,
    })
  })
})

describe('boot — as guardas da migration 084', () => {
  const all = SIMPLES_EXPECTED_CHECKS.map(([t, n]) => ({ t, n }))

  it('são seis CHECKs, nas quatro tabelas da 084', () => {
    expect(SIMPLES_EXPECTED_CHECKS).toHaveLength(6)
    expect(new Set(SIMPLES_EXPECTED_CHECKS.map(([t]) => t))).toEqual(
      new Set(['tb_establishment_simples_rate', 'tb_entity_tax', 'tb_merchandise', 'tb_order_item_ibscbs_simples']))
  })

  it('todos presentes: sobe e conta os schemas', async () => {
    const q = { query: jest.fn()
      .mockResolvedValueOnce([[{ s: 'setes_a' }, { s: 'setes_b' }]])
      .mockResolvedValue([all]) }
    expect(await assertIbscbsSimplesChecks(q)).toBe('6 CHECK(s) em 2 schema(s)')
  })

  it('um CHECK faltando num schema: NÃO sobe, e o erro diz qual e onde', async () => {
    const q = { query: jest.fn()
      .mockResolvedValueOnce([[{ s: 'setes_a' }]])
      .mockResolvedValueOnce([all.filter(r => r.n !== 'ck_merchandise_simples_activity')]) }
    await expect(assertIbscbsSimplesChecks(q)).rejects.toThrow(/setes_a: tb_merchandise\.ck_merchandise_simples_activity ausente/)
    expect(await simplesMissingChecks({ query: jest.fn().mockResolvedValue([[]]) }, 'x')).toHaveLength(6)
  })
})
