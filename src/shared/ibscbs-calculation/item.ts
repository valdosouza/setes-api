/**
 * IBS/CBS do item de mercadoria no REGIME REGULAR (RF-BC-04, RF-BC-06, RF-BC-07, RF-BC-08).
 * Molde: `Pc_DefineIBSCBS_*` do ERP Desktop (`componentes\tributacao.pas`), sem estado e sem banco.
 *
 * Por tributo: `pAliqEfet` (redução) → valor bruto → `vDif` → valor = bruto − `vDif`.
 * - `outside`: `vBC = S`; bruto = `vBC × pAliqEfet`.
 * - `inside`: `vBC` e os brutos saem da conta por dentro, com as alíquotas EFETIVAS.
 * - `vDif = vBC × pAliqEfet × pDif` (a NT manda a efetiva quando há redução; o ERP Desktop usa a nominal — divergência
 *   registrada na matriz, RF-BC-08). Na conta por dentro o bruto pode levar ±1 centavo de ajuste; por isso o `vDif`
 *   nunca passa do bruto (o valor não fica negativo) e, com diferimento de 100%, o `vDif` É o bruto (operação toda
 *   diferida não deixa centavo a recolher). Nos dois casos o `vDif` fica a no máximo 0,01 da fórmula, a tolerância da NT.
 * - O que a NT confere no valor é `vBC × p − vDif INFORMADO`, ±0,01 (RF-BC-04, RF-BC-06): o bruto fica a no máximo 0,01
 *   de `vBC × p`, então o valor sempre passa. Contra o exato sem arredondar, valor e `vDif` podem somar até 0,015.
 * - `vDevTrib` e crédito presumido não existem aqui (ficha do IBS.E9.P1, A-IB132e).
 */
import { calcIbscbsEffectiveAliq } from './aliqs'
import { MAX_CENTS, PPM_SCALE, PPM_SCALE_BIG, applyPpm, assertAssessment, assertCents, assertKnownKeys, assertPpm, roundHalfUpDiv } from './arith'
import { calcIbscbsInside } from './inside'
import {
  IbscbsAssessmentByTax, IbscbsCalculationError, IbscbsItemInput, IbscbsItemResult, IbscbsSimplesOption, IbscbsTax, IbscbsTaxValue,
} from './types'

const INPUT_KEYS: readonly string[] = ['grossBaseCents', 'mode', 'assessment', 'aliqs', 'reductions', 'deferrals']
const TAX_KEYS = ['ibsUf', 'ibsMun', 'cbs'] as const
const TAX_OF: Readonly<Record<(typeof TAX_KEYS)[number], IbscbsTax>> = { ibsUf: 'IBS_UF', ibsMun: 'IBS_MUN', cbs: 'CBS' }

/**
 * Onde cada tributo é apurado, a partir da opção do estabelecimento (`regApIBSCBSSN`, peça `@shared/ibscbs-assessment`):
 * 'not-simples' = não é do Simples (regular nos dois); '1' = os dois no DAS; '2' = CBS no DAS e IBS regular; '3' = os
 * dois regular. "Não é do Simples" é um valor DITO por quem chama, nunca `null`: na peça da opção, ausência de linha
 * quer dizer opção 1 (D-IB1), e um `null` aqui calcularia o regular cheio para uma empresa do Simples.
 * MEI e CRT 2 com sublimite não passam por aqui (ficha, A-IB132g).
 */
export function ibscbsTaxAssessmentOf(simplesOption: IbscbsSimplesOption): IbscbsAssessmentByTax {
  switch (simplesOption) {
    case 'not-simples': return { ibs: 'regular', cbs: 'regular' }
    case '1': return { ibs: 'das', cbs: 'das' }
    case '2': return { ibs: 'regular', cbs: 'das' }
    case '3': return { ibs: 'regular', cbs: 'regular' }
    default:
      throw new IbscbsCalculationError('ASSESSMENT_NOT_SUPPORTED', `opção de apuração desconhecida: ${String(simplesOption)}`)
  }
}

function deferred(baseCents: number, effectivePpm: number, deferralPpm: number): number {
  return Number(roundHalfUpDiv(BigInt(baseCents) * BigInt(effectivePpm) * BigInt(deferralPpm), PPM_SCALE_BIG * PPM_SCALE_BIG))
}

