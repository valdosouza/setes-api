import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { escapeLike } from '@shared/list'

/**
 * CATÁLOGO CENTRAL INICIADO PELO CLIENTE — marca, unidade de medida e embalagem (cadastro de produtos, onda 1 — D-PR5/D-PR28;
 * molde `@shared/payment-types`, inventário de peças do guardião). A linha vive UMA vez em `setes_central` e é COMPARTILHADA entre
 * clientes (dedupe dentro da transação; descrição imutável); o cliente se liga a ela por `tb_institution_has_<x>` (`active` — o
 * cliente desativa, nunca exclui). Quem tem a interface cria "na hora" pelo lookup do form.
 *
 * Chave do dedupe: marca e embalagem pela DESCRIÇÃO; unidade pela ABREVIAÇÃO (é o uCom/uTrib da NF-e — "UN" e "un" são a mesma pela
 * colação `_ci` da central). Achado de dev (D-PR28): medida "KILOGRAA" e a embalagem sentinela "NÃO INFORMADO" — dado a corrigir à parte.
 * Escopo (PADROES_BANCO §12): o VÍNCULO é tabela do GRUPO — `groupInstitutionId` = a chave do catálogo (hoje = a institution).
 */

export interface CatalogSpec {
  /** Rótulo humano (mensagens). */
  label:       string
  table:       'tb_brand' | 'tb_measure' | 'tb_package'
  linkTable:   'tb_institution_has_brand' | 'tb_institution_has_measure' | 'tb_institution_has_package'
  linkColumn:  'tb_brand_id' | 'tb_measure_id' | 'tb_package_id'
  dedupeBy:    'description' | 'abbreviation'
  /** A tabela central tem `abbreviation`? (marca não tem). */
  hasAbbreviation: boolean
}

export const BRAND_CATALOG: CatalogSpec = {
  label: 'Marca', table: 'tb_brand', linkTable: 'tb_institution_has_brand', linkColumn: 'tb_brand_id',
  dedupeBy: 'description', hasAbbreviation: false,
}
export const MEASURE_CATALOG: CatalogSpec = {
  label: 'Unidade', table: 'tb_measure', linkTable: 'tb_institution_has_measure', linkColumn: 'tb_measure_id',
  dedupeBy: 'abbreviation', hasAbbreviation: true,
}
export const PACKAGE_CATALOG: CatalogSpec = {
  label: 'Embalagem', table: 'tb_package', linkTable: 'tb_institution_has_package', linkColumn: 'tb_package_id',
  dedupeBy: 'description', hasAbbreviation: true,
}

export interface CatalogItemInput {
  description:   string
  abbreviation?: string | null
}

export interface CatalogItemRow {
  id:            number
  description:   string
  abbreviation:  string | null
  /** = description (+ abreviação) — contrato { id, name } das listas de apoio. */
  name:          string
}

/**
 * Garante o item no catálogo CENTRAL pela chave de dedupe: existente = reusa; inexistente = cria (id MAX+1 FOR UPDATE).
 * Identidade = a da D17 da revisão do sync (o OUTRO escritor da mesma linha): UPPER(TRIM(chave)) SEM colapsar acento — comparação
 * BINÁRIA (a colação unicode_ci da coluna fundiria 'AÇO' com 'ACO'; gate socrático do delta, M2). A dedupe é leitura do RETRATO, sem
 * `FOR UPDATE`: quem chama segura a trava NOMEADA do catálogo (`createAndLinkCatalogItem`) e a coluna não tem índice — o FOR UPDATE
 * travava a tabela central inteira, de todos os clientes (M4). Chave da medida = abreviação (D-PR28) × descrição na D17 → Q-PR39.
 */
