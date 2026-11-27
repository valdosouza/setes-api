/// <reference types="jest" />
// IBS.E9.P4 — peça @shared/ibscbs-regular: quando o regime regular vale, o que ela recusa e a conta do item (D-IB143 a D-IB145, A-IB143).
import { HttpError } from '@shared/errors/http-error'
import {
  ActiveRegularPlan, assertIbscbsRegularChecks, declareRegularItem, grossBaseComponentsOf, loadRegularPlan, percentTextOf,
  regularMissingChecks, regularProblemOf, REGULAR_EXPECTED_CHECKS,
} from '@shared/ibscbs-regular'
import { ClassificationAt } from '@shared/ibscbs-classification'
import { loadIbscbsAliqTable } from '@shared/ibscbs-rate'
import { IBSCBS_LEGAL_ALIQS } from '@shared/ibscbs-calculation'

jest.mock('@shared/ibscbs-rate', () => ({ __esModule: true, loadIbscbsAliqTable: jest.fn() }))
const mockTable = loadIbscbsAliqTable as jest.Mock

const LINE: ClassificationAt = {
  code: '000001', cst: '000', name: 'n', validFrom: '2026-01-01', validUntil: null, requiresRegularTaxation: false,
  ibsReductionPpm: 0, cbsReductionPpm: 0, applicable: true, superseded: false, cstRequiresGroup: true,
}
const plan = (emissionDate = '2026-11-10', table = [...IBSCBS_LEGAL_ALIQS]): ActiveRegularPlan =>
  ({ active: true, emissionDate, aliqTable: table })
// item de R$ 100,00 (2 × R$ 50,00), sem frete nem desconto
const PARCELS = { unitValue: 50, quantity: 2, merchandiseValue: 100, freightShare: 0, expensesShare: 0 }

beforeEach(() => { mockTable.mockReset(); mockTable.mockResolvedValue([...IBSCBS_LEGAL_ALIQS]) })

describe('loadRegularPlan — quando vale (A-IB143a)', () => {
  it('só o CRT 3: lê a tabela de alíquotas uma vez e guarda a data da emissão', async () => {
    const p = await loadRegularPlan({ crt: '3', emissionDate: '2026-11-10' })
    expect(p).toEqual({ active: true, emissionDate: '2026-11-10', aliqTable: [...IBSCBS_LEGAL_ALIQS] })
    expect(mockTable).toHaveBeenCalledTimes(1)
  })

  it.each([['1'], ['2'], [null]])('CRT %p: não vale e NÃO lê a tabela (o Simples é do ibscbs-simples-das)', async crt => {
    expect(await loadRegularPlan({ crt, emissionDate: '2026-11-10' })).toEqual({ active: false })
    expect(mockTable).not.toHaveBeenCalled()
  })

  it('falha de leitura da tabela SOBE (nunca vira "não vale" em silêncio)', async () => {
    mockTable.mockRejectedValue(new Error('banco fora'))
    await expect(loadRegularPlan({ crt: '3', emissionDate: '2026-11-10' })).rejects.toThrow('banco fora')
  })
})

