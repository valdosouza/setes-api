/// <reference types="jest" />
// Faturamento de ordens (W2 Onda 3 — rodada R4): /validate em lote (lista
// COMPLETA + grava regra origin 'A'; 'M' nunca sobrescrita) e /invoice
// consumindo as regras gravadas (422 REQUIRES_VALIDATION sem elas).
import pool from '../shared/db/connection'
import { parseCrt, parseDeadline, addDays, adjustMva, deriveProductSt } from '../modules/billing/billing.context'
import * as repo from '../modules/billing/billing.repository'
import { validateOrder, invoiceOrder, duplicatedItemIds, BILLING_INPUT_ATTEMPTS } from '../modules/billing/billing.service'
import { invoiceBodyDto } from '../modules/billing/billing.dto'
import * as taxRule from '../shared/tax-rule'
import * as fs from 'fs'
import * as path from 'path'

// IB-2 (D-IB71): a declaração IBS/CBS tem teste próprio (ibscbs-declaration.test.ts) — aqui a fronteira é mockada
// D-IB99/D-IB100: a opção de apuração do IBS/CBS tem teste próprio (ibscbs-assessment.test.ts) — aqui a fronteira é mockada
jest.mock('../shared/ibscbs-assessment', () => ({
  __esModule: true,
  previewIbscbsAssessmentRefusal: jest.fn().mockResolvedValue(null),
  // IBS.E9.P5: a opção vigente na data (lida só em nota do Simples de 2027 em diante) e a data de calendário real
  ibscbsAssessmentAt: jest.fn().mockResolvedValue({ assessment: '1', validFrom: null }),
  isIsoDate: (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
}))
// IBS.E9.P5: o percentual do mês tem teste próprio (ibscbs-simples-rate.test.ts) — aqui a fronteira é mockada (default: sem percentual)
jest.mock('../shared/ibscbs-simples-rate', () => ({
  ...jest.requireActual('../shared/ibscbs-simples-rate'),
  simplesRateAt: jest.fn().mockResolvedValue(null),
}))
// IBS.E9.P4: a tabela central de alíquotas tem teste próprio (ibscbs-rate.test.ts) — aqui a fronteira é mockada com as linhas da norma
jest.mock('../shared/ibscbs-rate', () => ({
  __esModule: true,
  loadIbscbsAliqTable: jest.fn(async () => [...jest.requireActual('../shared/ibscbs-calculation').IBSCBS_LEGAL_ALIQS]),
}))
// IBS.E9.P5: a data de emissão é a do dono único; aqui o default é o real e o bloco do Simples a fixa em 2027
jest.mock('../shared/invoice/emission-date', () => {
  const actual = jest.requireActual('../shared/invoice/emission-date')
  return { ...actual, invoiceEmissionDateFor: jest.fn(actual.invoiceEmissionDateFor) }
})
jest.mock('../shared/service-ibscbs-declaration', () => ({
  __esModule: true,
  declareServiceIbscbs: jest.fn().mockResolvedValue({ group: null, nbs: null, omitted: ['not-classified'] }),
  previewServiceIbscbs: jest.fn().mockResolvedValue(null),
}))
// D-FAT1: a conferência do pedido sob a trava tem teste próprio (billing-input-print.test.ts) — aqui a fronteira é mockada
jest.mock('../modules/billing/billing.input-print', () => ({
  ...jest.requireActual('../modules/billing/billing.input-print'),
  assertBillingInputsUnchanged: jest.fn().mockResolvedValue(undefined),
}))
// NFE.E1.P2 (D-NE260/D-NE267): a LEITURA do conteúdo da NF-e tem teste próprio (billing-content.test.ts) — aqui a fronteira é
// mockada (as regras puras são as reais); só é chamada com a marcação `authorizeNfe`
jest.mock('../modules/billing/billing.content', () => ({
  ...jest.requireActual('../modules/billing/billing.content'),
  loadInvoiceContent: jest.fn(),
}))
jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/invoice-series', () => ({ __esModule: true, invoiceSerieFor: jest.fn().mockResolvedValue('1') }))   // F2a A3 (D-F112): série da nota = leitura só no ERP

// isola o motor (testado em tax-rules/tax-calc) — o billing orquestra
// IBS.E9.P3 (D-IB134): mercadoria sem classificação de IBS/CBS não fatura. Os testes deste arquivo descrevem as peças de ICMS,
// IPI e PIS/COFINS; a regra simulada ganha uma classificação vigente por padrão ("000001"), a menos que o teste diga a chave
// `ibscbs` (o caso sem classificação e o de código fora de vigência estão em billing-ibscbs.test.ts).
jest.mock('../shared/tax-rule', () => {
  const actual = jest.requireActual('../shared/tax-rule')
  const loadPiecesInner = jest.fn()
  const loadPieces = async (...args: unknown[]) => {
    const pieces = (await loadPiecesInner(...args)) ?? {}   // teste que não descreve as peças = regra sem as outras peças
    return 'ibscbs' in pieces ? pieces : { ...pieces, ibscbs: { classificationCode: '000001' } }
  }
  return { ...actual, findTaxRule: jest.fn(), loadPieces, __loadPiecesInner: loadPiecesInner }
})
// a vigência do cClassTrib é do catálogo central (teste próprio: ibscbs-classification.test.ts) — aqui a fronteira é mockada
jest.mock('../shared/ibscbs-classification', () => ({
  ...jest.requireActual('../shared/ibscbs-classification'),
  // IBS.E9.P4: a linha que o regime regular aceita no modelo 55 (CST 000, com presença, sem redução)
  findClassificationAt: jest.fn().mockResolvedValue({
    code: '000001', cst: '000', applicable: true, requiresRegularTaxation: false, ibsReductionPpm: 0, cbsReductionPpm: 0,
  }),
}))

// isola os resolvers do catálogo MVA/FCP (testados em state-tax-rates.test)
jest.mock('../modules/state-tax-rates/state-tax-rates.repository', () => ({
  resolveMvaAliq: jest.fn().mockResolvedValue(null),
  resolveFcpAliq: jest.fn().mockResolvedValue(null),
}))

// isola o Framework de Configurações (série default '1')
jest.mock('../shared/interface-config', () => ({
  getConfigContent: jest.fn().mockResolvedValue(null),
  // lido pela composição @shared/title-automation (auto_bank_slip) — null = desligado
  getConfigContentFor: jest.fn().mockResolvedValue(null),
}))

// isola a baixa automática à vista (W3.2 — testada isoladamente em
// financial-settlement.test.ts); default = forma sem contrato (NO_CONTRACT).
jest.mock('../shared/financial-settlement', () => ({
  tryAutoSettleByContract: jest.fn().mockResolvedValue({ settled: false, reason: 'NO_CONTRACT' }),
}))

// isola as peças de comissão/devolução (testadas em commission-return.test.ts);
// defaults = venda sem vendedor resolvível/sem devolução — sequências antigas intactas.
jest.mock('../shared/order-return', () => ({
  buildReturnPlan: jest.fn().mockResolvedValue({ issues: [], plan: null }),
  getSaleOrderInfo: jest.fn().mockResolvedValue(null),
  getAnchor: jest.fn().mockResolvedValue(null),
  assertReturnableInTx: jest.fn().mockResolvedValue(undefined),
  persistReturn: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  // nota + ramos + evento E vivem na peça (cancelamento D3/D4/D17) — aqui só o contrato
  issueInvoice: jest.fn(async () => ({ invoiceNumber: '1', event: 1 })),
}))
// Q-A11: OS (ciclo vivo) fora do billing de venda — default "não é OS"
jest.mock('../shared/service-order', () => ({
  __esModule: true,
  hasServiceOrderCycle: jest.fn().mockResolvedValue(false),
}))
jest.mock('../shared/commission', () => ({
  resolveCommissionAliq: jest.fn().mockResolvedValue(0),
  getPostedItemCommissions: jest.fn().mockResolvedValue([]),
  insertCommissions: jest.fn().mockResolvedValue([]),
}))

const mockQuery = (pool as any).query as jest.Mock
const mockFindTaxRule = (taxRule as any).findTaxRule as jest.Mock
const mockLoadPieces = (taxRule as any).__loadPiecesInner as jest.Mock
const mockTryAutoSettleByContract = (jest.requireMock('../shared/financial-settlement') as any).tryAutoSettleByContract as jest.Mock
const mockOrderReturn = jest.requireMock('../shared/order-return') as any
const mockCommission = jest.requireMock('../shared/commission') as any
const mockInputPrint = jest.requireMock('../modules/billing/billing.input-print') as any
const mockContent = jest.requireMock('../modules/billing/billing.content') as any
/** Um conteúdo que a NF-e aceita (destinatário PJ contribuinte e um item com unidade). */
const goodContent = (over: { recipient?: any; items?: any[] } = {}) => ({
  recipient: {
    personType: 'J', name: 'Cliente Bom Ltda', document: '11.222.333/0001-81', stateRegistration: '123.456.789',
    stateRegistrationIndicator: '1',
    address: { street: 'Rua das Flores', number: '100', complement: null, neighborhood: 'Centro', zipCode: '80000-000', cityCode: '4106902', state: 'PR' },
    phone: '(41) 3333-4444', email: 'nfe@cliente.com.br', ...over.recipient,
  },
  items: over.items ?? [{ itemId: 1, description: 'Peça usinada', ncm: '84713012', unit: 'UN', taxableUnit: 'UN', gtin: null }],
})

const inst = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

beforeEach(() => {
  jest.clearAllMocks()
  // Q-A8: o validate termina lendo tb_order_billing — default "tem condições"
  // (as sequências antigas não precisam saber; o teste da issue sobrescreve)
  mockQuery.mockResolvedValue([[{ 1: 1 }]])
})

// ---------------------------------------------------------------------
// billing.context — funções puras
// ---------------------------------------------------------------------

describe('billing.context', () => {
  it('parseCrt extrai o 1º caractere válido do rótulo', () => {
    expect(parseCrt('1 - Simples Nacional')).toBe('1')
    expect(parseCrt('3 - Regime Normal - Lucro Presumido')).toBe('3')
    expect(parseCrt('X inválido')).toBeNull()
    expect(parseCrt(null)).toBeNull()
  })

  it('parseDeadline: "028/056/084" → [28, 56, 84]; vazio = à vista', () => {
    expect(parseDeadline('028/056/084')).toEqual([28, 56, 84])
    expect(parseDeadline('30')).toEqual([30])
    expect(parseDeadline('')).toEqual([0])
    expect(parseDeadline(null)).toEqual([0])
  })

  it('addDays soma dias em formato YYYY-MM-DD', () => {
    expect(addDays('2026-08-20', 28)).toBe('2026-09-17')
  })

  it('adjustMva aplica a fórmula P2.7 quando intra > inter', () => {
    // MVA 40%, inter 12, intra 18: (1.4 × 88/82 − 1) × 100 = 50.2439
    expect(adjustMva(40, 12, 18)).toBeCloseTo(50.2439, 3)
  })

  it('adjustMva mantém a original quando intra ≤ inter', () => {
    expect(adjustMva(40, 18, 12)).toBe(40)
    expect(adjustMva(40, 18, 18)).toBe(40)
  })

  it('deriveProductSt: CEST presente = produto ST', () => {
    expect(deriveProductSt('0100100')).toBe('S')
    expect(deriveProductSt('')).toBe('N')
    expect(deriveProductSt(null)).toBe('N')
  })
})

// ---------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------

describe('billing.repository', () => {
  it('billNumberOf (D-NE266): pedido/nota-parcela com número; sem número o pedido entra no lugar da nota', () => {
    expect(repo.billNumberOf(1500, '7', 2)).toBe('1500/7-2')
    expect(repo.billNumberOf(1500, null, 1)).toBe('1500/1500-1')
  })

  it('getOrderBranch identifica venda (direction S)', async () => {
    mockQuery.mockResolvedValueOnce([[{ entityId: 55 }]])
    const branch = await repo.getOrderBranch('setes_setes', 1, 10)
    expect(branch).toEqual({ branch: 'sale', recipientEntityId: 55, direction: 'S' })
  })

  it('getOrderBranch identifica compra (direction E) depois de venda vazia', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ entityId: 90 }]])
    const branch = await repo.getOrderBranch('setes_setes', 1, 10)
    expect(branch).toEqual({ branch: 'purchase', recipientEntityId: 90, direction: 'E' })
  })

  it('getOrderBranch devolve null sem nenhum ramo', async () => {
    mockQuery
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    expect(await repo.getOrderBranch('setes_setes', 1, 10)).toBeNull()
  })

  it('upsertItemRuleAuto preserva origin M no ON DUPLICATE (IF origin=M)', async () => {
    mockQuery.mockResolvedValueOnce([{}])
    await repo.upsertItemRuleAuto('setes_setes', 1, 10, 3, 'Sale', 42, '5102')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain("IF(origin = 'M', tb_tax_rule_id, VALUES(tb_tax_rule_id))")
    expect(mockQuery.mock.calls[0][1]).toEqual([10, 3, 1, 'Sale', 42, '5102'])
  })
})

