import { merchandiseInvoiceTotal, MerchandiseTotalError, MerchandiseTotalsCents } from 'fiscal-api/merchandise-total'
import { HttpError } from '@shared/errors/http-error'
import { calcMerchandiseValue } from '@shared/tax-rule'
import type { ComputedItem } from './billing.repository'

const cents = (value: number): number => Math.round(value * 100)

/**
 * As parcelas da fórmula oficial do vNF (W16-10 — RF-NFE-28) somadas dos itens de MERCADORIA do faturamento, em centavos inteiros
 * (cada parcela vira centavo ANTES de somar ou subtrair — nunca ponto flutuante).
 *  - `vProd` = unitário × quantidade, em 2 casas, por item; `vDesc` = `vProd` − valor líquido do item. Assim `vProd − vDesc` é
 *    EXATAMENTE o valor líquido que o faturamento já usa (imposto, rateio, financeiro), com qualquer número de casas no unitário.
 *  - `vFrete`/`vOutro` = as cotas do item no rateio; `vST`, `vFCPST`, `vIPI` = o que o motor calculou.
 *  - Zero por construção: seguro (o faturamento não tem), desonerado (D-NE225: o motor não calcula), monofásico, IPI devolvido,
 *    imposto de importação (o faturamento não entrega `ii` ao motor), PIS/COFINS-ST e `vServ` — na web o serviço da nota conjugada
 *    sai em NFS-e própria, então a NF-e 55 não tem item de serviço. Veículo novo: fora.
 * Item de serviço não entra (nem a cota de frete dele).
 */
export function merchandiseTotalsOf(items: readonly ComputedItem[]): MerchandiseTotalsCents {
  const t = { vProd: 0, vDesc: 0, vST: 0, vFCPST: 0, vFrete: 0, vOutro: 0, vIPI: 0 }
  for (const ci of items) {
    if (ci.item.productKind === 'S') continue
    const vProd = cents(calcMerchandiseValue(ci.item.unitValue, ci.item.quantity, 0))
    const part = {
      vProd, vDesc: vProd - cents(ci.merchandiseValue), vFrete: cents(ci.freightShare), vOutro: cents(ci.expensesShare),
      vST: cents(ci.taxes.icms?.valueSt ?? 0), vFCPST: cents(ci.taxes.fcpSt?.value ?? 0), vIPI: cents(ci.taxes.ipi?.value ?? 0),
    }
    // A recusa é POR ITEM: somada, a parcela negativa de um item (ex.: ST negativa do CSOSN) sumiria atrás da positiva de outro
    // e a nota sairia com total errado em silêncio (gate adversarial do NFE.E1.P1).
    for (const [field, value] of Object.entries(part)) {
      if (value < 0) {
        throw new HttpError(422, 'Total da nota de mercadoria inválido pela fórmula oficial — confira os valores dos itens',
          [{ field: `item.${ci.item.id}`, message: `Parcela ${field} negativa no item ${ci.item.id}` }], 'BILLING_TOTAL_INVALID')
      }
    }
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += part[k]
  }
  return {
    ...t, vSeg: 0, vICMSDesonDeducted: 0, vICMSMonoReten: 0, vII: 0, vIPIDevol: 0, vServ: 0,
    vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
  }
}

/**
 * D-NE215/D-NE27: o vNF do ramo de mercadoria (`tb_invoice_merchandise.total_value`) é CUNHADO pela peça do núcleo
 * (`fiscal-api/merchandise-total`), a mesma que a nfe-api usa para conferir na tolerância zero. `null` = nota sem mercadoria.
 * Parcela negativa de QUALQUER item (ex.: ST negativa do CSOSN — recusa por item, em `merchandiseTotalsOf`) ou data fora da
 * vigência da fórmula = 422 `BILLING_TOTAL_INVALID` com o campo — nunca 500, nunca total errado em silêncio.
 */
export function merchandiseInvoiceTotalOf(items: readonly ComputedItem[], dtEmission: string): number | null {
  if (!items.some(ci => ci.item.productKind !== 'S')) return null
  try {
    return merchandiseInvoiceTotal(merchandiseTotalsOf(items), dtEmission).cents / 100
  } catch (err) {
    if (err instanceof MerchandiseTotalError) {
      throw new HttpError(422, 'Total da nota de mercadoria inválido pela fórmula oficial — confira os valores dos itens',
        [{ field: `total.${err.field}`, message: err.message }], 'BILLING_TOTAL_INVALID')
    }
    throw err
  }
}
