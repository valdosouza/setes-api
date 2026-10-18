import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { z } from 'zod'
import { decimalField } from '@shared/validation'

/**
 * Peça da GRADE DE PREÇOS do produto (`tb_price` × `tb_price_list`) — executa a D4 do cadastro de serviços ("a peça de preço é
 * COMPARTILHADA produto × serviço desde já") no 2º consumidor, o cadastro de mercadorias (D-PR2; prompt_modulo_products.md §16.3).
 * Transaction-aware: grava na MESMA transação do produto. PRESENÇA = sincroniza: a tabela com preço é gravada (upsert), a tabela
 * sem preço (`priceTag` null) ou ausente da grade é soft-deletada.
 *
 * Comissão por produto (`aliq_kickback` — D-PR9, conferido no sync em 2026-10-17: é a COMISSÃO, a margem é `aliq_profit`): lida por
 * `@shared/commission` quando o vendedor comissiona por produto. `aliqKickback` AUSENTE (cliente antigo da API) = a coluna não é
 * tocada; `null` = sem comissão própria (cai na do vendedor).
 *
 * Escopo (PADROES_BANCO §12): tabela do GRUPO — `groupInstitutionId` é a chave do catálogo (hoje = a institution).
 */

export interface ProductPriceInput {
  priceListId:   number
  /** null = remover o preço desta tabela. */
  priceTag:      number | null
  /** % de comissão do produto nesta tabela; ausente = não mexe; null = sem comissão própria. */
  aliqKickback?: number | null
}

export interface ProductPriceRow {
  priceListId:          number
  priceListDescription: string | null
  priceTag:             number | null
  aliqKickback:         number | null
}

/**
 * Linha da grade no DTO — UMA forma para serviço e mercadoria. "O que valida é o que grava" (ADV-04 do gate da onda 1 de produtos):
 * `tb_price.price_tag` é DECIMAL(13,6) — acima de 9.999.999,999999 o servidor (sem modo estrito) GRAMPEARIA em silêncio; `aliq_kickback`
 * é DECIMAL(10,2) com domínio 0–100 %.
 */
export const productPriceInputDto = z.object({
  priceListId:  z.number().int().positive(),
  priceTag:     decimalField({ scale: 6, max: 9999999.999999 }).nullable(),
  // D-PR9: ausente = a coluna não é tocada (app antigo); null = sem comissão própria
  aliqKickback: decimalField({ scale: 2, max: 100 }).nullable().optional(),
})

type Executor = Pick<PoolConnection, 'query'>

/** Grade: TODAS as tabelas de preço vivas + o preço e a comissão atuais do produto (null = sem). */
export async function listProductPrices(
  schemaName: string, groupInstitutionId: number, productId: number, executor: Executor = pool as unknown as Executor
): Promise<ProductPriceRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await executor.query<any[]>(
    `SELECT l.id             AS priceListId,
            l.description    AS priceListDescription,
            pr.price_tag     AS priceTag,
            pr.aliq_kickback AS aliqKickback
       FROM \`${s}\`.tb_price_list l
       LEFT JOIN \`${s}\`.tb_price pr
         ON pr.tb_price_list_id = l.id
        AND pr.tb_institution_id = l.tb_institution_id
        AND pr.tb_product_id = ?
        AND pr.deleted = 'N'
      WHERE l.tb_institution_id = ? AND l.deleted = 'N'
      ORDER BY l.description, l.id`,
    [productId, groupInstitutionId]
  )
  return rows as ProductPriceRow[]
}

/** Toda tabela da grade existe e está viva — 400 com `fields[{ field: 'prices' }]` (molde do services). */
export async function assertPriceListsAlive(
  conn: PoolConnection, schemaName: string, groupInstitutionId: number, prices: readonly ProductPriceInput[]
): Promise<void> {
  const s = assertSchema(schemaName)
  for (const price of prices) {
    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${s}\`.tb_price_list WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [price.priceListId, groupInstitutionId])
    if (rows.length === 0) {
      throw new HttpError(400, 'Tabela de preço inexistente', [{ field: 'prices', message: 'Tabela de preço não encontrada' }])
    }
  }
}

/** Sincroniza a grade na transação do produto (presença = sincroniza). */
export async function syncProductPrices(
  conn: PoolConnection, schemaName: string, groupInstitutionId: number, productId: number,
  prices: readonly ProductPriceInput[]
): Promise<void> {
  const s = assertSchema(schemaName)
  const withValue = prices.filter(p => p.priceTag !== null)
  const keptIds = withValue.map(p => p.priceListId)

  await conn.query(
    `UPDATE \`${s}\`.tb_price
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_product_id = ?
        ${keptIds.length ? 'AND tb_price_list_id NOT IN (?)' : ''}`,
    keptIds.length ? [groupInstitutionId, productId, keptIds] : [groupInstitutionId, productId]
  )
  for (const price of withValue) {
    if (price.aliqKickback === undefined) {
      // "ausente = não mexe" vale para a linha VIVA; a linha que RENASCE (preço removido e devolvido) não herda a comissão da morta (gate
      // adversarial r2, ADV2-01 — molde "a revivida nunca herda"). A ORDEM importa: o MariaDB avalia as atribuições da esquerda para a
      // direita com os valores já atualizados — `aliq_kickback` lê o `deleted` ANTES de ele virar 'N'.
      await conn.query(
        `INSERT INTO \`${s}\`.tb_price
           (tb_institution_id, tb_price_list_id, tb_product_id, price_tag, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE price_tag = VALUES(price_tag),
                                 aliq_kickback = IF(deleted = 'S', NULL, aliq_kickback),
                                 deleted = 'N', updated_at = NOW()`,
        [groupInstitutionId, price.priceListId, productId, price.priceTag]
      )
    } else {
      await conn.query(
        `INSERT INTO \`${s}\`.tb_price
           (tb_institution_id, tb_price_list_id, tb_product_id, price_tag, aliq_kickback, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE price_tag = VALUES(price_tag), aliq_kickback = VALUES(aliq_kickback),
                                 deleted = 'N', updated_at = NOW()`,
        [groupInstitutionId, price.priceListId, productId, price.priceTag, price.aliqKickback]
      )
    }
  }
}
