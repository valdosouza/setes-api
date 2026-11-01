/// <reference types="jest" />
// Fase IBS/CBS, D-IB99/D-IB100 (prompt_fase_ibs_cbs.md §14): a OPÇÃO de apuração do IBS/CBS do Simples (regApIBSCBSSN), fato DATADO
// do estabelecimento na peça @shared/ibscbs-assessment. Aqui a peça com o banco SIMULADO; a prova contra o MariaDB (CHECK, trava,
// revive) é `scripts/prove-ibscbs-assessment.ts` em schema descartável.
import {
  IBSCBS_ASSESSMENTS, IBSCBS_ASSESSMENTS_SUPPORTED, IBSCBS_REGULAR_ASSESSMENT_START, IBSCBS_ASSESSMENT_LABELS,
  isIsoDate, isIbscbsAssessment, isAssessmentSupported, ibscbsAssessmentAt, assessmentRefusalOf, assertIbscbsAssessmentSupported,
  previewIbscbsAssessmentRefusal, readIbscbsAssessmentView, createIbscbsAssessment, changeIbscbsAssessment, removeIbscbsAssessment,
  assertIbscbsAssessmentChecks, normalizeCheckClause, EXPECTED_CHECK_CLAUSE,
} from '../shared/ibscbs-assessment'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
const pool = jest.requireMock('../shared/db/connection').default as { query: jest.Mock; getConnection: jest.Mock }
const tz = jest.requireMock('@shared/time-zone') as { todayFor: jest.Mock }

const TABLE = 'setes_acme.tb_establishment_ibscbs_assessment'

/** Conexão de transação simulada: `rows` responde às leituras pela ordem; INSERT/UPDATE registram. */
function fakeTxConn(opts: { insertError?: unknown; lockRow?: { assessment: string; deleted: string } | null } = {}) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/^\s*SELECT 1 AS ok/.test(sql)) return [opts.lockRow ? [{ ok: 1 }] : []]   // a linha existe? (escolhe o caminho)
      if (/^\s*INSERT/.test(sql)) { if (opts.insertError) throw opts.insertError; return [{ affectedRows: 1 }] }
      if (/FOR UPDATE/.test(sql)) return [opts.lockRow ? [opts.lockRow] : []]
      if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }]
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  }
  pool.getConnection.mockResolvedValue(conn)
  return conn
}
const sqlOf = (conn: { query: jest.Mock }) => conn.query.mock.calls.map(c => String(c[0]))

beforeEach(() => {
  jest.clearAllMocks()
  tz.todayFor.mockResolvedValue('2026-11-01')
})

