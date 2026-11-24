/// <reference types="jest" />
// IBS.E9.P3 — a regra de tributação de mercadoria traz a classificação de IBS/CBS (`tb_tax_rule_ibscbs`).
// Peça 1:1 (presença = a regra define IBS/CBS), só o cClassTrib; o cadastro confere existência e vigência (D-IB136).
import pool from '../shared/db/connection'
import { loadPieces, savePieces } from '../shared/tax-rule'
import { taxRuleBodyDto } from '../modules/tax-rules/tax-rules.dto'
import { NO_CRITERIA, compileCriteria } from '../shared/list'
import * as repo from '../modules/tax-rules/tax-rules.repository'
import * as service from '../modules/tax-rules/tax-rules.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/time-zone', () => ({
  __esModule: true,
  todayFor: jest.fn().mockResolvedValue('2026-11-23'),
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

/** Linha vigente do catálogo central para o código de exemplo (o SELECT de `findClassificationAt`). */
const LINE_000001 = {
  code: '000001', cst: '000', name: 'Situações tributadas integralmente pelo IBS e CBS',
  validFrom: '2026-01-01', validUntil: null, requiresRegular: 'N', absentSince: null, applicable: 0, requiresGroup: 'S',
}

const selector = { origin: '0', direction: 'S' as const, finalConsumer: 'N' as const, simples: 'N' as const,
  st: 'N' as const, purpose: '0' as const }

const sqlOf = (call: any[]): string => String(call[0]).replace(/\s+/g, ' ')

beforeEach(() => {
  jest.clearAllMocks()
  mockQuery.mockReset()
  mockGetConnection.mockReset()
})

describe('loadPieces / savePieces — a peça ibscbs', () => {
  it('loadPieces devolve a classificação quando a linha está viva (6ª consulta, só deleted = N)', async () => {
    mockQuery
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ classificationCode: '000001' }]])
    const pieces = await loadPieces('setes_setes', 7)
    expect(pieces).toEqual({ ibscbs: { classificationCode: '000001' } })
    expect(mockQuery).toHaveBeenCalledTimes(6)
    const last = mockQuery.mock.calls[5]
    expect(sqlOf(last)).toContain("FROM `setes_setes`.tb_tax_rule_ibscbs WHERE id = ? AND deleted = 'N'")
    expect(last[1]).toEqual([7])
  })

  it('loadPieces sem linha viva não devolve a chave (ausência = a regra não define IBS/CBS)', async () => {
    mockQuery.mockResolvedValue([[]])
    const pieces = await loadPieces('setes_setes', 7)
    expect(pieces).toEqual({})
    expect('ibscbs' in pieces).toBe(false)
  })

  const softDeletedOf = (conn: { query: jest.Mock }) =>
    conn.query.mock.calls.map(c => /\.(tb_tax_rule_\w+) SET deleted = 'S'/.exec(sqlOf(c))?.[1]).filter(Boolean)
  const SIBLINGS = ['tb_tax_rule_icms', 'tb_tax_rule_icms_st', 'tb_tax_rule_ipi', 'tb_tax_rule_pis_cofins', 'tb_tax_rule_ii']

  it('savePieces com a peça: as irmãs são substituídas e a classificação é gravada por upsert (ressuscita a linha)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await savePieces(conn, 'setes_setes', 7, { ibscbs: { classificationCode: '000001' } })
    expect(conn.query).toHaveBeenCalledTimes(6)
    expect(softDeletedOf(conn)).toEqual(SIBLINGS)
    const upsert = conn.query.mock.calls[5]
    expect(sqlOf(upsert)).toContain('INSERT INTO `setes_setes`.tb_tax_rule_ibscbs (id, classification_code, created_at, updated_at, deleted)')
    expect(sqlOf(upsert)).toContain("ON DUPLICATE KEY UPDATE classification_code = VALUES(classification_code), deleted = 'N'")
    expect(upsert[1]).toEqual([7, '000001'])
  })

  it('D-IB137 — savePieces SEM a chave: a classificação gravada não é tocada (nem apagada, nem regravada)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await savePieces(conn, 'setes_setes', 7, { ipi: { cst: '50', aliq: 0 } })
    expect(softDeletedOf(conn)).toEqual(SIBLINGS)
    expect(conn.query.mock.calls.some(c => sqlOf(c).includes('tb_tax_rule_ibscbs'))).toBe(false)
  })

  it('D-IB137 — savePieces com `ibscbs: null`: remove a classificação (soft-delete), sem gravar', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await savePieces(conn, 'setes_setes', 7, { ipi: { cst: '50', aliq: 0 }, ibscbs: null })
    expect(softDeletedOf(conn)).toEqual([...SIBLINGS, 'tb_tax_rule_ibscbs'])
    expect(conn.query.mock.calls.some(c => sqlOf(c).includes('INSERT INTO `setes_setes`.tb_tax_rule_ibscbs'))).toBe(false)
  })
})