// ---------------------------------------------------------------------
// Service — validateOrder
// ---------------------------------------------------------------------

function mockOrderBase(status = 'A') {
  // getOrderStatus
  mockQuery.mockResolvedValueOnce([[{ status }]])
}

function mockBranchSale(entityId = 55) {
  mockQuery.mockResolvedValueOnce([[{ entityId }]]) // tb_order_sale
}

function mockContext(over: {
  emitterRegime?: string; recipientRegime?: string | null
  emitterState?: number | null; recipientState?: number | null
  recipientIssRetido?: 'S' | 'N'
  emitterActivity?: string | null   // IBS.E9.P5: cAtivSN padrão do estabelecimento (tb_entity_tax.simples_activity)
  emitterSimplesRegime?: string | null   // IBS.E9.P5: opSimpNac do emitente ('2' = MEI)
} = {}) {
  // loadContext: getEntityTax(emitter) → getEntityLocation(emitter)
  //            → getEntityTax(recipient) → getEntityLocation(recipient)
  mockQuery.mockResolvedValueOnce([[{
    consumer: 'N', taxRegime: over.emitterRegime ?? '3 - Regime Normal',
    byPassSt: 'N', indIeDest: '1', issRetido: 'N', simplesActivity: over.emitterActivity ?? null,
    simplesRegime: over.emitterSimplesRegime ?? null,
  }]])
  mockQuery.mockResolvedValueOnce([[{
    stateId: over.emitterState === undefined ? 41 : over.emitterState,
    cityId: 1, cityIssAliq: 5,
  }]])
  mockQuery.mockResolvedValueOnce(
    over.recipientRegime === null ? [[]] : [[{
      consumer: 'N', taxRegime: over.recipientRegime ?? '3 - Regime Normal',
      byPassSt: 'N', indIeDest: '1', issRetido: over.recipientIssRetido ?? 'N',
    }]])
  mockQuery.mockResolvedValueOnce([[{
    stateId: over.recipientState === undefined ? 41 : over.recipientState,
    cityId: 2, cityIssAliq: 3,
  }]])
}

const itemRow = (over: any = {}) => ({
  id: 1, kind: 'Sale', productId: 100, quantity: 2, unitValue: 50,
  discountValue: 0, productKind: 'P', ncm: '84713012', origin: '0',
  cest: '', kind_tributary: '1', purpose: '1', simplesActivity: null, ...over,
})

describe('validateOrder', () => {
  it('ordem já faturada -> 409', async () => {
    mockOrderBase('F')
    await expect(validateOrder(inst as any, { orderId: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
  })

  it('D3/D4 (gate socrático 2026-09-29, HIGH): pedido CANCELADO com nota fiscal (C) NUNCA refatura — validate e invoice → 409 ORDER_CANCELLED antes de tocar a nota', async () => {
    mockOrderBase('C')
    await expect(validateOrder(inst as any, { orderId: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCELLED' })
    mockOrderBase('C')
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCELLED' })
    expect((pool as any).getConnection).not.toHaveBeenCalled()   // nenhuma transação aberta: issueInvoice nunca roda
  })

  it('empilha TODAS as issues (não para na primeira) e grava regra achada', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    // listBillingItems: 2 itens — um sem NCM, outro ok
    mockQuery.mockResolvedValueOnce([[
      itemRow({ id: 1, ncm: null }),
      itemRow({ id: 2 }),
    ]])
    // getItemRuleLinks: nenhum
    mockQuery.mockResolvedValueOnce([[]])
    // findTaxRule: item 1 sem regra, item 2 acha
    mockFindTaxRule
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    // clearAutoRuleLink do item 1 + upsert do item 2
    mockQuery.mockResolvedValueOnce([{}])
    mockQuery.mockResolvedValueOnce([{}])

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.issues.length).toBe(2) // ncm ausente + regra ausente do item 1
    expect(report.issues.some(i => i.field === 'ncm' && i.itemId === 1)).toBe(true)
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1)).toBe(true)
    expect(report.rulesResolved).toBe(1)

    // gate A5: match que falhou LIMPA o link automático antigo do item
    const clearCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes("origin = 'A'") && (c[0] as string).includes("SET deleted = 'S'"))
    expect(clearCall).toBeDefined()
  })

  it('Q-A11: ordem de SERVIÇO com ciclo vivo → 409 SERVICE_ORDER_OWN_ENDPOINT no validate (fatura só pelo módulo de OS)', async () => {
    const so = jest.requireMock('../shared/service-order') as any
    so.hasServiceOrderCycle.mockResolvedValueOnce(true)
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])   // ramo sale: não
    mockQuery.mockResolvedValueOnce([[]])   // ramo purchase: não
    mockQuery.mockResolvedValueOnce([[]])   // ramo adjust: não
    mockQuery.mockResolvedValueOnce([[{ entityId: 209 }]])   // ramo service (tomador)
    await expect(validateOrder(inst as any, { orderId: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERVICE_ORDER_OWN_ENDPOINT' })
    expect(so.hasServiceOrderCycle).toHaveBeenCalledWith('setes_setes', 1, 10)
  })

  it('Q-A8: ordem SEM tb_order_billing → issue order/billing (antes: 200 limpo e 422 no invoice)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])
    mockQuery.mockResolvedValueOnce([[]])   // tb_order_billing: nada
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues).toEqual([expect.objectContaining({ scope: 'order', field: 'billing' })])
    const last = mockQuery.mock.calls[mockQuery.mock.calls.length - 1]
    expect(String(last[0])).toMatch(/tb_order_billing[\s\S]*deleted = 'N' LIMIT 1/)
    expect(last[1]).toEqual([10, 1])
  })

  it('D-IB99: opção de apuração sem suporte vira issue BLOQUEANTE também na venda SÓ de mercadoria (a mesma regra do issueInvoice)', async () => {
    const assessment = jest.requireMock('../shared/ibscbs-assessment') as { previewIbscbsAssessmentRefusal: jest.Mock }
    const refusal = { code: 'IBSCBS_REGULAR_REGIME_UNSUPPORTED', message: 'Regime regular de IBS/CBS ainda não suportado: …' }
    assessment.previewIbscbsAssessmentRefusal.mockResolvedValueOnce(refusal)
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues).toEqual([{ scope: 'order', field: 'ibscbsAssessment', message: refusal.message }])
    // pergunta na data que o faturamento usaria (sem serviço: o dono único da data de emissão), sem trava
    expect(assessment.previewIbscbsAssessmentRefusal).toHaveBeenCalledWith(expect.anything(), 'setes_setes', 1, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('D-IB99: a prévia do serviço já trouxe a MESMA recusa → uma issue só (scope ibscbs), sem repetir', async () => {
    const assessment = jest.requireMock('../shared/ibscbs-assessment') as { previewIbscbsAssessmentRefusal: jest.Mock }
    const declaration = jest.requireMock('../shared/service-ibscbs-declaration') as { previewServiceIbscbs: jest.Mock }
    const refusal = { code: 'IBSCBS_REGULAR_REGIME_UNSUPPORTED', message: 'Regime regular de IBS/CBS ainda não suportado: …' }
    assessment.previewIbscbsAssessmentRefusal.mockResolvedValueOnce(refusal)
    declaration.previewServiceIbscbs.mockResolvedValueOnce({ competenceDate: '2027-01-05', obligationStart: '2027-01-01', obligatory: true,
      declared: true, omitted: [], refusal, atObligation: null })
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues).toEqual([{ scope: 'ibscbs', field: 'ibscbs', message: refusal.message }])
    expect(assessment.previewIbscbsAssessmentRefusal.mock.calls[0][3]).toBe('2027-01-05')   // a MESMA competência da prévia
  })

  // ── NFE.E1.P2.T1 (D-NE260, D-NE267): conferência do conteúdo só com a marcação de emitir a NF-e ───────────────────────
  const queueManualItem = () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405', setFinancial: 'S', origin: 'M',
    }]])
  }

  it('D-NE267 — /validate SEM a marcação: o conteúdo nem é lido e a lista é a de sempre', async () => {
    queueManualItem()
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(mockContent.loadInvoiceContent).not.toHaveBeenCalled()
    expect(report.issues).toEqual([])
    queueManualItem()
    await validateOrder(inst as any, { orderId: 10, authorizeNfe: false })
    expect(mockContent.loadInvoiceContent).not.toHaveBeenCalled()
  })

  it('D-NE260 — /validate COM a marcação: as pendências do conteúdo entram na lista, com o campo (destinatário sem CEP e item sem unidade)', async () => {
    queueManualItem()
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent({
      recipient: { address: { street: 'Rua das Flores', number: '100', complement: null, neighborhood: 'Centro', zipCode: null, cityCode: '4106902', state: 'PR' } },
      items: [{ itemId: 1, description: 'Peça usinada', ncm: '84713012', unit: null, taxableUnit: null, gtin: null }],
    }))
    const report = await validateOrder(inst as any, { orderId: 10, authorizeNfe: true })
    expect(mockContent.loadInvoiceContent).toHaveBeenCalledWith('setes_setes', 1, 55, [expect.objectContaining({ id: 1, productId: 100 })])
    expect(report.issues).toEqual([
      { scope: 'recipient', field: 'zipCode', message: 'CEP do destinatário não informado' },
      { scope: 'item', itemId: 1, field: 'unit', message: 'Item 1: produto sem unidade de venda cadastrada' },
    ])
  })

  it('D-NE260 — /validate COM a marcação e conteúdo bom: nenhuma pendência nova', async () => {
    queueManualItem()
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent())
    expect((await validateOrder(inst as any, { orderId: 10, authorizeNfe: true })).issues).toEqual([])
  })

  it('NFE.E1.P4.T4 — /validate COM a marcação: o CST de PIS e de COFINS da regra do item vai à conferência (regra sem COFINS → null); item sem regra vai sem o campo', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 }), itemRow({ id: 2, productId: 200 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405', setFinancial: 'S', origin: 'M' }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null, aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N', deferredAliq: null, highlight: 'N' },
      pisCofins: [{ kind: 'P', cst: '07', aliq: 0 }],
    })
    mockFindTaxRule.mockResolvedValueOnce(null)                   // item 2: nenhuma regra casa
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent({
      items: [{ itemId: 1, description: 'Peça', ncm: '84713012', unit: 'UN', taxableUnit: 'UN', gtin: null, pisCst: '07', cofinsCst: null }],
    }))
    const report = await validateOrder(inst as any, { orderId: 10, authorizeNfe: true })
    const passed = mockContent.loadInvoiceContent.mock.calls[0][3] as any[]
    expect(passed.find(i => i.id === 1)).toMatchObject({ pisCst: '07', cofinsCst: null })
    expect('pisCst' in passed.find(i => i.id === 2)).toBe(false)   // sem regra: não conferido aqui (a pendência dele é a da regra)
    expect(report.issues).toEqual(expect.arrayContaining([
      { scope: 'item', itemId: 1, field: 'cofins', message: 'Item 1: regra de tributação sem COFINS' },
    ]))
    expect(report.issues.some(i => i.field === 'pis')).toBe(false)
  })

  it('D-NE267 — pedido SÓ de serviço com a marcação: o conteúdo da NF-e não é conferido (não há nota de mercadoria)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S' })]])
    mockQuery.mockResolvedValueOnce([[]])
    await validateOrder(inst as any, { orderId: 10, authorizeNfe: true })
    expect(mockContent.loadInvoiceContent).not.toHaveBeenCalled()
  })

  it('linha manual (M) é respeitada — motor não roda para o item', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(mockFindTaxRule).not.toHaveBeenCalled()
    expect(report.rulesManual).toBe(1)
    expect(report.issues).toEqual([])
  })

  // D42 — regra casada precisa do código do regime VIGENTE do emitente
  it('D42: emitente Simples + regra só-CST -> issue e link NÃO gravado', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]]) // itens
    mockQuery.mockResolvedValueOnce([[]])                   // links
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: '00', csosn: null } })
    mockQuery.mockResolvedValueOnce([{}]) // clearAutoRuleLink

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.rulesResolved).toBe(0)
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1
      && i.message.includes('sem CSOSN'))).toBe(true)
    // link automático limpo (sem link o /invoice devolve REQUIRES_VALIDATION)
    const clearCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes("origin = 'A'") && (c[0] as string).includes("SET deleted = 'S'"))
    expect(clearCall).toBeDefined()
    // e NENHUM upsert de link aconteceu
    const upsertCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes('tb_order_item_has_tax_rule') && (c[0] as string).includes('INSERT'))
    expect(upsertCall).toBeUndefined()
  })

  it('D42: emitente Normal + regra só-CSOSN -> issue pedindo CST', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '3 - Regime Normal - Lucro Real' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[]])
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: null, csosn: '102' } })
    mockQuery.mockResolvedValueOnce([{}]) // clearAutoRuleLink

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i => i.field === 'taxRule'
      && i.message.includes('sem CST'))).toBe(true)
  })

  it('D42: RegraDireta (M) incompleta p/ o regime gera issue mas o vínculo permanece', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: '60', csosn: null } })

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.rulesManual).toBe(1)
    expect(mockFindTaxRule).not.toHaveBeenCalled()
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1
      && i.message.includes('99'))).toBe(true)
  })

  it('D42: regra completa p/ o regime segue normal (Simples + CSOSN presente)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[]])
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: null, csosn: '102' } })
    mockQuery.mockResolvedValueOnce([{}]) // upsert

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.rulesResolved).toBe(1)
    expect(report.issues).toEqual([])
  })

  it('emitente Simples (CRT 1) NÃO gera issue — CSOSN implementado (P2.9)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[]]) // sem itens
    mockQuery.mockResolvedValueOnce([[]]) // sem links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i => i.scope === 'emitter')).toBe(false)
  })

  it('ordem de ajuste sem adjustment -> issue de order', async () => {
    mockOrderBase()
    // branch: sale vazio, purchase vazio, adjust presente
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.branch).toBe('adjust')
    expect(report.issues.some(i => i.field === 'adjustment')).toBe(true)
  })

  it('D-A31: devolução com âncora soft-deletada e ordem viva → issue de inconsistência (não vira ajuste solto)', async () => {
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 7543, deleted: 'S' })
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'E', cfopId: 3 }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockQuery.mockResolvedValueOnce([[]]) // links
    const report = await validateOrder(inst as any, { orderId: 7544 })
    expect(report.issues.some(i => i.field === 'adjustment' && /âncora cancelada/.test(i.message))).toBe(true)
    expect(mockOrderReturn.getAnchor).toHaveBeenCalledWith('setes_setes', 1, 7544, { includeDeleted: true })
    expect(mockOrderReturn.buildReturnPlan).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// Service — invoiceOrder
