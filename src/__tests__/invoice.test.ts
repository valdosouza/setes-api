/// <reference types="jest" />
// Peça @shared/invoice (prompt_cancelamento_nota.md D3/D4/D5/D17 + parecer
// setes-conceito, 2026-09-08): nota = documento com história; estado
// derivado do último evento; E nasce no faturamento com snapshot; número
// MAX+1 ignora canceladas; cabeçalho e ramos REVIVEM por upsert.
import {
  stateFromLastEvent, nextInvoiceNumber, issueInvoice, DEFAULT_PRESENCE_INDICATOR, insertInvoiceEvent, lockInvoice,
  MODELS_NUMBERED_AT_TRANSMISSION, isNumberedAtTransmission,
} from '../shared/invoice'
import type { IbscbsDeclaration } from '../shared/ibscbs-classification'

// D-IB99/D-IB100: a opção de apuração do IBS/CBS tem teste próprio (ibscbs-assessment.test.ts) — nos testes de forma do
// issueInvoice a fronteira é mockada (passa); o bloco "D-IB99" abaixo usa a REAL para provar a ordem (recusa antes do número)
jest.mock('../shared/ibscbs-assessment', () => {
  const actual = jest.requireActual('../shared/ibscbs-assessment')
  return { __esModule: true, ...actual, assertIbscbsAssessmentSupported: jest.fn().mockResolvedValue(undefined) }
})
const assessmentPiece = jest.requireMock('../shared/ibscbs-assessment') as { assertIbscbsAssessmentSupported: jest.Mock }
const actualAssessment = jest.requireActual('../shared/ibscbs-assessment')

function fakeConn() { return { query: jest.fn() } }
beforeEach(() => {
  jest.clearAllMocks()
  assessmentPiece.assertIbscbsAssessmentSupported.mockResolvedValue(undefined)
})

describe('stateFromLastEvent', () => {
  it('C = cancelada; E ou sem evento (sincronizada) = emitida', () => {
    expect(stateFromLastEvent('C')).toBe('cancelled')
    expect(stateFromLastEvent('E')).toBe('issued')
    expect(stateFromLastEvent(null)).toBe('issued')
  })
})

describe('nextInvoiceNumber (D4)', () => {
  it('MAX+1 por modelo+série IGNORA notas canceladas (deleted=S) e trava a leitura', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextNumber: 12 }]])
    const n = await nextInvoiceNumber(conn as any, 'setes_setes', 1, '55', '1')
    expect(n).toBe('12')
    const sql = String(conn.query.mock.calls[0][0])
    expect(sql).toMatch(/deleted = 'N'/)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(conn.query.mock.calls[0][1]).toEqual([1, '55', '1'])
  })
})

