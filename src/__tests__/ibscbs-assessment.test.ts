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
function fakeTxConn(opts: {
  insertError?: unknown; lockRow?: { assessment: string; deleted: string } | null
  /** D-IB101: a última data de emissão de nota viva do estabelecimento (null = nenhuma nota). */
  lastInvoice?: string | null
} = {}) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/MAX\(dt_emission\)/.test(sql)) return [[{ last: opts.lastInvoice ?? null }]]
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
  pool.query.mockResolvedValue([[{ last: null }]])   // a PRÉ-CHECAGEM (pelo pool, sem trava) — nenhuma nota
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
      today: '2026-11-01', lastInvoice: null, firstStart: '2026-11-01', regularStart: '2027-01-01', supported: ['1'],
      current: { assessment: '1', validFrom: null, supported: true },
      items: [{ validFrom: '2027-01-01', assessment: '3', supported: false, inEffect: false, editable: true }],
    })
  })

  it('D-IB101 (ADV-D101-05): a visão traz a última nota e o 1º início aceito; linha futura até a última nota NÃO é editável', async () => {
    tz.todayFor.mockResolvedValue('2027-01-01')
    const q = { query: jest.fn(async (sql: string) => /MAX\(dt_emission\)/.test(sql)
      ? [[{ last: '2027-01-05' }]]
      : [[{ validFrom: '2027-01-03', assessment: '1' }, { validFrom: '2027-01-06', assessment: '3' }]]) }
    const v = await readIbscbsAssessmentView('setes_acme', 7, q)
    expect(v.lastInvoice).toBe('2027-01-05')
    expect(v.firstStart).toBe('2027-01-06')
    expect(v.items.map(i => [i.validFrom, i.editable])).toEqual([['2027-01-03', false], ['2027-01-06', true]])
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
  const dup = () => Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })
  /** Posição do 1º comando que casa — a ORDEM trava × leitura da fronteira é a regra da D-IB101. */
  const at = (conn: { query: jest.Mock }, re: RegExp) => sqlOf(conn).findIndex(x => re.test(x))

  it('registrar: início antes de hoje = 422 DATE_PAST pela PRÉ-CHECAGEM — sem transação, nunca segura o faturamento (ADV-D101-02)', async () => {
    fakeTxConn()
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-10-31', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_DATE_PAST', fields: [{ field: 'validFrom' }] })
    expect(pool.getConnection).not.toHaveBeenCalled()
  })

  it('registrar: a conferência DECISIVA continua depois da trava — o hoje virou entre a pré-checagem e a trava = 422 e desfaz', async () => {
    tz.todayFor.mockResolvedValueOnce('2026-11-01').mockResolvedValueOnce('2026-11-02')   // pré-checagem × depois da espera
    const conn = fakeTxConn()
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-11-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_DATE_PAST' })
    expect(conn.commit).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })

  it('registrar: regular antes de 01/01/2027 = 422 REGULAR_TOO_EARLY sem abrir transação; HOJE com 1 passa', async () => {
    fakeTxConn()
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-12-01', assessment: '3' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY', fields: [{ field: 'validFrom' }] })
    expect(pool.getConnection).not.toHaveBeenCalled()
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

  it('D-IB101: a fronteira (hoje + última nota viva) é lida DEPOIS da trava e com o relógio REAL de depois da espera', async () => {
    const conn = fakeTxConn()
    await createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' })
    expect(at(conn, /^\s*INSERT/)).toBe(0)                                  // a trava é o 1º comando (nenhuma leitura antes)
    expect(at(conn, /MAX\(dt_emission\)/)).toBeGreaterThan(0)
    expect(conn.query.mock.calls[at(conn, /MAX\(dt_emission\)/)][1]).toEqual(['setes_acme.tb_invoice', 7])
    expect(tz.todayFor).toHaveBeenCalledWith('setes_acme', 7, conn, expect.any(Date))   // nunca o relógio do início da requisição
  })

  it('D-IB101: registrar com início ≤ a última nota viva = 409 INVOICED (pré-checagem e decisiva); depois dela passa', async () => {
    pool.query.mockResolvedValue([[{ last: '2027-01-01' }]])
    fakeTxConn({ lastInvoice: '2027-01-01' })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '3' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_INVOICED', fields: [{ field: 'validFrom' }] })
    expect(pool.getConnection).not.toHaveBeenCalled()                                   // recusada SEM trava
    pool.query.mockResolvedValue([[{ last: null }]])                                    // a nota nasceu DURANTE a espera
    const conn = fakeTxConn({ lastInvoice: '2027-01-01' })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '3' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_INVOICED' })
    expect(conn.commit).not.toHaveBeenCalled()
    tz.todayFor.mockResolvedValue('2027-01-01')
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '3' }))
      .rejects.toMatchObject({ code: 'IBSCBS_ASSESSMENT_INVOICED' })   // a opção "a partir de HOJE" depois de uma nota de hoje
    const ok = fakeTxConn({ lastInvoice: '2027-01-01' })
    await createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-02', assessment: '3' })
    expect(ok.commit).toHaveBeenCalled()
  })

  it('registrar: PK viva = 409 DUPLICATE; PK morta = REVIVE da mesma linha regravando tudo (nunca herda), trava de REGISTRO antes', async () => {
    const live = fakeTxConn({ insertError: dup(), lockRow: { assessment: '3', deleted: 'N' } })
    await expect(createIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_DUPLICATE' })
    expect(live.commit).toHaveBeenCalledTimes(1)   // a 1ª transação (INSERT recusado) encerra sem nada gravado
    const conn = fakeTxConn({ insertError: dup(), lockRow: { assessment: '3', deleted: 'S' } })
    await createIbscbsAssessment('setes_acme', 7, 4, { validFrom: '2027-01-01', assessment: '1' })
    // ADV-IB99-05 + D-IB101: na 2ª transação a linha EXISTENTE é travada por registro ANTES da fronteira e da gravação
    const lock = at(conn, /FOR UPDATE/)
    expect(lock).toBeGreaterThan(at(conn, /^\s*INSERT/))
    expect(lock).toBeLessThan(sqlOf(conn).lastIndexOf(sqlOf(conn).find(x => /MAX\(dt_emission\)/.test(x))!))
    expect(lock).toBeLessThan(at(conn, /^\s*UPDATE/))
    const revive = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(String(revive[0])).toMatch(/SET assessment = \?, tb_user_id = \?, created_at = NOW\(\), updated_at = NOW\(\), deleted = 'N'[\s\S]*deleted = 'S'/)
    expect(revive[1]).toEqual([TABLE, '1', 4, 7, '2027-01-01'])
    // o revive também respeita a fronteira (D-IB101) — a nota nasceu depois da pré-checagem
    fakeTxConn({ insertError: dup(), lockRow: { assessment: '3', deleted: 'S' }, lastInvoice: '2027-01-01' })
    await expect(createIbscbsAssessment('setes_acme', 7, 4, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ code: 'IBSCBS_ASSESSMENT_INVOICED' })
  })

  it('trocar: inexistente/morta = 404; vigente ou passada = 409 IN_EFFECT; depois de nota = 409 INVOICED; futura troca', async () => {
    fakeTxConn({ lockRow: null })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'IBSCBS_ASSESSMENT_NOT_FOUND' })
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'S' } })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 404 })
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'N' } })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-11-01', assessment: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_IN_EFFECT' })
    // D-IB101 (ADV-IB99-02): o fuso trocado faz o "hoje" voltar — a linha parece futura, mas uma nota já leu a data
    fakeTxConn({ lockRow: { assessment: '1', deleted: 'N' }, lastInvoice: '2027-01-01' })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2027-01-01', assessment: '3' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_INVOICED' })
    await expect(changeIbscbsAssessment('setes_acme', 7, 3, { validFrom: '2026-12-15', assessment: '2' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY' })
    const conn = fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await changeIbscbsAssessment('setes_acme', 7, 5, { validFrom: '2027-01-01', assessment: '2' })
    expect(sqlOf(conn)[0]).toMatch(/WHERE tb_institution_id = \? AND valid_from = \? FOR UPDATE/)   // trava de REGISTRO, 1º comando
    const update = conn.query.mock.calls.find(c => /^\s*UPDATE/.test(String(c[0])))!
    expect(update[1]).toEqual([TABLE, '2', 5, 7, '2027-01-01'])
  })

  it('excluir: SOFT (nunca DELETE), só linha futura e depois da última nota, com o autor do ato', async () => {
    fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await expect(removeIbscbsAssessment('setes_acme', 7, 3, '2026-11-01'))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_IN_EFFECT' })
    fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' }, lastInvoice: '2027-01-05' })
    await expect(removeIbscbsAssessment('setes_acme', 7, 3, '2027-01-01'))
      .rejects.toMatchObject({ statusCode: 409, code: 'IBSCBS_ASSESSMENT_INVOICED' })
    const conn = fakeTxConn({ lockRow: { assessment: '3', deleted: 'N' } })
    await removeIbscbsAssessment('setes_acme', 7, 6, '2027-01-01')
    expect(sqlOf(conn).some(x => /DELETE/.test(x))).toBe(false)
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
