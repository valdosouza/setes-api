/// <reference types="jest" />
// setes-api:IBS.E9.P5 (D-IB138 a D-IB141, A-IB138a a g, A-IB141a): a peça @shared/ibscbs-simples-das — QUANDO o Simples no DAS vale e
// a declaração de um item — e a cerca da tabela do item. O faturamento ligado a ela está em `billing.test.ts` (bloco IBS.E9.P5).
import fs from 'fs'
import path from 'path'
import {
  IBSCBS_SIMPLES_START_FLOOR, simplesStartOf, loadSimplesDasPlan, declareSimplesItem, merchandiseParcelsOf,
  simplesRateMissingMessage,
} from '../shared/ibscbs-simples-das'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/interface-config', () => ({ __esModule: true, getConfigContent: jest.fn().mockResolvedValue(null), getConfigContentFor: jest.fn() }))
jest.mock('../shared/ibscbs-assessment', () => ({
  __esModule: true,
  ibscbsAssessmentAt: jest.fn().mockResolvedValue({ assessment: '1', validFrom: null }),
  isIsoDate: (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
}))
jest.mock('../shared/ibscbs-simples-rate', () => ({
  ...jest.requireActual('../shared/ibscbs-simples-rate'),
  simplesRateAt: jest.fn(),
}))

const assessmentAt = (jest.requireMock('../shared/ibscbs-assessment') as any).ibscbsAssessmentAt as jest.Mock
const rateAt = (jest.requireMock('../shared/ibscbs-simples-rate') as any).simplesRateAt as jest.Mock
const config = (jest.requireMock('../shared/interface-config') as any).getConfigContent as jest.Mock

const institution = { institutionId: 7, userId: 3, role: 'admin', schemaName: 'setes_acme' } as any
const RATE = { competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', ibsPpm: 1000, cbsPpm: 9000 }
const plan = (over: Record<string, unknown> = {}) =>
  ({ active: true as const, competence: '2027-01', rate: RATE, establishmentActivity: null, ...over }) as any

beforeEach(() => {
  jest.clearAllMocks()
  assessmentAt.mockResolvedValue({ assessment: '1', validFrom: null })
  rateAt.mockResolvedValue(RATE)
  config.mockResolvedValue(null)
})

describe('a data de início (D-IB141, A-IB141a)', () => {
  it('o piso é 2027-01-01; a configuração só ADIA; valor inválido ou anterior ao piso é ignorado', () => {
    expect(IBSCBS_SIMPLES_START_FLOOR).toBe('2027-01-01')
    expect(simplesStartOf(null)).toBe('2027-01-01')
    expect(simplesStartOf(undefined)).toBe('2027-01-01')
    expect(simplesStartOf('')).toBe('2027-01-01')
    expect(simplesStartOf('2027-01-01')).toBe('2027-01-01')
    expect(simplesStartOf('2027-03-01')).toBe('2027-03-01')       // adia
    expect(simplesStartOf('2026-01-01')).toBe('2027-01-01')       // não antecipa
    expect(simplesStartOf('2026-12-31')).toBe('2027-01-01')
    expect(simplesStartOf('01/03/2027')).toBe('2027-01-01')       // formato inválido
    expect(simplesStartOf('2027-02-30x')).toBe('2027-01-01')
    expect(simplesStartOf('2027-03-01T00:00:00Z')).toBe('2027-03-01')   // ISO com hora vale pelo dia (a API de configuração a aceita)
    expect(simplesStartOf('2026-06-01T00:00:00Z')).toBe('2027-01-01')
  })
})

describe('quando o Simples no DAS vale (A-IB138c)', () => {
  const run = (over: Record<string, unknown> = {}) => loadSimplesDasPlan({
    institution, crt: '1', simplesRegime: '3', emissionDate: '2027-01-15', establishmentActivity: '02', ...over })

  it('CRT 1, 2027-01-15, opção 1: vale, com o mês da emissão, o percentual lido e a atividade do estabelecimento', async () => {
    expect(await run()).toEqual({ active: true, competence: '2027-01', rate: RATE, establishmentActivity: '02' })
    expect(assessmentAt).toHaveBeenCalledWith(expect.anything(), 'setes_acme', 7, '2027-01-15', { lock: false })
    expect(rateAt).toHaveBeenCalledWith(expect.anything(), 'setes_acme', 7, '2027-01')
  })

  it('o mês do percentual é o da data de emissão: 2027-12-31 → 2027-12', async () => {
    await run({ emissionDate: '2027-12-31' })
    expect(rateAt.mock.calls[0][3]).toBe('2027-12')
  })

  it('sem percentual no mês: vale e traz rate null (o faturamento recusa, D-IB140)', async () => {
    rateAt.mockResolvedValue(null)
    expect(await run()).toMatchObject({ active: true, rate: null, competence: '2027-01' })
  })

  it.each([[null], ['3'], ['1']])('CRT 1 com opSimpNac %s (não informado, ME/EPP ou não optante) vale; só o MEI sai (A-IB138c)', async simplesRegime => {
    expect(await run({ simplesRegime })).toMatchObject({ active: true })
  })

  it('MEI (CRT 1 com opSimpNac 2): NÃO vale, nada é lido e nada é recusado — a NT não tem fonte para o MEI (RF-SN-16)', async () => {
    rateAt.mockResolvedValue(null)
    expect(await run({ simplesRegime: '2' })).toEqual({ active: false })
    expect(config).not.toHaveBeenCalled()
    expect(assessmentAt).not.toHaveBeenCalled()
    expect(rateAt).not.toHaveBeenCalled()
  })

  it.each([['3'], ['2'], [null]])('CRT %s: não vale, e nada é lido', async crt => {
    expect(await run({ crt })).toEqual({ active: false })
    expect(config).not.toHaveBeenCalled()
    expect(assessmentAt).not.toHaveBeenCalled()
    expect(rateAt).not.toHaveBeenCalled()
  })

  it('antes do piso (2026-12-31): não vale e NADA é lido, nem a configuração', async () => {
    expect(await run({ emissionDate: '2026-12-31' })).toEqual({ active: false })
    expect(config).not.toHaveBeenCalled()
    expect(assessmentAt).not.toHaveBeenCalled()
    expect(rateAt).not.toHaveBeenCalled()
  })

  it('a configuração adia: com início 2027-02-01 a nota de 2027-01-15 não vale; a de 2027-02-01 vale', async () => {
    config.mockResolvedValue('2027-02-01')
    expect(await run()).toEqual({ active: false })
    expect(rateAt).not.toHaveBeenCalled()
    expect(await run({ emissionDate: '2027-02-01' })).toMatchObject({ active: true, competence: '2027-02' })
    expect(config).toHaveBeenCalledWith(institution, 'billing', 'ibscbs_simples_start')
  })

  it('opção de apuração 2 ou 3: não vale (a recusa é do escritor da nota, D-IB99)', async () => {
    for (const assessment of ['2', '3']) {
      assessmentAt.mockResolvedValue({ assessment, validFrom: '2027-01-01' })
      expect(await run()).toEqual({ active: false })
    }
    expect(rateAt).not.toHaveBeenCalled()
  })

  it('falha de leitura sobe: nunca vira "não vale" em silêncio', async () => {
    rateAt.mockRejectedValue(new Error('banco caiu'))
    await expect(run()).rejects.toThrow('banco caiu')
  })
})

describe('a declaração do item (A-IB138e)', () => {
  const parcels = { unitValue: 50, quantity: 2, merchandiseValue: 100, freightShare: 0, expensesShare: 0 }

  it('as parcelas oficiais em centavos: vProd, vDesc, vFrete, vOutro', () => {
    expect(merchandiseParcelsOf(parcels)).toEqual({ vProd: 10000, vDesc: 0, vFrete: 0, vOutro: 0 })
    expect(merchandiseParcelsOf({ ...parcels, merchandiseValue: 90, freightShare: 5.25, expensesShare: 1.1 }))
      .toEqual({ vProd: 10000, vDesc: 1000, vFrete: 525, vOutro: 110 })
    // unitário com mais de 2 casas: vProd arredonda uma vez; vProd − vDesc é EXATAMENTE o líquido do item
    const odd = merchandiseParcelsOf({ unitValue: 33.333, quantity: 3, merchandiseValue: 99.99, freightShare: 0, expensesShare: 0 })
    expect(odd.vProd - odd.vDesc).toBe(9999)
  })

  it('R$ 100,00, IBS 0,1000% e CBS 0,9000%: base 100,00, IBS 0,10 e CBS 0,90, com o mês e os percentuais congelados', () => {
    expect(declareSimplesItem(plan(), 1, parcels, null)).toEqual({
      activityCode: '01', competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', baseValue: 100, ibsValue: 0.1, cbsValue: 0.9,
    })
  })

  it('base = vProd + frete + outras − desconto: 100,00 + 5,25 + 1,10 − 10,00 = 96,35 → IBS 0,10 e CBS 0,87 (meio para cima)', () => {
    const d = declareSimplesItem(plan(), 1, { ...parcels, merchandiseValue: 90, freightShare: 5.25, expensesShare: 1.1 }, null)
    expect(d.baseValue).toBe(96.35)
    expect(d.ibsValue).toBe(0.1)    // 9635 × 1000 ppm = 9,635 centavos → 10
    expect(d.cbsValue).toBe(0.87)   // 9635 × 9000 ppm = 86,715 centavos → 87
  })

  it('percentual zero grava valor zero; o centavo meio-para-cima: base 0,05 a 10% (100000 ppm) = 0,01', () => {
    const zero = plan({ rate: { ...RATE, ibsRate: '0.0000', cbsRate: '0.0000', ibsPpm: 0, cbsPpm: 0 } })
    expect(declareSimplesItem(zero, 1, parcels, null)).toMatchObject({ baseValue: 100, ibsValue: 0, cbsValue: 0 })
    const tenth = plan({ rate: { ...RATE, ibsRate: '10.0000', cbsRate: '10.0000', ibsPpm: 100000, cbsPpm: 100000 } })
    expect(declareSimplesItem(tenth, 1, { unitValue: 0.05, quantity: 1, merchandiseValue: 0.05, freightShare: 0, expensesShare: 0 }, null))
      .toMatchObject({ baseValue: 0.05, ibsValue: 0.01, cbsValue: 0.01 })
  })

  it('a atividade: a da mercadoria, senão a do estabelecimento, senão 01', () => {
    expect(declareSimplesItem(plan({ establishmentActivity: '02' }), 1, parcels, '03').activityCode).toBe('03')
    expect(declareSimplesItem(plan({ establishmentActivity: '02' }), 1, parcels, null).activityCode).toBe('02')
    expect(declareSimplesItem(plan(), 1, parcels, null).activityCode).toBe('01')
  })

  it('parcela que o motor recusa (frete negativo) vira 422 BILLING_TOTAL_INVALID com o item — nunca 500', () => {
    expect(() => declareSimplesItem(plan(), 9, { ...parcels, freightShare: -1 }, null)).toThrow(expect.objectContaining({
      statusCode: 422, code: 'BILLING_TOTAL_INVALID', fields: [expect.objectContaining({ field: 'item.9' })],
    }))
  })

  it('a mensagem da recusa traz o item e o mês', () => {
    expect(simplesRateMissingMessage(4, '2027-03')).toMatch(/Item 4: sem o percentual de IBS\/CBS do Simples do mês 2027-03/)
  })
})

describe('cerca da tabela do item (IBS.E9.P5)', () => {
  const SRC = path.join(__dirname, '..')
  const ALLOWED = new Set([
    path.join(SRC, 'modules', 'billing', 'billing.repository.ts'),          // persistItemTaxes: a única escrita
    path.join(SRC, 'shared', 'invoice', 'invoice-cancel.ts'),                // o soft-delete do cancelamento
    path.join(SRC, 'migrations', 'sql', '084_ibscbs_simples_das.sql'),
  ])
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p)
    return /\.(ts|sql)$/.test(e.name) ? [p] : []
  })

  it('só o faturamento grava e só o cancelamento apaga (soft) tb_order_item_ibscbs_simples', () => {
    const offenders = files(SRC).filter(f => !ALLOWED.has(f) && /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+\S*tb_order_item_ibscbs_simples/i.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f))
    expect(offenders).toEqual([])
    const cancel = fs.readFileSync(path.join(SRC, 'shared', 'invoice', 'invoice-cancel.ts'), 'utf8')
    expect(cancel).toContain("'tb_order_item_ibscbs_simples'")
    expect(fs.readFileSync(path.join(SRC, 'modules', 'billing', 'billing.repository.ts'), 'utf8'))
      .not.toMatch(/DELETE\s+FROM\s+`?\$\{?s\}?`?\.?tb_order_item_ibscbs_simples/i)
  })
})