export async function ensureCatalogItem(
  conn: PoolConnection, spec: CatalogSpec, input: CatalogItemInput
): Promise<{ id: number; reused: boolean }> {
  const key = spec.dedupeBy === 'abbreviation' ? (input.abbreviation ?? '').trim() : input.description.trim()
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM setes_central.${spec.table}
      WHERE UPPER(TRIM(${spec.dedupeBy})) COLLATE utf8mb4_bin = UPPER(TRIM(?)) COLLATE utf8mb4_bin AND deleted = 'N'
      ORDER BY id LIMIT 1`,
    [key])
  if (rows.length > 0) return { id: Number(rows[0].id), reused: true }

  const [mx] = await conn.query<any[]>(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.${spec.table} FOR UPDATE`)
  const id = Number(mx[0].nextId)
  if (spec.hasAbbreviation) {
    await conn.query(
      `INSERT INTO setes_central.${spec.table} (id, description, abbreviation, created_at, updated_at, deleted)
       VALUES (?, ?, ?, NOW(), NOW(), 'N')`,
      [id, input.description.trim(), (input.abbreviation ?? '').trim() || null])
  } else {
    await conn.query(
      `INSERT INTO setes_central.${spec.table} (id, description, created_at, updated_at, deleted) VALUES (?, ?, NOW(), NOW(), 'N')`,
      [id, input.description.trim()])
  }
  return { id, reused: false }
}

/** Upsert do VÍNCULO institution × item (ressuscita o desativado/soft-deletado). */
export async function linkCatalogItem(
  conn: PoolConnection, spec: CatalogSpec, schemaName: string, groupInstitutionId: number, itemId: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `INSERT INTO \`${s}\`.${spec.linkTable} (tb_institution_id, ${spec.linkColumn}, active, created_at, updated_at, deleted)
     VALUES (?, ?, 'S', NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
    [groupInstitutionId, itemId])
}

/** O item existe na central E está vinculado ATIVO à institution — senão 422 `CATALOG_ITEM_NOT_LINKED` no campo do payload. */
export async function assertCatalogItemLinked(
  conn: PoolConnection, spec: CatalogSpec, schemaName: string, groupInstitutionId: number, itemId: number, field: string
): Promise<void> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM \`${s}\`.${spec.linkTable} l
       JOIN setes_central.${spec.table} c ON c.id = l.${spec.linkColumn} AND c.deleted = 'N'
      WHERE l.tb_institution_id = ? AND l.${spec.linkColumn} = ? AND l.deleted = 'N' AND l.active = 'S'`,
    [groupInstitutionId, itemId])
  if (rows.length === 0) {
    throw new HttpError(422, `${spec.label} inexistente ou não vinculada`,
      [{ field, message: `${spec.label} não encontrada no estabelecimento` }], ErrorCodes.CATALOG_ITEM_NOT_LINKED)
  }
}

/** Lista de apoio: itens VINCULADOS e ativos da institution (LIMIT 100, escapeLike) — `{ id, name }` + descrição/abreviação. */
export async function listLinkedCatalog(
  spec: CatalogSpec, schemaName: string, groupInstitutionId: number, filter: string
): Promise<CatalogItemRow[]> {
  const s = assertSchema(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const abbr = spec.hasAbbreviation ? 'c.abbreviation' : 'NULL'
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.description, ${abbr} AS abbreviation,
            ${spec.hasAbbreviation ? "CONCAT(COALESCE(CONCAT(c.abbreviation, ' — '), ''), c.description)" : 'c.description'} AS name
       FROM \`${s}\`.${spec.linkTable} l
       JOIN setes_central.${spec.table} c ON c.id = l.${spec.linkColumn} AND c.deleted = 'N'
      WHERE l.tb_institution_id = ? AND l.deleted = 'N' AND l.active = 'S'
        AND (? IS NULL OR c.description LIKE ? ${spec.hasAbbreviation ? 'OR c.abbreviation LIKE ?' : ''})
      ORDER BY c.description, c.id
      LIMIT 100`,
    spec.hasAbbreviation ? [groupInstitutionId, like, like, like] : [groupInstitutionId, like, like])
  return rows as CatalogItemRow[]
}

