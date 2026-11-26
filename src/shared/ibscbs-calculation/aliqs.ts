/**
 * Alíquotas do IBS/CBS: a linha vigente numa data (RF-BC-11) e a alíquota efetiva com redução (RF-BC-07).
 * Molde: `Fc_AliquotaVigente` (`Funcao\Un_RegraIBSCBS2027.pas`) e `Fc_AliquotaEfetivaPPM` (`Un_RegraContaPorDentro.pas`).
 */
import { PPM_SCALE_BIG, assertKnownKeys, assertPpm, roundHalfUpDiv } from './arith'
import { IbscbsAliqLine, IbscbsCalculationError, IbscbsTax } from './types'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TAXES: readonly string[] = ['IBS_UF', 'IBS_MUN', 'CBS']
const LINE_KEYS: readonly string[] = ['tax', 'validFrom', 'validUntil', 'ppm']

/** `AAAA-MM-DD` de um dia que existe (30/02 e 29/02 de ano comum são recusados). */
function assertDate(value: string, name: string): void {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]) return
  }
  throw new IbscbsCalculationError('INVALID_DATE', `${name}: esperado AAAA-MM-DD de um dia que existe, veio ${String(value)}`)
}

function assertTax(value: string, name: string): void {
  if (!TAXES.includes(value)) {
    throw new IbscbsCalculationError('INVALID_TAX', `${name}: esperado IBS_UF, IBS_MUN ou CBS, veio ${String(value)}`)
  }
}

/**
 * As linhas que a NT 2025.002 v1.53 FIXA (rej. 1026, 1036 e 1037; LC 214 arts. 343, 344 e 346): 2025–2026 e o IBS de
 * 2027–2028. A CBS de 2027 em diante NÃO está aqui de propósito: a norma diz "alíquota vigente conforme legislação" e o
 * valor ainda não foi fixado (RF-CAL-02) — quem chama traz a linha na tabela dele; sem linha, `ibscbsAliqAt` devolve `null`.
 */
export const IBSCBS_LEGAL_ALIQS: readonly IbscbsAliqLine[] = Object.freeze([
  Object.freeze({ tax: 'IBS_UF', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 1000 } as const),
  Object.freeze({ tax: 'IBS_MUN', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 0 } as const),
  Object.freeze({ tax: 'CBS', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 9000 } as const),
  Object.freeze({ tax: 'IBS_UF', validFrom: '2027-01-01', validUntil: '2028-12-31', ppm: 500 } as const),
  Object.freeze({ tax: 'IBS_MUN', validFrom: '2027-01-01', validUntil: '2028-12-31', ppm: 500 } as const),
])

/**
 * Alíquota nominal (milionésimos) do tributo na data do fato; `null` = sem linha vigente (nunca um valor inventado).
 * Com mais de uma linha vigente vale a de início mais recente; duas vigentes com o MESMO início e alíquotas diferentes
 * são recusadas, mesmo que uma terceira mais nova vencesse — a resposta não pode depender da ordem em que a tabela veio. A tabela inteira é validada, não só as
 * linhas do tributo pedido.
 */
export function ibscbsAliqAt(table: readonly IbscbsAliqLine[], tax: IbscbsTax, factDate: string): number | null {
  assertTax(tax, 'tax')
  assertDate(factDate, 'factDate')
  if (!Array.isArray(table)) throw new IbscbsCalculationError('INVALID_INPUT', 'table: esperada uma lista de linhas')
  const current: IbscbsAliqLine[] = []
  for (let i = 0; i < table.length; i++) {
    const line = table[i]
    assertKnownKeys(line, LINE_KEYS, `table[${i}]`)
    assertTax(line.tax, `table[${i}].tax`)
    assertDate(line.validFrom, `table[${i}].validFrom`)
    if (line.validUntil !== null) {
      assertDate(line.validUntil, `table[${i}].validUntil`)
      if (line.validUntil < line.validFrom) {
        throw new IbscbsCalculationError('INVALID_DATE', `table[${i}]: validUntil antes de validFrom`)
      }
    }
    assertPpm(line.ppm, `table[${i}].ppm`)
    if (line.tax !== tax) continue
    if (line.validFrom > factDate) continue
    if (line.validUntil !== null && line.validUntil < factDate) continue
    current.push(line)
  }
  // O empate é conferido entre TODAS as vigentes (não só contra a que venceria): o desfecho é o mesmo em qualquer ordem.
  for (let i = 0; i < current.length; i++) {
    for (let j = i + 1; j < current.length; j++) {
      if (current[i].validFrom === current[j].validFrom && current[i].ppm !== current[j].ppm) {
        throw new IbscbsCalculationError(
          'AMBIGUOUS_ALIQ_LINE',
          `duas linhas de ${tax} vigentes em ${factDate} com o mesmo início (${current[i].validFrom}) e alíquotas diferentes`,
        )
      }
    }
  }
  let found: IbscbsAliqLine | null = null
  for (const line of current) {
    if (found === null || line.validFrom > found.validFrom) found = line
  }
  return found === null ? null : assertPpm(found.ppm, 'ppm')
}

/**
 * `pAliqEfet = p × (1 − pRedAliq/100)`, com 4 casas do percentual (= milionésimos inteiros), meio para cima.
 * A NT não diz o modo de arredondamento (RF-BC-07); o redutor de compra governamental não é aplicado aqui.
 */
export function calcIbscbsEffectiveAliq(aliqPpm: number, reductionPpm: number): number {
  assertPpm(aliqPpm, 'aliqPpm')
  assertPpm(reductionPpm, 'reductionPpm')
  return Number(roundHalfUpDiv(BigInt(aliqPpm) * (PPM_SCALE_BIG - BigInt(reductionPpm)), PPM_SCALE_BIG))
}
