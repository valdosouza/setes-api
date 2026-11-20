import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { entityRoleSearchCriteria, roleStatusSearchCriteria, saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { SETES_INSTITUTION_ID, SETES_SCHEMA } from '@shared/auth/roles'
import { assertSchema } from '@shared/db/schema'
import { lockInstitutionCounters } from '@shared/db/counters'
import { ensureDefaultCategories, CategoryKind } from '@shared/category-kind'
import { SourceKind, isSourceKind, sourceKindHasSync } from '@shared/catalog-owner'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull, InstitutionFact, SyncApiKeyRow,
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
            i.active,
            i.source_kind  AS sourceKind
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
    // o nome do autor do ato (D-PR58, Valdo 2026-11-20 — a tela mostra autor e motivo ao lado da data): `nick_trade` não vazio, senão
    // `name_company` (a variante com NULLIF do users.repository; tb_user herda a PK de tb_entity); sem filtro de `deleted`: fato histórico
    `SELECT i.schema_name AS schemaName, i.active, i.source_kind AS sourceKind, i.transition_ended_at AS transitionEndedAt,
            i.transition_ended_by AS transitionEndedBy, i.transition_end_reason AS transitionEndReason,
            COALESCE(NULLIF(ea.nick_trade, ''), ea.name_company) AS transitionEndedByName
     FROM setes_central.tb_institution i
     LEFT JOIN setes_central.tb_entity ea ON ea.id = i.transition_ended_by
     WHERE i.id = ? AND i.deleted = 'N'`,
    [id]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  return {
    ...chain, schemaName: rows[0].schemaName, active: rows[0].active,
    sourceKind: rows[0].sourceKind, transitionEndedAt: toIso(rows[0].transitionEndedAt),
    transitionEndedBy: rows[0].transitionEndedBy == null ? null : Number(rows[0].transitionEndedBy),
    transitionEndReason: rows[0].transitionEndReason ?? null,
    transitionEndedByName: rows[0].transitionEndedBy == null ? null : (rows[0].transitionEndedByName ?? null),
  }
}

/** O FATO do estabelecimento sem a cadeia (D-PR47): schema + origem dos cadastros + instante do encerramento. null = inexistente. */
export async function getInstitutionFact(id: number): Promise<InstitutionFact | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt
       FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'`,
    [id])
  if (!rows[0]) return null
  return { schemaName: rows[0].schemaName, sourceKind: rows[0].sourceKind, transitionEndedAt: toIso(rows[0].transitionEndedAt) }
}