describe('domínio e regra (D-IB99)', () => {
  it('domínio da NT 009; só a 1 é suportada hoje; piso legal do regular em 01/01/2027', () => {
    expect([...IBSCBS_ASSESSMENTS]).toEqual(['1', '2', '3'])
    expect([...IBSCBS_ASSESSMENTS_SUPPORTED]).toEqual(['1'])
    expect(IBSCBS_REGULAR_ASSESSMENT_START).toBe('2027-01-01')
    // rótulo oficial da NT 009 (a D-IB99 descreveu a opção 2 ao contrário — vale a NT)
    expect(IBSCBS_ASSESSMENT_LABELS['2']).toMatch(/CBS apurada pelo Simples Nacional e IBS pelo regime regular/)
    expect(isIbscbsAssessment('2')).toBe(true)
    expect(isIbscbsAssessment('4')).toBe(false)
    expect(isIbscbsAssessment(2)).toBe(false)
    expect(isAssessmentSupported('1')).toBe(true)
    expect(isAssessmentSupported('X')).toBe(false)   // fora do domínio NUNCA é suportado (falha fechado)
  })

  it('isIsoDate: só data de calendário real (sem modo estrito, 2027-02-30 viraria 0000-00-00)', () => {
    expect(isIsoDate('2027-01-01')).toBe(true)
    for (const bad of ['2027-02-30', '2027-13-01', '27-01-01', '2027-1-1', '', null, 20270101, '1999-12-31', '2027-01-01T00:00']) {
      expect(isIsoDate(bad)).toBe(false)
    }
  })

  it('assessmentRefusalOf: 1 passa; 2/3 recusam com código próprio, opção, início e competência; desconhecida também recusa', () => {
    expect(assessmentRefusalOf({ assessment: '1', validFrom: null }, '2027-02-10')).toBeNull()
    expect(assessmentRefusalOf({ assessment: '1', validFrom: '2027-07-01' }, '2027-08-10')).toBeNull()
    const r = assessmentRefusalOf({ assessment: '3', validFrom: '2027-01-01' }, '2027-02-10')
    expect(r).toEqual({ code: 'IBSCBS_REGULAR_REGIME_UNSUPPORTED', message: expect.stringMatching(/^Regime regular de IBS\/CBS ainda não suportado/) })
    expect(r!.message).toMatch(/"3 — IBS e CBS apurados pelo regime regular" a partir de 2027-01-01/)
    expect(r!.message).toMatch(/competência 2027-02-10/)
    expect(assessmentRefusalOf({ assessment: '2', validFrom: '2027-01-01' }, '2027-01-01')?.code).toBe('IBSCBS_REGULAR_REGIME_UNSUPPORTED')
    expect(assessmentRefusalOf({ assessment: '9', validFrom: '2027-01-01' }, '2027-01-02')?.message).toMatch(/desconhecida \("9"\)/)
  })
})

describe('ibscbsAssessmentAt — a opção que governa a data', () => {
  it('linha viva de maior início ≤ data; TRAVANTE compartilhada só quando pedido; tabela por parâmetro (??)', async () => {
    const q = { query: jest.fn().mockResolvedValue([[{ validFrom: '2027-01-01', assessment: '3' }]]) }
    expect(await ibscbsAssessmentAt(q, 'setes_acme', 7, '2027-02-10', { lock: true })).toEqual({ assessment: '3', validFrom: '2027-01-01' })
    const sql = String(q.query.mock.calls[0][0])
    expect(sql).toMatch(/valid_from <= \?[\s\S]*deleted = 'N'[\s\S]*ORDER BY valid_from DESC LIMIT 1 LOCK IN SHARE MODE/)
    expect(q.query.mock.calls[0][1]).toEqual([TABLE, 7, '2027-02-10'])
    await ibscbsAssessmentAt(q, 'setes_acme', 7, '2027-02-10', { lock: false })
    expect(String(q.query.mock.calls[1][0])).not.toMatch(/LOCK|FOR UPDATE/)
  })

  it.each(['', 'abc', '2027-13-45', '2027-02-30'])('ADV-IB99-03: competência inválida %p falha FECHADO antes do SQL (nunca "sem linha = 1")', async d => {
    const q = { query: jest.fn().mockResolvedValue([[]]) }
    await expect(assertIbscbsAssessmentSupported(q, 'setes_acme', 7, d)).rejects.toThrow(/competência inválida/)
    await expect(previewIbscbsAssessmentRefusal(q, 'setes_acme', 7, d)).rejects.toThrow(/competência inválida/)
    expect(q.query).not.toHaveBeenCalled()
  })

  it('sem linha = 1 (D-IB1: efeito legal de não optar), validFrom null', async () => {
    const q = { query: jest.fn().mockResolvedValue([[]]) }
    expect(await ibscbsAssessmentAt(q, 'setes_acme', 7, '2027-02-10', { lock: false })).toEqual({ assessment: '1', validFrom: null })
  })

  it('assertIbscbsAssessmentSupported: 422 com o código do catálogo; a prévia devolve a MESMA recusa sem travar', async () => {
    const q = { query: jest.fn().mockResolvedValue([[{ validFrom: '2027-01-01', assessment: '2' }]]) }
    await expect(assertIbscbsAssessmentSupported(q, 'setes_acme', 7, '2027-03-01'))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_REGULAR_REGIME_UNSUPPORTED' })
    const preview = await previewIbscbsAssessmentRefusal(q, 'setes_acme', 7, '2027-03-01')
    expect(preview?.code).toBe('IBSCBS_REGULAR_REGIME_UNSUPPORTED')
    expect(String(q.query.mock.calls[1][0])).not.toMatch(/LOCK/)
    const none = { query: jest.fn().mockResolvedValue([[]]) }
    await expect(assertIbscbsAssessmentSupported(none, 'setes_acme', 7, '2027-03-01')).resolves.toBeUndefined()
  })
})

