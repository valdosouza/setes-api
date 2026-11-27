import pool from '@shared/db/connection'
import { IbscbsAliqLine, IbscbsTax, ibscbsAliqAt, ibscbsPpmFromPercent } from '@shared/ibscbs-calculation'

/**
 * PEÇA @shared/ibscbs-rate (setes-api:IBS.E9.P4; D-IB135, D-IB143): as ALÍQUOTAS NOMINAIS do IBS (UF e município) e da CBS por
 * vigência (`setes_central.tb_tax_ibscbs_rate`, script `sql/81_ibscbs_reduction_and_rate_ddl.sql`), na forma que o motor
 * `@shared/ibscbs-calculation` pede (`IbscbsAliqLine[]`, em milionésimos). Dona ÚNICA da leitura da tabela (cerca
 * `ibscbs-rate-fence.test.ts`).
 *
 * - **Da lei, nacional**: não é dado do estabelecimento. A jurisdição (UF ou município), se a alíquota passar a variar, nasce como
 *   exceção ao lado — nunca como coluna nova aqui.
 * - **Sem linha = sem alíquota**: a CBS de 2027 em diante não é constante nem está no seed (RF-CAL-02); o motor devolve `no-aliq` e
 *   o faturamento do regular recusa (A-IB143f). Nada é inventado nesta peça.
 * - A PK (`tax`, `valid_from`) impede duas linhas do mesmo tributo com o MESMO início: o `AMBIGUOUS_ALIQ_LINE` do motor não acontece.
 *   Faixas que se sobrepõem com inícios diferentes passam, e o motor usa a de início mais recente (RF-BC-11) — quem cadastra a tabela
 *   (script no central, feito pelo Valdo) encerra a faixa anterior.
 * - O pool devolve DECIMAL como número (`decimalNumbers`): a leitura pede o texto exato do banco (`CAST … AS CHAR`) e só assim passa
 *   para milionésimos (`ibscbsPpmFromPercent` só aceita texto) — nunca por ponto flutuante.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

const TAX_LABEL: Readonly<Record<IbscbsTax, string>> = { IBS_UF: 'IBS da UF', IBS_MUN: 'IBS do município', CBS: 'CBS' }

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Avisos de PRONTIDÃO do regime regular (A-IB143f): tributo sem alíquota vigente HOJE (todo faturamento do CRT 3 recusa já) ou que deixa
 * de ter vigente dentro do horizonte (a CBS de 2027 não tem linha até a legislação fixar). Não derruba o boot: o dado é do Valdo.
 */
export function ibscbsRateAlerts(table: readonly IbscbsAliqLine[], today: string, horizonDays = 45): string[] {
  const alerts: string[] = []
  const limit = addDays(today, horizonDays)
  for (const tax of ['IBS_UF', 'IBS_MUN', 'CBS'] as const) {
    if (ibscbsAliqAt(table, tax, today) === null) {
      alerts.push(`sem alíquota de ${TAX_LABEL[tax]} vigente hoje (${today}): o faturamento do regime regular recusa`)
    } else if (ibscbsAliqAt(table, tax, limit) === null) {
      alerts.push(`a alíquota de ${TAX_LABEL[tax]} deixa de ter linha vigente até ${limit}: cadastre a próxima faixa no central antes disso`)
    }
  }
  return alerts
}

const TAX_OF: Readonly<Record<string, IbscbsTax>> = { U: 'IBS_UF', M: 'IBS_MUN', C: 'CBS' }

const dateStr = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

/**
 * A tabela de alíquotas VIVA, pronta para `ibscbsAliqAt` (lida uma vez por faturamento, antes da transação). Linha com tributo
 * fora de U, M e C ou percentual que não é texto de 0 a 100 é erro de dado e SOBE — nunca vira "sem alíquota" em silêncio.
 */
export async function loadIbscbsAliqTable(q: Queryable = pool as any, central = 'setes_central'): Promise<IbscbsAliqLine[]> {
  if (!/^[a-z0-9_]+$/.test(central)) throw new Error(`schema central inválido: ${central}`)
  const [rows] = await q.query(
    `SELECT tax, valid_from AS validFrom, valid_until AS validUntil, CAST(rate AS CHAR) AS rate
       FROM ${central}.tb_tax_ibscbs_rate
      WHERE deleted = 'N'
      ORDER BY tax, valid_from`)
  return (rows as any[]).map((r): IbscbsAliqLine => {
    const tax = TAX_OF[String(r.tax)]
    if (!tax) throw new Error(`tb_tax_ibscbs_rate: tributo "${String(r.tax)}" fora de U, M e C`)
    return { tax, validFrom: dateStr(r.validFrom) ?? '', validUntil: dateStr(r.validUntil), ppm: ibscbsPpmFromPercent(String(r.rate)) }
  })
}
