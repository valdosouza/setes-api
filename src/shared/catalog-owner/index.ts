import pool from '@shared/db/connection'
import type { Pool } from 'mysql2/promise'

/**
 * O DONO DO CATÁLOGO DE BASE do estabelecimento — peça ÚNICA da pergunta "quem escreve o cadastro?" (cadastro de produtos, Rodada 7 —
 * D-PR47/D-PR48/D-PR49/D-PR51/D-PR52, Valdo 2026-10-20; `Infra-IA/prompts/prompt_modulo_products.md`; parecer do guardião 2026-10-20).
 *
 * O FATO: `setes_central.tb_institution.source_kind` = o TIPO DA FONTE EXTERNA que alimenta o estabelecimento (as mesmas letras do
 * `tb_terminal.kind` da frente do terminal — D-TM9):
 *   W = nenhuma (nativo web)                      → o catálogo é da WEB
 *   L = servidor desktop do legado (transição)    → o catálogo é do LEGADO: a web só CONSULTA (salvo o enquadramento fiscal — D-PR45)
 *   P = PDVs (mandam só movimento)                → o catálogo é da WEB (os PDVs o recebem — D-TM18)
 * Declarado pelo Super no cadastro do estabelecimento (sem presunção — nunca DEFAULT), MONOTÔNICO: só muda pelo ato "encerrar a
 * transição" (L → W ou L → P, uma vez, irreversível — `transition_ended_at`), nunca de volta a L. Por isso NÃO existe reconferência
 * dentro da transação do escritor (a `assertNoActiveSyncKey` da Rodada 6 morreu): quem passou pela guarda nunca é alcançado por um
 * fechamento — o fato só abre. A CHAVE do sincronizador (`tb_sync_api_key`) voltou a ser só AUTENTICAÇÃO (a pausa da D-PR48 item 1 é
 * interruptor de emergência e não decide dono).
 *
 * D-TM10: o fato na linha da FUNDADORA é o fato do GRUPO; as filiais leem pelo `groupInstitutionId` (`@shared/group`, que ainda não
 * existe — hoje grupo = institution). Quando a peça do grupo nascer, `sourceKindOf` resolve o grupo por ela e lê a fundadora; os
 * consumidores (guarda, ato, setes-sync) não mudam.
 */

export type SourceKind = 'W' | 'L' | 'P'
export const SOURCE_KINDS: readonly SourceKind[] = ['W', 'L', 'P']

export type CatalogOwner = 'web' | 'legacy'

/** Regra PURA: quem escreve o catálogo de base dado o tipo da fonte. */
export function catalogOwnerOf(kind: SourceKind): CatalogOwner {
  return kind === 'L' ? 'legacy' : 'web'
}

/** A chave do sincronizador só existe para quem TEM fonte externa (D-PR47: "gerada só para L e P"). */
export function sourceKindHasSync(kind: SourceKind): boolean {
  return kind !== 'W'
}

/** Frase ÚNICA da recusa (guarda do gateway, Swagger, mensagens). */
export const CATALOG_LEGACY_OWNED_MESSAGE =
  'Este estabelecimento está em transição do sistema legado: o cadastro é do desktop — na web ele é só consulta'

/**
 * CATÁLOGO DE BASE (D-PR52, literal do Valdo: "unidade/medida/embalagem/categorias/produtos/servicos/tabela de preco/preco, Lista de
 * Estoque, saldo de estoque....sao os cadastros de base") — o que o dono do catálogo escreve e, no modo L, a web só consulta; em P é
 * também o que os PDVs recebem (projeção da D-TM18 — consumidor futuro). Medida e embalagem são catálogos CENTRAIS (D5 do sync): a linha
 * é compartilhada, o que é do estabelecimento é o VÍNCULO.
 */
export const BASE_CATALOG_TABLES = [
  'tb_merchandise_trade_unit',                               // unidade de venda (071)
  'tb_measure', 'tb_institution_has_measure',                // medida (central + vínculo)
  'tb_package', 'tb_institution_has_package',                // embalagem (central + vínculo)
  'tb_category',                                             // categorias
  'tb_product', 'tb_merchandise',                            // produtos (mercadoria)
  'tb_service',                                              // serviços — só o CADASTRO; o enquadramento fiscal é da web (D-PR45)
  'tb_price_list', 'tb_price',                               // tabela de preço e preço
  'tb_stock_list', 'tb_stock_balance',                       // lista e saldo de estoque
] as const

/**
 * O que o LEGADO envia e a web cunha por MAX+1 no MESMO espaço de id — a lista da GUARDA (`catalogOwnerGuard`) e da cerca da skill
 * `setes-api/skills/novo-modulo.md`: o catálogo de base (D-PR52) + plano de contas e contas bancárias (D-PR51 — cadastros que o legado
 * também envia, fora do catálogo de base). Módulo cujo cadastro está aqui MONTA a guarda; tabela nova que o legado alimentar entra aqui.
 */