describe('issueInvoice', () => {
  it('cabeçalho por upsert (REVIVE), ramos por PRESENÇA, evento E com snapshot — o 55 nasce SEM número fiscal (D-NE257)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])                  // tb_invoice upsert (o 55 não cunha: nenhum MAX+1 antes)
      .mockResolvedValueOnce([{}])                  // merchandise upsert
      .mockResolvedValueOnce([{}])                  // service → deleted='S' (ausente nesta vida)
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]) // MAX(event)+1 (2ª vida: E1, C2, E3)
      .mockResolvedValueOnce([{}])                  // INSERT evento
    const r = await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 100, recipientEntityId: 209, model: '55', serie: '1', totalValue: 250,
      noteText: 'obs', merchandise: {
        baseIcms: 250, icms: 45, baseIcmsSt: 0, icmsSt: 0, ipi: 0, totalValue: 250,
        freight: 0, expenses: 0, discount: 0, quantity: 2,
      }, service: null, dtEmission: '2026-09-08',
    })
    expect(r).toEqual({ invoiceNumber: null, event: 3 })
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    // D-NE257 (NFE.E1.P3.T1): nenhum MAX+1, nenhuma leitura de faixa, ambiente ou habilitação — só os 5 comandos da nota
    expect(conn.query).toHaveBeenCalledTimes(5)
    expect(sqls.some(q => /MAX\(number_seq\)|fiscal_api|number_void|establishment_issuer/.test(q))).toBe(false)
    expect(sqls[0]).toMatch(/INSERT INTO `setes_setes`.tb_invoice[\s\S]*ON DUPLICATE KEY UPDATE[\s\S]*deleted = 'N'/)
    // o INSERT e o REVIVE são o mesmo comando: o parâmetro `number` vai NULL e o revive regrava `number = VALUES(number)` —
    // a nota refaturada volta a ficar sem número (cada vida recebe o dela na transmissão)
    expect(sqls[0]).toMatch(/number = VALUES\(number\)/)
    // D-IB64: dt_emission = a data que o PRODUTOR calculou UMA vez (hoje do estabelecimento — Q-TZ1), a mesma do evento E
    expect(conn.query.mock.calls[0][1]).toEqual([100, 1, 1, null, '1', 209, '2026-09-08', 250, '55', 'obs'])
    expect(sqls[1]).toMatch(/tb_invoice_merchandise[\s\S]*ON DUPLICATE KEY UPDATE/)
    // D-NE246: o indPres nasce 3 (teleatendimento) no INSERT e no revive — nenhum 0 fixo sobra no SQL
    expect(DEFAULT_PRESENCE_INDICATOR).toBe(3)
    expect(sqls[1]).toMatch(/indPres = VALUES\(indPres\)/)
    expect(sqls[1]).not.toMatch(/indPres = 0/)
    expect(sqls[1]).toMatch(/total_qtty, indPres, created_at[\s\S]*VALUES \(\?, \?, 0, \?, \?, \?, \?, \?, \?, \?, 0, \?, \?, \?, \?, NOW\(\)/)
    expect((conn.query.mock.calls[1][1] as unknown[]).at(-1)).toBe(3)
    expect(sqls[2]).toMatch(/UPDATE `setes_setes`.tb_invoice_service SET deleted = 'S'/)
    expect(sqls[4]).toMatch(/INSERT INTO `setes_setes`.tb_invoice_event/)
    // snapshot do fato: número (NULL no 55)/série/modelo/valor + autor
    expect(conn.query.mock.calls[4][1]).toEqual([1, 100, 3, 'E', '2026-09-08', null, '1', '55', 250, null, null, 7])
  })

  it.each(['SE', '65'])('modelo %s segue numerando no faturamento: MAX+1 por modelo e série, número no cabeçalho e no evento E', async (model) => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextNumber: 12 }]]) // MAX+1
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 300, recipientEntityId: 209, model, serie: '2', totalValue: 10,
      noteText: null, merchandise: null, service: null, dtEmission: '2026-11-23',
    })
    expect(r).toEqual({ invoiceNumber: '12', event: 1 })
    expect(String(conn.query.mock.calls[0][0])).toMatch(/MAX\(number_seq\)[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[0][1]).toEqual([1, model, '2'])
    expect(conn.query.mock.calls[1][1][3]).toBe('12')
    expect(conn.query.mock.calls[5][1][5]).toBe('12')
  })

  it('D-NE257: só o 55 é numerado na transmissão — lista fechada e congelada', () => {
    expect([...MODELS_NUMBERED_AT_TRANSMISSION]).toEqual(['55'])
    expect(Object.isFrozen(MODELS_NUMBERED_AT_TRANSMISSION)).toBe(true)
    expect(isNumberedAtTransmission('55')).toBe(true)
    expect(['SE', '65', '', '5', '055'].map(isNumberedAtTransmission)).toEqual([false, false, false, false, false])
  })

  it('nota SÓ de serviço: ramo de mercadoria vira S, serviço upsert', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextNumber: 1 }]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 101, recipientEntityId: 209, model: 'SE', serie: '1', totalValue: 80,
      noteText: null, merchandise: null, dtEmission: '2026-10-15',
      service: { totalValue: 80, serviceListId: '1.02', nationalCode: '010201', municipalCode: '0102', cityId: 4004, baseIss: 80, aliqIss: 5, issValue: 4, issWithheld: 'N', liability: '1', description: 'Suporte',
        ibscbs: { group: { classificationCode: '000001', placeIndicatorCode: '100301' }, nbs: '115021000', omitted: [] } as unknown as IbscbsDeclaration },
    })
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls[2]).toMatch(/UPDATE `setes_setes`.tb_invoice_merchandise SET deleted = 'S'/)
    expect(sqls[3]).toMatch(/tb_invoice_service[\s\S]*national_code[\s\S]*ON DUPLICATE KEY UPDATE[\s\S]*total_value = VALUES\(total_value\)/)
    // D-IB71: a declaração IBS/CBS congelada no ramo — gravada no INSERT e no ON DUPLICATE (a revivida nunca herda)
    expect(sqls[3]).toMatch(/classification_code, place_indicator_code, nbs/)
    expect(sqls[3]).toMatch(/classification_code = VALUES\(classification_code\), place_indicator_code = VALUES\(place_indicator_code\),\s*nbs = VALUES\(nbs\)/)
    expect(conn.query.mock.calls[3][1].slice(-3)).toEqual(['000001', '100301', '115021000'])
  })

  it('D-IB71: grupo OMITIDO grava NULL nas 3 colunas mesmo na revivida (a NBS pode ir sozinha — D-IB62)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextNumber: 2 }]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]).mockResolvedValueOnce([{}])
    await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 101, recipientEntityId: 209, model: 'SE', serie: '1', totalValue: 80,
      noteText: null, merchandise: null, dtEmission: '2026-12-20',
      service: { totalValue: 80, serviceListId: '1.02', nationalCode: '010201', municipalCode: '0102', cityId: 4004, baseIss: 80, aliqIss: 5, issValue: 4, issWithheld: 'N', liability: '1', description: 'Suporte',
        ibscbs: { group: null, nbs: '115021000', omitted: ['not-classified'] } as unknown as IbscbsDeclaration },
    })
    expect(conn.query.mock.calls[3][1].slice(-3)).toEqual([null, null, '115021000'])
    // evento E com a MESMA data da emissão
    expect(conn.query.mock.calls[5][1][4]).toBe('2026-12-20')
  })
})

