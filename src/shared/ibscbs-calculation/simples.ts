/**
 * IBS/CBS do item no SIMPLES NO DAS (grupo `gTribSN`: RF-SN-03, RF-SN-13, RF-SN-18).
 * Molde: `Fc_BaseSimplesIBSCBS`, `Fc_ValorSN` e `Fc_CalculaSimplesItem` do ERP Desktop (`Funcao\Un_RegraSimplesIBSCBS.pas`).
 *
 * A NT não define a base do `gTribSN` (RF-SN-02): "produto + frete + seguro + outras − desconto" é leitura da casa (grau L)
 * e este é o ponto único de troca. As alíquotas efetivas (`pIBSSN`, `pCBSSN`) vêm de quem chama (partilha do DAS).
 * A presença dos grupos no XML (RF-SN-17) não é decidida aqui.
 */
import { MAX_CENTS, applyPpm, assertAssessment, assertCents, assertKnownKeys, assertPpm, sumCents } from './arith'
import { IbscbsAssessmentByTax, IbscbsCalculationError, IbscbsSimplesAliqs, IbscbsSimplesItemResult } from './types'

export interface IbscbsSimplesBaseComponents {
  vProd?: number
  vFrete?: number
  vSeg?: number
  vOutro?: number
  vDesc?: number
}

const BASE_PLUS = ['vProd', 'vFrete', 'vSeg', 'vOutro'] as const
const BASE_KEYS: readonly string[] = [...BASE_PLUS, 'vDesc']

function assertBelowLimit(value: number, name: string): number {
  if (value > MAX_CENTS) throw new IbscbsCalculationError('GROSS_BASE_ABOVE_LIMIT', `${name}: valor acima do limite do cálculo`)
  return value
}

/**
 * `vBCSN` em centavos, com piso em zero (o molde do ERP Desktop: desconto maior que a soma dá base zero, sem erro —
 * diferente do regular, em que `S` negativo é recusado). Chave desconhecida é erro, nunca um componente ignorado.
 */
export function calcIbscbsSimplesBase(components: IbscbsSimplesBaseComponents): number {
  const given = assertKnownKeys(components, BASE_KEYS, 'components')
  const read = (key: string): number =>
    given[key] === undefined ? 0 : assertBelowLimit(assertCents(given[key] as number, key), key)
  return Math.max(0, sumCents(BASE_PLUS.map(read), [read('vDesc')], 'vBCSN'))
}

/** Valor = base × alíquota efetiva do Simples, meio para cima (o modo de arredondamento é leitura da casa). */
export function calcIbscbsSimplesValue(baseCents: number, simplesAliqPpm: number): number {
  assertBelowLimit(assertCents(baseCents, 'baseCents'), 'baseCents')
  assertPpm(simplesAliqPpm, 'simplesAliqPpm')
  return applyPpm(baseCents, simplesAliqPpm)
}

export function calcIbscbsSimplesItem(input: {
  baseCents: number
  assessment: IbscbsAssessmentByTax
  simplesAliqs: IbscbsSimplesAliqs
}): IbscbsSimplesItemResult {
  const given = assertKnownKeys(input, ['baseCents', 'assessment', 'simplesAliqs'], 'input')
  const assessment = assertAssessment(given.assessment)
  if (assessment.ibs !== 'das' || assessment.cbs !== 'das') {
    throw new IbscbsCalculationError(
      'ASSESSMENT_NOT_SUPPORTED',
      `calcIbscbsSimplesItem só calcula IBS e CBS apurados no DAS (IBS: ${assessment.ibs}; CBS: ${assessment.cbs})`,
    )
  }
  const baseCents = assertBelowLimit(assertCents(given.baseCents as number, 'baseCents'), 'baseCents')
  const aliqs = assertKnownKeys(given.simplesAliqs, ['ibs', 'cbs'], 'simplesAliqs')
  // As duas são validadas antes de responder "sem alíquota".
  const ibs = aliqs.ibs === null || aliqs.ibs === undefined ? null : assertPpm(aliqs.ibs as number, 'simplesAliqs.ibs')
  const cbs = aliqs.cbs === null || aliqs.cbs === undefined ? null : assertPpm(aliqs.cbs as number, 'simplesAliqs.cbs')
  if (ibs === null) return { status: 'no-aliq', tax: 'IBS' }
  if (cbs === null) return { status: 'no-aliq', tax: 'CBS' }
  return { status: 'calculated', baseCents, ibsCents: applyPpm(baseCents, ibs), cbsCents: applyPpm(baseCents, cbs) }
}