describe('regularProblemOf — o que recusa, com o mesmo texto no 422 e no /validate', () => {
  it('classificação aceita e as três alíquotas vigentes → sem problema (2026 e IBS de 2027 não bastam: a CBS decide)', () => {
    expect(regularProblemOf(plan('2026-11-10'), 1, 41, '000001', LINE)).toBeNull()
    expect(regularProblemOf(plan('2026-12-31'), 1, 41, '000001', LINE)).toBeNull()
  })

  it('2027 sem CBS na tabela: BILLING_IBSCBS_RATE_NOT_FOUND nomeando o tributo e a data (nada inventado)', () => {
    expect(regularProblemOf(plan('2027-01-01'), 3, 41, '000001', LINE)).toEqual({
      code: 'BILLING_IBSCBS_RATE_NOT_FOUND',
      message: expect.stringMatching(/Item 3: sem alíquota de CBS vigente em 2027-01-01/),
    })
  })

  it('sem o IBS da UF (tabela vazia): o primeiro tributo que falta é o dito', () => {
    expect(regularProblemOf(plan('2026-11-10', []), 1, 41, '000001', LINE)?.message).toMatch(/alíquota de IBS da UF/)
  })

  it.each([
    ['sem linha vigente', null, 'IBSCBS_CLASSIFICATION_NOT_FOUND', /Item 1: cClassTrib 000001 da regra de tributação 41 não existe/],
    ['sem presença no modelo 55', { applicable: false }, 'BILLING_IBSCBS_NOT_ALLOWED_IN_NFE', /não é permitido na NF-e modelo 55 \(rej\. 1025\)/],
    ['CST 410', { cst: '410' }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /CST 410\) ainda não é calculado no regime regular/],
    ['CST 515 (diferimento)', { cst: '515' }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /CST 515/],
    ['gTribRegular', { requiresRegularTaxation: true }, 'BILLING_IBSCBS_CST_NOT_SUPPORTED', /exige o grupo de tributação regular/],
    ['redução do IBS desconhecida', { ibsReductionPpm: null }, 'BILLING_IBSCBS_REDUCTION_UNKNOWN', /redução de alíquota do cClassTrib 000001/],
    ['redução da CBS desconhecida', { cbsReductionPpm: null }, 'BILLING_IBSCBS_REDUCTION_UNKNOWN', /ainda não foi carregada/],
  ])('%s', (_name, over, code, message) => {
    const line = over === null ? null : { ...LINE, ...over }
    expect(regularProblemOf(plan(), 1, 41, '000001', line)).toEqual({ code, message: expect.stringMatching(message) })
  })
})

describe('declareRegularItem — a conta por fora do motor (D-IB143, A-IB143b)', () => {
  const run = (line: Partial<ClassificationAt> = {}, taxes = {}, parcels = PARCELS, p = plan()) =>
    declareRegularItem(p, 1, { ...LINE, ...line }, parcels, taxes)

  it('R$ 100,00 sem imposto: base 100,00; IBS UF 0,1000% → 0,10; IBS município 0,0000% → 0,00; CBS 0,9000% → 0,90', () => {
    expect(run()).toEqual({
      baseValue: 100,
      taxes: [
        { tax: 'U', nominalRate: '0.1000', reductionRate: null, effectiveRate: '0.1000', taxValue: 0.1 },
        { tax: 'M', nominalRate: '0.0000', reductionRate: null, effectiveRate: '0.0000', taxValue: 0 },
        { tax: 'C', nominalRate: '0.9000', reductionRate: null, effectiveRate: '0.9000', taxValue: 0.9 },
      ],
    })
  })

  it('IBS de 2027 (0,0500% UF e 0,0500% município) com uma CBS hipotética de teste: as linhas do ano valem', () => {
    const table = [...IBSCBS_LEGAL_ALIQS, { tax: 'CBS' as const, validFrom: '2027-01-01', validUntil: null, ppm: 88000 }]
    const r = run({}, {}, PARCELS, plan('2027-03-10', table))
    expect(r.taxes.map(t => [t.tax, t.nominalRate, t.taxValue])).toEqual([['U', '0.0500', 0.05], ['M', '0.0500', 0.05], ['C', '8.8000', 8.8]])
  })

  it('redução: IBS 60% e CBS 100% (CST 200) → efetivas 0,0400% e 0,0000%; reduction_rate só quando há redução', () => {
    const r = run({ cst: '200', ibsReductionPpm: 600000, cbsReductionPpm: 1000000 })
    expect(r.taxes).toEqual([
      { tax: 'U', nominalRate: '0.1000', reductionRate: '60.0000', effectiveRate: '0.0400', taxValue: 0.04 },
      { tax: 'M', nominalRate: '0.0000', reductionRate: '60.0000', effectiveRate: '0.0000', taxValue: 0 },
      { tax: 'C', nominalRate: '0.9000', reductionRate: '100.0000', effectiveRate: '0.0000', taxValue: 0 },
    ])
  })

  it('o ICMS, o PIS, o COFINS, o FCP e o II do item saem/entram na base como a RF-BC-03 manda (100,00 − 18,00 − 1,65 − 7,60 = 72,75)', () => {
    const taxes = { icms: { value: 18 }, pisCofins: [{ kind: 'P', value: 1.65 }, { kind: 'C', value: 7.6 }] } as any
    const r = run({}, taxes)
    expect(r.baseValue).toBe(72.75)
    // 72,75 × 0,1% = 0,07275 → 0,07 ; 72,75 × 0,9% = 0,65475 → 0,65 (meio para cima, em centavos)
    expect(r.taxes.map(t => t.taxValue)).toEqual([0.07, 0, 0.65])
    expect(grossBaseComponentsOf(PARCELS, { ...taxes, fcp: { value: 2 }, ii: { iiValue: 3 } } as any)).toMatchObject({
      vProd: 10000, vICMS: 1800, vPIS: 165, vCOFINS: 760, vFCP: 200, vII: 300 })
  })

  it('frete e despesas entram na base; o desconto sai (as parcelas oficiais do item)', () => {
    const r = run({}, {}, { unitValue: 50, quantity: 2, merchandiseValue: 90, freightShare: 5, expensesShare: 2.5 })
    // vProd 100,00 − vDesc 10,00 + vFrete 5,00 + vOutro 2,50 = 97,50
    expect(r.baseValue).toBe(97.5)
  })

  it('S negativo (impostos maiores que o item): 422 BILLING_TOTAL_INVALID com o item — nunca 500', () => {
    let error: unknown
    try { run({}, { icms: { value: 150 } } as any) } catch (e) { error = e }
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ statusCode: 422, code: 'BILLING_TOTAL_INVALID', fields: [{ field: 'item.1', message: expect.stringMatching(/^Item 1:/) }] })
  })
})