const toIso = (v: unknown): string | null => v == null ? null : (v instanceof Date ? v.toISOString() : String(v))

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

    // D-PR47: a origem dos cadastros é DECLARADA no cadastro (o DTO exige; aqui é o cinto — a coluna é NOT NULL sem default)
    if (!isSourceKind(input.sourceKind)) {
      throw new HttpError(400, 'Informe a origem dos cadastros do estabelecimento (W, L ou P)',
        [{ field: 'sourceKind', message: 'W = nativo web · L = transição do desktop legado · P = PDV' }])
    }
    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, source_kind, active, created_at, updated_at)
       VALUES (?, ?, ?, 'N', NOW(), NOW())`,
      [id, schemaName, input.sourceKind]
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

    // D-PR47: a origem dos cadastros é IMUTÁVEL pela edição — só o ato "encerrar a transição" a muda (L → W/P). Igual ao gravado passa;
    // diferente recusa (nunca descarte silencioso). Leitura travante: a linha é a que o ato trava.
    if (input.sourceKind !== undefined) {
      const [cur] = await conn.query<any[]>(
        `SELECT source_kind AS sourceKind FROM setes_central.tb_institution WHERE id = ? FOR UPDATE`, [id])
      if (cur[0] && cur[0].sourceKind !== input.sourceKind) {
        throw new HttpError(409, 'A origem dos cadastros não se edita — use o ato "encerrar a transição"',
          [{ field: 'sourceKind', message: `gravado: ${cur[0].sourceKind}` }], ErrorCodes.SOURCE_KIND_IMMUTABLE)
      }
    }

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

/** Desfecho do interruptor da chave (D-PR43 + D-PR48 item 1: só PAUSA/RETOMADA, reversível). */
export type SyncKeySwitchOutcome =
  | { kind: 'missing' }
  | { kind: 'unchanged' }
  | { kind: 'switched'; keys: number }
  | { kind: 'not-for-source'; sourceKind: SourceKind }

/**
 * Pausa/retoma a chave VIVA do estabelecimento NUMA transação (D-PR43; Rodada 7 — D-PR48 item 1): NÃO muda o dono do catálogo, não cria
 * categoria, não confere linhas (a Rodada 6 fazia isso e caiu: o dono é o fato `source_kind`, nunca a chave). Nunca apaga (PADROES §3.1).
 *  - 1º statement: a trava da institution (PADROES §9 regra 7) — serializa com o ato "encerrar a transição" (que lê e muda o fato) e
 *    com outro interruptor; depois o FATO (leitura consistente DEPOIS da trava — o retrato já vê o ato comitado) e as chaves vivas
 *    `FOR UPDATE`.
 *  - RETOMAR ('S') em W é recusado: W não tem sincronizador — nativo web, ou transição encerrada para W (a chave inativada pelo ato
 *    nunca reativa — D-PR48). Pausar em W (nada vivo) cai em `unchanged`.
 *  - estado já é o pedido → nada muda.
 */
export async function switchSyncApiKeyTx(institutionId: number, active: 'S' | 'N'): Promise<SyncKeySwitchOutcome> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockInstitutionCounters(conn, institutionId)
    const [fact] = await conn.query<any[]>(
      `SELECT source_kind AS sourceKind FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'`, [institutionId])
    const sourceKind: SourceKind | undefined = fact[0]?.sourceKind
    if (active === 'S' && sourceKind === 'W') { await conn.rollback(); return { kind: 'not-for-source', sourceKind } }
    const [keys] = await conn.query<any[]>(
      `SELECT id, active FROM setes_central.tb_sync_api_key
        WHERE tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [institutionId])
    if ((keys as any[]).length === 0) { await conn.rollback(); return { kind: 'missing' } }
    const toFlip = (keys as any[]).filter(k => k.active !== active)
    if (toFlip.length === 0) { await conn.rollback(); return { kind: 'unchanged' } }
    await conn.query(
      `UPDATE setes_central.tb_sync_api_key SET active = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND deleted = 'N' AND active <> ?`,
      [active, institutionId, active])
    await conn.commit()
    return { kind: 'switched', keys: toFlip.length }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Desfecho do ato "encerrar a transição" (D-PR48/D-PR49). */
export type LegacyTransitionOutcome =
  | { kind: 'missing' }
  | { kind: 'not-applicable'; sourceKind: SourceKind; transitionEndedAt: string | null }
  | { kind: 'ended'; schemaName: string; defaultCategories: Record<CategoryKind, number | null>; syncKeysInactivated: number }

/**
 * ENCERRAR A TRANSIÇÃO do desktop legado (D-PR48/D-PR49 — ato ÚNICO e IRREVERSÍVEL do Super), NUMA transação, na linha do FATO:
 *  1. trava da institution (PADROES §9 regra 7 — a MESMA linha que todo cunhador de id e o interruptor da chave travam: quem esperar
 *     por ela lê o fato novo) e o fato `FOR UPDATE` (regra 2 do §9 — leitura que decide trava);
 *  2. só `source_kind = 'L'` passa (não-L = `not-applicable`: repetir o ato cai aqui — não há 2º código, depois do ato a institution
 *     simplesmente não é L);
 *  3. `UPDATE … SET source_kind = destino, transition_ended_at = NOW(), transition_ended_by = autor, transition_end_reason = motivo
 *     WHERE id = ? AND source_kind = 'L' AND transition_ended_at IS NULL` — as QUATRO marcas do ato no MESMO comando (D-PR53: write-once,
 *     nascem juntas; o CHECK `ck_institution_transition_author` da 079 recusa o ato pela metade) e a condição NO COMANDO (PADROES §11
 *     regra 10: fato monotônico); 0 linhas = alguém mudou o fato por baixo → falha alto;
 *  4. destino W: as chaves vivas do sincronizador ficam INATIVAS em definitivo (W nunca reativa — `switchSyncApiKeyTx`); destino P: a
 *     chave fica — é a MESMA que os PDVs usam (D-PR49/D-TM11; A-PR4 — Q-PR60 ao Valdo); o servidor desktop passa a ser recusado pelo
 *     FATO, lido pelo setes-sync (contrato `SYNC_TRANSITION_ENDED` — grupo do sync);
 *  5. as categorias padrão que faltarem ("Produtos" P / "Serviços" S — `ensureDefaultCategories`, a MESMA regra da migration 073).
 * Falha em qualquer passo desfaz TUDO (o fato segue L). Quem chama reexecuta em deadlock (o passo 5 cunha id).
 * ORDEM DAS TRAVAS (gate adversarial da PROD.E6.P2): a FK do autor (079) põe trava S em `tb_user(autor)` DEPOIS da trava da institution —
 * transação nova que trave `tb_user` e depois o contador/linha de uma institution inverte a ordem e pode dar deadlock com o ato.
 */
export async function endLegacyTransitionTx(
  institutionId: number, destination: 'W' | 'P', actorUserId: number, reason: string
): Promise<LegacyTransitionOutcome> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockInstitutionCounters(conn, institutionId)
    const [rows] = await conn.query<any[]>(
      `SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt
         FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N' FOR UPDATE`,
      [institutionId])
    if ((rows as any[]).length === 0) { await conn.rollback(); return { kind: 'missing' } }
    const { schemaName, sourceKind, transitionEndedAt } = rows[0]
    if (sourceKind !== 'L') {
      await conn.rollback()
      return { kind: 'not-applicable', sourceKind, transitionEndedAt: toIso(transitionEndedAt) }
    }
    const s = assertSchema(schemaName)
    const [upd] = await conn.query<any>(
      `UPDATE setes_central.tb_institution
          SET source_kind = ?, transition_ended_at = NOW(), transition_ended_by = ?, transition_end_reason = ?, updated_at = NOW()
        WHERE id = ? AND source_kind = 'L' AND transition_ended_at IS NULL`,
      [destination, actorUserId, reason, institutionId])
    if (Number(upd.affectedRows) !== 1) {
      throw new Error(`encerrar a transição: o fato da institution ${institutionId} mudou por baixo da trava (affectedRows = ${upd.affectedRows})`)
    }
    let syncKeysInactivated = 0
    if (destination === 'W') {
      const [k] = await conn.query<any>(
        `UPDATE setes_central.tb_sync_api_key SET active = 'N', updated_at = NOW()
          WHERE tb_institution_id = ? AND deleted = 'N' AND active = 'S'`,
        [institutionId])
      syncKeysInactivated = Number(k.affectedRows)
    }
    const defaultCategories = await ensureDefaultCategories(conn, s, institutionId)
    await conn.commit()
    return { kind: 'ended', schemaName: s, defaultCategories, syncKeysInactivated }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Desfecho de gerar a chave (D12 + D-PR47). */