// ---------------------------------------------------------------------

// Gate socrático 2026-09-06 (TOCTOU): a negociação é resolvida DENTRO da
// transação do faturamento (depois do FOR UPDATE) — billing, installments e
// kinds saem do pool e entram na conn.
let txnDeadline: string | null = null
function mockNegotiationInTx(conn: { query: jest.Mock }, deadline: string | null) {
  conn.query.mockResolvedValueOnce([[{ paymentTypeId: 5, plots: null, deadline }]]) // tb_order_billing (na tx)
  conn.query.mockResolvedValueOnce([[]])                                            // installments
  conn.query.mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 }]]) // assertPaymentRules (Q-N1, na tx)
  conn.query.mockResolvedValueOnce([[]])                                            // getPaymentTypeKinds (D9 cheque)
}

describe('invoiceOrder', () => {
  it('item de mercadoria sem regra gravada -> 422 REQUIRES_VALIDATION', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]]) // itens
    mockQuery.mockResolvedValueOnce([[]])                   // links vazios

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('D-NE220 — id de item repetido entre os kind -> 422 ORDER_ITEM_ID_DUPLICATED com o item no detalhe, antes de ler vínculo ou gravar', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[
      itemRow({ id: 1, kind: 'Sale' }), itemRow({ id: 2, kind: 'Sale' }),
      itemRow({ id: 1, kind: 'Service', productKind: 'S' }),
    ]])
    const before = mockQuery.mock.calls.length
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'ORDER_ITEM_ID_DUPLICATED',
      fields: [{ field: 'item.1', message: expect.stringContaining('item 1') }],
    })
    expect(mockQuery.mock.calls.length).toBe(before + 7)   // status, ramo, 4 do contexto, itens — nenhuma leitura depois
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it('D-NE220 — duplicatedItemIds: ids distintos passam (1/Sale e 2/Service); repetidos saem em ordem, uma vez cada', () => {
    expect(duplicatedItemIds([{ id: 1 }, { id: 2 }])).toEqual([])
    expect(duplicatedItemIds([{ id: 3 }, { id: 1 }, { id: 3 }, { id: 1 }, { id: 3 }])).toEqual([1, 3])
    expect(duplicatedItemIds([])).toEqual([])
  })

  it('pendência de cadastro (destinatário sem UF) -> 422 antes de tudo', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ recipientState: null })
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  // NFE.E1.P3 (D-NE257/D-NE266): a nota de mercadoria nasce SEM número — o retorno leva null e o título leva o pedido no lugar
  // da nota (`pedido/pedido-parcela`); com número (o que a peça devolve para os modelos que o ERP numera) segue `pedido/nota-parcela`
  it.each([
    [null, ['10/10-1', '10/10-2']],
    ['1', ['10/1-1', '10/1-2']],
  ] as Array<[string | null, string[]]>)('fatura feliz (número da nota = %s): calcula, monta parcelas do prazo e persiste', async (issuedNumber, billNumbers) => {
    ;(jest.requireMock('../shared/invoice') as any).issueInvoice.mockResolvedValueOnce({ invoiceNumber: issuedNumber, event: 1 })
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{                       // link A
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds: 42 vivo
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])       // shipping
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])      // totalizer
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates

    // persistInvoice via conn
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: null, deadline: '028/056' }]]) // negociação (na tx)
      .mockResolvedValueOnce([[]])                  // installments
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 }]]) // assertPaymentRules (Q-N1)
      .mockResolvedValueOnce([[]])                  // kinds
      .mockResolvedValueOnce([{}])                  // icms item
      .mockResolvedValueOnce([{}])                  // approx_tax_aliq update
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial p1 + bill p1
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial p2 + bill p2
      .mockResolvedValueOnce([{}])                  // status F

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.invoiceNumber).toBe(issuedNumber)
    expect(result.model).toBe('55')
    expect(result.parcels).toBe(2)                  // prazo 028/056
    expect(result.totalValue).toBe(100)
    expect(conn.commit).toHaveBeenCalled()

    // Gate socrático 2026-09-06 (TOCTOU): a negociação é lida DEPOIS do
    // FOR UPDATE em tb_order, na mesma conexão — nunca pelo pool antes do lock.
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[1][0]).toContain('tb_order_billing')
    expect(mockQuery.mock.calls.some(c => (c[0] as string).includes('tb_order_billing'))).toBe(false)

    // financeiro: 2 parcelas de 50 kind RA (venda)
    const finCalls = conn.query.mock.calls.filter(c =>
      (c[0] as string).includes('INSERT INTO') && (c[0] as string).includes('tb_financial\n'))
    const billCalls = conn.query.mock.calls.filter(c =>
      (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls.length).toBe(2)
    expect(billCalls[0][1]).toContain('RA')
    expect(billCalls.map(c => (c[1] as unknown[])[3])).toEqual(billNumbers)
    void finCalls
  })

  it('gate A4: regra do link soft-deletada -> 422 REQUIRES_VALIDATION (nunca nota sem imposto)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[]]) // findDeadRuleIds: 42 NÃO está vivo

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('gate A6: item com desconto maior que o valor -> 422 NEGATIVE_ITEM_VALUE', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, discountValue: 140 })]]) // 100 - 140 = -40
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]]) // regra viva

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'NEGATIVE_ITEM_VALUE' })
  })

  it('gate A2: deadline absurdo ("999999999") -> 422 INVALID_DEADLINE, nunca 500', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
    const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    mockNegotiationInTx(conn, '999999999')

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_DEADLINE' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('gate A8: destinatário sem tributação configurada gera issue na validação', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ recipientRegime: null })
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i =>
      i.scope === 'recipient' && i.field === 'taxRegime')).toBe(true)
  })

  it('gate P1: nota SÓ de serviço grava tb_invoice_service, nunca merchandise', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S' })]])
    mockQuery.mockResolvedValueOnce([[]])                 // links (mercadoria)
    // Onda 3: serviço exige vínculo irmão + regra viva/coerente (cidade 2 = tomador)
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 2, cityName: 'X', serviceListId: '1.02', aliq: 5, municipalCode: null, nationalCode: '010201', active: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[]])                 // getGeneralObservations

    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: null, deadline: null }]]) // negociação (na tx)
      .mockResolvedValueOnce([[]])                  // installments
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 }]]) // assertPaymentRules (Q-N1)
      .mockResolvedValueOnce([[]])                  // kinds
      .mockResolvedValueOnce([{}])                  // issqn item
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financeiro p1
      .mockResolvedValueOnce([{}])                  // status F

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.model).toBe('SE')                 // só serviço → SE
    // D-NE248 (082): o ISS retido que o motor calculou é registrado (aqui o tomador não retém → 0, não NULL)
    const issqn = conn.query.mock.calls.find(c => /INSERT INTO `setes_setes`\.tb_order_item_issqn\b/.test(String(c[0])))!
    expect(String(issqn[0])).toMatch(/tax_code, withheld_value,[\s\S]*withheld_value = VALUES\(withheld_value\)/)
    expect((issqn[1] as unknown[]).at(-1)).toBe(0)
    // IB-2 (gate socrático) + D-FAT1: a releitura do pedido sob a trava (travante, antes da declaração) é a conferência única do
    // começo da transação — provada em billing-input-print.test.ts; aqui, que ela foi chamada com a impressão do service
    expect(mockInputPrint.assertBillingInputsUnchanged).toHaveBeenCalledWith(conn, 'setes_setes', 1, 10, expect.stringContaining('I|1|Sale|100|2|50|0'))
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    // natureza por PRESENÇA chega à peça: serviço com total, mercadoria ausente
    const inv = jest.requireMock('../shared/invoice') as any
    expect(inv.issueInvoice).toHaveBeenCalledTimes(1)
    expect(inv.issueInvoice.mock.calls[0][4]).toMatchObject({ merchandise: null })
    expect(inv.issueInvoice.mock.calls[0][4].service.totalValue).toBeGreaterThan(0)
    expect(inv.issueInvoice.mock.calls[0][4].service.nationalCode).toBe('010201')
    expect(sqls.some(s => s.includes('tb_invoice_merchandise'))).toBe(false)
    // IB-2 (D-IB64/D-IB71): a declaração IBS/CBS pela composição ÚNICA na transação (conexão dela), com o campo do ITEM e a
    // MESMA data que vai à nota; congelada no ramo e devolvida no resultado (D-IB65)
    const decl = jest.requireMock('../shared/service-ibscbs-declaration') as any
    expect(decl.declareServiceIbscbs).toHaveBeenCalledWith(conn, 'setes_setes', 1, {
      items: [{ productId: expect.any(Number), field: 'item.1' }],
      competenceDate: inv.issueInvoice.mock.calls[0][4].dtEmission,
    })
    expect(inv.issueInvoice.mock.calls[0][4].dtEmission).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(inv.issueInvoice.mock.calls[0][4].service.ibscbs).toEqual({ group: null, nbs: null, omitted: ['not-classified'] })
    expect(result.ibscbs).toEqual({ declared: false, omitted: ['not-classified'] })
  })

  it('ordem já faturada detectada DENTRO da transação -> 409 e rollback', async () => {
    mockOrderBase()  // status A na leitura otimista
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S', kind: 'Sale' })]])
    mockQuery.mockResolvedValueOnce([[]])                 // links (mercadoria)
    // Onda 3: serviço exige vínculo irmão + regra viva/coerente (cidade 2 = tomador)
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 2, cityName: 'X', serviceListId: '1.02', aliq: 5, municipalCode: null, nationalCode: '010201', active: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[]])                 // getGeneralObservations

    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]]) // mudou no meio

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------
  // Rodada 5 (evidência do legado, 2026-08-21)
  // -------------------------------------------------------------------

  it('R5-Q3: item de mercadoria sem NCM -> 422 MISSING_NCM (gate revalidado no /invoice)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, ncm: null })]])
    mockQuery.mockResolvedValueOnce([[]]) // getItemRuleLinks

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MISSING_NCM' })
  })

  it('R5-Q2: parcelamento elaborado diverge do valor atual -> 422 INSTALLMENT_MISMATCH', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
    // Resolução DENTRO da transação (gate socrático 2026-09-06 — TOCTOU):
    // elaborado com soma 80 ≠ base do PEDIDO 100 (itens editados depois da
    // negociação). D4/D7: a comparação é contra a base do PEDIDO (itens +
    // frete, sem impostos — ValidaParcelamento do legado), não da nota.
    const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    conn.query.mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '002', deadline: '028/056' }]])
    conn.query.mockResolvedValueOnce([[
      { parcel: 1, dueDate: '2026-09-01', amount: 40, paymentTypeId: 5 },
      { parcel: 2, dueDate: '2026-10-01', amount: 40, paymentTypeId: 5 },
    ]])
    conn.query.mockResolvedValueOnce([[{ quantity: 1, unitValue: 100, discountValue: 0, setFinancial: 'S' }]])
    conn.query.mockResolvedValueOnce([[{ freight: 0 }]])

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_MISMATCH' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  function mockPersistTxn(extraInserts: number) {
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    mockNegotiationInTx(conn, txnDeadline)
    conn.query.mockResolvedValueOnce([{}])                  // icms item
    conn.query.mockResolvedValueOnce([{}])                  // approx_tax_aliq update
    for (let i = 0; i < extraInserts; i++) {
      conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial + bill
    }
    conn.query.mockResolvedValueOnce([{}])                  // status F
    return conn
  }

  function mockHappyItemChain(deadline: string | null) {
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    txnDeadline = deadline
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
  }

  it('R5-Q1: compra (branch purchase) gera financeiro PA + D', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])                    // tb_order_sale vazio
    mockQuery.mockResolvedValueOnce([[{ entityId: 90 }]])    // tb_order_purchase
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Purchase' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Purchase', taxRuleId: 42, cfopId: '1102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(result.parcels).toBe(1)

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('PA')
    expect(billCalls[0][1]).toContain('D')
  })

  it('R5-Q1: ajuste com direção Entrada (E) gera RA + D — inverso do padrão de venda', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])                    // sale vazio
    mockQuery.mockResolvedValueOnce([[]])                    // purchase vazio
    // direção vem do RAMO (fonte única — parecer 2026-08-24)
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'E' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1949',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1949' },
    })

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('RA')
    expect(billCalls[0][1]).toContain('D')
  })

  it('R5-Q1: ajuste com direção Saída (S) gera PA + C', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '5949',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '5949' },
    })

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('PA')
    expect(billCalls[0][1]).toContain('C')
  })

  // ── D-NE248 (NFE.E1.P1.T3): o cálculo é registrado por item, inteiro ──────────────────────────────────────────────
  const icmsPiece = (over: Record<string, unknown> = {}) => ({
    cstNr: '00', csosn: null, modBc: '3', dischargeId: null, aliq: 18, aliqReduction: 0, baseReduction: 0,
    deferred: 'N', deferredAliq: null, highlight: 'N', ...over,
  })
  /** Fatura UM item de mercadoria (2 × 50,00) com as peças dadas; a conexão responde `[{}]` a toda gravação. */
  async function invoiceWithPieces(pieces: Record<string, unknown>, ctxOver: Parameters<typeof mockContext>[0] = {}, items: any[] = [itemRow({ id: 1 })], freight = 0) {
    mockOrderBase()
    mockBranchSale()
    mockContext(ctxOver)
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A',
    }))])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce(pieces)
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])     // FOR UPDATE
    mockNegotiationInTx(conn, null)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    const call = (table: RegExp) => conn.query.mock.calls.find(c => table.test(String(c[0])))
    return { result, conn, call }
  }

  it('D-NE248 — CST 51: grava o ICMS da operação, a alíquota e o valor do diferimento que o motor calculou (antes eram descartados)', async () => {
    const { call } = await invoiceWithPieces({ icms: icmsPiece({ cstNr: '51', deferred: 'S', deferredAliq: 33.33 }) })
    const icms = call(/INSERT INTO `setes_setes`\.tb_order_item_icms\b/)!
    expect(String(icms[0])).toMatch(/operation_value, deferred_aliq, deferred_value,/)
    expect(String(icms[0])).toMatch(/operation_value = VALUES\(operation_value\), deferred_aliq = VALUES\(deferred_aliq\),\s+deferred_value = VALUES\(deferred_value\)/)
    // base 100,00 × 18% = 18,00 (vICMSOp); 18,00 × 33,33% = 6,00 (vICMSDif)
    expect((icms[1] as unknown[]).slice(-3)).toEqual([18, 33.33, 6])
  })

  it('D-NE248 — CST 00: o motor não calcula diferimento → as três colunas ficam NULL (nunca zero)', async () => {
    const { call } = await invoiceWithPieces({ icms: icmsPiece() })
    expect((call(/INSERT INTO `setes_setes`\.tb_order_item_icms\b/)![1] as unknown[]).slice(-3)).toEqual([null, null, null])
  })

  it('D-NE248 — CSOSN: o ICMS da operação é gravado (base × alíquota) e o diferimento é 0 com alíquota 0 quando a regra não difere — o que o motor devolveu, como devolveu', async () => {
    const { call } = await invoiceWithPieces({ icms: icmsPiece({ cstNr: null, csosn: '101' }) }, { emitterRegime: '1 - Simples Nacional' })
    expect((call(/INSERT INTO `setes_setes`\.tb_order_item_icms\b/)![1] as unknown[]).slice(-3)).toEqual([18, 0, 0])
  })

  it('D-NE248 — CSOSN com diferimento e destinatário revendedor: alíquota e valor do diferimento gravados', async () => {
    const { call } = await invoiceWithPieces({ icms: icmsPiece({ cstNr: null, csosn: '900', deferredAliq: 50 }) }, { emitterRegime: '1 - Simples Nacional' })
    expect((call(/INSERT INTO `setes_setes`\.tb_order_item_icms\b/)![1] as unknown[]).slice(-3)).toEqual([18, 50, 9])
  })

  it('D-NE248 — IPI: o VALOR calculado é gravado em tag_value (a tabela só tinha base e alíquota)', async () => {
    const { call } = await invoiceWithPieces({ icms: icmsPiece(), ipi: { cst: '50', aliq: 10 } })
    const ipi = call(/INSERT INTO `setes_setes`\.tb_order_item_ipi\b/)!
    expect(String(ipi[0])).toMatch(/base_value, aliq_value, tag_value,[\s\S]*tag_value = VALUES\(tag_value\)/)
    expect((ipi[1] as unknown[]).slice(-3)).toEqual([100, 10, 10])   // base 100,00 × 10% = 10,00
  })

  it('D-NE267 — /invoice SEM a marcação: o conteúdo não é lido e a nota sai como sempre, mesmo com texto longo', async () => {
    const { result } = await invoiceWithPieces({ icms: icmsPiece() })
    expect(result.totalValue).toBe(100)
    expect(mockContent.loadInvoiceContent).not.toHaveBeenCalled()
  })

  it('D-NE260 — /invoice COM a marcação e pendência de conteúdo: 422 REQUIRES_VALIDATION com os campos, antes de abrir conexão', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent({
      recipient: { name: 'N'.repeat(73) },
      items: [{ itemId: 1, description: 'Peça usinada', ncm: '84713012', unit: null, taxableUnit: null, gtin: '123' }],
    }))
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, authorizeNfe: true })).rejects.toMatchObject({
      statusCode: 422, code: 'REQUIRES_VALIDATION',
      fields: [
        { field: 'name', message: 'Nome do destinatário com 73 caracteres — o máximo da NF-e é 60' },
        { field: 'item.1', message: 'Item 1: produto sem unidade de venda cadastrada' },
        { field: 'item.1', message: expect.stringContaining('GTIN') },
      ],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it('NFE.E1.P4.T4 — /invoice COM a marcação: regra vinculada sem PIS → 422 REQUIRES_VALIDATION no item, antes de gravar; as peças lidas na conferência são as do cálculo (uma leitura só)', async () => {
    const queue = () => {
      mockOrderBase()
      mockBranchSale()
      mockContext()
      mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
      mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
      mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    }
    queue()
    mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece(), pisCofins: [{ kind: 'C', cst: '07', aliq: 0 }] })
    mockContent.loadInvoiceContent.mockImplementationOnce(async (_s: string, _i: number, _r: number, items: any[]) => goodContent({
      items: items.map(i => ({ itemId: i.id, description: 'Peça', ncm: '84713012', unit: 'UN', taxableUnit: 'UN', gtin: null, pisCst: i.pisCst, cofinsCst: i.cofinsCst })),
    }))
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, authorizeNfe: true })).rejects.toMatchObject({
      statusCode: 422, code: 'REQUIRES_VALIDATION',
      fields: [{ field: 'item.1', message: 'Item 1: regra de tributação sem PIS' }],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()

    // com as duas peças (CST 07 do Simples) a nota sai, e a regra foi lida UMA vez (conferência e cálculo usam o mesmo cache)
    queue()
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockClear()
    mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece(), pisCofins: [{ kind: 'P', cst: '07', aliq: 0 }, { kind: 'C', cst: '07', aliq: 0 }] })
    mockContent.loadInvoiceContent.mockImplementationOnce(async (_s: string, _i: number, _r: number, items: any[]) => goodContent({
      items: items.map(i => ({ itemId: i.id, description: 'Peça', ncm: '84713012', unit: 'UN', taxableUnit: 'UN', gtin: null, pisCst: i.pisCst, cofinsCst: i.cofinsCst })),
    }))
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    mockNegotiationInTx(conn, null)
    const ok = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, authorizeNfe: true })
    expect(ok.totalValue).toBe(100)
    expect(mockLoadPieces).toHaveBeenCalledTimes(1)
    // e o CST do item foi registrado nas tabelas de PIS e de COFINS (D-NE248)
    const cst = (table: string) => (conn.query.mock.calls.find((c: any[]) => String(c[0]).includes(`.${table}`))![1] as unknown[])[3]
    expect([cst('tb_order_item_pis'), cst('tb_order_item_cofins')]).toEqual(['07', '07'])
  })

  it('D-NE260 — /invoice COM a marcação e conteúdo bom: fatura', async () => {
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent())
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece() })
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    mockNegotiationInTx(conn, null)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, authorizeNfe: true })
    expect(result.totalValue).toBe(100)
    expect(mockContent.loadInvoiceContent).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('D-NE49 — /invoice COM a marcação e texto da nota acima de 5000 caracteres: 422 com o campo note (nunca trunca); sem a marcação, fatura', async () => {
    const queue = () => {
      mockOrderBase()
      mockBranchSale()
      mockContext()
      mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
      mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
      mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
      mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
      mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
      mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece() })
      mockQuery.mockResolvedValueOnce([[]])                                      // getRuleObservationNotes
      mockQuery.mockResolvedValueOnce([[{ note: 'x'.repeat(5001) }]])            // getGeneralObservations: texto de 5001
      mockQuery.mockResolvedValueOnce([[]])                                      // getNcmApproxRates
    }
    queue()
    mockContent.loadInvoiceContent.mockResolvedValueOnce(goodContent())
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, authorizeNfe: true })).rejects.toMatchObject({
      statusCode: 422, code: 'REQUIRES_VALIDATION',
      fields: [{ field: 'note', message: 'Observações da nota com 5001 caracteres — o máximo da NF-e é 5000' }],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
    // sem a marcação o mesmo pedido fatura (o texto vai inteiro para a nota interna, como sempre)
    queue()
    const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    mockNegotiationInTx(conn, null)
    const ok = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(ok.totalValue).toBe(100)
    expect((jest.requireMock('../shared/invoice') as any).issueInvoice.mock.calls[0][4].noteText.length).toBe(5001)
  })

  it('D-FAT2 — todos os itens em valor zero com frete 10,00: o frete é dividido em partes iguais (5,00 em cada item) e o total da nota fecha em 10,00 (antes o frete sumia)', async () => {
    const inv = jest.requireMock('../shared/invoice') as any
    const { result, conn } = await invoiceWithPieces({ icms: icmsPiece() }, {},
      [itemRow({ id: 1, unitValue: 0 }), itemRow({ id: 2, unitValue: 0 })], 10)
    expect(result.totalValue).toBe(10)
    const icms = conn.query.mock.calls.filter((c: any[]) => /INSERT INTO `setes_setes`\.tb_order_item_icms\b/.test(String(c[0])))
    expect(icms.length).toBe(2)
    // freight_value do item = antepenúltimo bloco: [..., freight, expenses, cfop, vICMSOp, pDif, vICMSDif]
    expect(icms.map((c: any[]) => (c[1] as unknown[]).at(-6))).toEqual([5, 5])
    expect(inv.issueInvoice.mock.calls[0][4].merchandise).toMatchObject({ freight: 10, totalValue: 10 })   // vNF = vFrete 10,00
  })

  // ── D-FAT1 (NFE.E1.P1.T4): a nota só grava cálculo conferido com o pedido travado ─────────────────────────────────────
  it('D-FAT1 — pedido de MERCADORIA também é conferido sob a trava, com a impressão de itens, vínculo, frete e despesas', async () => {
    const { conn } = await invoiceWithPieces({ icms: icmsPiece() })
    expect(mockInputPrint.assertBillingInputsUnchanged).toHaveBeenCalledTimes(1)
    expect(mockInputPrint.assertBillingInputsUnchanged).toHaveBeenCalledWith(conn, 'setes_setes', 1, 10,
      'I|1|Sale|100|2|50|0\nL|1|Sale|42|5102|S\nF|0\nE|0')
    // a conferência vem logo depois da trava do pedido e antes de qualquer gravação
    expect(String(conn.query.mock.calls[0][0])).toContain('FOR UPDATE')
    expect(conn.query.mock.calls.findIndex((c: any[]) => /INSERT INTO/.test(String(c[0])))).toBeGreaterThan(0)
  })

  it('D-FAT1 — o pedido mudou antes da trava: nada é gravado na 1ª tentativa (rollback), o faturamento RELÊ e RECALCULA, e a nota sai com o imposto do item novo', async () => {
    const { BillingInputChanged } = jest.requireActual('../modules/billing/billing.input-print')
    mockInputPrint.assertBillingInputsUnchanged.mockRejectedValueOnce(new BillingInputChanged(10))
    // 1ª leitura: quantidade 2 (100,00); alguém edita; 2ª leitura: quantidade 5 (250,00)
    const queue = (quantity: number) => {
      mockOrderBase(); mockBranchSale(); mockContext()
      mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, quantity })]])
      mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
      mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
      mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
      mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
      mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece() })
      mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    }
    queue(2)
    queue(5)
    const mk = () => ({
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    })
    const first = mk(); const second = mk()
    first.query.mockResolvedValueOnce([[{ status: 'A' }]])
    second.query.mockResolvedValueOnce([[{ status: 'A' }]])
    mockNegotiationInTx(second, null)
    ;((pool as any).getConnection as jest.Mock).mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.totalValue).toBe(250)
    expect(first.rollback).toHaveBeenCalledTimes(1)
    expect(first.commit).not.toHaveBeenCalled()
    expect(first.release).toHaveBeenCalledTimes(1)
    expect(first.query.mock.calls.some((c: any[]) => /INSERT|UPDATE `/.test(String(c[0])))).toBe(false)   // nada gravado
    expect(second.commit).toHaveBeenCalledTimes(1)
    const icms = second.query.mock.calls.find((c: any[]) => /INSERT INTO `setes_setes`\.tb_order_item_icms\b/.test(String(c[0])))!
    expect(icms[1]).toEqual(expect.arrayContaining([250, 45]))                                             // base 250,00 e ICMS 45,00 — do item NOVO
    expect(mockInputPrint.assertBillingInputsUnchanged.mock.calls.map((c: any[]) => c[4])).toEqual([
      'I|1|Sale|100|2|50|0\nL|1|Sale|42|5102|S\nF|0\nE|0', 'I|1|Sale|100|5|50|0\nL|1|Sale|42|5102|S\nF|0\nE|0',
    ])
    expect((jest.requireMock('../shared/invoice') as any).issueInvoice).toHaveBeenCalledTimes(1)          // uma nota só
  })

  it('D-FAT1 — o pedido muda nas 3 tentativas → 409 RESOURCE_BUSY, nenhuma nota, toda conexão devolvida', async () => {
    const { BillingInputChanged } = jest.requireActual('../modules/billing/billing.input-print')
    mockInputPrint.assertBillingInputsUnchanged.mockRejectedValue(new BillingInputChanged(10))
    try {
      const conns: any[] = []
      ;((pool as any).getConnection as jest.Mock).mockImplementation(async () => {
        const c = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
        c.query.mockResolvedValueOnce([[{ status: 'A' }]])
        conns.push(c)
        return c
      })
      for (let i = 0; i < BILLING_INPUT_ATTEMPTS; i++) {
        mockOrderBase(); mockBranchSale(); mockContext()
        mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, quantity: i + 1 })]])
        mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
        mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
        mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
        mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
        mockLoadPieces.mockResolvedValueOnce({ icms: icmsPiece() })
        mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      }
      await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
        .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
      expect(BILLING_INPUT_ATTEMPTS).toBe(3)
      expect(conns.length).toBe(3)
      for (const c of conns) {
        expect(c.rollback).toHaveBeenCalledTimes(1)
        expect(c.commit).not.toHaveBeenCalled()
        expect(c.release).toHaveBeenCalledTimes(1)
      }
      expect((jest.requireMock('../shared/invoice') as any).issueInvoice).not.toHaveBeenCalled()
    } finally {
      mockInputPrint.assertBillingInputsUnchanged.mockReset().mockResolvedValue(undefined)
      ;((pool as any).getConnection as jest.Mock).mockReset()
    }
  })

  it('D-NE215 — o faturamento entrega ao ramo de mercadoria o vNF da fórmula oficial; sem FCP-ST é o mesmo número do total da nota', async () => {
    const inv = jest.requireMock('../shared/invoice') as any
    const { result } = await invoiceWithPieces({ icms: icmsPiece(), ipi: { cst: '50', aliq: 10 } })
    expect(result.totalValue).toBe(110)                                              // 100,00 + IPI 10,00 — como era
    expect(inv.issueInvoice.mock.calls[0][4].totalValue).toBe(110)
    expect(inv.issueInvoice.mock.calls[0][4].merchandise.totalValue).toBe(110)       // vNF = vProd 100,00 + vIPI 10,00
  })

  it('D-NE215 — com FCP-ST o vNF do ramo inclui a parcela (fórmula oficial); o total da nota e o financeiro NÃO mudam neste passo', async () => {
    const stRates = jest.requireMock('../modules/state-tax-rates/state-tax-rates.repository') as any
    stRates.resolveMvaAliq.mockResolvedValue({ internalAliq: 18, mvaOriginal: 40 })
    stRates.resolveFcpAliq.mockResolvedValue({ aliq: 2 })
    try {
      const inv = jest.requireMock('../shared/invoice') as any
      const { result, conn } = await invoiceWithPieces({
        icms: icmsPiece({ cstNr: '10' }), icmsSt: { modBcSt: '4', propagateBaseReduction: 'N' },
      })
      const m = inv.issueInvoice.mock.calls[0][4].merchandise
      expect(m.icmsSt).toBeGreaterThan(0)
      // a diferença entre o vNF do ramo e o total da nota é EXATAMENTE o FCP-ST que o motor calculou e gravou no item (vfcpst)
      const fcp = conn.query.mock.calls.find((c: any[]) => /INSERT INTO `setes_setes`\.tb_order_item_icms_fcp\b/.test(String(c[0])))!
      const vfcpst = (fcp[1] as number[]).at(-1)!
      expect(vfcpst).toBeGreaterThan(0)
      expect(Math.round((m.totalValue - result.totalValue) * 100)).toBe(Math.round(vfcpst * 100))
      expect(Math.round(result.totalValue * 100)).toBe(10000 + Math.round(m.icmsSt * 100))   // total da nota: como era (sem FCP-ST)
    } finally {
      stRates.resolveMvaAliq.mockResolvedValue(null)
      stRates.resolveFcpAliq.mockResolvedValue(null)
    }
  })

  it('D-NE248 — serviço com tomador que RETÉM o ISS: o ISS retido calculado (5% de 100,00 = 5,00) é gravado em withheld_value', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ recipientIssRetido: 'S' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S' })]])
    mockQuery.mockResolvedValueOnce([[]])                 // links (mercadoria)
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 2, cityName: 'X', serviceListId: '1.02', aliq: 5, municipalCode: null, nationalCode: '010201', active: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[]])                 // getGeneralObservations
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    mockNegotiationInTx(conn, null)
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    const issqn = conn.query.mock.calls.find((c: any[]) => /INSERT INTO `setes_setes`\.tb_order_item_issqn\b/.test(String(c[0])))!
    // params: ...key(3), base, alíquota, valor, listservice, tax_code, ISS retido
    expect((issqn[1] as unknown[]).slice(3)).toEqual([100, 5, 5, '1.02', null, 5])
  })

  it('D-NE248 — cerca: todo campo que o motor devolve tem coluna (TAX_CALC_RECORD); o imposto de importação fica fora porque o faturamento não o entrega ao motor', () => {
    const r = repo.TAX_CALC_RECORD
    expect(r.icms).toMatchObject({ operationValue: 'operation_value', deferredAliq: 'deferred_aliq', deferredValue: 'deferred_value' })
    expect(r.ipi.value).toBe('tag_value')
    expect(r.issqn.withheldValue).toBe('withheld_value')
    expect(r.tables.ii).toBeNull()
    // as colunas do mapa existem no SQL que o faturamento grava e na migration 082 (as novas)
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'billing', 'billing.repository.ts'), 'utf8')
    const persist = src.slice(src.indexOf('async function persistItemTaxes'))
    for (const col of [...Object.values(r.icms), ...Object.values(r.fcp), ...Object.values(r.fcpSt), ...Object.values(r.ipi),
      ...Object.values(r.pisCofins).filter((c): c is string => c !== null), ...Object.values(r.issqn)]) {
      expect(persist).toContain(col)
    }
    const m082 = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '082_order_item_tax_calc_record.sql'), 'utf8')
    for (const col of ['operation_value', 'deferred_aliq', 'deferred_value', 'tag_value', 'withheld_value']) {
      expect(m082).toMatch(new RegExp('ADD COLUMN IF NOT EXISTS `' + col + '` DECIMAL\\(\\d+,\\d+\\) DEFAULT NULL'))
    }
    // quando o faturamento passar a entregar `ii` ao motor, este teste quebra e obriga a criar o registro do imposto de importação
    const service = fs.readFileSync(path.join(__dirname, '..', 'modules', 'billing', 'billing.service.ts'), 'utf8')
    const calcInput = service.slice(service.indexOf('const calcInput: ItemTaxCalcInput = {'), service.indexOf('const serviceRule = isService'))
    expect(calcInput.length).toBeGreaterThan(200)
    expect(calcInput).not.toMatch(/\bii\s*:/)
  })

  it('P2.9: emitente Simples fatura por CSOSN (regra com csosn, sem cstNr)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: null, csosn: '900', modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    txnDeadline = null
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(result.totalValue).toBe(100)

    const icmsCall = conn.query.mock.calls.find(c => (c[0] as string).includes('tb_order_item_icms'))
    expect(icmsCall![1]).toContain('900')      // cst gravado com o código CSOSN (fallback)
  })

  it('W3.2: parcelas em espécie -> tryAutoSettleByContract chamado por parcela, autoSettled reflete o resultado', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain('028/056')                              // 2 parcelas de 50

    mockTryAutoSettleByContract
      .mockResolvedValueOnce({ settled: true, settledCode: 1, statementId: 1, cashierId: 5 })
      .mockResolvedValueOnce({ settled: false, reason: 'NO_OPEN_CASHIER' })

    const conn = mockPersistTxn(2)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.autoSettled).toBe(1)
    expect(mockTryAutoSettleByContract).toHaveBeenCalledTimes(2)
    expect(mockTryAutoSettleByContract).toHaveBeenNthCalledWith(1, conn,
      'setes_setes', 1, 7,
      expect.objectContaining({ orderId: 10, parcel: 1, paymentTypeId: 5 }))
  })

  it('gate socrático 2026-08-22: falha TÉCNICA na baixa automática NÃO derruba a nota (SAVEPOINT isola)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null) // 1 parcela

    mockTryAutoSettleByContract.mockRejectedValueOnce(new Error('falha técnica inesperada'))

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    // a nota persiste normalmente (commit chamado, nunca rollback)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.rollback).not.toHaveBeenCalled()
    expect(result.autoSettled).toBe(0)

    // a falha foi isolada por SAVEPOINT, não pelo catch da transação inteira
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('SAVEPOINT auto_settle'))).toBe(true)
    expect(sqls.some(s => s.includes('ROLLBACK TO SAVEPOINT auto_settle'))).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Comissão por item + Devolução de mercadoria (rodada Q1–Q5, 2026-08-24)
// ---------------------------------------------------------------------

describe('comissão e devolução', () => {
  function mockBranchAdjust(entityId = 55, direction: 'E' | 'S' = 'E') {
    mockQuery.mockResolvedValueOnce([[]])   // sale vazio
    mockQuery.mockResolvedValueOnce([[]])   // purchase vazio
    mockQuery.mockResolvedValueOnce([[{ entityId, direction }]])
  }

  function mockInvoiceChain() {
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    txnDeadline = null
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
  }

  function mockTxn() {
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValue([{}])
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    mockNegotiationInTx(conn, txnDeadline)
    conn.query.mockResolvedValueOnce([{}])                  // icms item
    conn.query.mockResolvedValueOnce([{}])                  // approx_tax_aliq
    return conn
  }

  it('validate: âncora presente com ajuste de SAÍDA vira issue (sem consultar o pedido)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'S')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '5202' },
    })
    expect(report.issues.some(i =>
      i.field === 'adjustment' && i.message.includes('ENTRADA'))).toBe(true)
    expect(mockOrderReturn.buildReturnPlan).not.toHaveBeenCalled()
  })

  it('validate: devolução (âncora) propaga as issues do plano (qtde > saldo etc.)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({
      issues: [{ itemId: 1, field: 'quantity', message: 'saldo insuficiente' }],
      plan: null,
    })
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '1202' },
    })
    expect(mockOrderReturn.getAnchor).toHaveBeenCalledWith('setes_setes', 1, 10, { includeDeleted: true })
    expect(mockOrderReturn.buildReturnPlan).toHaveBeenCalledWith(
      'setes_setes', 1, 77, 55, expect.any(Array), { refuseRepeatedLines: false })   // sem a marcação: o acúmulo de sempre
    expect(report.issues.some(i =>
      i.itemId === 1 && i.field === 'quantity' && i.scope === 'item')).toBe(true)
  })

  it('D-NE113 + D-NE267 — devolução de venda do ERP Desktop COM a marcação: /validate avisa e /invoice recusa com RETURN_ORIGIN_LEGACY (antes das issues do plano); SEM a marcação segue como sempre', async () => {
    const legacyPlan = { issues: [{ itemId: 1, field: 'quantity', message: 'saldo insuficiente' }], plan: null, originLegacy: true }
    // /validate com a marcação
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce(legacyPlan)
    mockQuery.mockResolvedValueOnce([[]]) // links
    const report = await validateOrder(inst as any, { orderId: 10, adjustment: { cfopId: '1202' }, authorizeNfe: true })
    expect(report.issues).toEqual(expect.arrayContaining([
      { scope: 'order', field: 'returnedOrderId', message: expect.stringContaining('A venda 77 foi feita no ERP Desktop') },
    ]))
    // /validate SEM a marcação: só as issues do plano
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]])
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce(legacyPlan)
    mockQuery.mockResolvedValueOnce([[]])
    const plain = await validateOrder(inst as any, { orderId: 10, adjustment: { cfopId: '1202' } })
    expect(plain.issues.some(i => i.field === 'returnedOrderId')).toBe(false)

    const queueInvoice = () => {
      mockOrderBase()
      mockBranchAdjust(55, 'E')
      mockContext()
      mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
      mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1202', setFinancial: 'S', origin: 'A' }]])
      mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
      mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
      mockOrderReturn.buildReturnPlan.mockResolvedValueOnce(legacyPlan)
    }
    // /invoice com a marcação: a causa é a origem — não o saldo nem o cadastro (a conferência do conteúdo nem chega a rodar)
    queueInvoice()
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' }, authorizeNfe: true }))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_ORIGIN_LEGACY', message: expect.stringContaining('A venda 77 foi feita no ERP Desktop') })
    expect(mockContent.loadInvoiceContent).not.toHaveBeenCalled()
    // a marcação chega ao plano: com ela, linhas repetidas são recusadas (D-NE112); sem ela, o acúmulo de sempre
    expect(mockOrderReturn.buildReturnPlan.mock.calls.at(-1)![5]).toEqual({ refuseRepeatedLines: true })
    // /invoice sem a marcação: a devolução de venda do Desktop segue o caminho de sempre (aqui, as issues do plano)
    queueInvoice()
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' } }))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
    expect(mockOrderReturn.buildReturnPlan.mock.calls.at(-1)![5]).toEqual({ refuseRepeatedLines: false })
  })

  it('invoice: devolução inválida -> 422 RETURN_INVALID (gate DURO revalidado)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1202',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]]) // regra viva
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({
      issues: [{ itemId: 1, field: 'quantity', message: 'saldo insuficiente' }],
      plan: null,
    })

    await expect(invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' },
    })).rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
  })

  it('invoice: âncora presente com ajuste de Saída -> 422 RETURN_REQUIRES_ENTRY', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'S')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '5202',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })

    await expect(invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '5202' },
    })).rejects.toMatchObject({ statusCode: 422, code: 'RETURN_REQUIRES_ENTRY' })
  })

  it('venda gera comissão POSITIVA por item (kind F, base = valor líquido)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // 2 × 50 = 100
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockInvoiceChain()
    mockOrderReturn.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55 })
    mockCommission.resolveCommissionAliq.mockResolvedValueOnce(5)

    const conn = mockTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, [expect.objectContaining({
        kind: 'F', orderId: 10, orderItemId: 1, orderItemKind: 'Sale',
        salesmanId: 9, customerId: 55, baseValue: 100, aliq: 5, value: 5,
      })])
  })

  it('venda com alíquota 0 NÃO gera lançamento', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockInvoiceChain()
    mockOrderReturn.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55 })
    mockCommission.resolveCommissionAliq.mockResolvedValueOnce(0)

    const conn0 = mockTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(conn0, 'setes_setes', 1, [])
  })

  it('devolução: comissão NEGATIVA espelha a alíquota POSTADA da venda + persiste os elos', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]]) // base 100
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1202',
      setFinancial: 'S', origin: 'A',
    }]])
    const plan = {
      orderIdOri: 77, salesmanId: 9, customerId: 55,
      links: [{ itemId: 1, itemKind: 'Adjust', quantity: 2, itemIdOri: 33,
        kindOri: 'Sale', productId: 100, priceListIdOri: 2 }],
    }
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({ issues: [], plan })
    mockInvoiceChain()
    mockCommission.getPostedItemCommissions.mockResolvedValueOnce([
      { orderItemId: 33, orderItemKind: 'Sale', salesmanId: 9, customerId: 55, aliq: 10 },
    ])

    const conn = mockTxn()
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' },
    })

    // estorno POR ITEM (corrige o achado literal do legado — Q2): -10 sobre 100 a 10%
    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, [expect.objectContaining({
        kind: 'F', orderItemId: 1, orderItemKind: 'Adjust',
        salesmanId: 9, baseValue: 100, aliq: 10, value: -10,
      })])
    // alíquota veio do lançamento postado — não re-resolve pela fonte atual
    expect(mockCommission.resolveCommissionAliq).not.toHaveBeenCalled()
    // saldo REVALIDADO sob lock da origem ANTES de gravar (R2/HIGH dos gates)
    // D-FAT1 em cenário de DEVOLUÇÃO: a conferência do pedido sob a trava (releituras travantes — billing-input-print.test.ts) roda
    // ANTES da invariante do saldo devolvível, que exige ser a primeira leitura não travante da transação
    expect(mockInputPrint.assertBillingInputsUnchanged).toHaveBeenCalledTimes(1)
    expect(mockInputPrint.assertBillingInputsUnchanged.mock.invocationCallOrder[0])
      .toBeLessThan(mockOrderReturn.assertReturnableInTx.mock.invocationCallOrder[0])
    expect(mockOrderReturn.assertReturnableInTx).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, 10, plan)
    expect(mockOrderReturn.persistReturn).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, 10, plan)
  })

  it('devolução: item de SERVIÇO fica fora do plano (mercadoria apenas)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[
      itemRow({ id: 1, kind: 'Adjust' }),
      itemRow({ id: 2, kind: 'Adjust', productKind: 'S', ncm: null }),
    ]])
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({ issues: [], plan: null })
    mockQuery.mockResolvedValueOnce([[]]) // links
    mockQuery.mockResolvedValueOnce([[]]) // links de serviço (Onda 3)
    mockQuery.mockResolvedValueOnce([[]]) // item 2 (serviço) sem regra -> issue
    mockQuery.mockResolvedValueOnce([{}]) // clear vínculo A do serviço

    await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '1202' },
    })
    const passedItems = mockOrderReturn.buildReturnPlan.mock.calls[0][4]
    expect(passedItems).toHaveLength(1)
    expect(passedItems[0].id).toBe(1)
  })
})

describe('invoiceBodyDto — bloco checks (D9/onda do cheque)', () => {
  const checkItem = (over: Record<string, any> = {}) => ({
    bankId: 1, agency: '1234', account: '56789', number: '000123',
    issuer: 'JOAO DA SILVA', value: 100, dtCheck: '2026-09-04', ...over,
  })
  const body = (value: number) => ({
    orderId: 10,
    checks: [{ parcel: 1, items: [checkItem({ value })] }],
  })

  it('aceita valor com até 2 casas decimais', () => {
    expect(invoiceBodyDto.safeParse(body(100)).success).toBe(true)
    expect(invoiceBodyDto.safeParse(body(33.33)).success).toBe(true)
  })

  it('recusa valor com mais de 2 casas decimais (achado do gate adversarial 2026-09-04)', () => {
    // Sem o refine, 3 cheques de 33.334 somavam 100.00 (round2) mas cada um
    // gravava 33.33 em DECIMAL(10,2) — a soma real divergia do paid_value.
    const r = invoiceBodyDto.safeParse(body(33.334))
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Máximo 2 casas decimais')
    }
  })
})

// ---------------------------------------------------------------------
// IBS.E9.P3 — classificação de IBS/CBS da mercadoria no faturamento (D-IB133, D-IB134, D-IB136)
// ---------------------------------------------------------------------

describe('IBS.E9.P3 — classificação de IBS/CBS da mercadoria', () => {
  const mockFindClassificationAt = (jest.requireMock('../shared/ibscbs-classification') as any).findClassificationAt as jest.Mock
  const mockIssueInvoice = (jest.requireMock('../shared/invoice') as any).issueInvoice as jest.Mock
  // vigente e aceita pelo regime regular no 55 (IBS.E9.P4: a marca do modelo 55 deixou de ser ignorada, D-IB136)
  const LINE = { code: '000001', cst: '000', applicable: true, requiresRegularTaxation: false, ibsReductionPpm: 0, cbsReductionPpm: 0 }
  const icms = { cstNr: '00', csosn: null, modBc: '3', dischargeId: null, aliq: 18, aliqReduction: 0, baseReduction: 0,
    deferred: 'N', deferredAliq: null, highlight: 'N' }

  beforeEach(() => {
    mockFindClassificationAt.mockReset()
    mockFindClassificationAt.mockImplementation(async (_q: unknown, code: string) => (code === '999999' ? null : { ...LINE, code }))
  })

  /** Fila do /invoice até o laço dos itens: cada item com a SUA regra (id = 40 + id do item) e as peças dadas. */
  function queueInvoice(items: any[], piecesByItem: Array<Record<string, unknown>>) {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 40 + i.id, cfopId: '5102', setFinancial: 'S', origin: 'A',
    }))])
    mockQuery.mockResolvedValueOnce([items.map(i => ({ id: 40 + i.id }))])   // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    for (const pieces of piecesByItem) mockLoadPieces.mockResolvedValueOnce(pieces)
  }
  function queueTxn() {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])   // observações e aproximado
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])     // FOR UPDATE
    mockNegotiationInTx(conn, null)
    return conn
  }
  const ibscbsWrites = (conn: { query: jest.Mock }) =>
    conn.query.mock.calls.filter(c => /INSERT INTO `setes_setes`\.tb_order_item_ibscbs\b/.test(String(c[0])))

  it('D-IB134 — regra SEM a classificação: 422 BILLING_IBSCBS_CLASSIFICATION_REQUIRED com o item, e nada é gravado', async () => {
    queueInvoice([itemRow({ id: 1 })], [{ icms, ibscbs: undefined }])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'BILLING_IBSCBS_CLASSIFICATION_REQUIRED',
      fields: [{ field: 'item.1', message: expect.stringMatching(/regra de tributação 41 sem classificação de IBS\/CBS/) }],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()   // nenhuma transação: nada gravado
    expect(mockIssueInvoice).not.toHaveBeenCalled()
    expect(mockFindClassificationAt).not.toHaveBeenCalled()      // sem código não há o que conferir
  })

  it('D-IB136 — código sem linha vigente na data de emissão: 422 IBSCBS_CLASSIFICATION_NOT_FOUND com o item', async () => {
    queueInvoice([itemRow({ id: 1 })], [{ icms, ibscbs: { classificationCode: '999999' } }])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
      fields: [{ field: 'item.1', message: expect.stringMatching(/cClassTrib 999999 .* não está vigente em \d{4}-\d{2}-\d{2}/) }],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
    // conferido no modelo 55, na data de emissão (a mesma que o faturamento usa para a nota)
    const [, code, model, date] = mockFindClassificationAt.mock.calls[0]
    expect([code, model]).toEqual(['999999', '55'])
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('dois itens com problema: UM 422 com os dois no fields (código do primeiro); o /validate lista os dois sem lançar', async () => {
    const items = [itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })]
    queueInvoice(items, [{ icms, ibscbs: undefined }, { icms, ibscbs: { classificationCode: '999999' } }])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'BILLING_IBSCBS_CLASSIFICATION_REQUIRED',
      fields: [expect.objectContaining({ field: 'item.1' }), expect.objectContaining({ field: 'item.2' })],
    })

    // /validate do mesmo pedido: vínculos manuais (o motor não roda), uma pendência por item, nenhum throw
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 40 + i.id, cfopId: '5102', setFinancial: 'S', origin: 'M',
    }))])
    mockLoadPieces
      .mockResolvedValueOnce({ icms, ibscbs: undefined })
      .mockResolvedValueOnce({ icms, ibscbs: { classificationCode: '999999' } })
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues).toEqual([
      { scope: 'item', itemId: 1, field: 'ibscbsClassification', message: expect.stringMatching(/sem classificação de IBS\/CBS/) },
      { scope: 'item', itemId: 2, field: 'ibscbsClassification', message: expect.stringMatching(/cClassTrib 999999/) },
    ])
    expect(report.rulesManual).toBe(2)
  })

  it('mercadoria classificada fatura e grava UMA linha por item em tb_order_item_ibscbs, só com o código da regra', async () => {
    const items = [itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })]
    queueInvoice(items, [{ icms, ibscbs: { classificationCode: '000001' } }, { icms, ibscbs: { classificationCode: '200034' } }])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    const writes = ibscbsWrites(conn)
    // pedido, item, institution, código, base (IBS.E9.P4: o CRT 3 do contexto calcula o regular; 100,00 menos o ICMS de 18,00 = 82,00)
    expect(writes.map(w => w[1])).toEqual([[10, 1, 1, '000001', 82], [10, 2, 1, '200034', 82]])
    const sql = String(writes[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain('(tb_order_id, tb_order_item_id, tb_institution_id, terminal, classification_code, base_value, created_at, updated_at, deleted)')
    expect(sql).toContain("VALUES (?, ?, ?, 0, ?, ?, NOW(), NOW(), 'N')")
    // refaturar regrava a MESMA linha (ressuscita a que o cancelamento apagou) — nunca duplica
    expect(sql).toContain("ON DUPLICATE KEY UPDATE classification_code = VALUES(classification_code), base_value = VALUES(base_value), deleted = 'N'")
    // a vigência é conferida uma vez por código; a marca do modelo 55 (applicable: false) não recusa (D-IB136)
    expect(mockFindClassificationAt).toHaveBeenCalledTimes(2)
    expect(conn.commit).toHaveBeenCalled()
  })

  // ── gates do passo (socrático e adversarial) ──────────────────────────────────────────────────────────────────────
  it.each([
    ['compra', 'Purchase', () => { mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[{ entityId: 90 }]]) }, undefined],
    ['ajuste', 'Adjust', () => { mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]]) }, { cfopId: '5949' }],
  ])('D-IB134 vale para %s (A-IB134a): regra sem a classificação → 422, nada gravado', async (_name, kind, queueBranch, adjustment) => {
    mockOrderBase()
    ;(queueBranch as () => void)()
    mockContext()
    const items = [itemRow({ id: 1, kind })]
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind, taxRuleId: 41, cfopId: '5949', setFinancial: 'S', origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 41 }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({ icms, ibscbs: undefined })
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, adjustment } as any)).rejects.toMatchObject({
      statusCode: 422, code: 'BILLING_IBSCBS_CLASSIFICATION_REQUIRED', fields: [expect.objectContaining({ field: 'item.1' })],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it.each([[123456], [' 00001'], ['0000011'], ['００００００'], ['abcdef'], ['null']])(
    'código %p gravado fora da API: recusado pelo FORMATO, sem consultar o catálogo e sem chegar ao INSERT', async badCode => {
      queueInvoice([itemRow({ id: 1 })], [{ icms, ibscbs: { classificationCode: badCode } }])
      await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
        statusCode: 422, code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
      })
      expect(mockFindClassificationAt).not.toHaveBeenCalled()
      expect((pool as any).getConnection).not.toHaveBeenCalled()
    })

  it('catálogo que responde undefined não conta como vigente', async () => {
    mockFindClassificationAt.mockResolvedValue(undefined)
    queueInvoice([itemRow({ id: 1 })], [{ icms, ibscbs: { classificationCode: '000001' } }])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
    })
  })

  it('só o código CONFERIDO é gravado: produto com kind que o faturamento não trata como mercadoria não ganha linha', async () => {
    // (item de produto com `kind` fora de Sale/Purchase/Adjust já escapava da regra de tributação antes deste passo — achado
    //  registrado na árvore; aqui a garantia é que o registro do item nunca recebe um código que ninguém conferiu)
    queueInvoice([itemRow({ id: 1, kind: 'Transfer' })], [{ icms, ibscbs: { classificationCode: '999999' } }])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(mockFindClassificationAt).not.toHaveBeenCalled()
    expect(ibscbsWrites(conn)).toHaveLength(0)
  })

  it('/validate: regra automática sem o código do regime E sem classificação → as duas pendências na mesma volta', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()                                             // emitente no Regime Normal → exige CST
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[]])                     // nenhum vínculo
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { ...icms, cstNr: null, csosn: '102' }, ibscbs: undefined })
    mockQuery.mockResolvedValueOnce([{}])                     // clearAutoRuleLink
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.map(i => i.field)).toEqual(['taxRule', 'ibscbsClassification'])
    expect(report.rulesResolved).toBe(0)
  })

  it('a mesma regra em vários itens: uma consulta de vigência só', async () => {
    const items = [itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })]
    queueInvoice(items, [{ icms, ibscbs: { classificationCode: '000001' } }, { icms, ibscbs: { classificationCode: '000001' } }])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(mockFindClassificationAt).toHaveBeenCalledTimes(1)
    expect(ibscbsWrites(conn)).toHaveLength(2)
  })
})


// ---------------------------------------------------------------------
// IBS.E9.P5 — IBS/CBS do Simples no DAS a partir de 2027 (D-IB138 a D-IB141; A-IB138a a g, A-IB141a)
// ---------------------------------------------------------------------

describe('IBS.E9.P5 — IBS/CBS do Simples no DAS', () => {
  const mockIssueInvoice = (jest.requireMock('../shared/invoice') as any).issueInvoice as jest.Mock
  const mockEmissionDate = (jest.requireMock('../shared/invoice/emission-date') as any).invoiceEmissionDateFor as jest.Mock
  const emissionActual = jest.requireActual('../shared/invoice/emission-date').invoiceEmissionDateFor
  const mockAssessmentAt = (jest.requireMock('../shared/ibscbs-assessment') as any).ibscbsAssessmentAt as jest.Mock
  const mockRateAt = (jest.requireMock('../shared/ibscbs-simples-rate') as any).simplesRateAt as jest.Mock
  const mockConfig = (jest.requireMock('../shared/interface-config') as any).getConfigContent as jest.Mock
  const simplesIcms = { cstNr: null, csosn: '102', modBc: '3', dischargeId: null, aliq: 0, aliqReduction: 0, baseReduction: 0,
    deferred: 'N', deferredAliq: null, highlight: 'N' }
  const SIMPLES = '1 - Simples Nacional'
  const RATE = { competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', ibsPpm: 1000, cbsPpm: 9000 }

  beforeEach(() => {
    mockEmissionDate.mockReset()
    mockEmissionDate.mockResolvedValue('2027-01-15')
    mockAssessmentAt.mockReset()
    mockAssessmentAt.mockResolvedValue({ assessment: '1', validFrom: null })
    mockRateAt.mockReset()
    mockRateAt.mockResolvedValue(RATE)
    mockConfig.mockReset()
    mockConfig.mockResolvedValue(null)
  })
  afterAll(() => { mockEmissionDate.mockReset(); mockEmissionDate.mockImplementation(emissionActual) })

  /** Fila do /invoice até o laço dos itens, com o emitente no regime dado (default: Simples) e a atividade padrão. */
  function queueInvoice(items: any[], opts: { regime?: string; activity?: string | null; simplesRegime?: string | null } = {}) {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: opts.regime ?? SIMPLES, emitterActivity: opts.activity ?? null, emitterSimplesRegime: opts.simplesRegime ?? null })
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 40 + i.id, cfopId: '5102', setFinancial: 'S', origin: 'A',
    }))])
    mockQuery.mockResolvedValueOnce([items.map(i => ({ id: 40 + i.id }))])   // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    for (const _ of items) mockLoadPieces.mockResolvedValueOnce({ icms: simplesIcms })
  }
  function queueTxn() {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])     // FOR UPDATE
    mockNegotiationInTx(conn, null)
    return conn
  }
  const simplesWrites = (conn: { query: jest.Mock }) =>
    conn.query.mock.calls.filter(c => /INSERT INTO `setes_setes`\.tb_order_item_ibscbs_simples\b/.test(String(c[0])))

  it('emissão 2027-01-15, CRT 1, opção 1: uma linha por item com atividade, mês, percentuais congelados, base e valores', async () => {
    // item: 2 × R$ 50,00 = R$ 100,00 (base 10000 centavos); IBS 0,1000% = 1000 ppm → 10 centavos; CBS 0,9000% = 9000 ppm → 90 centavos
    queueInvoice([itemRow({ id: 1 })], { activity: '02' })
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    const writes = simplesWrites(conn)
    expect(writes.map(w => w[1])).toEqual([[10, 1, 1, '02', '2027-01', '0.1000', '0.9000', 100, 0.1, 0.9]])
    const sql = String(writes[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain('(tb_order_id, tb_order_item_id, tb_institution_id, terminal, activity_code, competence, ibs_rate, cbs_rate, base_value, ibs_value, cbs_value, created_at, updated_at, deleted)')
    expect(sql).toContain("VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')")
    expect(sql).toContain("ON DUPLICATE KEY UPDATE") // refaturar regrava a MESMA linha — nunca duplica
    expect(sql).toContain("deleted = 'N'")
    expect(mockRateAt.mock.calls[0].slice(1)).toEqual(['setes_setes', 1, '2027-01'])   // o mês da emissão (A-IB138a)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('a base desconta o desconto incondicional: 2 × 50,00 com R$ 10,00 de desconto → base 90,00, IBS 0,09 e CBS 0,81', async () => {
    queueInvoice([itemRow({ id: 1, discountValue: 10 })])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn).map(w => w[1])).toEqual([[10, 1, 1, '01', '2027-01', '0.1000', '0.9000', 90, 0.09, 0.81]])   // sem atividade: 01
  })

  it('a atividade da mercadoria vale sobre a do estabelecimento (D-IB139)', async () => {
    queueInvoice([itemRow({ id: 1, simplesActivity: '03' }), itemRow({ id: 2, productId: 101 })], { activity: '02' })
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn).map(w => w[1][3])).toEqual(['03', '02'])   // a exceção, e a herdada do estabelecimento
  })

  it('D-IB140 — mês sem percentual: UM 422 BILLING_IBSCBS_SIMPLES_RATE_REQUIRED com todos os itens, e nada é gravado', async () => {
    mockRateAt.mockResolvedValue(null)
    queueInvoice([itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'BILLING_IBSCBS_SIMPLES_RATE_REQUIRED',
      fields: [
        { field: 'item.1', message: expect.stringMatching(/sem o percentual de IBS\/CBS do Simples do mês 2027-01/) },
        { field: 'item.2', message: expect.stringMatching(/mês 2027-01/) },
      ],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()   // nenhuma transação: nada gravado
    expect(mockIssueInvoice).not.toHaveBeenCalled()
  })

  it('o /validate lista a pendência POR ITEM de mercadoria (field ibscbsSimplesRate), sem lançar', async () => {
    mockRateAt.mockResolvedValue(null)
    const items = [itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })]
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: SIMPLES })
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 40 + i.id, cfopId: '5102', setFinancial: 'S', origin: 'M',
    }))])
    mockLoadPieces.mockResolvedValueOnce({ icms: simplesIcms }).mockResolvedValueOnce({ icms: simplesIcms })
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.filter(i => i.field === 'ibscbsSimplesRate')).toEqual([
      { scope: 'item', itemId: 1, field: 'ibscbsSimplesRate', message: expect.stringMatching(/mês 2027-01/) },
      { scope: 'item', itemId: 2, field: 'ibscbsSimplesRate', message: expect.stringMatching(/mês 2027-01/) },
    ])
  })

  it('A-IB141a — antes do piso (emissão 2026-12-31): nada muda, nenhuma consulta ao percentual nem à opção, nenhuma linha', async () => {
    mockEmissionDate.mockResolvedValue('2026-12-31')
    mockRateAt.mockResolvedValue(null)   // mesmo sem percentual: em 2026 não recusa
    queueInvoice([itemRow({ id: 1 })])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(mockRateAt).not.toHaveBeenCalled()
    expect(mockAssessmentAt).not.toHaveBeenCalled()
    expect(mockConfig.mock.calls.some(c => c[2] === 'ibscbs_simples_start')).toBe(false)
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('A-IB141a — a configuração só ADIA: 2027-02-01 adia a nota de 2027-01-15; 2026-01-01 não antecipa a de 2026-12-31', async () => {
    mockConfig.mockImplementation(async (_i: unknown, _m: string, name: string) => (name === 'ibscbs_simples_start' ? '2027-02-01' : null))
    queueInvoice([itemRow({ id: 1 })])
    let conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(mockRateAt).not.toHaveBeenCalled()

    mockEmissionDate.mockResolvedValue('2026-12-31')
    mockConfig.mockImplementation(async (_i: unknown, _m: string, name: string) => (name === 'ibscbs_simples_start' ? '2026-01-01' : null))
    queueInvoice([itemRow({ id: 1 })])
    conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(mockRateAt).not.toHaveBeenCalled()
  })

  it.each([
    ['CRT 3 (regime normal; o regular calcula, o Simples não é lido)', '3 - Regime Normal', 'não consulta nada do Simples'],
    ['CRT 2 (Simples com excesso de sublimite: fora do passo, A-IB138c)', '2 - Simples Nacional - excesso de sublimite de receita bruta', 'idem'],
  ])('%s: nenhuma linha e nenhuma recusa nova', async (_name, regime) => {
    mockRateAt.mockResolvedValue(null)
    // IBS.E9.P4: em 2027 o regular (CRT 3) recusa sem a CBS na tabela (A-IB143f); aqui a prova é a do Simples, então a tabela do teste traz uma CBS hipotética
    const mockRateTable = (jest.requireMock('../shared/ibscbs-rate') as any).loadIbscbsAliqTable as jest.Mock
    mockRateTable.mockResolvedValueOnce([
      ...jest.requireActual('../shared/ibscbs-calculation').IBSCBS_LEGAL_ALIQS,
      { tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: 88000 }])
    queueInvoice([itemRow({ id: 1 })], { regime })
    mockLoadPieces.mockReset()
    mockLoadPieces.mockResolvedValue({ icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null, aliq: 18, aliqReduction: 0, baseReduction: 0,
      deferred: 'N', deferredAliq: null, highlight: 'N' } })
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(mockRateAt).not.toHaveBeenCalled()
  })

  it.each([
    ['compra', 'Purchase', () => { mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[{ entityId: 90 }]]) }, undefined],
    ['ajuste', 'Adjust', () => { mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[]]); mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]]) }, { cfopId: '5949', direction: 'S' }],
  ])('D-IB142 — %s (entrada) NÃO entra no Simples: nenhuma linha e nenhuma recusa, mesmo sem percentual', async (_name, kind, queueBranch, adjustment) => {
    mockRateAt.mockResolvedValue(null)
    mockOrderBase()
    ;(queueBranch as () => void)()
    mockContext({ emitterRegime: SIMPLES })
    const items = [itemRow({ id: 1, kind })]
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind, taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 41 }]])   // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({ icms: simplesIcms })
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false, ...(adjustment ? { adjustment } : {}) } as any)
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('MEI (CRT 1 com opSimpNac 2): nenhuma linha e nenhuma recusa, mesmo sem percentual — o /invoice e o /validate (A-IB138c)', async () => {
    mockRateAt.mockResolvedValue(null)
    queueInvoice([itemRow({ id: 1 })], { simplesRegime: '2' })
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(mockRateAt).not.toHaveBeenCalled()

    const items = [itemRow({ id: 1 })]
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: SIMPLES, emitterSimplesRegime: '2' })
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'M' }]])
    mockLoadPieces.mockResolvedValueOnce({ icms: simplesIcms })
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.filter(i => i.field === 'ibscbsSimplesRate')).toEqual([])
  })

  it('opção de apuração diferente de 1 (a recusa é do escritor da nota, D-IB99): o Simples não grava e não recusa', async () => {
    mockAssessmentAt.mockResolvedValue({ assessment: '2', validFrom: '2027-01-01' })
    queueInvoice([itemRow({ id: 1 })])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(simplesWrites(conn)).toHaveLength(0)
    expect(mockRateAt).not.toHaveBeenCalled()
  })
})


// ---------------------------------------------------------------------
// IBS.E9.P4 — IBS/CBS do regime regular (CRT 3): o motor liga no faturamento (D-IB143, D-IB144, D-IB145)
// ---------------------------------------------------------------------

describe('IBS.E9.P4 — IBS/CBS do regime regular', () => {
  const mockFindClassificationAt = (jest.requireMock('../shared/ibscbs-classification') as any).findClassificationAt as jest.Mock
  const mockEmissionDate = (jest.requireMock('../shared/invoice/emission-date') as any).invoiceEmissionDateFor as jest.Mock
  const emissionActual = jest.requireActual('../shared/invoice/emission-date').invoiceEmissionDateFor
  const mockRateTable = (jest.requireMock('../shared/ibscbs-rate') as any).loadIbscbsAliqTable as jest.Mock
  const LEGAL = jest.requireActual('../shared/ibscbs-calculation').IBSCBS_LEGAL_ALIQS
  const LINE = { code: '000001', cst: '000', applicable: true, requiresRegularTaxation: false, ibsReductionPpm: 0, cbsReductionPpm: 0 }
  // ICMS com alíquota 0: o item de R$ 100,00 (2 × R$ 50,00) tem base 100,00 — as contas ficam legíveis
  const icms0 = { cstNr: '00', csosn: null, modBc: '3', dischargeId: null, aliq: 0, aliqReduction: 0, baseReduction: 0,
    deferred: 'N', deferredAliq: null, highlight: 'N' }
  const icms18 = { ...icms0, aliq: 18 }

  beforeEach(() => {
    mockEmissionDate.mockReset()
    mockEmissionDate.mockResolvedValue('2026-11-10')
    mockRateTable.mockReset()
    mockRateTable.mockImplementation(async () => [...LEGAL])
    mockFindClassificationAt.mockReset()
    mockFindClassificationAt.mockImplementation(async (_q: unknown, code: string) => (code === '999999' ? null : { ...LINE, code }))
  })
  afterAll(() => { mockEmissionDate.mockReset(); mockEmissionDate.mockImplementation(emissionActual) })

  function queueInvoice(items: any[], piecesByItem: Array<Record<string, unknown>>, regime?: string) {
    mockOrderBase()
    mockBranchSale()
    mockContext(regime ? { emitterRegime: regime } : {})
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([items.map(i => ({
      orderItemId: i.id, kind: i.kind, taxRuleId: 40 + i.id, cfopId: '5102', setFinancial: 'S', origin: 'A',
    }))])
    mockQuery.mockResolvedValueOnce([items.map(i => ({ id: 40 + i.id }))])   // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    for (const pieces of piecesByItem) mockLoadPieces.mockResolvedValueOnce(pieces)
  }
  function queueTxn() {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])     // FOR UPDATE
    mockNegotiationInTx(conn, null)
    return conn
  }
  const taxWrites = (conn: { query: jest.Mock }) =>
    conn.query.mock.calls.filter(c => /INSERT INTO `setes_setes`\.tb_order_item_ibscbs_tax\b/.test(String(c[0])))
  const itemWrites = (conn: { query: jest.Mock }) =>
    conn.query.mock.calls.filter(c => /INSERT INTO `setes_setes`\.tb_order_item_ibscbs\b/.test(String(c[0])))
  const rule = (icms: unknown, code = '000001') => ({ icms, ibscbs: { classificationCode: code } })

  it('emissão 2026-11-10, CRT 3, CST 000: a base e uma linha por tributo (U, M, C), com as alíquotas e os valores congelados', async () => {
    // item: 2 × R$ 50,00 = R$ 100,00 sem imposto sobre a base: IBS UF 0,1000% → 0,10; IBS município 0,0000% → 0,00; CBS 0,9000% → 0,90
    queueInvoice([itemRow({ id: 1 })], [rule(icms0)])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(itemWrites(conn).map(w => w[1])).toEqual([[10, 1, 1, '000001', 100]])
    expect(taxWrites(conn).map(w => w[1])).toEqual([
      [10, 1, 1, 'U', '0.1000', null, '0.1000', 0.1],
      [10, 1, 1, 'M', '0.0000', null, '0.0000', 0],
      [10, 1, 1, 'C', '0.9000', null, '0.9000', 0.9],
    ])
    const sql = String(taxWrites(conn)[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain('(tb_order_id, tb_order_item_id, tb_institution_id, terminal, tax, nominal_rate, reduction_rate, effective_rate, tax_value, created_at, updated_at, deleted)')
    expect(sql).toContain("VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')")
    expect(sql).toContain('ON DUPLICATE KEY UPDATE')   // refaturar regrava as MESMAS linhas
    expect(sql).toContain("deleted = 'N'")
    expect(conn.commit).toHaveBeenCalled()
  })

  it('o ICMS, o PIS e o COFINS do item saem da base (RF-BC-03): 100,00 − ICMS 18,00 = 82,00 → IBS UF 0,08 e CBS 0,74', async () => {
    queueInvoice([itemRow({ id: 1 })], [rule(icms18)])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(itemWrites(conn)[0][1]).toEqual([10, 1, 1, '000001', 82])
    expect(taxWrites(conn).map(w => [w[1][3], w[1][7]])).toEqual([['U', 0.08], ['M', 0], ['C', 0.74]])
  })

  it('CST 200 com redução do catálogo (IBS 60%, CBS 100%): grava a redução, a efetiva e o valor reduzido', async () => {
    mockFindClassificationAt.mockImplementation(async (_q: unknown, code: string) =>
      ({ ...LINE, code, cst: '200', ibsReductionPpm: 600000, cbsReductionPpm: 1000000 }))
    queueInvoice([itemRow({ id: 1 })], [rule(icms0, '200034')])
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    // IBS UF 0,1000% reduzido em 60% → 0,0400% → 0,04; IBS município 0; CBS 0,9000% reduzida em 100% → 0 (efetiva 0,0000)
    expect(taxWrites(conn).map(w => w[1])).toEqual([
      [10, 1, 1, 'U', '0.1000', '60.0000', '0.0400', 0.04],
      [10, 1, 1, 'M', '0.0000', '60.0000', '0.0000', 0],
      [10, 1, 1, 'C', '0.9000', '100.0000', '0.0000', 0],
    ])
  })

  it('D-IB145 — compra e ajuste também calculam o regular (os mesmos tipos da classificação)', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 90 }]])   // ramo de compra
    mockContext()
    const items = [itemRow({ id: 1, kind: 'Purchase' })]
    mockQuery.mockResolvedValueOnce([items])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Purchase', taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 41 }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce(rule(icms0))
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(taxWrites(conn)).toHaveLength(3)
  })

  it('sem alíquota vigente (a CBS de 2027 não está na tabela): UM 422 BILLING_IBSCBS_RATE_NOT_FOUND com todos os itens, nada gravado', async () => {
    mockEmissionDate.mockResolvedValue('2027-01-15')
    queueInvoice([itemRow({ id: 1 }), itemRow({ id: 2, productId: 101 })], [rule(icms0), rule(icms0)])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code: 'BILLING_IBSCBS_RATE_NOT_FOUND',
      fields: [
        { field: 'item.1', message: expect.stringMatching(/sem alíquota de CBS vigente em 2027-01-15/) },
        { field: 'item.2', message: expect.stringMatching(/sem alíquota de CBS vigente em 2027-01-15/) },
      ],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it.each([
    ['CST 410 (imunidade)', { cst: '410' }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /CST 410.*só o CST 000 e o 200/],
    ['CST 550 (suspensão)', { cst: '550' }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /CST 550/],
    ['CST 200 com gTribRegular', { cst: '200', requiresRegularTaxation: true }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /gTribRegular/],
    ['sem presença no modelo 55 (rej. 1025)', { applicable: false }, 'BILLING_IBSCBS_NOT_ALLOWED_IN_NFE', /não é permitido na NF-e modelo 55/],
    ['redução ainda desconhecida (NULL)', { ibsReductionPpm: null }, 'BILLING_IBSCBS_REDUCTION_UNKNOWN', /ainda não foi carregada/],
  ])('D-IB144 — %s: 422 com o item e a regra, e nada é gravado', async (_name, over, code, message) => {
    mockFindClassificationAt.mockImplementation(async (_q: unknown, c: string) => ({ ...LINE, code: c, ...over }))
    queueInvoice([itemRow({ id: 1 })], [rule(icms0)])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })).rejects.toMatchObject({
      statusCode: 422, code, fields: [{ field: 'item.1', message: expect.stringMatching(message) }],
    })
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it('o Simples (CRT 1) não é tocado: a mesma classificação sem presença no 55 fatura como antes, sem linha de tributo e sem ler a tabela de alíquotas', async () => {
    mockFindClassificationAt.mockImplementation(async (_q: unknown, c: string) => ({ ...LINE, code: c, cst: '410', applicable: false }))
    queueInvoice([itemRow({ id: 1 })], [{ icms: { cstNr: null, csosn: '102', modBc: '3', dischargeId: null, aliq: 0, aliqReduction: 0, baseReduction: 0,
      deferred: 'N', deferredAliq: null, highlight: 'N' }, ibscbs: { classificationCode: '410014' } }], '1 - Simples Nacional')
    const conn = queueTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(taxWrites(conn)).toHaveLength(0)
    expect(itemWrites(conn).map(w => w[1])).toEqual([[10, 1, 1, '410014', null]])   // a base fica NULL: o item não foi calculado no regular
    expect(mockRateTable).not.toHaveBeenCalled()
    expect(conn.commit).toHaveBeenCalled()
  })

  it('/validate: as mesmas pendências viram issue POR ITEM (campo ibscbsRegular), sem lançar', async () => {
    mockEmissionDate.mockResolvedValue('2027-01-15')   // sem CBS na tabela
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'M' }]])
    mockLoadPieces.mockResolvedValueOnce(rule(icms0))
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.filter(i => i.field === 'ibscbsRegular')).toEqual([
      { scope: 'item', itemId: 1, field: 'ibscbsRegular', message: expect.stringMatching(/sem alíquota de CBS vigente em 2027-01-15/) },
    ])
  })

  it('/validate: CST fora de 000/200 também vira pendência, e a classificação inexistente só traz a sua (sem repetir)', async () => {
    mockFindClassificationAt.mockImplementation(async (_q: unknown, c: string) => ({ ...LINE, code: c, cst: '410' }))
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'M' }]])
    mockLoadPieces.mockResolvedValueOnce(rule(icms0, '410014'))
    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.map(i => i.field).filter(f => (f ?? '').startsWith('ibscbs'))).toEqual(['ibscbsRegular'])

    mockFindClassificationAt.mockImplementation(async () => null)
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', taxRuleId: 41, cfopId: '5102', setFinancial: 'S', origin: 'M' }]])
    mockLoadPieces.mockResolvedValueOnce(rule(icms0, '999999'))
    const report2 = await validateOrder(inst as any, { orderId: 10 })
    expect(report2.issues.map(i => i.field).filter(f => (f ?? '').startsWith('ibscbs'))).toEqual(['ibscbsClassification'])
  })
})
