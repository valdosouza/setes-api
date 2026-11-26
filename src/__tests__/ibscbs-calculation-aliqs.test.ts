/**
 * @shared/ibscbs-calculation — alíquota pela data (RF-BC-11) e alíquota efetiva (RF-BC-07). setes-api:IBS.E9.P1.
 */
import {
  IBSCBS_LEGAL_ALIQS, IbscbsAliqLine, IbscbsCalculationError, IbscbsTax,
  calcIbscbsEffectiveAliq, ibscbsAliqAt, ibscbsPpmFromPercent,
} from '@shared/ibscbs-calculation'
import { roundHalfUpDiv } from '@shared/ibscbs-calculation/arith'
import { VectorCase, fractionOf, loadIbscbsVector, ppmOfFraction } from '../test-setup/ibscbs-vectors'

const vector = loadIbscbsVector('ibscbs-item.json')

describe('roundHalfUpDiv (meio para cima; no negativo, para longe do zero)', () => {
  it.each([
    [5n, 10n, 1n], [4n, 10n, 0n], [15n, 10n, 2n], [0n, 7n, 0n], [-5n, 10n, -1n], [-4n, 10n, 0n], [-15n, 10n, -2n],
  ])('%s / %s = %s', (num, den, expected) => {
    expect(roundHalfUpDiv(num, den)).toBe(expected)
  })

  it('recusa denominador zero ou negativo', () => {
    expect(() => roundHalfUpDiv(1n, 0n)).toThrow(RangeError)
    expect(() => roundHalfUpDiv(1n, -1n)).toThrow(RangeError)
  })
})

describe('ibscbsPpmFromPercent', () => {
  it.each([['8.7', 87000], ['0.05', 500], ['60', 600000], ['0,9', 9000], ['11.2', 112000], ['100', 1000000], ['0', 0], ['0.1234', 1234]])(
    '%s%% = %d milionésimos', (text, ppm) => {
      expect(ibscbsPpmFromPercent(text)).toBe(ppm)
    })

  it.each(['-1', '8.70001', 'abc', '', '100.0001', '1e2', '1000'])('recusa "%s"', text => {
    expect(() => ibscbsPpmFromPercent(text)).toThrow(IbscbsCalculationError)
  })
})

describe('calcIbscbsEffectiveAliq — vetor casosAliquotaEfetiva', () => {
  const cases: VectorCase[] = vector.casosAliquotaEfetiva
  it('o vetor tem os 6 casos', () => expect(cases).toHaveLength(6))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const got = calcIbscbsEffectiveAliq(ppmOfFraction(c.entrada.aliquota), ppmOfFraction(c.entrada.reducao))
    expect(fractionOf(got)).toBe(c.saida.aliquotaEfetiva)
  })

  it('os números da ficha, em milionésimos', () => {
    expect(calcIbscbsEffectiveAliq(87000, 600000)).toBe(34800)
    expect(calcIbscbsEffectiveAliq(500, 600000)).toBe(200)
    expect(calcIbscbsEffectiveAliq(1000, 400000)).toBe(600)
    expect(calcIbscbsEffectiveAliq(87000, 1000000)).toBe(0)
    expect(calcIbscbsEffectiveAliq(112000, 0)).toBe(112000)
  })

  it('arredonda o meio para cima na 4ª casa do percentual', () => {
    // 0,0005% × (1 − 50%) = 0,00025% → 2,5 milionésimos → 3
    expect(calcIbscbsEffectiveAliq(5, 500000)).toBe(3)
  })

  it('recusa alíquota ou redução fora de 0..100%', () => {
    expect(() => calcIbscbsEffectiveAliq(-1, 0)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsEffectiveAliq(1000001, 0)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsEffectiveAliq(1000, 1000001)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsEffectiveAliq(1000.5, 0)).toThrow(IbscbsCalculationError)
  })
})

describe('ibscbsAliqAt — vetor casosAliquotaPorData (tabela da norma)', () => {
  const cases: VectorCase[] = vector.casosAliquotaPorData
  it('o vetor tem os 10 casos', () => expect(cases).toHaveLength(10))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const got = ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, c.entrada.tributo as IbscbsTax, c.entrada.data)
    expect(got === null ? null : fractionOf(got)).toBe(c.saida.aliquota)
  })

  it('a CBS de 2027 NÃO está embutida (RF-CAL-02): sem linha', () => {
    expect(ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, 'CBS', '2027-01-01')).toBeNull()
    expect(IBSCBS_LEGAL_ALIQS.some(l => l.tax === 'CBS' && l.validFrom >= '2027-01-01')).toBe(false)
  })

  it('a tabela de quem chama completa a da norma; com duas linhas vigentes vale a de início mais recente', () => {
    const table: IbscbsAliqLine[] = [
      ...IBSCBS_LEGAL_ALIQS,
      { tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: 87000 },
      { tax: 'CBS', validFrom: '2027-07-01', validUntil: null, ppm: 88000 },
    ]
    expect(ibscbsAliqAt(table, 'CBS', '2027-06-30')).toBe(87000)
    expect(ibscbsAliqAt(table, 'CBS', '2027-07-01')).toBe(88000)
    expect(ibscbsAliqAt(table, 'CBS', '2031-01-01')).toBe(88000)
    expect(ibscbsAliqAt(table, 'CBS', '2026-12-31')).toBe(9000)
  })

  it('a tabela da norma é imutável', () => {
    expect(Object.isFrozen(IBSCBS_LEGAL_ALIQS)).toBe(true)
    expect(IBSCBS_LEGAL_ALIQS.every(l => Object.isFrozen(l))).toBe(true)
  })

  it.each(['2027-1-1', '01/01/2027', '2027-13-01', '2027-01-32', '', '2027-01-01T00:00:00Z'])('recusa a data "%s"', date => {
    expect(() => ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, 'CBS', date)).toThrow(IbscbsCalculationError)
  })

  it('recusa linha de tabela com data ou alíquota inválida', () => {
    expect(() => ibscbsAliqAt([{ tax: 'CBS', validFrom: '2027', validUntil: null, ppm: 1 }], 'CBS', '2027-01-01')).toThrow(IbscbsCalculationError)
    expect(() => ibscbsAliqAt([{ tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: -1 }], 'CBS', '2027-01-01')).toThrow(IbscbsCalculationError)
  })
})
