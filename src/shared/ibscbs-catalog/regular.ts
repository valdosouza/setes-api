import { ClassificationRecord } from './parse'

/**
 * IBS.E9.P4 (D-IB143 a D-IB145; A-IB143e): o que o faturamento do REGIME REGULAR aceita no modelo 55.
 * O motor de IBS/CBS do item só cobre o CST 000 e o 200 sem `gTribRegular`; o restante (410, 510, 515, 550, 620, 830,
 * 800, 810, 811…) é recusado (D-IB144). Esta função é a visão da FONTE (a IT lida na carga) — a decisão do faturamento
 * vem da peça `@shared/ibscbs-classification`, que lê o catálogo central já gravado; as duas usam o mesmo critério.
 */
export const REGULAR_SUPPORTED_CSTS: readonly string[] = ['000', '200']

/**
 * Códigos da fonte que o regular aceitaria no modelo 55 na data: a linha vigente de início mais recente (D-IB59), com presença
 * no 55, sem exigir tributação regular (`gTribRegular`) e de CST 000 ou 200.
 */
export function regularAcceptedCodes(
  classifications: readonly ClassificationRecord[], date: string,
  /** Linha que a carga NÃO grava com presença (não confirmada pela Calculadora ou bloqueada no 55): vale como sem o modelo 55. */
  lacksPresence: (c: ClassificationRecord) => boolean = () => false,
): Set<string> {
  const latest = new Map<string, ClassificationRecord>()
  for (const c of classifications) {
    if (c.validFrom > date || (c.validUntil !== null && c.validUntil < date)) continue
    const have = latest.get(c.code)
    if (!have || c.validFrom > have.validFrom) latest.set(c.code, c)
  }
  const accepted = new Set<string>()
  for (const c of latest.values()) {
    if (c.models.includes('55') && !lacksPresence(c) && !c.requiresRegularTaxation && REGULAR_SUPPORTED_CSTS.includes(c.cst)) accepted.add(c.code)
  }
  return accepted
}