describe('taxRuleBodyDto — ibscbs', () => {
  it('regra só com a classificação é aceita (a peça conta como "a regra define um tributo")', () => {
    const parsed = taxRuleBodyDto.safeParse({ selector, ibscbs: { classificationCode: '000001' } })
    expect(parsed.success).toBe(true)
  })

  it('sem peça nenhuma continua recusada', () => {
    expect(taxRuleBodyDto.safeParse({ selector }).success).toBe(false)
    expect(taxRuleBodyDto.safeParse({ selector, ibscbs: null }).success).toBe(false)
  })

  it.each(['00001', '0000001', '00000A', '', ' 00001'])('classificationCode %p é recusado pelo schema (6 dígitos)', code => {
    const parsed = taxRuleBodyDto.safeParse({ selector, ibscbs: { classificationCode: code } })
    expect(parsed.success).toBe(false)
  })

  it('o corpo não aceita CST, alíquota nem redução na peça (chaves a mais são descartadas)', () => {
    const parsed = taxRuleBodyDto.safeParse(
      { selector, ibscbs: { classificationCode: '000001', cst: '000', aliq: 1, aliqReduction: 60 } })
    expect(parsed.success).toBe(true)
    expect((parsed as any).data.ibscbs).toEqual({ classificationCode: '000001' })
  })
})