describe('issueInvoice — D-IB99: opção de apuração do IBS/CBS sem suporte recusa ANTES de cunhar o número', () => {
  const input = {
    orderId: 100, recipientEntityId: 209, model: '55', serie: '1', totalValue: 250, noteText: null,
    merchandise: { baseIcms: 0, icms: 0, baseIcmsSt: 0, icmsSt: 0, ipi: 0, totalValue: 250, freight: 0, expenses: 0, discount: 0, quantity: 1 },
    service: null, dtEmission: '2027-02-10',
  }

  it('chama a regra com a conexão da transação, o schema, a institution e a COMPETÊNCIA (dtEmission) — em todo modelo', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextNumber: 1 }]]).mockResolvedValue([[{ nextEvent: 1 }]])
    await issueInvoice(conn as any, 'setes_setes', 1, 7, input)
    expect(assessmentPiece.assertIbscbsAssessmentSupported).toHaveBeenCalledWith(conn, 'setes_setes', 1, '2027-02-10')
  })

  it('opção 3 vigente na competência → 422 IBSCBS_REGULAR_REGIME_UNSUPPORTED e NADA além da leitura travante (nem o MAX+1)', async () => {
    assessmentPiece.assertIbscbsAssessmentSupported.mockImplementation(actualAssessment.assertIbscbsAssessmentSupported)
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ validFrom: '2027-01-01', assessment: '3' }]])
    await expect(issueInvoice(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 422, code: 'IBSCBS_REGULAR_REGIME_UNSUPPORTED' })
    expect(conn.query).toHaveBeenCalledTimes(1)
    expect(String(conn.query.mock.calls[0][0])).toMatch(/tb_institution_id = \? AND valid_from <= \?[\s\S]*LOCK IN SHARE MODE/)
    expect(conn.query.mock.calls[0][1]).toEqual(['setes_setes.tb_establishment_ibscbs_assessment', 1, '2027-02-10'])
  })

  it('sem linha (D-IB1: vale 1) → a nota nasce normalmente', async () => {
    assessmentPiece.assertIbscbsAssessmentSupported.mockImplementation(actualAssessment.assertIbscbsAssessmentSupported)
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]).mockResolvedValue([[{ nextEvent: 1 }]])
    const r = await issueInvoice(conn as any, 'setes_setes', 1, 7, input)
    expect(r).toEqual({ invoiceNumber: null, event: 1 })   // 55: nasce sem número (D-NE257)
    expect(String(conn.query.mock.calls[1][0])).toMatch(/INSERT INTO `setes_setes`.tb_invoice/)

    const se = fakeConn()
    se.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ nextNumber: 4 }]]).mockResolvedValue([[{ nextEvent: 1 }]])
    const rSe = await issueInvoice(se as any, 'setes_setes', 1, 7, { ...input, model: 'SE', merchandise: null })
    expect(rSe.invoiceNumber).toBe('4')
    expect(String(se.query.mock.calls[1][0])).toMatch(/MAX\(number_seq\)/)
  })
})

describe('insertInvoiceEvent / lockInvoice', () => {
  it('C guarda motivo, origem e o snapshot; autor pode ser NULL (retroativo)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    const ev = await insertInvoiceEvent(conn as any, 'setes_setes', 1, 100, null, {
      kind: 'C', dtRecord: '2026-09-08', note: 'x'.repeat(300), originEvent: 1,
      snapshot: { number: '7', serie: '1', model: '55', value: 250 },
    })
    expect(ev).toBe(2)
    const params = conn.query.mock.calls[1][1]
    expect(params.slice(0, 5)).toEqual([1, 100, 2, 'C', '2026-09-08'])
    expect(params[9]).toBe(1)              // origin_event
    expect(String(params[10])).toHaveLength(255) // note cortada
    expect(params[11]).toBeNull()          // autor
  })

  it('lockInvoice: 404 quando a nota não existe ou está soft-deletada; devolve o último evento', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(lockInvoice(conn as any, 'setes_setes', 1, 5))
      .rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    conn.query.mockResolvedValueOnce([[{ id: 5, number: '9', serie: '1', model: '55', value: '10.00', status: '0' }]])
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 2, lastKind: 'C' }]])
    const inv = await lockInvoice(conn as any, 'setes_setes', 1, 5)
    expect(inv).toMatchObject({ id: 5, number: '9', value: 10, lifeEvent: 1, lastEvent: 2, lastKind: 'C' })
    // D-F32 (F2a A2): vida e último evento pela VIEW de política, em leitura travante compartilhada DEPOIS da trava da nota
    expect(String(conn.query.mock.calls[2][0])).toMatch(/FROM `setes_setes`\.vw_invoice_life[\s\S]*LOCK IN SHARE MODE/)
    expect(String(conn.query.mock.calls[2][0])).not.toMatch(/tb_invoice_event/)
    expect(String(conn.query.mock.calls[1][0])).toMatch(/deleted = 'N' FOR UPDATE/)
  })
})
