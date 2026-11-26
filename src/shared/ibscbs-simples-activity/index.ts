import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * PEÇA @shared/ibscbs-simples-activity (setes-api:IBS.E9.P5; D-IB139, RF-SN-16): a ATIVIDADE do Simples em que a mercadoria se
 * enquadra — o `cAtivSN` (I17d, 2 caracteres) da NF-e de 2027. Dois lugares a guardam, o mesmo valor: o PADRÃO do estabelecimento
 * (`tb_entity_tax.simples_activity`, a linha do próprio emitente) e a EXCEÇÃO opcional da mercadoria
 * (`tb_merchandise.simples_activity`, NULL = herda). O item da nota usa a da mercadoria, senão a do estabelecimento, senão 01
 * (A-IB138b: o padrão do ERP Desktop, D-EM29, que o guarda na regra de tributação — divergência registrada na MATRIZ).
 *
 * Os códigos aceitos são 01, 02, 03 e 04 (RF-SN-16): 01 revenda e industrializados (Anexo I) · 02 demais bens sem ICMS (Anexo I) ·
 * 03 e 04 Zona Franca de Manaus (Anexo II). A 90 (não tributável) fica FORA (A-IB138d): a NT não diz se leva `gTribSN` nem com que
 * valor — não achado; quem digitar 90 recebe 400 com o motivo. O banco guarda o mesmo domínio por CHECK binário (migration 084).
 */

export const SIMPLES_ACTIVITIES = Object.freeze(['01', '02', '03', '04'] as const)
export type SimplesActivity = typeof SIMPLES_ACTIVITIES[number]

/** A atividade que vale quando nem a mercadoria nem o estabelecimento disseram (A-IB138b). */
export const SIMPLES_ACTIVITY_DEFAULT: SimplesActivity = '01'

export const isSimplesActivity = (value: unknown): value is SimplesActivity =>
  typeof value === 'string' && (SIMPLES_ACTIVITIES as readonly string[]).includes(value)

/** Recusa (400) o código fora do domínio; `null` e `undefined` passam (= sem atividade própria). */
export function assertSimplesActivity(value: unknown, field = 'simplesActivity'): void {
  if (value === null || value === undefined) return
  if (isSimplesActivity(value)) return
  const detail = value === '90'
    ? 'A atividade 90 (não tributável) não é aceita ainda: a NT não diz como declará-la'
    : 'Use 01, 02, 03 ou 04'
  throw new HttpError(400, 'Atividade do Simples (cAtivSN) inválida', [{ field, message: detail }],
    ErrorCodes.IBSCBS_SIMPLES_ACTIVITY_INVALID)
}

/**
 * A atividade do item: a da mercadoria, senão a do estabelecimento, senão 01. Valor gravado fora do domínio (só com o CHECK da 084
 * ausente, que o boot exige) falha ALTO — nunca vira 01 em silêncio, que declararia a atividade errada na nota.
 */
export function resolveSimplesActivity(
  merchandiseActivity: string | null | undefined, establishmentActivity: string | null | undefined,
): SimplesActivity {
  const chosen = merchandiseActivity ?? establishmentActivity ?? SIMPLES_ACTIVITY_DEFAULT
  if (!isSimplesActivity(chosen)) {
    throw new Error(`Atividade do Simples gravada fora do domínio (${JSON.stringify(chosen)}) — confira a migration 084`)
  }
  return chosen
}
