/**
 * @shared/ibscbs-calculation — entradas hostis ou descuidadas (achados do gate adversarial do setes-api:IBS.E9.P1).
 * A regra: entrada fora do contrato é ERRO da peça (`IbscbsCalculationError`), nunca um cálculo "quase certo" em silêncio.
 */
import {
  IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS, IBSCBS_LEGAL_ALIQS, IbscbsCalculationError, IbscbsItemInput,
  calcIbscbsEffectiveAliq, calcIbscbsGrossBase, calcIbscbsInside, calcIbscbsItem, calcIbscbsSimplesBase, calcIbscbsSimplesItem,
  calcIbscbsSimplesValue, ibscbsAliqAt, ibscbsPpmFromPercent, ibscbsSimplesTotals, ibscbsTotals,
} from '@shared/ibscbs-calculation'

const REGULAR = { ibs: 'regular', cbs: 'regular' } as const
const DAS = { ibs: 'das', cbs: 'das' } as const
const BASE: IbscbsItemInput = { grossBaseCents: 1000000, mode: 'outside', assessment: REGULAR, aliqs: { ibsUf: 1000, ibsMun: 0, cbs: 9000 } }
const MAX_SAFE = Number.MAX_SAFE_INTEGER

function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) {
    if (e instanceof IbscbsCalculationError) return e.code
    return `não é erro da peça: ${String(e)}`
  }
  return 'não lançou'
}

describe('M1 — chave ou contêiner errado nunca vira "sem redução" em silêncio', () => {
  it('a chave certa reduz; a errada é erro (antes: tributo cheio, sem aviso)', () => {
    const ok = calcIbscbsItem({ ...BASE, reductions: { cbs: 600000 } })
    expect(ok.status === 'calculated' && ok.cbs.valueCents).toBe(3600)
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: { CBS: 600000 } as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: { ibsUF: 1, Cbs: 1 } as any }))).toBe('INVALID_INPUT')
  })

  it.each([600000, '100', [0, 0, 1000000], null, true])('reductions/deferrals = %p é erro', value => {
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: value as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, deferrals: value as any }))).toBe('INVALID_INPUT')
  })

  it('objeto que não é simples (Map, classe, chave escondida) é erro, nunca "sem redução"', () => {
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: new Map([['cbs', 600000]]) as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: new Number(5) as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: Object.create({ cbs: 600000 }) }))).toBe('INVALID_INPUT')
    const hidden = Object.defineProperty({}, 'CBS', { value: 600000, enumerable: false })
    expect(codeOf(() => calcIbscbsItem({ ...BASE, reductions: hidden }))).toBe('INVALID_INPUT')
    const bare = Object.assign(Object.create(null), { cbs: 600000 })
    const r = calcIbscbsItem({ ...BASE, reductions: bare })
    expect(r.status === 'calculated' && r.cbs.valueCents).toBe(3600)
    expect(codeOf(() => ibscbsTotals([{ status: 'calculated', closes: false } as any]))).toBe('INVALID_INPUT')
  })

  it('entrada, aliqs e assessment que não são objeto, ou com chave a mais, são erro', () => {
    expect(codeOf(() => calcIbscbsItem(null as any))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: null as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: '100' as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: 5 as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: { ...BASE.aliqs, CBS: 1 } as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, assessment: null as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, assessment: { ibs: 'regular' } as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, assessment: { ibs: 'Regular', cbs: 'regular' } as any }))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, vDesc: 1 } as any))).toBe('INVALID_INPUT')
    expect(codeOf(() => calcIbscbsSimplesItem({ baseCents: 1, assessment: DAS, simplesAliqs: { IBS: 1, cbs: 1 } as any }))).toBe('INVALID_INPUT')
  })

  it('componentes do S e da base do Simples: chave errada e contêiner errado são erro', () => {
    expect(calcIbscbsGrossBase({ vProd: 10000, vDesc: 1000, vICMS: 1200 })).toBe(7800)
    expect(codeOf(() => calcIbscbsGrossBase({ vProd: 10000, vdesc: 1000, vIcms: 1200 } as any))).toBe('INVALID_INPUT')
    for (const hostile of ['100', 5, Number.NaN, null, undefined, [1]]) {
      expect(codeOf(() => calcIbscbsGrossBase(hostile as any))).toBe('INVALID_INPUT')
      expect(codeOf(() => calcIbscbsSimplesBase(hostile as any))).toBe('INVALID_INPUT')
    }
    expect(codeOf(() => calcIbscbsSimplesBase({ vProd: 1, vICMS: 1 } as any))).toBe('INVALID_INPUT')
  })

  it('"sem alíquota" não esconde entrada inválida em outro tributo', () => {
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: { ibsUf: null, ibsMun: 0, cbs: -5 } }))).toBe('INVALID_PPM')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, aliqs: { ibsUf: null, ibsMun: 0, cbs: 1 }, reductions: { cbs: 2000000 } }))).toBe('INVALID_PPM')
    expect(codeOf(() => calcIbscbsSimplesItem({ baseCents: 1, assessment: DAS, simplesAliqs: { ibs: null, cbs: -1 } }))).toBe('INVALID_PPM')
  })

  it('modo desconhecido tem código próprio', () => {
    expect(codeOf(() => calcIbscbsItem({ ...BASE, mode: 'por-dentro' as any }))).toBe('INVALID_MODE')
  })
})

