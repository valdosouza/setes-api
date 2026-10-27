import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { sourceKindOf, SourceKind } from '@shared/catalog-owner'

/**
 * Consultas dos fatos derivados de sessão (decisão 17). tb_salesman vive no
 * schema do cliente (sql/03) com PK (id, tb_institution_id).
 */

/** "É vendedor" (decisão 15; refino D3 da Onda 2 — 2026-08-03): registro
 *  VIVO e ATIVO em tb_salesman. O cadastro de salesmen dá controle do
 *  `active` (DDL default 'N'), então vendedor desativado deixa de ter o
 *  contexto/carteira de vendedor. */
export async function existsSalesman(
  schemaName: string, institutionId: number, userId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_salesman
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' AND active = 'S'`,
    [userId, institutionId]
  )
  return rows.length > 0
}

/** D-PR47 (Rodada 7 de produtos): a ORIGEM DOS CADASTROS do estabelecimento — a peça `@shared/catalog-owner` é a fonte (hoje a
 *  institution; com `@shared/group`, a fundadora). Vive aqui para o contexto de sessão ter UM repositório (e UM ponto de mock). */
export async function readSourceKind(institutionId: number): Promise<SourceKind | null> {
  return sourceKindOf(institutionId)
}
