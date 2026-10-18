import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { lockInstitutionCounters } from '@shared/db/counters'
import { assertSchema } from '@shared/db/schema'
import { assertNoActiveSyncKey } from '@shared/sync-key'

/**
 * Peça TÉCNICA do espaço de chaves de `tb_product` (cadastro de produtos — D-PR2/D-PR7/A-PR1; prompt_modulo_products.md §3/§16.3):
 * o espaço de ids é da TABELA (serviço e mercadoria dividem o mesmo `tb_product`), o conteúdo é do CAMINHO — esta peça nunca faz
 * INSERT/UPDATE da linha (a D5 do serviço segue intacta: cada módulo escreve o seu kind).
 *
 * PROTOCOLO DE TRAVA (regra 7 do PADROES §9 + a regra 4 do §12):
 *  - CRIAR: `allocateProductId` é o 1º statement da transação — trava a institution ANTES de qualquer leitura (o snapshot do
 *    REPEATABLE READ nasce na 1ª leitura consistente, DEPOIS do lock: o MAX vê todo criador que já comitou) e lê o MAX SEM FOR UPDATE.
 *    Sem next-key lock nas linhas de produto, não há ciclo com o faturamento (que trava linhas de produto e DEPOIS a institution,
 *    no `nextSettledCode`).
 *  - EDITAR: só quem MUDA o código toma o lock da institution (`lockForIdentifierChange`) — depois da trava da PRÓPRIA linha e antes da
 *    1ª leitura consistente; mesma ordem do faturamento (produto → institution).
 *  - A unicidade do código (`assertIdentifierFree`) só roda quando o código NASCE ou MUDA (A-PR1 — produto do legado com duplicidade
 *    segue editável nos outros campos) e EXIGE o lock acima já tomado.
 *
 * `groupInstitutionId`: a chave do catálogo (D-PR24 regra 4, frente do grupo §11) — hoje = a institution da sessão.
 */

/** Trava a institution (1º lock da transação) e cunha o próximo id de `tb_product`. Chame ANTES de qualquer outra leitura. Depois da
 *  trava, reconfere a chave do sincronizador (`assertNoActiveSyncKey` — o espaço de id é do legado quando ela está ativa; Rodada 6). */
export async function allocateProductId(
  conn: PoolConnection, schemaName: string, groupInstitutionId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  await lockInstitutionCounters(conn, groupInstitutionId)
  await assertNoActiveSyncKey(conn, groupInstitutionId)
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_product WHERE tb_institution_id = ?`,
    [groupInstitutionId]
  )
  return Number(rows[0].nextId)
}

/** Edição que MUDA o código do produto: serializa com criadores e com outras trocas de código (ordem produto → institution). */
export async function lockForIdentifierChange(conn: PoolConnection, groupInstitutionId: number): Promise<void> {
  await lockInstitutionCounters(conn, groupInstitutionId)
}

/**
 * D-PR7: código ÚNICO por institution entre P/M/S vivos. 409 `PRODUCT_IDENTIFIER_TAKEN` com o campo `identifier` e o id do produto
 * que já o tem (`fields[1] = { field: 'id', message: <id> }` — molde do DUP_ROLE dos papéis). Exige o lock da institution já tomado.
 */
export async function assertIdentifierFree(
  conn: PoolConnection, schemaName: string, groupInstitutionId: number, identifier: string, exceptId: number | null,
  opts: { automatic?: boolean } = {}
): Promise<void> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_product
      WHERE tb_institution_id = ? AND identifier = ? AND deleted = 'N' ${exceptId != null ? 'AND id <> ?' : ''}
      ORDER BY id LIMIT 1`,
    exceptId != null ? [groupInstitutionId, identifier, exceptId] : [groupInstitutionId, identifier]
  )
  if (rows[0]) {
    const other = Number(rows[0].id)
    // código em BRANCO recebe o id (D1); se esse número já é o código DIGITADO de outro produto, a frase diz o que fazer (ADV-09)
    const message = opts.automatic
      ? `O código automático ${identifier} já é usado pelo produto ${other} — informe um código`
      : `Código já usado pelo produto ${other}`
    throw new HttpError(409, `O código ${identifier} já é do produto ${other}`,
      [{ field: 'identifier', message }, { field: 'id', message: String(other) }],
      ErrorCodes.PRODUCT_IDENTIFIER_TAKEN)
  }
}

/** D1 do serviço (vale para a mercadoria): código em branco recebe o próprio id. */
export function identifierOrId(identifier: string | null | undefined, id: number): string {
  return (identifier ?? '').trim() || String(id)
}