describe('M2 — a tabela de alíquotas não decide pela ordem em que veio', () => {
  const a = { tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: 87000 } as const
  const b = { tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: 99000 } as const

  it('duas linhas vigentes com o mesmo início e alíquotas diferentes: erro, nas duas ordens', () => {
    expect(codeOf(() => ibscbsAliqAt([a, b], 'CBS', '2027-06-01'))).toBe('AMBIGUOUS_ALIQ_LINE')
    expect(codeOf(() => ibscbsAliqAt([b, a], 'CBS', '2027-06-01'))).toBe('AMBIGUOUS_ALIQ_LINE')
  })

  it('empate "na sombra" de uma linha mais nova: erro em qualquer ordem (antes dependia da ordem)', () => {
    const newer = { tax: 'CBS', validFrom: '2027-07-01', validUntil: null, ppm: 88000 } as const
    for (const table of [[a, newer, b], [newer, a, b], [a, b, newer], [b, newer, a]]) {
      expect(codeOf(() => ibscbsAliqAt(table, 'CBS', '2027-08-01'))).toBe('AMBIGUOUS_ALIQ_LINE')
    }
    expect(ibscbsAliqAt([a, newer], 'CBS', '2027-08-01')).toBe(88000)
  })

  it('linha repetida (mesma alíquota) não é ambiguidade; fora da vigência do empate, a consulta responde', () => {
    expect(ibscbsAliqAt([a, { ...a }], 'CBS', '2027-06-01')).toBe(87000)
    expect(ibscbsAliqAt([a, b], 'CBS', '2026-06-01')).toBeNull()
  })

  it('tributo desconhecido, intervalo invertido, dia que não existe e tabela que não é lista são erro', () => {
    expect(codeOf(() => ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, 'cbs' as any, '2026-06-01'))).toBe('INVALID_TAX')
    expect(codeOf(() => ibscbsAliqAt([{ ...a, tax: 'ICMS' as any }], 'CBS', '2027-06-01'))).toBe('INVALID_TAX')
    expect(codeOf(() => ibscbsAliqAt([{ ...a, validUntil: '2026-12-31' }], 'CBS', '2027-06-01'))).toBe('INVALID_DATE')
    for (const date of ['2026-02-31', '2025-02-29', '2026-04-31', '2026-00-10', '2026-13-01']) {
      expect(codeOf(() => ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, 'CBS', date))).toBe('INVALID_DATE')
    }
    expect(ibscbsAliqAt(IBSCBS_LEGAL_ALIQS, 'CBS', '2028-02-29')).toBeNull() // bissexto existe
    expect(codeOf(() => ibscbsAliqAt(null as any, 'CBS', '2026-06-01'))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsAliqAt([null as any], 'CBS', '2026-06-01'))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsAliqAt(new Array(2) as any, 'CBS', '2026-06-01'))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsAliqAt([{ ...a, extra: 1 } as any], 'CBS', '2027-06-01'))).toBe('INVALID_INPUT')
  })

  it('linha inválida de OUTRO tributo também é recusada (a tabela inteira é conferida)', () => {
    expect(codeOf(() => ibscbsAliqAt([a, { tax: 'IBS_UF', validFrom: 'ontem', validUntil: null, ppm: 1 }], 'CBS', '2027-06-01'))).toBe('INVALID_DATE')
  })
})

