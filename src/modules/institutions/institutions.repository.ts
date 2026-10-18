import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { entityRoleSearchCriteria, roleStatusSearchCriteria, saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { SETES_INSTITUTION_ID, SETES_SCHEMA } from '@shared/auth/roles'
import { assertSchema } from '@shared/db/schema'
import { lockInstitutionCounters } from '@shared/db/counters'
import { WebBornRows, webBornSince } from '@shared/sync-key'
import { ensureDefaultCategory } from '@shared/category-kind'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull, SyncApiKeyRow,
} from './institutions.interface'

/**
 * Repositório do CONCRETO Institution — CONSUMIDOR da cadeia de entidade
 * fiscal compartilhada (@shared/entity/entity.repository — skill
 * cadastro-entidade-fiscal.md). Responsabilidades daqui:
 * abrir/fechar a TRANSAÇÃO da cascade, chamar os helpers da cadeia e
 * cuidar da tabela própria (tb_institution) + feature flags do onboarding.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/**
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — D-BA2/D-BA3, Onda 2 §12):
 * lista branca dos critérios desta lista. Vive AQUI (D-BA12) porque as expressões
 * dependem dos aliases da query base. O operador é da peça @shared/list (D-BA4).
 */
export const INSTITUTION_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  ...entityRoleSearchCriteria('institutions', 'i'),
  { key: 'schemaName', kind: 'text', labelKey: 'search.institutions.schemaName', expr: 'i.schema_name' },
  ...roleStatusSearchCriteria('institutions', 'i'),
]

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por i.id (D8) mantém o OFFSET estável.
 */
export async function listInstitutions(query: ListQuery): Promise<PagedRows<InstitutionListRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR i.schema_name LIKE ?)${query.criteria.sql}`
  const params = [like, like, like, like,
                  ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            i.schema_name  AS schemaName,
            i.active
     ${where}
     ORDER BY e.nick_trade, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Objeto COMPLETO: cadeia compartilhada (shared/entity) + tb_institution. */
export async function getInstitution(id: number): Promise<InstitutionFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName, active
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  return { ...chain, schemaName: rows[0].schemaName, active: rows[0].active }
}

/** schema_name é UNIQUE e nunca reaproveitado — verifica INCLUINDO deleted='S'. */
export async function schemaNameExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tb_institution WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}

/** schema do estabelecimento vivo (null = inexistente) — o ato de ligar/desligar o sincronizador escreve no schema dele. */
export async function getInstitutionSchema(id: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    "SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [id]
  )
  return rows[0]?.schemaName ?? null
}

export async function institutionExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [id]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_institution é daqui
// ---------------------------------------------------------------------

/**
 * POST: cadeia inteira em transação única (helpers do shared) + INSERT da
 * tb_institution. A institution nasce active='N' — quem ativa é a migração
 * do schema, DEPOIS do commit (DDL não tem rollback).
 */
export async function insertInstitutionCascade(
  input: InstitutionInput, schemaName: string, updatedBy: number | null = null
): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Fase 3 (decisões 1 e 9): a cadeia resolve reuso pelo documento.
    const { id } = await saveEntityFiscalChain(conn, null, input, updatedBy)

    // Papel duplicado (decisão 2): 409 com o id no payload — o app oferece
    // abrir em edição. Vale mesmo deleted='S' (schema nunca é reaproveitado).
    const [existing] = await conn.query<any[]>(
      'SELECT 1 FROM setes_central.tb_institution WHERE id = ? FOR UPDATE',
      [id]
    )
    if (existing.length > 0) {
      throw new HttpError(409,
        `Esta entidade já está cadastrada como estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }])
    }

    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, active, created_at, updated_at)
       VALUES (?, ?, 'N', NOW(), NOW())`,
      [id, schemaName]
    )

    // Decisão 13 da Fase 3 (Valdo, 2026-07-16): todo institution nasce também
    // CLIENTE DA SETES (tb_customer em setes_setes, institution 1) para a
    // administração do contrato — "clientes de verdade são os que não são a
    // própria Setes". Idempotente: se a entity já era cliente da Setes,
    // revive/mantém (não é papel duplicado — é o vínculo comercial esperado).
    await conn.query(
      `INSERT INTO ??
         (id, tb_institution_id, active, created_at, updated_at)
       VALUES (?, ?, 'S', NOW(), NOW())
       ON DUPLICATE KEY UPDATE deleted = 'N', active = 'S', updated_at = NOW()`,
      [`${SETES_SCHEMA}.tb_customer`, id, SETES_INSTITUTION_ID]
    )

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: mesma cascade em transação única. schema_name é IMUTÁVEL. */
export async function updateInstitutionCascade(
  id: number, input: InstitutionInput, updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    if (input.active !== undefined) {
      await conn.query(
        `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
        [input.active, id]
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function setInstitutionActive(id: number, active: 'S' | 'N'): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
    [active, id]
  )
}

