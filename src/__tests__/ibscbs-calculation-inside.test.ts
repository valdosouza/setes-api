/**
 * @shared/ibscbs-calculation — o `S` do item (RF-BC-03) e a conta por dentro (RF-PRC-02 a 04). setes-api:IBS.E9.P1.
 * Vetores neutros: os mesmos do ERP Desktop (`Tests\TestRegraContaPorDentro`).
 */
import {
  IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS, IbscbsCalculationError, IbscbsGrossBaseComponents,
  calcIbscbsGrossBase, calcIbscbsInside,
} from '@shared/ibscbs-calculation'
import { roundHalfUpDiv } from '@shared/ibscbs-calculation/arith'
import { VectorCase, centsOf, loadIbscbsVector, ppmOfFraction, reaisOf } from '../test-setup/ibscbs-vectors'

const SCALE = 1_000_000

describe('calcIbscbsGrossBase — vetor nfe-diversos.json (casosVBC)', () => {
  const cases: VectorCase[] = loadIbscbsVector('nfe-diversos.json').casosVBC
  it('o vetor tem os 6 casos', () => expect(cases).toHaveLength(6))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const components: Record<string, number> = {}
    for (const [key, value] of Object.entries(c.entrada)) components[key] = centsOf(value)
    expect(reaisOf(calcIbscbsGrossBase(components as IbscbsGrossBaseComponents))).toBe(c.saida.vBC)
  })

  it('componente ausente vale zero; o resultado pode ser negativo', () => {
    expect(calcIbscbsGrossBase({})).toBe(0)
    expect(calcIbscbsGrossBase({ vProd: 1000, vDesc: 1500 })).toBe(-500)
  })

  it('recusa componente negativo ou fracionado', () => {
    expect(() => calcIbscbsGrossBase({ vProd: -1 })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsGrossBase({ vProd: 10.5 })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsGrossBase({ vICMS: Number.NaN })).toThrow(IbscbsCalculationError)
  })
})

/** `S = P − ICMS arredondado`, como o teste do ERP Desktop faz com o vetor. */
function grossBaseOf(P: string, aliquotaICMS: string): { icms: number; s: number } {
  const p = centsOf(P)
  const icms = Number(roundHalfUpDiv(BigInt(p) * BigInt(ppmOfFraction(aliquotaICMS)), BigInt(SCALE)))
  return { icms, s: p - icms }
}

describe('calcIbscbsInside — vetor conta-por-dentro.json', () => {
  const vector = loadIbscbsVector('conta-por-dentro.json')
  const single: VectorCase<Record<string, string>, Record<string, any>>[] = vector.casos
  const split: VectorCase<Record<string, string>, Record<string, any>>[] = vector.casosComponentes

  it('o vetor tem 48 casos com o IBS num componente e 40 com UF e município separados', () => {
    expect(single).toHaveLength(48)
    expect(split).toHaveLength(40)
  })

  it.each(single.map(c => [c.id, c] as const))('%s (IBS num componente só: entra como UF)', (_id, c) => {
    const { icms, s } = grossBaseOf(c.entrada.P, c.entrada.aliquotaICMS)
    const r = calcIbscbsInside(s, ppmOfFraction(c.entrada.aliquotaIBS), 0, ppmOfFraction(c.entrada.aliquotaCBS))
    expect(reaisOf(icms)).toBe(c.saida.icms)
    expect(reaisOf(r.baseCents)).toBe(c.saida.vBC)
    expect(reaisOf(r.ibsUfCents)).toBe(c.saida.vIBS)
    expect(r.ibsMunCents).toBe(0)
    expect(reaisOf(r.cbsCents)).toBe(c.saida.vCBS)
    expect(reaisOf(r.baseCents + icms)).toBe(c.saida.vProd)
    expect(r.adjustedCents > 0).toBe(c.saida.ajusteCentavo)
    expect(r.closes).toBe(c.saida.fecha)
  })

  it.each(split.map(c => [c.id, c] as const))('%s (UF, município e CBS)', (_id, c) => {
    const { icms, s } = grossBaseOf(c.entrada.P, c.entrada.aliquotaICMS)
    const r = calcIbscbsInside(
      s, ppmOfFraction(c.entrada.aliquotaIBSUF), ppmOfFraction(c.entrada.aliquotaIBSMun), ppmOfFraction(c.entrada.aliquotaCBS),
    )
    expect(reaisOf(icms)).toBe(c.saida.icms)
    expect(reaisOf(r.baseCents)).toBe(c.saida.vBC)
    expect(reaisOf(r.ibsUfCents)).toBe(c.saida.vIBSUF)
    expect(reaisOf(r.ibsMunCents)).toBe(c.saida.vIBSMun)
    expect(reaisOf(r.ibsUfCents + r.ibsMunCents)).toBe(c.saida.vIBS)
    expect(reaisOf(r.cbsCents)).toBe(c.saida.vCBS)
    expect(reaisOf(r.baseCents + icms)).toBe(c.saida.vProd)
    expect(r.adjustedCents).toBe(c.saida.ajustes)
    expect(r.closes).toBe(c.saida.fecha)
  })

  it('CPC-006 da ficha: 2499,99 com ICMS 19,5% e CBS 11,2%', () => {
    const { s } = grossBaseOf('2499.99', '0.195')
    expect(s).toBe(201249)
    expect(calcIbscbsInside(s, 500, 500, 112000)).toEqual({
      baseCents: 180817, ibsUfCents: 90, ibsMunCents: 90, cbsCents: 20252, adjustedCents: 0, closes: true,
    })
  })
})

