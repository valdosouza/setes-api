import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'
import { lockInstitutionCounters } from '@shared/db/counters'
import { pathSegment } from '@shared/tree-path'

/**
 * A NATUREZA da categoria (`tb_category.kind` — árvore P de produtos × S de serviços) para quem a CONSOME fora da tela Categorias
 * (cadastro de produtos, Rodada 6 — Q-PR38' (a) + Q-PR49 (a), Valdo 2026-10-18; Rodada 7 — D-PR47/D-PR48, 2026-10-20;
 * `Infra-IA/prompts/prompt_modulo_products.md`).
 *
 * Fato que decide: o legado não marca categoria de serviço — toda categoria sincronizada nasce 'P' (grupo do sync,
 * `setes-sync/verificacao-comissao-margem-mercadoria.md` §8) — e o estabelecimento cujo catálogo é da WEB (origem dos cadastros W ou P —
 * D-PR47) recebe "Produtos" (P) e "Serviços" (S): pela migration 072 (os que já existem), pelo onboarding (os que nascem W/P) e pelo ato
 * "encerrar a transição" (o L que vira W ou P — D-PR48). A regra do serviço é pelo FATO, nunca pelo modo: o estabelecimento que TEM
 * categoria S viva usa só as S; o que não tem (o do legado, até ele separar — D-SY11) usa as P.
 */

export type CategoryKind = 'P' | 'S'

/** Descrições das categorias padrão — as MESMAS da migration 072 (o SQL não importa o TS: mudou aqui, muda lá). */
export const DEFAULT_CATEGORY_DESCRIPTION: Record<CategoryKind, string> = { P: 'Produtos', S: 'Serviços' }

/**
 * Predicado ÚNICO "a categoria serve ao SERVIÇO" (Q-PR49 (a)): kind S; ou QUALQUER categoria (P, e a de kind NULL vinda de antes da árvore
 * P/S) quando o estabelecimento da linha não tem NENHUMA categoria S VIVA — viva = não excluída E ativa (`LIVE_SERVICE_CATEGORY_SQL`; uma S
 * só inativa não esconde as outras — gate adversarial R6). Correlacionado pelo alias (sem placeholder) — o lookup do serviço e a validação
 * do save usam o MESMO texto (catálogo servido = catálogo aceito).
 */
export function serviceCategorySql(schemaName: string, alias = 'c'): string {
  const s = assertSchema(schemaName)
  return `(${alias}.kind = 'S' OR NOT EXISTS (
            SELECT 1 FROM \`${s}\`.tb_category sk
             WHERE sk.tb_institution_id = ${alias}.tb_institution_id AND ${LIVE_SERVICE_CATEGORY_SQL('sk')}))`
}

/** "Categoria de serviço VIVA" = kind S, não excluída e ativa — a MESMA condição no predicado do serviço, no ato de desligar e na 072. */
export const LIVE_SERVICE_CATEGORY_SQL = (alias: string) => `${alias}.kind = 'S' AND ${alias}.deleted = 'N' AND ${alias}.active = 'S'`

/**
 * Cria a categoria padrão do kind (`DEFAULT_CATEGORY_DESCRIPTION`) quando o estabelecimento não tem NENHUMA viva (não excluída e ativa)
 * daquele kind — peça do onboarding W/P e do ato "encerrar a transição" (D-PR48); a migration 072 faz o mesmo em SQL para os que já
 * existem. Raiz, `posit_level` = o próprio id em 3 dígitos (`@shared/tree-path`), id MAX+1 da institution contando as excluídas (o id
 * nunca volta com outro significado).
 * Protocolo de trava: a institution (PADROES §9 regra 7) e a faixa das categorias dela (`FOR UPDATE` — o mesmo do módulo `categories`,
 * que cunha por MAX+1 travante); pode ser o 1º statement da transação. Devolve o id criado, ou null se já havia uma viva.
 */
export async function ensureDefaultCategory(
  conn: PoolConnection, schemaName: string, institutionId: number, kind: CategoryKind
): Promise<number | null> {
  const s = assertSchema(schemaName)
  await lockInstitutionCounters(conn, institutionId)
  // viva = não excluída E ativa (o mesmo do predicado do serviço e da 072)
  const [live] = await conn.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_category
      WHERE tb_institution_id = ? AND kind = ? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE`,
    [institutionId, kind])
  if ((live as any[]).length > 0) return null
  const [[{ nextId }]] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_category WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]) as any
  const id = Number(nextId)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_category (id, tb_institution_id, description, posit_level, kind, active, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 'S', NOW(), NOW(), 'N')`,
    [id, institutionId, DEFAULT_CATEGORY_DESCRIPTION[kind], pathSegment(id), kind])
  return id
}

/** As DUAS categorias padrão de um catálogo da web ("Produtos" P e "Serviços" S) — o que falta nasce, o que existe vivo fica.
 *  Chamada pelo onboarding (origem W/P) e pelo ato "encerrar a transição" (D-PR48). Devolve o id criado por kind (null = já havia). */
export async function ensureDefaultCategories(
  conn: PoolConnection, schemaName: string, institutionId: number
): Promise<Record<CategoryKind, number | null>> {
  return {
    P: await ensureDefaultCategory(conn, schemaName, institutionId, 'P'),
    S: await ensureDefaultCategory(conn, schemaName, institutionId, 'S'),
  }
}
