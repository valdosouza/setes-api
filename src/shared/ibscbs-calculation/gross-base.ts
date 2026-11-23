/**
 * O `S` do item: a soma que a UB16-10 da NT 2025.002 descrevia (RF-BC-03 — a regra foi removida pela NT 2026.008 e segue
 * como a definição de `S`). Com o IBS/CBS por fora, `vBC = S`; na conta por dentro, o `vBC` é tirado de `S`.
 *
 * Fora daqui de propósito (ficha do IBS.E9.P1, A-IB132e): ICMS diferido e ICMS-ST retido na base, e as exceções 1 e 2 da
 * UB16-10 (PIS/COFINS por substituição tributária). Diferente do ERP Desktop, soma `vServ` e subtrai `vICMSMono`, como a regra.
 */
import { MAX_CENTS, assertCents, assertKnownKeys, sumCents } from './arith'
import { IbscbsCalculationError, IbscbsGrossBaseComponents } from './types'

const PLUS = ['vProd', 'vServ', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS'] as const
const MINUS = ['vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'] as const
const KEYS: readonly string[] = [...PLUS, ...MINUS]

/**
 * Centavos. Cada componente é não negativo e não passa do teto; chave desconhecida (`vdesc`, `vIcms`) é erro, nunca um
 * componente ignorado. O RESULTADO pode ser negativo (desconto e tributos maiores que a soma) — `calcIbscbsItem` recusa
 * `S` negativo, e é quem chama que decide o que fazer com esse item.
 */
export function calcIbscbsGrossBase(components: IbscbsGrossBaseComponents): number {
  const given = assertKnownKeys(components, KEYS, 'components')
  const read = (key: string): number => {
    const raw = given[key]
    if (raw === undefined) return 0
    const value = assertCents(raw as number, key)
    if (value > MAX_CENTS) throw new IbscbsCalculationError('GROSS_BASE_ABOVE_LIMIT', `${key}: valor acima do limite do cálculo`)
    return value
  }
  return sumCents(PLUS.map(read), MINUS.map(read), 'S')
}
