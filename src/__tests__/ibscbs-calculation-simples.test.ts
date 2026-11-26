/**
 * @shared/ibscbs-calculation — Simples no DAS (gTribSN: RF-SN-03, 13, 18, 19). setes-api:IBS.E9.P1.
 */
import {
  IbscbsCalculationError, IbscbsSimplesItemCalculated, IbscbsSimplesItemResult,
  calcIbscbsSimplesBase, calcIbscbsSimplesItem, calcIbscbsSimplesValue, ibscbsSimplesTotals, ibscbsTaxAssessmentOf,
} from '@shared/ibscbs-calculation'
import { VectorCase, centsOf, loadIbscbsVector, ppmOfFraction, reaisOf } from '../test-setup/ibscbs-vectors'

const vector = loadIbscbsVector('ibscbs-item.json')
const DAS = ibscbsTaxAssessmentOf('1')

function calculated(r: IbscbsSimplesItemResult): IbscbsSimplesItemCalculated {
  if (r.status !== 'calculated') throw new Error(`esperado calculado, veio ${JSON.stringify(r)}`)
  return r
}

describe('calcIbscbsSimplesBase — vetor casosSimplesBase', () => {
  const cases: VectorCase<Record<string, string>, Record<string, string>>[] = vector.casosSimplesBase
  it('o vetor tem os 3 casos', () => expect(cases).toHaveLength(3))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const e = c.entrada
    const got = calcIbscbsSimplesBase({
      vProd: centsOf(e.vProd), vFrete: centsOf(e.vFrete), vSeg: centsOf(e.vSeg), vOutro: centsOf(e.vOutro), vDesc: centsOf(e.vDesc),
    })
    expect(reaisOf(got)).toBe(c.saida.vBCSN)
  })

  it('os números da ficha: (100; 10; 5; 2,5; desconto 7,5) → 110,00 e piso em zero', () => {
    expect(calcIbscbsSimplesBase({ vProd: 10000, vFrete: 1000, vSeg: 500, vOutro: 250, vDesc: 750 })).toBe(11000)
    expect(calcIbscbsSimplesBase({ vProd: 1000, vDesc: 1500 })).toBe(0)
    expect(calcIbscbsSimplesBase({})).toBe(0)
  })

  it('recusa componente negativo ou fracionado', () => {
    expect(() => calcIbscbsSimplesBase({ vProd: -1 })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsSimplesBase({ vDesc: 0.5 })).toThrow(IbscbsCalculationError)
  })
})

describe('calcIbscbsSimplesValue — vetor casosSimplesValor', () => {
  const cases: VectorCase<Record<string, string>, Record<string, string>>[] = vector.casosSimplesValor
  it('o vetor tem os 6 casos', () => expect(cases).toHaveLength(6))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const got = calcIbscbsSimplesValue(centsOf(c.entrada.vBCSN), ppmOfFraction(c.entrada.aliquotaEfetivaSN))
    expect(reaisOf(got)).toBe(c.saida.valor)
  })

  it('os números da ficha', () => {
    expect(calcIbscbsSimplesValue(100000, 1234)).toBe(123)
    expect(calcIbscbsSimplesValue(100000, 9258)).toBe(926)
    expect(calcIbscbsSimplesValue(12345, 31000)).toBe(383)
    expect(calcIbscbsSimplesValue(33333, 1234)).toBe(41)
    expect(calcIbscbsSimplesValue(33333, 9258)).toBe(309)
  })

  it('meio centavo sobe: 5,00 × 0,1% = 0,005 → 0,01', () => {
    expect(calcIbscbsSimplesValue(500, 1000)).toBe(1)
  })
})

describe('calcIbscbsSimplesItem', () => {
  it('base 1000 com IBS 0,1234% e CBS 0,9258% → 1,23 e 9,26', () => {
    expect(calcIbscbsSimplesItem({ baseCents: 100000, assessment: DAS, simplesAliqs: { ibs: 1234, cbs: 9258 } }))
      .toEqual({ status: 'calculated', baseCents: 100000, ibsCents: 123, cbsCents: 926 })
  })

  it('sem alíquota efetiva informada: responde qual falta e não calcula', () => {
    expect(calcIbscbsSimplesItem({ baseCents: 100000, assessment: DAS, simplesAliqs: { ibs: null, cbs: 9258 } }))
      .toEqual({ status: 'no-aliq', tax: 'IBS' })
    expect(calcIbscbsSimplesItem({ baseCents: 100000, assessment: DAS, simplesAliqs: { ibs: 1234, cbs: null } }))
      .toEqual({ status: 'no-aliq', tax: 'CBS' })
  })

  it.each([
    ['regular nos dois', ibscbsTaxAssessmentOf('3')],
    ['opção 2 (apuração mista)', ibscbsTaxAssessmentOf('2')],
    ['MEI', { ibs: 'none', cbs: 'none' } as const],
  ])('recusa apuração que não é DAS nos dois: %s', (_name, assessment) => {
    expect(() => calcIbscbsSimplesItem({ baseCents: 100, assessment, simplesAliqs: { ibs: 1, cbs: 1 } })).toThrow(IbscbsCalculationError)
  })

  it('recusa base negativa e alíquota fora de 0..100%', () => {
    expect(() => calcIbscbsSimplesItem({ baseCents: -1, assessment: DAS, simplesAliqs: { ibs: 1, cbs: 1 } })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsSimplesItem({ baseCents: 100, assessment: DAS, simplesAliqs: { ibs: 1000001, cbs: 1 } })).toThrow(IbscbsCalculationError)
  })
})

describe('ibscbsSimplesTotals — soma dos itens (RF-SN-19)', () => {
  it('itens de base 1000 e 333,33 → IBS 1,64 e CBS 12,35', () => {
    const items = [100000, 33333].map(baseCents =>
      calculated(calcIbscbsSimplesItem({ baseCents, assessment: DAS, simplesAliqs: { ibs: 1234, cbs: 9258 } })))
    expect(ibscbsSimplesTotals(items)).toEqual({ baseCents: 133333, ibsCents: 164, cbsCents: 1235 })
  })

  it('sem itens: zeros', () => {
    expect(ibscbsSimplesTotals([])).toEqual({ baseCents: 0, ibsCents: 0, cbsCents: 0 })
  })
})
