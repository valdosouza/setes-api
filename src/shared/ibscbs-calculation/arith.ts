/**
 * Aritmética inteira e validação de entrada da peça (fora do barrel). `roundHalfUpDiv` é o porte de
 * `Fc_ArredondaMeioParaCima` do ERP Desktop (`Funcao\Un_RegraContaPorDentro.pas`): meio para cima; no negativo, para
 * longe do zero.
 */
import { IbscbsAssessmentByTax, IbscbsCalculationError, IbscbsTaxAssessment } from './types'

/** Milionésimos de fração: 100% = 1.000.000. */
export const PPM_SCALE = 1_000_000
export const PPM_SCALE_BIG = BigInt(PPM_SCALE)

/** Teto de um valor em centavos (o do ERP Desktop): 40 bilhões de reais. Vale para o `S` e para cada componente. */
export const MAX_CENTS = 4_000_000_000_000

export function roundHalfUpDiv(num: bigint, den: bigint): bigint {
  if (den <= BigInt(0)) throw new RangeError('roundHalfUpDiv: denominador deve ser maior que zero')
  const two = BigInt(2)
  if (num >= BigInt(0)) return (two * num + den) / (two * den)
  return -((-two * num + den) / (two * den))
}

/** Centavos: inteiro seguro e não negativo. Devolve o valor com `-0` normalizado para `0`. */
export function assertCents(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IbscbsCalculationError('INVALID_CENTS', `${name}: esperado inteiro de centavos não negativo, veio ${String(value)}`)
  }
  return value === 0 ? 0 : value
}

/** Milionésimos: inteiro entre 0 e 1.000.000. Devolve o valor com `-0` normalizado para `0`. */
export function assertPpm(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > PPM_SCALE) {
    throw new IbscbsCalculationError('INVALID_PPM', `${name}: esperado inteiro de 0 a ${PPM_SCALE} (milionésimos), veio ${String(value)}`)
  }
  return value === 0 ? 0 : value
}

/**
 * Objeto simples com chaves CONHECIDAS. Chave fora da lista é erro: `{ CBS: 600000 }` no lugar de `{ cbs: 600000 }`
 * não pode virar "sem redução" em silêncio — o tributo sairia cheio.
 */
export function assertKnownKeys(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  const proto = value === null || typeof value !== 'object' ? undefined : Object.getPrototypeOf(value)
  if (value === null || typeof value !== 'object' || (proto !== Object.prototype && proto !== null)) {
    throw new IbscbsCalculationError('INVALID_INPUT', `${name}: esperado um objeto simples`)
  }
  // Todas as chaves PRÓPRIAS, inclusive as não enumeráveis: Map, classe e chave escondida não passam por "vazio".
  for (const key of Reflect.ownKeys(value).map(String)) {
    if (!allowed.includes(key)) {
      throw new IbscbsCalculationError('INVALID_INPUT', `${name}: chave desconhecida "${key}" (aceitas: ${allowed.join(', ')})`)
    }
  }
  return value as Record<string, unknown>
}

const ASSESSMENT_KEYS: readonly string[] = ['ibs', 'cbs']
const ASSESSMENTS: readonly string[] = ['regular', 'das', 'none']

/** Confere a forma de `assessment`: as duas chaves, com valor conhecido. */
export function assertAssessment(value: unknown): IbscbsAssessmentByTax {
  const given = assertKnownKeys(value, ASSESSMENT_KEYS, 'assessment')
  for (const key of ASSESSMENT_KEYS) {
    if (!ASSESSMENTS.includes(given[key] as string)) {
      throw new IbscbsCalculationError('INVALID_INPUT', `assessment.${key}: esperado regular, das ou none, veio ${String(given[key])}`)
    }
  }
  return { ibs: given.ibs as IbscbsTaxAssessment, cbs: given.cbs as IbscbsTaxAssessment }
}

/** `cents × ppm ÷ 10^6`, meio para cima, em centavos. */
export function applyPpm(cents: number, ppm: number): number {
  return Number(roundHalfUpDiv(BigInt(cents) * BigInt(ppm), PPM_SCALE_BIG))
}

/** Soma (e subtrai) centavos em `bigint`, sem perder precisão no meio do caminho; o resultado tem de caber. */
export function sumCents(plus: readonly number[], minus: readonly number[], name: string): number {
  let total = BigInt(0)
  for (const value of plus) total += BigInt(value)
  for (const value of minus) total -= BigInt(value)
  const result = Number(total)
  if (!Number.isSafeInteger(result)) {
    throw new IbscbsCalculationError('INVALID_CENTS', `${name}: a soma não cabe num inteiro seguro`)
  }
  return result === 0 ? 0 : result
}

/**
 * Percentual ESCRITO (texto, até 4 casas, como o `pIBSUF` do leiaute) → milionésimos, sem passar por ponto flutuante:
 * "8.7" → 87000; "0.05" → 500; "60" → 600000. Aceita vírgula ou ponto. Só texto: número já passou por ponto flutuante.
 */
export function ibscbsPpmFromPercent(percent: string): number {
  if (typeof percent !== 'string') {
    throw new IbscbsCalculationError('INVALID_PERCENT', 'percentual: esperado texto (ex.: "8.7")')
  }
  const match = /^(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(percent.trim())
  const ppm = match ? Number(match[1]) * 10_000 + Number((match[2] ?? '').padEnd(4, '0')) : -1
  if (ppm < 0 || ppm > PPM_SCALE) {
    throw new IbscbsCalculationError('INVALID_PERCENT', `percentual inválido (de 0 a 100, até 4 casas, sem sinal): ${percent}`)
  }
  return ppm
}