describe('L1 a L3 — precisão e teto', () => {
  it('a soma do S não perde precisão no meio do caminho; componente acima do teto é erro', () => {
    const m = IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS
    expect(calcIbscbsGrossBase({ vProd: m, vFrete: m, vSeg: m, vDesc: m, vPIS: m })).toBe(m)
    expect(codeOf(() => calcIbscbsGrossBase({ vProd: MAX_SAFE }))).toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(codeOf(() => calcIbscbsSimplesBase({ vProd: MAX_SAFE, vFrete: MAX_SAFE }))).toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(calcIbscbsSimplesBase({ vProd: m, vFrete: m, vDesc: m })).toBe(m)
  })

  it('o teto do S vale nos dois modos e no Simples', () => {
    const above = IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS + 1
    expect(codeOf(() => calcIbscbsItem({ ...BASE, grossBaseCents: above }))).toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, mode: 'inside', grossBaseCents: above }))).toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(codeOf(() => calcIbscbsItem({ ...BASE, grossBaseCents: MAX_SAFE, aliqs: { ibsUf: 1000000, ibsMun: 1000000, cbs: 1000000 } })))
      .toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(codeOf(() => calcIbscbsSimplesValue(above, 1))).toBe('GROSS_BASE_ABOVE_LIMIT')
    expect(codeOf(() => calcIbscbsSimplesItem({ baseCents: above, assessment: DAS, simplesAliqs: { ibs: 1, cbs: 1 } }))).toBe('GROSS_BASE_ABOVE_LIMIT')
  })

  it('no teto, com alíquotas de 100%, tudo segue inteiro seguro', () => {
    const r = calcIbscbsItem({
      ...BASE, grossBaseCents: IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS, aliqs: { ibsUf: 1000000, ibsMun: 1000000, cbs: 1000000 },
    })
    expect(r.status === 'calculated' && Number.isSafeInteger(r.ibsCents) && r.ibsCents).toBe(2 * IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS)
  })
})

describe('L4 e L5 — percentual só de texto; -0 não vaza', () => {
  it.each([8.7, [8, 7], ['8.7'], BigInt(10), { toString: () => '50' }, null, undefined])('ibscbsPpmFromPercent(%p) é erro', value => {
    expect(codeOf(() => ibscbsPpmFromPercent(value as any))).toBe('INVALID_PERCENT')
  })

  it('acima de 100% é INVALID_PERCENT; zeros à esquerda e espaços nas pontas são aceitos', () => {
    expect(codeOf(() => ibscbsPpmFromPercent('101'))).toBe('INVALID_PERCENT')
    expect(codeOf(() => ibscbsPpmFromPercent('100.0001'))).toBe('INVALID_PERCENT')
    expect(ibscbsPpmFromPercent('007')).toBe(70000)
    expect(ibscbsPpmFromPercent(' 8,7 ')).toBe(87000)
  })

  it('-0 na entrada sai como 0', () => {
    const r = calcIbscbsItem({ ...BASE, grossBaseCents: -0, aliqs: { ibsUf: -0, ibsMun: -0, cbs: -0 } })
    if (r.status !== 'calculated') throw new Error('esperado calculado')
    for (const value of [r.baseCents, r.ibsCents, r.ibsUf.aliqPpm, r.ibsUf.valueCents, r.cbs.effectiveAliqPpm, r.cbs.deferredCents]) {
      expect(Object.is(value, 0)).toBe(true)
    }
    expect(Object.is(calcIbscbsInside(-0, 500, 500, 87000).baseCents, 0)).toBe(true)
    expect(Object.is(calcIbscbsGrossBase({ vProd: -0 }), 0)).toBe(true)
    expect(Object.is(calcIbscbsEffectiveAliq(-0, 0), 0)).toBe(true)
    expect(Object.is(ibscbsAliqAt([{ tax: 'CBS', validFrom: '2027-01-01', validUntil: null, ppm: -0 }], 'CBS', '2027-01-01'), 0)).toBe(true)
  })
})