export function calcIbscbsItem(input: IbscbsItemInput): IbscbsItemResult {
  const given = assertKnownKeys(input, INPUT_KEYS, 'input')
  const mode = given.mode
  if (mode !== 'outside' && mode !== 'inside') {
    throw new IbscbsCalculationError('INVALID_MODE', `modo de cálculo desconhecido: ${String(mode)}`)
  }
  // Só o regular nos DOIS tributos. Simples no DAS = `calcIbscbsSimplesItem`; apuração mista (opção 2) ainda sem regra
  // (RF-SN-17, grau N; não se sabe se a CBS do DAS entra no divisor da conta por dentro): recusa, nunca um palpite.
  const assessment = assertAssessment(given.assessment)
  if (assessment.ibs !== 'regular' || assessment.cbs !== 'regular') {
    throw new IbscbsCalculationError(
      'ASSESSMENT_NOT_SUPPORTED',
      `calcIbscbsItem só calcula IBS e CBS no regime regular (IBS: ${assessment.ibs}; CBS: ${assessment.cbs})`,
    )
  }
  const grossBaseCents = assertCents(given.grossBaseCents as number, 'grossBaseCents')
  if (grossBaseCents > MAX_CENTS) {
    throw new IbscbsCalculationError('GROSS_BASE_ABOVE_LIMIT', 'grossBaseCents: valor acima do limite do cálculo')
  }

  const aliqs = assertKnownKeys(given.aliqs, TAX_KEYS, 'aliqs')
  const reductions = given.reductions === undefined ? {} : assertKnownKeys(given.reductions, TAX_KEYS, 'reductions')
  const deferrals = given.deferrals === undefined ? {} : assertKnownKeys(given.deferrals, TAX_KEYS, 'deferrals')

  // Tudo é validado ANTES de responder "sem alíquota": entrada inválida num tributo nunca se esconde atrás do `null` de outro.
  const nominal: Array<number | null> = []
  const reduction: number[] = []
  const deferral: number[] = []
  for (const key of TAX_KEYS) {
    const aliq = aliqs[key]
    nominal.push(aliq === null || aliq === undefined ? null : assertPpm(aliq as number, `aliqs.${key}`))
    reduction.push(reductions[key] === undefined ? 0 : assertPpm(reductions[key] as number, `reductions.${key}`))
    deferral.push(deferrals[key] === undefined ? 0 : assertPpm(deferrals[key] as number, `deferrals.${key}`))
  }
  const missing = nominal.indexOf(null)
  if (missing >= 0) return { status: 'no-aliq', tax: TAX_OF[TAX_KEYS[missing]] }

  const effective = nominal.map((aliq, i) => calcIbscbsEffectiveAliq(aliq as number, reduction[i]))

  let baseCents: number
  let gross: number[]
  let adjustedCents = 0
  let closes = true
  if (mode === 'inside') {
    const inside = calcIbscbsInside(grossBaseCents, effective[0], effective[1], effective[2])
    baseCents = inside.baseCents
    gross = [inside.ibsUfCents, inside.ibsMunCents, inside.cbsCents]
    adjustedCents = inside.adjustedCents
    closes = inside.closes
  } else {
    baseCents = grossBaseCents
    gross = effective.map(ppm => applyPpm(baseCents, ppm))
  }

  const values: IbscbsTaxValue[] = TAX_KEYS.map((_, i) => {
    const deferredCents = deferral[i] === PPM_SCALE
      ? gross[i]
      : Math.min(deferred(baseCents, effective[i], deferral[i]), gross[i])
    return {
      aliqPpm: nominal[i] as number,
      reductionPpm: reduction[i],
      effectiveAliqPpm: effective[i],
      deferralPpm: deferral[i],
      deferredCents,
      valueCents: gross[i] - deferredCents,
    }
  })

  return {
    status: 'calculated',
    mode,
    baseCents,
    ibsUf: values[0],
    ibsMun: values[1],
    cbs: values[2],
    ibsCents: values[0].valueCents + values[1].valueCents,
    adjustedCents,
    closes,
  }
}