export const LEGACY_OWNED_TABLES = [
  ...BASE_CATALOG_TABLES,
  'tb_financial_plans',                                      // plano de contas (D-PR51)
  'tb_bank_account',                                         // contas bancárias (D-PR51)
] as const

/** Os módulos do gateway que montam a guarda (D-PR41 revista + D-PR51) — a cerca de montagem confere esta lista contra o roteador. */
export const LEGACY_OWNED_MODULES = [
  'merchandise', 'services', 'price-lists', 'categories', 'financial-plans', 'bank-accounts',
] as const

/**
 * Lê o fato do estabelecimento (hoje = a própria institution; com `@shared/group`, a fundadora do grupo). Sem cache: o ato de encerrar a
 * transição vale na hora. null = institution inexistente/excluída (quem chama decide: a guarda recusa fechado).
 */
export async function sourceKindOf(institutionId: number): Promise<SourceKind | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT source_kind AS kind FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'`,
    [institutionId])
  const kind = rows[0]?.kind
  return isSourceKind(kind) ? kind : null
}

export function isSourceKind(v: unknown): v is SourceKind {
  return v === 'W' || v === 'L' || v === 'P'
}

/** Nomes das constraints da migration 072 — conferidos no boot pelo NOME (PADROES §11 regra 11). */
export const CK_INSTITUTION_SOURCE_KIND = 'ck_institution_source_kind'
export const CK_INSTITUTION_TRANSITION_ENDED = 'ck_institution_transition_ended'
/** Nomes das constraints da migration 079 (autor e motivo do ato — D-PR53/D-PR57), conferidos no boot pelo NOME. */
export const CK_INSTITUTION_TRANSITION_AUTHOR = 'ck_institution_transition_author'
export const CK_INSTITUTION_TRANSITION_REASON = 'ck_institution_transition_reason'
export const FK_INSTITUTION_TRANSITION_ENDED_BY = 'fk_institution_transition_ended_by'

/**
 * Boot (server.ts, DEPOIS das migrations): as colunas existem (`source_kind` NOT NULL sem default — 072; autor e motivo anuláveis — 079),
 * os quatro CHECKs e a FK do autor existem pelo NOME e o motor os aplica — SONDA (PADROES §11 regra 11): linhas de PROVA com PK PRÓPRIA
 * (`id = -1`: entity, o usuário de prova quando a sonda leva autor, e institution, todos `deleted = 'S'`), cada sonda numa transação SEMPRE
 * desfeita — um valor FORA do domínio ('X'), a minúscula de um válido ('l' — a colação `_ci` da tabela aceitaria), "L com data" (com autor
 * e motivo, para isolar a 072) e, da 079 (D-PR53/D-PR57), "W com data sem autor nem motivo" e "W com data, autor e motivo só branco" — cada
 * uma recusada pela constraint ESPERADA (o nome na mensagem do motor — errno 4025 no MariaDB, 3819 no MySQL). Nunca toca a linha de um
 * estabelecimento real: a linha da Setes é a que todo cunhador de id trava (gate socrático da Rodada 7 — um UPDATE nela esperaria o
 * detentor e derrubaria o boot por contenção). Os INSERTs de prova abrem a transação e recuam antes de qualquer outro statement.
 * Limite conhecido (gate adversarial da PROD.E6.P2): a sonda com autor depende de INSERT em `tb_user` — se a credencial migrar para a
 * auth-api (D-AU6) e o usuário de banco do setes-api perder esse direito, o boot cai com erro de privilégio (rever a sonda nessa hora).
 * Outro limite (re-gate da PROD.E6.P2): o boot confere nome, nulabilidade e a tabela da FK, não o TIPO das colunas nem a coluna da FK.
 */
const BOOT_PROBE_ID = -1