describe('readIbscbsAssessmentView — o que a tela mostra', () => {
  it('sem linha vigente: vale 1 (sem linha); a linha futura é editável e não suportada', async () => {
    const q = { query: jest.fn().mockResolvedValue([[{ validFrom: '2027-01-01', assessment: '3' }]]) }
    const v = await readIbscbsAssessmentView('setes_acme', 7, q)
    expect(v).toEqual({
      today: '2026-11-01', regularStart: '2027-01-01', supported: ['1'],
      current: { assessment: '1', validFrom: null, supported: true },
      items: [{ validFrom: '2027-01-01', assessment: '3', supported: false, inEffect: false, editable: true }],
    })
  })

  it('a vigente é a de maior início ≤ hoje; passadas e vigente não são editáveis', async () => {
    tz.todayFor.mockResolvedValue('2027-03-01')
    const q = { query: jest.fn().mockResolvedValue([[
      { validFrom: '2026-11-05', assessment: '1' }, { validFrom: '2027-01-01', assessment: '3' }, { validFrom: '2027-07-01', assessment: '1' },
    ]]) }
    const v = await readIbscbsAssessmentView('setes_acme', 7, q)
    expect(v.current).toEqual({ assessment: '3', validFrom: '2027-01-01', supported: false })
    expect(v.items.map(i => [i.validFrom, i.inEffect, i.editable])).toEqual([
      ['2026-11-05', false, false], ['2027-01-01', true, false], ['2027-07-01', false, true],
    ])
  })
})