describe('L6 — os totais conferem cada item antes de somar', () => {
  const item = (() => {
    const r = calcIbscbsItem(BASE)
    if (r.status !== 'calculated') throw new Error('esperado calculado')
    return r
  })()

  it('item não calculado, campo que não é centavo e vIBS incoerente são erro', () => {
    expect(codeOf(() => ibscbsTotals([{ status: 'no-aliq', tax: 'CBS' } as any]))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsTotals([null as any]))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsTotals('x' as any))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsTotals([{ ...item, baseCents: -50 }, { ...item, baseCents: 150 }]))).toBe('INVALID_CENTS')
    expect(codeOf(() => ibscbsTotals([{ ...item, baseCents: 0.5 }, { ...item, baseCents: 0.5 }]))).toBe('INVALID_CENTS')
    expect(codeOf(() => ibscbsTotals([{ ...item, ibsCents: 999 }]))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsTotals([{ ...item, cbs: null as any }]))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsSimplesTotals([{ status: 'no-aliq', tax: 'IBS' } as any]))).toBe('INVALID_INPUT')
    expect(codeOf(() => ibscbsSimplesTotals([{ status: 'calculated', baseCents: 1, ibsCents: -1, cbsCents: 0 }]))).toBe('INVALID_CENTS')
  })

  it('total que estoura é erro, não número impreciso', () => {
    const big = { ...item, baseCents: MAX_SAFE }
    expect(codeOf(() => ibscbsTotals([big, big]))).toBe('INVALID_CENTS')
  })
})

describe('L9 — diferimento na conta por dentro encosta na tolerância, sem passar', () => {
  it('S 10,88 com CBS de 8,7% e 50% de diferimento: valor 0,42 e vDif 0,44 (exato 0,435 cada)', () => {
    const r = calcIbscbsItem({
      grossBaseCents: 1088, mode: 'inside', assessment: REGULAR, aliqs: { ibsUf: 500, ibsMun: 500, cbs: 87000 }, deferrals: { cbs: 500000 },
    })
    if (r.status !== 'calculated') throw new Error('esperado calculado')
    expect([r.baseCents, r.cbs.deferredCents, r.cbs.valueCents]).toEqual([1000, 44, 42])
    expect(r.baseCents + r.ibsUf.valueCents + r.ibsMun.valueCents + r.cbs.valueCents + r.cbs.deferredCents).toBe(1088)
  })

  it('em 20.000 itens, valor + vDif fecha com S e o vDif fica a no máximo 0,01 da fórmula', () => {
    for (let s = 1; s <= 20000; s++) {
      const r = calcIbscbsItem({
        grossBaseCents: s, mode: 'inside', assessment: REGULAR, aliqs: { ibsUf: 500, ibsMun: 500, cbs: 112000 },
        deferrals: { ibsUf: 333333, ibsMun: 500000, cbs: 777777 },
      })
      if (r.status !== 'calculated') throw new Error('esperado calculado')
      let sum = r.baseCents
      for (const v of [r.ibsUf, r.ibsMun, r.cbs]) {
        sum += v.valueCents + v.deferredCents
        expect(v.valueCents).toBeGreaterThanOrEqual(0)
        const exact = (r.baseCents * v.effectiveAliqPpm * v.deferralPpm) / 1e12
        expect(Math.abs(v.deferredCents - exact)).toBeLessThanOrEqual(1)
      }
      expect(sum).toBe(s)
    }
  })
})
