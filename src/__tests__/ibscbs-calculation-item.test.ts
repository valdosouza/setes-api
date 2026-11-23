/**
 * @shared/ibscbs-calculation — IBS/CBS do item no regime regular (RF-BC-04, 06, 07, 08) e totais (RF-BC-09).
 * setes-api:IBS.E9.P1.
 */
import {
  IBSCBS_LEGAL_ALIQS, IbscbsCalculationError, IbscbsItemCalculated, IbscbsItemInput, IbscbsItemResult,
  calcIbscbsItem, ibscbsAliqAt, ibscbsTaxAssessmentOf, ibscbsTotals,
} from '@shared/ibscbs-calculation'
import { VectorCase, centsOf, fractionOf, loadIbscbsVector, ppmOfFraction, reaisOf } from '../test-setup/ibscbs-vectors'

const REGULAR = { ibs: 'regular', cbs: 'regular' } as const
const ALIQS_2026 = { ibsUf: 1000, ibsMun: 0, cbs: 9000 }

function calculated(r: IbscbsItemResult): IbscbsItemCalculated {
  if (r.status !== 'calculated') throw new Error(`esperado calculado, veio ${JSON.stringify(r)}`)
  return r
}

function outside2026(baseCents: number, extra: Partial<IbscbsItemInput> = {}): IbscbsItemCalculated {
  return calculated(calcIbscbsItem({ grossBaseCents: baseCents, mode: 'outside', assessment: REGULAR, aliqs: ALIQS_2026, ...extra }))
}

describe('calcIbscbsItem — vetor ibscbs-item.json (casosItem, IBS/CBS por fora)', () => {
  const cases: VectorCase<Record<string, string>, Record<string, string>>[] = loadIbscbsVector('ibscbs-item.json').casosItem
  it('o vetor tem os 8 casos', () => expect(cases).toHaveLength(8))

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const e = c.entrada
    const r = calculated(calcIbscbsItem({
      grossBaseCents: centsOf(e.vBC),
      mode: 'outside',
      assessment: REGULAR,
      aliqs: { ibsUf: ppmOfFraction(e.aliquotaIBSUF), ibsMun: ppmOfFraction(e.aliquotaIBSMun), cbs: ppmOfFraction(e.aliquotaCBS) },
      reductions: { ibsUf: ppmOfFraction(e.reducaoIBSUF), ibsMun: ppmOfFraction(e.reducaoIBSMun), cbs: ppmOfFraction(e.reducaoCBS) },
      deferrals: { ibsUf: ppmOfFraction(e.diferimentoIBSUF), ibsMun: ppmOfFraction(e.diferimentoIBSMun), cbs: ppmOfFraction(e.diferimentoCBS) },
    }))
    expect({
      vBC: reaisOf(r.baseCents),
      aliquotaEfetivaIBSUF: fractionOf(r.ibsUf.effectiveAliqPpm),
      aliquotaEfetivaIBSMun: fractionOf(r.ibsMun.effectiveAliqPpm),
      aliquotaEfetivaCBS: fractionOf(r.cbs.effectiveAliqPpm),
      vDifIBSUF: reaisOf(r.ibsUf.deferredCents),
      vDifIBSMun: reaisOf(r.ibsMun.deferredCents),
      vDifCBS: reaisOf(r.cbs.deferredCents),
      vIBSUF: reaisOf(r.ibsUf.valueCents),
      vIBSMun: reaisOf(r.ibsMun.valueCents),
      vCBS: reaisOf(r.cbs.valueCents),
      vIBS: reaisOf(r.ibsCents),
    }).toEqual(c.saida)
    expect(r.closes).toBe(true)
    expect(r.adjustedCents).toBe(0)
  })
})