/** Espera máxima (s) da trava nomeada E das travas InnoDB/metadados enquanto ela é segurada. */
const CATALOG_LOCK_WAIT_SECONDS = 10

/**
 * "Criar na hora" (lookup do form): garante na central + vincula — na MESMA transação, SERIALIZADA por catálogo.
 *
 * ⚠️ CONHECIMENTO NEGATIVO (gate adversarial da onda 1 de produtos, ADV-06, 2026-10-18 — provado em cópia descartável da `tb_brand`):
 * dedupe `… FOR UPDATE` num valor AUSENTE + `MAX(id) … FOR UPDATE` só tomam travas de INTERVALO, e travas de intervalo são compatíveis
 * entre si — 8 criadores concorrentes deram 1 ok e 7 × ER_LOCK_DEADLOCK no INSERT. A regra 7 do PADROES §9 (travar a institution) não
 * serve aqui: o catálogo é CENTRAL, compartilhado entre clientes (institutions diferentes não se esperam). O ponto único de serialização é
 * a trava NOMEADA do catálogo (`GET_LOCK('setes_central.<tabela>')` — da sessão, solta no `finally` depois do commit; a transação começa
 * DEPOIS dela, então o retrato já enxerga o item que o criador anterior gravou e a dedupe o reusa). Limite conhecido: o setes-sync cria
 * itens centrais pelo protocolo dele (grupo do sync) — esta trava só ordena os escritores do setes-api.
 */
export async function createAndLinkCatalogItem(
  spec: CatalogSpec, schemaName: string, groupInstitutionId: number, input: CatalogItemInput
): Promise<{ id: number; reused: boolean }> {
  const conn = await pool.getConnection()
  const lockName = `setes_central.${spec.table}`
  let locked = false
  let shortened = false
  let inTransaction = false
  let reusable = true
  try {
    // quem segura uma trava GLOBAL (todos os clientes) nunca espera trava de tenant sem prazo (M4 do gate do delta): o INSERT do vínculo
    // pede S na linha da institution (FK) e o MAX pede o fim da tabela central — espera curta na SESSÃO, devolvida no fim (molde D-F131)
    await conn.query('SET @setes_cat_prev_lw = @@session.innodb_lock_wait_timeout, @setes_cat_prev_mdl = @@session.lock_wait_timeout')
    shortened = true
    await conn.query('SET SESSION innodb_lock_wait_timeout = ?, lock_wait_timeout = ?', [CATALOG_LOCK_WAIT_SECONDS, CATALOG_LOCK_WAIT_SECONDS])
    const [got] = await conn.query<any[]>(`SELECT GET_LOCK(?, ?) AS ok`, [lockName, CATALOG_LOCK_WAIT_SECONDS])
    // sem a trava no prazo = a mesma contenção da casa (409 RESOURCE_BUSY — o usuário tenta de novo)
    if (Number(got[0]?.ok) !== 1) throw new HttpError(409, 'Registro em uso por outra operação — tente novamente', undefined, ErrorCodes.RESOURCE_BUSY)
    locked = true
    await conn.beginTransaction()
    inTransaction = true
    const item = await ensureCatalogItem(conn, spec, input)
    await linkCatalogItem(conn, spec, schemaName, groupInstitutionId, item.id)
    await conn.commit()
    inTransaction = false
    return item
  } catch (err) {
    if (inTransaction) {
      try { await conn.rollback() } catch { reusable = false }   // a falha do rollback não mascara o erro original
    }
    throw err
  } finally {
    // conexão que pode voltar ao pool SEGURANDO a trava nomeada (o GET_LOCK é recursivo por sessão) ou com a espera encurtada = DESCARTADA
    if (locked) await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => { reusable = false })
    if (shortened && reusable) {
      await conn.query('SET SESSION innodb_lock_wait_timeout = @setes_cat_prev_lw, lock_wait_timeout = @setes_cat_prev_mdl')
        .catch(() => { reusable = false })
    }
    if (reusable) conn.release()
    else conn.destroy()
  }
}