describe('cadastro — conferência da classificação (D-IB136: existência e vigência)', () => {
  const body = (code: string) => taxRuleBodyDto.parse({ selector, ibscbs: { classificationCode: code } })

  /** Conexão simulada da cascata: MAX+1 e gravações. */
  function connOk() {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn().mockImplementation(async (sql: string) =>
        /MAX\(/i.test(sql) ? [[{ nextId: 12, next: 12, id: 12 }]] : [{ affectedRows: 1 }]),
    }
    mockGetConnection.mockResolvedValue(conn)
    return conn
  }

  it('código sem linha vigente hoje → 422 IBSCBS_CLASSIFICATION_NOT_FOUND, sem abrir transação', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes('tb_tax_ibscbs_classification_validity') ? [[]] : [[]])
    await expect(service.createTaxRule('setes_setes', 1, body('999999'))).rejects.toMatchObject({
      statusCode: 422, code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
      fields: [expect.objectContaining({ field: 'ibscbs.classificationCode' })],
    })
    expect(mockGetConnection).not.toHaveBeenCalled()
    const probe = mockQuery.mock.calls.find(c => String(c[0]).includes('tb_tax_ibscbs_classification_validity'))!
    expect(probe[1]).toEqual(['55', '999999', '2026-11-23', '2026-11-23'])
  })

  it('a edição passa pela mesma conferência', async () => {
    mockQuery.mockResolvedValue([[]])
    await expect(service.editTaxRule('setes_setes', 1, 12, body('999999'))).rejects.toMatchObject({
      statusCode: 422, code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
    })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('código vigente grava a peça — mesmo sem a marca do modelo 55 (applicable = 0 é ignorado)', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes('tb_tax_ibscbs_classification_validity') ? [[LINE_000001]] : [[]])
    const conn = connOk()
    await service.createTaxRule('setes_setes', 1, body('000001'))
    const upsert = conn.query.mock.calls.find(c => sqlOf(c).includes('INSERT INTO `setes_setes`.tb_tax_rule_ibscbs'))
    expect(upsert).toBeDefined()
    expect(upsert![1][1]).toBe('000001')
    expect(conn.commit).toHaveBeenCalled()
  })

  it('D-IB137 — edição pela tela que não conhece o campo (corpo sem `ibscbs`): a classificação gravada fica; com null, sai', async () => {
    mockQuery.mockResolvedValue([[{ id: '50' }]])
    const conn = connOk()
    const withoutKey = taxRuleBodyDto.parse({ selector, ipi: { cst: '50', aliq: 0 } })
    expect('ibscbs' in withoutKey && withoutKey.ibscbs !== undefined).toBe(false)
    await service.editTaxRule('setes_setes', 1, 12, withoutKey)
    expect(conn.query.mock.calls.some(c => sqlOf(c).includes('tb_tax_rule_ibscbs'))).toBe(false)

    const conn2 = connOk()
    await service.editTaxRule('setes_setes', 1, 12, taxRuleBodyDto.parse({ selector, ipi: { cst: '50', aliq: 0 }, ibscbs: null }))
    expect(conn2.query.mock.calls.some(c => /tb_tax_rule_ibscbs SET deleted = 'S'/.test(sqlOf(c)))).toBe(true)
  })

  it('regra sem a peça não consulta o catálogo de IBS/CBS', async () => {
    mockQuery.mockResolvedValue([[{ id: '00' }]])
    connOk()
    await service.createTaxRule('setes_setes', 1,
      taxRuleBodyDto.parse({ selector, ipi: { cst: '50', aliq: 0 } }))
    expect(mockQuery.mock.calls.some(c => String(c[0]).includes('tb_tax_ibscbs_classification_validity'))).toBe(false)
  })
})

describe('repositório — lista e exclusão', () => {
  it('a lista traz hasIbscbs pela presença da peça viva', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, origin: '0', purpose: '0', st: 'N', finalConsumer: 'N', simples: 'N',
        hasIcms: 1, hasIcmsSt: 0, hasIpi: 0, hasPisCofins: 0, hasIi: 0, hasIbscbs: 1 }]])
      .mockResolvedValueOnce([[{ total: 1 }]])
    const page = await repo.listTaxRules('setes_setes', 1,
      { filter: '', pageSize: 20, offset: 0, criteria: NO_CRITERIA } as any)
    expect(page.rows[0].hasIbscbs).toBe(true)
    const sql = sqlOf(mockQuery.mock.calls[0])
    expect(sql).toContain("LEFT JOIN `setes_setes`.tb_tax_rule_ibscbs ibscbs ON ibscbs.id = r.id AND ibscbs.deleted = 'N'")
    expect(sql).toContain('(ibscbs.id IS NOT NULL) AS hasIbscbs')
  })

  it('o critério hasIbscbs da pesquisa avançada usa a MESMA expressão da coluna', () => {
    const criteria = compileCriteria(JSON.stringify({ hasIbscbs: true }), repo.TAX_RULE_SEARCH_CRITERIA)
    expect(criteria.sql).toContain('ibscbs.id IS NOT NULL')
  })

  it('excluir a regra faz o soft-delete da peça na mesma transação', async () => {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
    }
    mockGetConnection.mockResolvedValue(conn)
    await repo.deleteTaxRuleCascade('setes_setes', 1, 12)
    const tables = conn.query.mock.calls.map(c => /\.(tb_tax_rule\w*) SET deleted = 'S'/.exec(sqlOf(c))?.[1])
    expect(tables).toEqual(['tb_tax_rule', 'tb_tax_rule_icms', 'tb_tax_rule_icms_st', 'tb_tax_rule_ipi',
      'tb_tax_rule_pis_cofins', 'tb_tax_rule_ii', 'tb_tax_rule_ibscbs'])
    expect(conn.commit).toHaveBeenCalled()
  })
})
