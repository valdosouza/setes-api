import { todayFor } from '@shared/time-zone'

/**
 * A DATA DE EMISSÃO da nota — que é também a COMPETÊNCIA FISCAL da declaração IBS/CBS (`dCompet` — D-IB64: a data do faturamento,
 * nunca a competência do contrato) e a base dos vencimentos. DONO ÚNICO (gate socrático da IB-3, M2 → D-IB88, 2026-10-15): os dois
 * produtores do ramo de serviço (billing da venda e faturamento da OS) e a PRÉVIA (validate da venda, detalhe da OS aberta) perguntam aqui —
 * se a D-IB64 mudar (pendente com o contador), muda num lugar só e a prévia segue sendo "o que o faturamento faria". Cerca:
 * `__tests__/emission-date-fence.test.ts` (nenhum `todayFor` decide `dtEmission`/`baseDate`/`competenceDate` fora daqui).
 * Dentro de transação, a conexão dela (C1 — nunca 2ª conexão do pool); o relógio é o da operação (Q-TZ8/Q-TZ9).
 */
export function invoiceEmissionDateFor(
  schemaName: string, institutionId: number, conn?: Parameters<typeof todayFor>[2],
): Promise<string> {
  return todayFor(schemaName, institutionId, conn)
}

/**
 * D-IB101 (Valdo 2026-11-01 — prompt_fase_ibs_cbs.md §14.4): a ÚLTIMA data de emissão de nota VIVA do estabelecimento (qualquer terminal
 * e modelo; a autorizada cancelada segue viva — D3/D4) = a fronteira do que a opção de apuração do IBS/CBS pode mudar. Leitura
 * CONSISTENTE: quem decide chama DEPOIS de tomar a trava que serializa com o faturamento (o retrato da transação nasce depois da
 * espera). null = nenhuma nota. Índice próprio `idx_invoice_live_emission` (076): a MAX é "Select tables optimized away" — sem ele, a
 * leitura sob a trava parava o faturamento por segundos (gate do delta, ADV-D101-02).
 */
export async function lastLiveEmissionDate(
  q: NonNullable<Parameters<typeof todayFor>[2]>, schemaName: string, institutionId: number,
): Promise<string | null> {
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(MAX(dt_emission), '%Y-%m-%d') AS last FROM ?? WHERE tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_invoice`, institutionId])
  const last = (rows as any[])[0]?.last
  return last == null ? null : String(last)
}