export async function assertInstitutionSourceKindSchema(q: Pick<Pool, 'getConnection'> = pool): Promise<string> {
  const conn = await q.getConnection()
  try {
    const [cols] = await conn.query<any[]>(
      `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution'
          AND COLUMN_NAME IN ('source_kind', 'transition_ended_at', 'transition_ended_by', 'transition_end_reason')`)
    const byName = new Map((cols as any[]).map(r => [r.c, r]))
    if (!byName.has('source_kind') || !byName.has('transition_ended_at')) {
      throw new Error('tb_institution sem source_kind/transition_ended_at — a migration 072 não rodou (D-PR47)')
    }
    if (!byName.has('transition_ended_by') || !byName.has('transition_end_reason')) {
      throw new Error('tb_institution sem transition_ended_by/transition_end_reason — a migration 079 não rodou (D-PR53)')
    }
    if (byName.get('transition_ended_by').n !== 'YES' || byName.get('transition_end_reason').n !== 'YES') {
      throw new Error('tb_institution.transition_ended_by/transition_end_reason têm de ser anuláveis (só o ato as preenche — D-PR53)')
    }
    if (byName.get('source_kind').n !== 'NO' || byName.get('source_kind').d != null) {
      throw new Error('tb_institution.source_kind tem de ser NOT NULL sem DEFAULT (fato declarado — D-PR47)')
    }
    const [cks] = await conn.query<any[]>(
      `SELECT CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution' AND CONSTRAINT_NAME IN (?, ?, ?, ?)`,
      [CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED, CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON])
    const names = new Set((cks as any[]).map(r => r.n))
    for (const ck of [CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED]) {
      if (!names.has(ck)) throw new Error(`tb_institution sem a constraint ${ck} (migration 072 — D-PR47)`)
    }
    for (const ck of [CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON]) {
      if (!names.has(ck)) throw new Error(`tb_institution sem a constraint ${ck} (migration 079 — D-PR53)`)
    }
    const [fks] = await conn.query<any[]>(
      `SELECT REFERENCED_TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution' AND CONSTRAINT_NAME = ?`,
      [FK_INSTITUTION_TRANSITION_ENDED_BY])
    if ((fks as any[])[0]?.t !== 'tb_user') {
      throw new Error(`tb_institution sem a FK ${FK_INSTITUTION_TRANSITION_ENDED_BY} → tb_user (migration 079 — D-PR57)`)
    }
    // sonda: linhas de prova com PK própria, transação desfeita — a recusa tem de vir da constraint ESPERADA. Com `withAuthor` a linha leva
    // o autor (usuário de prova com a MESMA PK -1, na mesma transação — a FK da 079 fica satisfeita) e o motivo: "L com data" passa a violar
    // SÓ o ck_institution_transition_ended (sem autor violaria também o da 079, e qual o motor acusa primeiro é detalhe dele).
    const refuses = async (
      sourceKind: string, endedSql: 'NULL' | 'NOW()', withAuthor: boolean, expected: string, reason: string | null = 'sonda do boot (D-PR53)'
    ): Promise<void> => {
      await conn.beginTransaction()
      try {
        await conn.query(
          `INSERT INTO setes_central.tb_entity (id, name_company, nick_trade, created_at, updated_at, deleted)
           VALUES (?, 'sonda do boot (D-PR47)', 'sonda', NOW(), NOW(), 'S')`, [BOOT_PROBE_ID])
        if (withAuthor) {
          await conn.query(
            `INSERT INTO setes_central.tb_user (id, active, created_at, updated_at, deleted) VALUES (?, 'N', NOW(), NOW(), 'S')`, [BOOT_PROBE_ID])
        }
        await conn.query(
          `INSERT INTO setes_central.tb_institution
             (id, schema_name, source_kind, transition_ended_at, transition_ended_by, transition_end_reason, active, created_at, updated_at, deleted)
           VALUES (?, 'setes_sonda_boot', ?, ${endedSql}, ?, ?, 'N', NOW(), NOW(), 'S')`,
          [BOOT_PROBE_ID, sourceKind, withAuthor ? BOOT_PROBE_ID : null, withAuthor ? reason : null])
        throw new Error(`CHECK ${expected} NÃO aplicado pelo motor: a sonda ('${sourceKind}', ${endedSql}, autor: ${withAuthor}) gravou`)
      } catch (err: any) {
        if (!(err?.errno === 4025 || err?.errno === 3819)) throw err
        if (!String(err?.message ?? '').includes(expected)) {
          throw new Error(`a sonda foi recusada por OUTRA constraint (${err.message}) — esperava ${expected}`)
        }
      } finally {
        await conn.rollback()
      }
    }
    await refuses('X', 'NULL', false, CK_INSTITUTION_SOURCE_KIND)
    await refuses('l', 'NULL', false, CK_INSTITUTION_SOURCE_KIND)
    await refuses('L', 'NOW()', true, CK_INSTITUTION_TRANSITION_ENDED)
    await refuses('W', 'NOW()', false, CK_INSTITUTION_TRANSITION_AUTHOR)   // o ato sem autor e motivo (079 — D-PR53)
    await refuses('W', 'NOW()', true, CK_INSTITUTION_TRANSITION_REASON, '   ')   // motivo só branco (079)
    await refuses('W', 'NOW()', true, CK_INSTITUTION_TRANSITION_AUTHOR, null)   // data + autor sem motivo (079)
    return 'ok'
  } finally {
    conn.release()
  }
}
