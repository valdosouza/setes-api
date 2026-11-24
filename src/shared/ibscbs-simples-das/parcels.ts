import { calcMerchandiseValue } from '@shared/tax-rule'

/**
 * As parcelas oficiais do item de mercadoria em centavos inteiros — PURA (sem banco): a MESMA leitura serve à fórmula do vNF
 * (`billing.total.ts`, `merchandiseTotalsOf`) e à base do Simples no DAS (`@shared/ibscbs-simples-das`, IBS.E9.P5).
 *  - `vProd` = unitário × quantidade em 2 casas; `vDesc` = `vProd` − valor líquido do item (assim `vProd − vDesc` é EXATAMENTE o
 *    líquido que o faturamento usa, com qualquer número de casas no unitário); `vFrete`/`vOutro` = as cotas do item no rateio.
 */
export interface SimplesItemParcels {
  unitValue:     number
  quantity:      number
  /** Valor líquido do item (unitário × quantidade − desconto). */
  merchandiseValue: number
  freightShare:  number
  expensesShare: number
}

const cents = (value: number): number => Math.round(value * 100)

export function merchandiseParcelsOf(p: SimplesItemParcels): { vProd: number; vDesc: number; vFrete: number; vOutro: number } {
  const vProd = cents(calcMerchandiseValue(p.unitValue, p.quantity, 0))
  return { vProd, vDesc: vProd - cents(p.merchandiseValue), vFrete: cents(p.freightShare), vOutro: cents(p.expensesShare) }
}
