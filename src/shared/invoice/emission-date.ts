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
 * D-IB101 + D-IB103 (Valdo 2026-11-01 — prompt_fase_ibs_cbs.md §14.4/§14.6): a ÚLTIMA data de emissão de nota VIVA emitida pelo **ERP web**
 * = a fronteira do que a opção de apuração do IBS/CBS pode mudar ("o passado já lido por uma nota"). Nota do ERP web = nasceu pelo escritor
 * único `issueInvoice` (que LÊ a opção) — tem evento E em `tb_invoice_event` (qualquer modelo; a autorizada cancelada segue viva — D3/D4).
 * NÃO contam (D-IB103): as notas do **ERP Desktop** que chegam pelo sincronizador (sem evento E — nunca leram a opção do ERP web; uma data
 * digitada errado no desktop/PDV travava a opção sem saída) e as COMPRAS de terceiros. O campo `issuer` não separa (o sincronizador grava
 * `issuer` = cliente) — o critério é o evento E.
 * Leitura CONSISTENTE: quem decide chama DEPOIS de tomar a trava que serializa com o faturamento (o retrato nasce depois da espera).
 * null = nenhuma nota do ERP web. **Lida a partir do FATO que a define** (gate do delta, ADV-D103-01): varredura DESCENDENTE pelos eventos
 * E no índice `idx_invoice_event_issue` (076) que para na 1ª nota VIVA — O(1) linhas lidas; filtrar as notas pela existência do evento
 * materializava todos os eventos e varria as notas do ERP Desktop mais novas (1,3–1,6 s sob a trava com 300 mil notas). Devolve a data do
 * EVENTO E (`dt_record` — o `issueInvoice` grava a data de emissão, D-IB64): a data que a nota do ERP web LEU; o cabeçalho reescrito na
 * mesma PK pelo sincronizador (id do ERP Desktop alcançando o da web — ADV-D103-02) não move a fronteira.
 */
export async function lastErpWebEmissionDate(
  q: NonNullable<Parameters<typeof todayFor>[2]>, schemaName: string, institutionId: number,
): Promise<string | null> {
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(e.dt_record, '%Y-%m-%d') AS last
       FROM ?? e STRAIGHT_JOIN ?? i
         ON i.id = e.tb_invoice_id AND i.tb_institution_id = e.tb_institution_id AND i.terminal = e.terminal AND i.deleted = 'N'
      WHERE e.tb_institution_id = ? AND e.kind = 'E' AND e.deleted = 'N'
      ORDER BY e.dt_record DESC LIMIT 1`,
    [`${schemaName}.tb_invoice_event`, `${schemaName}.tb_invoice`, institutionId])
  const last = (rows as any[])[0]?.last
  return last == null ? null : String(last)
}