/** Soft delete da institution — a cadeia entity permanece. */
export async function deleteInstitution(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Feature flags padrão do onboarding (gate técnico — decisão 17). Veio do
 * antigo admin.repository quando o cadastro absorveu o onboarding
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertDefaultFlags(institutionId: number): Promise<void> {
  // 'customers' liberado por padrão desde a Fase 3; 'collaborators' desde a
  // onda 2; 'salesmen'/'carriers' desde a Onda 2 salesman/carrier (gate
  // técnico — o comercial por tela continua em tb_institution_has_interface,
  // decisão 17).
  // 'modules' (menus do cliente) liberado por padrão desde 2026-08-04
  // (prompt_modulo_menus.md — a tela é do admin via adminGuard).
  // 'users' desde 2026-08-15 (A2): sem ele o admin do cliente toma 403 ao
  // gerenciar os próprios usuários — administração, não produto vendável.
  // 'state-tax-rates' desde 2026-08-20 (W2 Onda 2): catálogo MVA/FCP por
  // UF×NCM — gate técnico, sem tela no app ainda (Q22).
  // 'billing' desde 2026-08-20 (W2 Onda 3): faturamento de ordens.
  // 'cashier' desde 2026-08-22 (W3.2): abertura/fechamento de caixa.
  // 'orders' desde 2026-08-22: pedido de venda/conjugado.
  // 'order-returns' desde 2026-08-24: devolução de mercadoria (seed 39
  // cobre as institutions retroativas).
  // 'establishment' desde 2026-08-26: autoatendimento do admin sobre o
  // PRÓPRIO institution (seed 41 cobre as institutions retroativas).
  // 'services'/'price-lists' desde 2026-09-01 (prompt_modulo_services.md):
  // gate técnico — a liberação comercial é por interface (D3: só cliente
  // sem legado); seed 42 cobre as institutions retroativas.
  // 'merchandise' desde 2026-10-18 (prompt_modulo_products.md §16 — cadastro de produtos/mercadoria, onda 1): mesma regra da liberação
  // comercial (D-PR14); seed 66 cobre as institutions retroativas.
  const defaultModules = [
    'core', 'users', 'customers', 'collaborators', 'salesmen', 'carriers',
    'providers', 'categories', 'financial-plans', 'tax-rules',
    'state-tax-rates', 'billing',
    'payment-types', 'contracts', 'bank-accounts',
    'service-orders', 'settlements', 'modules', 'cashier', 'orders',
    'order-returns', 'establishment', 'services', 'price-lists',
    'service-tax-rules', 'settlement-rules', 'bank-slips',
    'bank-charge-agreements', 'checks', 'merchandise',
  ]
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM setes_central.tb_feature_flag FOR UPDATE'
    )
    let nextId = Number(rows[0].maxId)

    const now    = new Date()
    const values = defaultModules.map(mod => [++nextId, institutionId, mod, true, now, now])

    await conn.query(
      `INSERT INTO setes_central.tb_feature_flag
         (id, tb_institution_id, module_key, enabled, created_at, updated_at)
       VALUES ?`,
      [values]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Telas ESTRUTURAIS do cliente (decisão do Valdo, 2026-08-15 — A2): não são
 * produto vendável, são o mínimo para o admin se virar sozinho. Todo o resto
 * do catálogo continua venda explícita do Super (tela de Interfaces do
 * Estabelecimento). Sem isto o menu de um cliente novo nasce VAZIO — o
 * getMenus faz INNER JOIN com o contrato.
 *
 * Ids resolvidos por i18n_key, nunca literais (lição do seed 25).
 * Roda DEPOIS das migrations: a tabela vive no schema do cliente.
 */
export const STRUCTURAL_INTERFACE_KEYS = ['users', 'modules', 'interface-configs', 'establishment']

export async function grantStructuralInterfaces(
  schemaName: string, institutionId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_interface
      WHERE i18n_key IN (?) AND deleted = 'N'`,
    [STRUCTURAL_INTERFACE_KEYS]
  )
  if (rows.length === 0) return 0

  const now    = new Date()
  const values = rows.map((r: any) => [institutionId, r.id, 'S', now, now])
  await pool.query(
    `INSERT INTO \`${s}\`.tb_institution_has_interface
       (tb_institution_id, tb_interface_id, active, created_at, updated_at)
     VALUES ?
     ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
    [values]
  )
  return rows.length
}

// ---------------------------------------------------------------------
// Chave de sincronização (tb_sync_api_key — D12 da revisão do sincronizador)
// ---------------------------------------------------------------------

export async function getSyncApiKey(institutionId: number): Promise<SyncApiKeyRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT api_key AS apiKey, establishment_code AS establishmentCode, active
     FROM setes_central.tb_sync_api_key
     WHERE tb_institution_id = ? AND deleted = 'N'
     ORDER BY id
     LIMIT 1`,
    [institutionId]
  )
  return rows[0] ?? null
}

/** Desfecho do ato de ligar/desligar o sincronizador (D-PR43 + Rodada 6 de produtos). */
export type SyncKeySwitchOutcome =
  | { kind: 'missing' }
  | { kind: 'unchanged' }
  | { kind: 'switched'; defaultServiceCategoryId: number | null }
  | { kind: 'web-rows'; since: Date; rows: WebBornRows[] }

/**
 * Liga/desliga a chave VIVA do estabelecimento NUMA transação (D-PR43; Q-PR47 (a) e Q-PR49 (a) da Rodada 6) — nunca apaga (PADROES §3.1):
 *  - 1º statement: a trava da institution (PADROES §9 regra 7) — serializa com quem cunha id de produto e com outro ato de ligar/desligar;
 *    depois as chaves vivas `FOR UPDATE` (locking read: o snapshot do REPEATABLE READ ainda não nasceu).
 *  - estado já é o pedido → nada muda (o `updated_at` da chave desligada é o INSTANTE do desligamento que o religar confere — repetir o
 *    'N' não pode empurrá-lo para a frente e esconder o que a web criou no período).
 *  - DESLIGAR: o instante do desligamento é UM `NOW()` lido uma vez (T); cria "Serviços" (kind S) se não houver categoria S viva (peça
 *    `@shared/category-kind`) com `created_at` = T − 1 s, e grava a chave com `updated_at` = T — a categoria do próprio ato nunca conta
 *    como "nascida na web" no religar (que confere `>=` T).
 *  - RELIGAR: confere o que NASCEU nas tabelas do legado (`webBornSince`, leitura consistente depois das travas) desde o desligamento —
 *    havendo, desfaz e devolve as linhas (o serviço responde 409).
 * Sem `updated_at` (chave desligada por SQL manual), o instante é o `created_at` da chave; sem os dois, a época — o religar só passa se a
 * web nunca criou nada ali (falha fechado).
 */
export async function switchSyncApiKeyTx(
  institutionId: number, schemaName: string, active: 'S' | 'N'
): Promise<SyncKeySwitchOutcome> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockInstitutionCounters(conn, institutionId)
    const [keys] = await conn.query<any[]>(
      `SELECT id, active, created_at AS createdAt, updated_at AS updatedAt
         FROM setes_central.tb_sync_api_key
        WHERE tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [institutionId])
    if ((keys as any[]).length === 0) { await conn.rollback(); return { kind: 'missing' } }
    const toFlip = (keys as any[]).filter(k => k.active !== active)
    if (toFlip.length === 0) { await conn.rollback(); return { kind: 'unchanged' } }

    let defaultServiceCategoryId: number | null = null
    let at: Date | null = null
    if (active === 'N') {
      const [[{ now }]] = await conn.query<any[]>('SELECT NOW() AS now') as any
      at = new Date(now)
      defaultServiceCategoryId = await ensureDefaultCategory(conn, s, institutionId, 'S', new Date(at.getTime() - 1000))
    } else {
      const since = new Date(Math.min(...toFlip.map(k => {
        const at = k.updatedAt ?? k.createdAt
        return at ? new Date(at).getTime() : 0
      })))
      const rows = await webBornSince(conn, s, institutionId, since)
      if (rows.length > 0) { await conn.rollback(); return { kind: 'web-rows', since, rows } }
    }
    await conn.query(
      `UPDATE setes_central.tb_sync_api_key SET active = ?, updated_at = COALESCE(?, NOW())
        WHERE tb_institution_id = ? AND deleted = 'N' AND active <> ?`,
      [active, at, institutionId, active])
    await conn.commit()
    return { kind: 'switched', defaultServiceCategoryId }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Uma chave por estabelecimento; id sem auto_increment → MAX+1 na transação. */
export async function insertSyncApiKey(
  institutionId: number, apiKey: string, establishmentCode: string
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_sync_api_key FOR UPDATE'
    )
    await conn.query(
      `INSERT INTO setes_central.tb_sync_api_key
         (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'S', NOW(), NOW())`,
      [Number(rows[0].nextId), apiKey, institutionId, establishmentCode]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