describe('calcIbscbsInside — bordas e limites', () => {
  it('sem base ou sem alíquota não há o que dividir: vBC = S', () => {
    expect(calcIbscbsInside(0, 500, 500, 87000)).toEqual({ baseCents: 0, ibsUfCents: 0, ibsMunCents: 0, cbsCents: 0, adjustedCents: 0, closes: true })
    expect(calcIbscbsInside(12345, 0, 0, 0)).toEqual({ baseCents: 12345, ibsUfCents: 0, ibsMunCents: 0, cbsCents: 0, adjustedCents: 0, closes: true })
  })

  it('componente sem alíquota fica em zero', () => {
    const r = calcIbscbsInside(201249, 1000, 0, 87000)
    expect(r.ibsMunCents).toBe(0)
    expect(r.closes).toBe(true)
  })

  it('um centavo e valores mínimos fecham', () => {
    for (let s = 1; s <= 300; s++) {
      const r = calcIbscbsInside(s, 500, 500, 87000)
      expect(r.baseCents + r.ibsUfCents + r.ibsMunCents + r.cbsCents).toBe(s)
      expect(r.closes).toBe(true)
    }
  })

  it('o teto do S é aceito e acima dele recusa', () => {
    const r = calcIbscbsInside(IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS, 500, 500, 112000)
    expect(r.baseCents + r.ibsUfCents + r.ibsMunCents + r.cbsCents).toBe(IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS)
    expect(() => calcIbscbsInside(IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS + 1, 500, 500, 87000)).toThrow(IbscbsCalculationError)
  })

  it('recusa S negativo ou fracionado e alíquota fora de 0..100%', () => {
    expect(() => calcIbscbsInside(-1, 500, 500, 87000)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsInside(10.5, 500, 500, 87000)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsInside(100, -1, 500, 87000)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsInside(100, 500, 1000001, 87000)).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsInside(100, 500, 500, 87000.5)).toThrow(IbscbsCalculationError)
  })
})

describe('calcIbscbsInside — 30.000 itens aleatórios fecham e ficam na tolerância (RF-PRC-03)', () => {
  // Os 10 cenários e as faixas de preço do ERP Desktop (`Test_RegraContaPorDentro.pas`); gerador próprio, semente fixa.
  const SCENARIOS: Array<[number, number, number]> = [
    [500, 500, 87000], [500, 500, 112000], [1000, 0, 9000], [200, 200, 34800], [200, 200, 44800],
    [0, 0, 0], [500, 500, 0], [0, 0, 87000], [1000, 0, 87000], [0, 0, 0],
  ]
  let state = 20261123n
  const next = (n: number): number => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)
    return Number((state >> 33n) % BigInt(n))
  }

  it('fecha 100% e cada tributo fica a no máximo 0,01 do exato', () => {
    let failures = 0
    let first = ''
    let adjusted = 0
    for (let n = 1; n <= 30000; n++) {
      const idx = next(SCENARIOS.length)
      let [uf, mun, cbs] = SCENARIOS[idx]
      if (idx === SCENARIOS.length - 1) { uf = next(20001); mun = next(20001); cbs = next(120001) }
      const band = next(3)
      const p = 1 + next(band === 0 ? 1000 : band === 1 ? 1000000 : 100000000)
      const t = next(40) * 5000 // ICMS de 0 a 19,5%
      const icms = Number(roundHalfUpDiv(BigInt(p) * BigInt(t), BigInt(SCALE)))
      const s = p - icms
      const r = calcIbscbsInside(s, uf, mun, cbs)
      const within = (value: number, aliq: number): boolean =>
        value >= 0 && Math.abs(value * SCALE - r.baseCents * aliq) <= SCALE
      const ok = r.closes && r.baseCents + r.ibsUfCents + r.ibsMunCents + r.cbsCents === s &&
        within(r.ibsUfCents, uf) && within(r.ibsMunCents, mun) && within(r.cbsCents, cbs)
      if (r.adjustedCents > 0) adjusted++
      if (!ok) {
        failures++
        if (!first) first = `item ${n} (S=${s}, UF=${uf}, Mun=${mun}, CBS=${cbs}): ${JSON.stringify(r)}`
      }
    }
    expect(first).toBe('')
    expect(failures).toBe(0)
    expect(adjusted).toBeGreaterThan(0) // o ajuste de centavo é exercitado
  })
})
