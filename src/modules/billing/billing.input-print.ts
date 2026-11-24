import { PoolConnection } from 'mysql2/promise'

/**
 * D-FAT1 (Valdo, 2026-11-22; desenho do `setes-api:NFE.E1.P1.T4`): a nota só grava cálculo CONFERIDO com o pedido travado.
 *
 * O faturamento lê o pedido e calcula o imposto FORA da transação (pelo pool); a trava do pedido só vem depois. Uma edição de
 * item confirmada nesse intervalo fazia a nota gravar o imposto e o total do item antigo, sem erro. Travar antes de ler exigiria
 * duas conexões por faturamento (esgota o pool) ou levaria as leituras para a conexão travada (quebra a invariante do saldo
 * devolvível). Então: o service tira a IMPRESSÃO do que o pedido entregou ao cálculo; a transação, logo depois do `FOR UPDATE` do
 * pedido, relê os mesmos dados NA conexão travada e compara. Diferente → `BillingInputChanged`, nada é gravado, e o service
 * refaz a leitura e o cálculo (nunca recusa na primeira: a opção "só recusar" foi descartada).
 *
 * O que entra: os itens vivos (id, kind, produto, quantidade, unitário, desconto), o vínculo de regra de cada um (regra, CFOP,
 * `set_financial`), o vínculo de regra de serviço e o frete e as despesas do pedido. O que NÃO entra, de propósito: dado de
 * CADASTRO (NCM, origem, regra em si — D-NE248: não se congela cadastro) e o destinatário do pedido.
 */
export interface BillingInputSource {
  items: ReadonlyArray<{ id: number; kind: string; productId: number; quantity: number; unitValue: number; discountValue: number; productKind: string }>
  links: ReadonlyArray<{ orderItemId: number; kind: string; taxRuleId: number; cfopId: string | null; setFinancial: string }>
  serviceLinks: ReadonlyArray<{ orderItemId: number; kind: string; serviceTaxRuleId: number }>
  freight: number
  expenses: number
}

const num = (v: unknown): string => String(Number(v ?? 0))

/** A impressão: texto estável (ordem das linhas não importa). Vínculo de item que não está vivo não conta — nem o de serviço em item que não é serviço. */
export function billingInputPrint(src: BillingInputSource): string {
  const live = new Set(src.items.map(i => `${Number(i.id)}|${i.kind}`))
  const service = new Set(src.items.filter(i => i.productKind === 'S').map(i => `${Number(i.id)}|${i.kind}`))
  const lines = [
    ...src.items.map(i => `I|${Number(i.id)}|${i.kind}|${Number(i.productId)}|${num(i.quantity)}|${num(i.unitValue)}|${num(i.discountValue)}`),
    ...src.links.filter(l => live.has(`${Number(l.orderItemId)}|${l.kind}`))
      .map(l => `L|${Number(l.orderItemId)}|${l.kind}|${Number(l.taxRuleId)}|${l.cfopId ?? ''}|${l.setFinancial ?? ''}`),
    ...src.serviceLinks.filter(l => service.has(`${Number(l.orderItemId)}|${l.kind}`))
      .map(l => `S|${Number(l.orderItemId)}|${l.kind}|${Number(l.serviceTaxRuleId)}`),
  ].sort()
  return [...lines, `F|${num(src.freight)}`, `E|${num(src.expenses)}`].join('\n')
}

/** O pedido mudou entre a leitura do faturamento e a trava: refazer leitura e cálculo (capturado só em `invoiceOrder`). */
export class BillingInputChanged extends Error {
  constructor(public readonly orderId: number) {
    super(`Pedido ${orderId} mudou durante o faturamento`)
    this.name = 'BillingInputChanged'
  }
}

/**
 * Relê, NA conexão que já segura o `FOR UPDATE` do pedido, o que o pedido entrega ao cálculo e compara com a impressão do service.
 * Toda leitura é TRAVANTE (não abre o retrato da transação — a invariante do saldo devolvível exige que as primeiras leituras não
 * travantes sejam as dela): itens, frete e despesas com trava compartilhada; os vínculos com `FOR UPDATE`, porque a transação os
 * atualiza em seguida (evita a promoção de trava contra um /validate concorrente).
 */
export async function assertBillingInputsUnchanged(
  conn: PoolConnection, s: string, institutionId: number, orderId: number, print: string,
): Promise<void> {
  const key = [orderId, institutionId]
  const [items] = await conn.query<any[]>(
    `SELECT i.id, i.kind, i.tb_product_id AS productId, i.quantity, i.unit_value AS unitValue,
            COALESCE(i.discount_value, 0) AS discountValue, p.kind AS productKind
       FROM \`${s}\`.tb_order_item i
       JOIN \`${s}\`.tb_product p ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
      WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N'
      LOCK IN SHARE MODE`, key)
  const [links] = await conn.query<any[]>(
    `SELECT tb_order_item_id AS orderItemId, kind, tb_tax_rule_id AS taxRuleId, tb_cfop_id AS cfopId, set_financial AS setFinancial
       FROM \`${s}\`.tb_order_item_tax_rule
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
      FOR UPDATE`, key)
  const [serviceLinks] = await conn.query<any[]>(
    `SELECT tb_order_item_id AS orderItemId, kind, tb_service_tax_rule_id AS serviceTaxRuleId
       FROM \`${s}\`.tb_order_item_service_tax_rule
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
      FOR UPDATE`, key)
  const [ship] = await conn.query<any[]>(
    `SELECT COALESCE(SUM(value), 0) AS freight FROM \`${s}\`.tb_order_shipping
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
      LOCK IN SHARE MODE`, key)
  const [tot] = await conn.query<any[]>(
    `SELECT COALESCE(expenses_value, 0) AS expenses FROM \`${s}\`.tb_order_totalizer
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
      LOCK IN SHARE MODE`, key)
  const now = billingInputPrint({
    items: (items as any[]).map(r => ({ ...r, productKind: String(r.productKind ?? 'P') })),
    links: links as any[], serviceLinks: serviceLinks as any[],
    freight: Number(ship[0]?.freight ?? 0), expenses: Number(tot[0]?.expenses ?? 0),
  })
  if (now !== print) throw new BillingInputChanged(orderId)
}