describe('calcIbscbsItem — os números da ficha (alíquotas de 2026, por fora)', () => {
  it('base 100,00 → 0,10 / 0,00 / 0,90', () => {
    const r = outside2026(10000)
    expect([r.baseCents, r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents, r.ibsCents]).toEqual([10000, 10, 0, 90, 10])
  })

  it('base 33,33 → 0,03 / 0,00 / 0,30', () => {
    const r = outside2026(3333)
    expect([r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents]).toEqual([3, 0, 30])
  })

  it('redução de 60%, base 10.000,00 → pAliqEfet 0,0400% e 0,3600%; 4,00 / 0,00 / 36,00', () => {
    const r = outside2026(1000000, { reductions: { ibsUf: 600000, ibsMun: 600000, cbs: 600000 } })
    expect([r.ibsUf.effectiveAliqPpm, r.cbs.effectiveAliqPpm]).toEqual([400, 3600])
    expect([r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents]).toEqual([400, 0, 3600])
    expect(r.ibsUf.aliqPpm).toBe(1000) // a nominal segue informada
  })

  it('diferimento de 50%, base 1.000,00 → vDif 0,50 e 4,50; 0,50 / 0,00 / 4,50', () => {
    const r = outside2026(100000, { deferrals: { ibsUf: 500000, cbs: 500000 } })
    expect([r.ibsUf.deferredCents, r.cbs.deferredCents]).toEqual([50, 450])
    expect([r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents]).toEqual([50, 0, 450])
  })

  it('redução de 60% com diferimento de 50%: o vDif usa a alíquota EFETIVA (NT; RF-BC-08)', () => {
    const r = outside2026(1000000, {
      reductions: { ibsUf: 600000, cbs: 600000 }, deferrals: { ibsUf: 500000, cbs: 500000 },
    })
    expect([r.ibsUf.deferredCents, r.cbs.deferredCents]).toEqual([200, 1800])
    expect([r.ibsUf.valueCents, r.cbs.valueCents]).toEqual([200, 1800])
  })

  it('meio centavo exato sobe: base 5,00 → UF 0,01 (0,005) e CBS 0,05 (0,045)', () => {
    const r = outside2026(500)
    expect([r.ibsUf.valueCents, r.cbs.valueCents]).toEqual([1, 5])
  })

  it('diferimento de 100% zera o valor e o vDif é o bruto', () => {
    const r = outside2026(100000, { deferrals: { ibsUf: 1000000, cbs: 1000000 } })
    expect([r.ibsUf.deferredCents, r.ibsUf.valueCents, r.cbs.deferredCents, r.cbs.valueCents]).toEqual([100, 0, 900, 0])
  })

  it('base zero → tudo zero', () => {
    const r = outside2026(0)
    expect([r.baseCents, r.ibsUf.valueCents, r.cbs.valueCents, r.ibsCents]).toEqual([0, 0, 0, 0])
  })

  it('as alíquotas podem vir da tabela da norma pela data', () => {
    const at = (tax: 'IBS_UF' | 'IBS_MUN' | 'CBS') => ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, tax, '2026-11-23')
    const r = calculated(calcIbscbsItem({
      grossBaseCents: 10000, mode: 'outside', assessment: REGULAR, aliqs: { ibsUf: at('IBS_UF'), ibsMun: at('IBS_MUN'), cbs: at('CBS') },
    }))
    expect([r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents]).toEqual([10, 0, 90])
  })
})