describe('percentTextOf — milionésimos → percentual em texto, sem ponto flutuante', () => {
  it.each([[0, '0.0000'], [500, '0.0500'], [1000, '0.1000'], [9000, '0.9000'], [600000, '60.0000'], [1000000, '100.0000'], [333300, '33.3300'], [1, '0.0001']])(
    '%p → %s', (ppm, text) => { expect(percentTextOf(ppm)).toBe(text) })
})

describe('boot — as guardas da migration 085 (D-IB135)', () => {
  const all = REGULAR_EXPECTED_CHECKS.map(([t, n]) => ({ t, n }))

  it('são três CHECKs, todos da tabela de valores por tributo', () => {
    expect(REGULAR_EXPECTED_CHECKS).toHaveLength(3)
    expect(new Set(REGULAR_EXPECTED_CHECKS.map(([t]) => t))).toEqual(new Set(['tb_order_item_ibscbs_tax']))
  })

  // a sonda faz duas perguntas por schema: os CHECKs (information_schema.CHECK_CONSTRAINTS) e a coluna base_value (COLUMNS)
  const probe = (schemas: string[], opts: { checks?: typeof all; column?: boolean } = {}) => ({
    query: jest.fn(async (sql: string) => {
      if (/FROM setes_central\.tb_institution/.test(sql)) return [schemas.map(s => ({ s }))]
      if (/information_schema\.COLUMNS/.test(sql)) return [opts.column === false ? [] : [{ c: 'base_value' }]]
      return [opts.checks ?? all]
    }),
  })

  it('todos presentes: sobe e conta os schemas', async () => {
    expect(await assertIbscbsRegularChecks(probe(['setes_a', 'setes_b']))).toBe('3 CHECK(s) em 2 schema(s)')
  })

  it('a coluna base_value ausente (085 pela metade): NÃO sobe, e o erro diz qual e onde', async () => {
    await expect(assertIbscbsRegularChecks(probe(['setes_a'], { column: false })))
      .rejects.toThrow(/setes_a: tb_order_item_ibscbs\.base_value \(coluna\) ausente.*migration 085/)
  })

  it('um CHECK faltando num schema: NÃO sobe, e o erro diz qual e onde', async () => {
    const q = probe(['setes_a'], { checks: all.filter(r => r.n !== 'ck_order_item_ibscbs_tax_effective') })
    await expect(assertIbscbsRegularChecks(q)).rejects.toThrow(/setes_a: tb_order_item_ibscbs_tax\.ck_order_item_ibscbs_tax_effective ausente.*migration 085/)
    expect(await regularMissingChecks({ query: jest.fn().mockResolvedValue([[]]) }, 'x')).toHaveLength(3)
  })
})