export type SyncKeyCreateOutcome =
  | { kind: 'missing' }
  | { kind: 'not-for-source'; sourceKind: SourceKind }
  | { kind: 'exists' }
  | { kind: 'created' }

/**
 * Uma chave por estabelecimento; id sem auto_increment → MAX+1 na transação. As DECISÕES ficam DENTRO da transação (gate adversarial
 * R7, ADV-R7-03 — TOCTOU): trava da institution 1º (PADROES §9 regra 7 — a MESMA linha que o ato "encerrar a transição" trava) → o fato
 * `FOR UPDATE` (W não tem chave — nativo web, ou L encerrado para W; lido FORA da transação, o ato podia comitar no meio e nascer uma
 * chave ATIVA numa institution W: dois escritores) → "já existe chave viva" na mesma transação (dois POSTs simultâneos) → INSERT.
 */
export async function insertSyncApiKey(
  institutionId: number, apiKey: string, establishmentCode: string
): Promise<SyncKeyCreateOutcome> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockInstitutionCounters(conn, institutionId)
    const [fact] = await conn.query<any[]>(
      `SELECT source_kind AS sourceKind FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N' FOR UPDATE`, [institutionId])
    if ((fact as any[]).length === 0) { await conn.rollback(); return { kind: 'missing' } }
    const sourceKind: SourceKind = fact[0].sourceKind
    if (!sourceKindHasSync(sourceKind)) { await conn.rollback(); return { kind: 'not-for-source', sourceKind } }
    const [keys] = await conn.query<any[]>(
      `SELECT id, active FROM setes_central.tb_sync_api_key
        WHERE tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [institutionId])
    if ((keys as any[]).length > 0) { await conn.rollback(); return { kind: 'exists' } }
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
    return { kind: 'created' }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