describe('calcIbscbsItem — conta por dentro', () => {
  const ALIQS_2027 = { ibsUf: 500, ibsMun: 500, cbs: 87000 }

  it('CPC-001: S 108,80 com 0,05% + 0,05% + 8,7% → vBC 100,00 · 0,05 / 0,05 / 8,70', () => {
    const r = calculated(calcIbscbsItem({ grossBaseCents: 10880, mode: 'inside', assessment: REGULAR, aliqs: ALIQS_2027 }))
    expect([r.baseCents, r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents, r.ibsCents]).toEqual([10000, 5, 5, 870, 10])
    expect(r.closes).toBe(true)
    expect(r.mode).toBe('inside')
  })

  it('com redução, a conta por dentro usa as alíquotas efetivas', () => {
    // 60% de redução: 0,02% + 0,02% + 3,48% → S 103,52 = vBC 100,00 + 0,02 + 0,02 + 3,48
    const r = calculated(calcIbscbsItem({
      grossBaseCents: 10352, mode: 'inside', assessment: REGULAR, aliqs: ALIQS_2027,
      reductions: { ibsUf: 600000, ibsMun: 600000, cbs: 600000 },
    }))
    expect([r.baseCents, r.ibsUf.valueCents, r.ibsMun.valueCents, r.cbs.valueCents]).toEqual([10000, 2, 2, 348])
    expect(r.closes).toBe(true)
  })

  it('com diferimento, o vDif sai do vBC de dentro e o que fecha com S é o bruto (valor + vDif)', () => {
    const r = calculated(calcIbscbsItem({
      grossBaseCents: 10880, mode: 'inside', assessment: REGULAR, aliqs: ALIQS_2027, deferrals: { cbs: 500000 },
    }))
    expect([r.baseCents, r.cbs.deferredCents, r.cbs.valueCents]).toEqual([10000, 435, 435])
    expect(r.baseCents + r.ibsUf.valueCents + r.ibsMun.valueCents + r.cbs.valueCents + r.cbs.deferredCents).toBe(10880)
  })

  it('diferimento de 100%: nada a recolher — o vDif é o bruto, a no máximo 0,01 da fórmula, com ou sem ajuste de centavo', () => {
    let adjusted = 0
    for (let s = 1; s <= 3000; s++) {
      const r = calculated(calcIbscbsItem({
        grossBaseCents: s, mode: 'inside', assessment: REGULAR, aliqs: { ibsUf: 500, ibsMun: 500, cbs: 112000 },
        deferrals: { ibsUf: 1000000, ibsMun: 1000000, cbs: 1000000 },
      }))
      for (const v of [r.ibsUf, r.ibsMun, r.cbs]) {
        expect(v.valueCents).toBe(0)
        const formula = Math.floor((2 * r.baseCents * v.effectiveAliqPpm + 1_000_000) / 2_000_000)
        expect(Math.abs(v.deferredCents - formula)).toBeLessThanOrEqual(1)
        if (v.deferredCents !== formula) adjusted++
      }
      expect(r.baseCents + r.ibsUf.deferredCents + r.ibsMun.deferredCents + r.cbs.deferredCents).toBe(s)
    }
    expect(adjusted).toBeGreaterThan(0) // o ajuste de centavo acontece na faixa
  })

  it('diferimento parcial: o vDif nunca passa do bruto e o valor nunca fica negativo', () => {
    for (let s = 1; s <= 3000; s++) {
      const r = calculated(calcIbscbsItem({
        grossBaseCents: s, mode: 'inside', assessment: REGULAR, aliqs: { ibsUf: 500, ibsMun: 500, cbs: 112000 },
        deferrals: { ibsUf: 999999, ibsMun: 999999, cbs: 999999 },
      }))
      for (const v of [r.ibsUf, r.ibsMun, r.cbs]) expect(v.valueCents).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('calcIbscbsItem — o que a peça recusa ou não calcula', () => {
  const base: IbscbsItemInput = { grossBaseCents: 10000, mode: 'outside', assessment: REGULAR, aliqs: ALIQS_2026 }

  it('sem linha de alíquota: responde qual tributo falta e não calcula nada', () => {
    expect(calcIbscbsItem({ ...base, aliqs: { ibsUf: 500, ibsMun: 500, cbs: null } })).toEqual({ status: 'no-aliq', tax: 'CBS' })
    expect(calcIbscbsItem({ ...base, aliqs: { ibsUf: null, ibsMun: 500, cbs: null } })).toEqual({ status: 'no-aliq', tax: 'IBS_UF' })
    expect(calcIbscbsItem({ ...base, aliqs: { ibsUf: 500, ibsMun: null, cbs: 87000 } })).toEqual({ status: 'no-aliq', tax: 'IBS_MUN' })
  })

  it('CBS de 2027 pela tabela da norma: sem alíquota, sem valor', () => {
    const at = (tax: 'IBS_UF' | 'IBS_MUN' | 'CBS') => ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, tax, '2027-01-01')
    expect(calcIbscbsItem({ ...base, aliqs: { ibsUf: at('IBS_UF'), ibsMun: at('IBS_MUN'), cbs: at('CBS') } }))
      .toEqual({ status: 'no-aliq', tax: 'CBS' })
  })

  it.each([
    ['opção 1 (os dois no DAS)', ibscbsTaxAssessmentOf('1')],
    ['opção 2 (CBS no DAS, IBS regular)', ibscbsTaxAssessmentOf('2')],
    ['MEI (nenhum)', { ibs: 'none', cbs: 'none' } as const],
  ])('recusa apuração que não é regular nos dois: %s', (_name, assessment) => {
    expect(() => calcIbscbsItem({ ...base, assessment })).toThrow(IbscbsCalculationError)
    try { calcIbscbsItem({ ...base, assessment }) } catch (e) { expect((e as IbscbsCalculationError).code).toBe('ASSESSMENT_NOT_SUPPORTED') }
  })

  it('recusa valor negativo ou fracionado, alíquota, redução e diferimento fora de 0..100% e modo desconhecido', () => {
    expect(() => calcIbscbsItem({ ...base, grossBaseCents: -1 })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsItem({ ...base, grossBaseCents: 100.5 })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsItem({ ...base, aliqs: { ibsUf: 1000001, ibsMun: 0, cbs: 0 } })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsItem({ ...base, reductions: { cbs: -1 } })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsItem({ ...base, deferrals: { ibsUf: 1000001 } })).toThrow(IbscbsCalculationError)
    expect(() => calcIbscbsItem({ ...base, mode: 'por-dentro' as any })).toThrow(IbscbsCalculationError)
  })
})

describe('ibscbsTaxAssessmentOf — onde cada tributo é apurado, pela opção do estabelecimento', () => {
  it('não é do Simples e opção 3: regular nos dois; opção 1: DAS nos dois; opção 2: CBS no DAS e IBS regular', () => {
    expect(ibscbsTaxAssessmentOf('not-simples')).toEqual({ ibs: 'regular', cbs: 'regular' })
    expect(ibscbsTaxAssessmentOf('3')).toEqual({ ibs: 'regular', cbs: 'regular' })
    expect(ibscbsTaxAssessmentOf('1')).toEqual({ ibs: 'das', cbs: 'das' })
    expect(ibscbsTaxAssessmentOf('2')).toEqual({ ibs: 'regular', cbs: 'das' })
  })

  it('opção desconhecida falha alto', () => {
    expect(() => ibscbsTaxAssessmentOf('4' as any)).toThrow(IbscbsCalculationError)
    expect(() => ibscbsTaxAssessmentOf(undefined as any)).toThrow(IbscbsCalculationError)
    // "não achei a linha" nunca vira "não é do Simples": null é erro (na peça da opção, ausência = opção 1)
    expect(() => ibscbsTaxAssessmentOf(null as any)).toThrow(IbscbsCalculationError)
  })
})

describe('ibscbsTotals — soma exata dos itens (RF-BC-09)', () => {
  it('os dois primeiros casos da ficha: vBC 133,33 · UF 0,13 · Mun 0,00 · CBS 1,20 · vIBS 0,13', () => {
    expect(ibscbsTotals([outside2026(10000), outside2026(3333)])).toEqual({
      baseCents: 13333, ibsUfDeferredCents: 0, ibsUfCents: 13, ibsMunDeferredCents: 0, ibsMunCents: 0, ibsCents: 13,
      cbsDeferredCents: 0, cbsCents: 120,
    })
  })

  it('soma também o diferido; a soma dos arredondados não é o arredondado da soma', () => {
    const items = [
      outside2026(500), outside2026(500), // 0,005 sobe duas vezes: 0,02, e não 0,01 sobre a base somada
      outside2026(100000, { deferrals: { ibsUf: 500000, cbs: 500000 } }),
    ]
    const t = ibscbsTotals(items)
    expect([t.baseCents, t.ibsUfCents, t.ibsUfDeferredCents, t.cbsCents, t.cbsDeferredCents, t.ibsCents]).toEqual([101000, 52, 50, 460, 450, 52])
  })

  it('sem itens: zeros', () => {
    expect(ibscbsTotals([])).toEqual({
      baseCents: 0, ibsUfDeferredCents: 0, ibsUfCents: 0, ibsMunDeferredCents: 0, ibsMunCents: 0, ibsCents: 0,
      cbsDeferredCents: 0, cbsCents: 0,
    })
  })
})