describe('escrita — só pela peça (registrar, trocar, excluir)', () => {
  it('registrar: início antes de hoje = 422 DATE_PAST no campo da data, nada gravado, transação desfeita', async () => {
    const conn = fakeTxConn()
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-10-31', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_DATE_PAST', fields: [{ field: 'validFrom' }] })
    expect(sqlOf(conn).some(s => /INSERT|UPDATE/.test(s))).toBe(false)
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })

  it('registrar: regular antes de 01/01/2027 = 422 REGULAR_TOO_EARLY; HOJE com 1 passa', async () => {
    fakeTxConn()
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-12-01', assessment: '3' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY', fields: [{ field: 'validFrom' }] })
    const conn = fakeTxConn()
    await createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-11-01', assessment: '1' })
    expect(conn.query.mock.calls.find(c => /^\s*INSERT/.test(String(c[0])))![1]).toEqual([TABLE, 7, '2026-11-01', '1', 3])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('registrar: o que valida é o que grava — data/opção fora do formato = 400 antes de abrir transação', async () => {
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-02-30', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'validFrom' }] })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '4' as any }))
      .rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'assessment' }] })
    expect(pool.getConnection).not.toHaveBeenCalled()
  })

  it('registrar: PK viva = 409 DUPLICATE; PK morta = REVIVE da mesma linha regravando tudo (nunca herda)', async () => {
    fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_DUPLICATE' })
    const conn = fakeTxConn({ lockRow: { assessment: '3', deleted: 'S' } })
    await createIbscbsAssessment('setes_acme', 7, 4, { validFrom: '2027-01-01', assessment: '1' })
    // ADV-IB99-05: a linha EXISTENTE é travada por registro ANTES de decidir — nenhum INSERT (que pegaria trava S e subiria para X)
    expect(sqlOf(conn).some(s => /^\s*INSERT/.test(s))).toBe(false)
    expect(sqlOf(conn).findIndex(s => /FOR UPDATE/.test(s))).toBeLessThan(sqlOf(conn).findIndex(s => /^\s*UPDATE/.test(s)))
    const revive = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(String(revive[0])).toMatch(/SET assessment = \?, tb_user_id = \?, created_at = NOW\(\), updated_at = NOW\(\), deleted = 'N'[\s\S]*deleted = 'S'/)
    expect(revive[1]).toEqual([TABLE, '1', 4, 7, '2027-01-01'])
  })

  it('registrar: outro criador gravou a mesma data no intervalo (chave duplicada no INSERT) = 409 DUPLICATE, nunca 500', async () => {
    fakeTxConn({ insertError: Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }) })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_DUPLICATE' })
  })

  it('trocar: inexistente/morta = 404; vigente ou passada = 409 IN_EFFECT; futura troca (com o piso do regular)', async () => {
    fakeTxConn({ lockRow: null })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'IBSCBS_ASSESSMENT_NOT_FOUND' })
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'S' } })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 404 })
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'N' } })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-11-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_IN_EFFECT' })
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'N' } })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-12-15', assessment: '2' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY' })
    const conn = fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await changeIbscbsAssessment('setes_acme', 7, 5, { validFrom: '2027-01-01', assessment: '2' })
    expect(sqlOf(conn)[0]).toMatch(/WHERE tb_institution_id = \? AND valid_from = \? FOR UPDATE/)   // trava de REGISTRO (PK completa)
    const update = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(update[1]).toEqual([TABLE, '2', 5, 7, '2027-01-01'])
  })

  it('excluir: SOFT (nunca DELETE), só linha futura, com o autor do ato', async () => {
    fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await expect(removeIbscbsAssessment('setes_acme', 7, 3, '2026-11-01'))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_IN_EFFECT' })
    const conn = fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await removeIbscbsAssessment('setes_acme', 7, 6, '2027-01-01')
    expect(sqlOf(conn).some(s => /DELETE/.test(s))).toBe(false)
    const update = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(String(update[0])).toMatch(/SET deleted = 'S', tb_user_id = \?/)
    expect(update[1]).toEqual([TABLE, 6, 7, '2027-01-01'])
    await expect(removeIbscbsAssessment('setes_acme', 7, 6, 'x')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('boot (D-IB26): o CHECK do domínio pelo NOME e pelo corpo, em cada schema vivo', () => {
  const q = (clauses: Record<string, string | null>) => ({
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/tb_institution/.test(sql)) return [Object.keys(clauses).map(s => ({ s }))]
      const c = clauses[params[0]]
      return [c == null ? [] : [{ clause: c }]]
    }),
  })

  it('a forma que o MariaDB 10.4 guarda (provada no schema descartável) casa com o esperado', () => {
    expect(normalizeCheckClause("`assessment` collate utf8mb4_bin in ('1','2','3')")).toBe(EXPECTED_CHECK_CLAUSE)
  })

  it('presente em todos → sobe; ausente ou com corpo diferente → NÃO sobe, nomeando o schema', async () => {
    const good = "`assessment` collate utf8mb4_bin in ('1','2','3')"
    await expect(assertIbscbsAssessmentChecks(q({ setes_a: good, setes_b: good }))).resolves.toMatch(/2 schema/)
    await expect(assertIbscbsAssessmentChecks(q({ setes_a: good, setes_b: null }))).rejects.toThrow(/setes_b: ck_establishment_ibscbs_assessment ausente/)
    await expect(assertIbscbsAssessmentChecks(q({ setes_a: "`assessment` in ('1','2','3')" }))).rejects.toThrow(/setes_a: .*corpo diferente/)
  })
})
