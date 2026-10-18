import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { ErrorCodes } from '@shared/errors/error-codes'
import { HttpError } from '@shared/errors/http-error'

/** Frase ÚNICA da recusa (guarda do gateway e reconferência na transação do escritor). */
export const SYNC_MANAGED_MESSAGE =
  'Este estabelecimento recebe o cadastro do sistema legado (sincronizador ativo) — na web ele é só consulta'

/**
 * O estabelecimento recebe cadastro do sistema LEGADO? (chave do sincronizador ATIVA em `setes_central.tb_sync_api_key` — quem a
 * administra é o módulo `institutions`; quem a consome é o setes-sync.) Peça ÚNICA da pergunta, lida pela guarda de escrita dos
 * cadastros que o legado alimenta (`syncWriteGuard` — D-PR32 e D-PR41 revista: `merchandise`, `services`, `price-lists`, `categories`;
 * sincronizado só CONSULTA na web). Sem cache: desativar a chave (D-PR43) vale na hora.
 */
export async function hasActiveSyncKey(institutionId: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_sync_api_key
      WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N' LIMIT 1`,
    [institutionId])
  return rows.length > 0
}

/**
 * Reconferência da guarda DENTRO da transação de quem CUNHA id numa tabela do legado (gate socrático da Rodada 6 de produtos): a guarda do
 * gateway lê a chave FORA da transação — um escritor que passou por ela com a chave desligada pode esperar a trava da institution enquanto
 * o super RELIGA (o ato segura a mesma trava) e inserir depois, já com a chave ativa, numa linha que nenhuma conferência futura vê.
 * Chame LOGO DEPOIS da trava da institution (PADROES §9 regra 7). Leitura TRAVANTE compartilhada (`LOCK IN SHARE MODE`): lê o último
 * comitado qualquer que seja o snapshot e segue a ordem do ato (institution → chaves), sem ciclo. Chave ativa = 409 `SYNC_MANAGED_CATALOG`.
 */
export async function assertNoActiveSyncKey(conn: PoolConnection, institutionId: number): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_sync_api_key
      WHERE tb_institution_id = ? AND active = 'S' AND deleted = 'N' LIMIT 1 LOCK IN SHARE MODE`,
    [institutionId])
  if ((rows as any[]).length > 0) throw new HttpError(409, SYNC_MANAGED_MESSAGE, [], ErrorCodes.SYNC_MANAGED_CATALOG)
}

/**
 * Tabelas dos cadastros que o LEGADO alimenta com o id DELE (o `tb_product.id` é o PRO_CODIGO, a categoria e a tabela de preço vêm dos
 * geradores do legado — grupo do sync, `setes-sync/verificacao-comissao-margem-mercadoria.md` §9) e onde a web cunha id por MAX+1.
 * Linha que nasce aqui pela web com o sincronizador DESLIGADO ocupa um id que o legado ainda vai gerar — religado, o envio a sobrescreve
 * sem aviso (upsert pela PK). Cadastro novo protegido pelo `syncWriteGuard` entra nesta lista (skill `setes-api/skills/novo-modulo.md`).
 */
export const SYNC_FED_TABLES = ['tb_product', 'tb_price_list', 'tb_category'] as const

export interface WebBornRows {
  table: (typeof SYNC_FED_TABLES)[number]
  count: number
  /** até 20 ids, em ordem — para o super conferir o que nasceu. */
  ids:   number[]
}

const SAMPLE = 20

/**
 * Q-PR47 (a) (Rodada 6): o que NASCEU (`created_at`) nas tabelas do legado a partir de `since` — o instante em que a chave foi desligada.
 * Inclusivo (`>=`): DATETIME tem precisão de segundo — a linha criada no MESMO segundo do desligamento também conta (o ato de desligar
 * grava a categoria padrão 1 s antes, para não contar a si mesmo). Conta INCLUSIVE a linha excluída (soft delete não libera o id: o
 * legado a sobrescreveria e reviveria). Leitura CONSISTENTE: chame depois da trava da institution (PADROES §9 regra 7 — o snapshot nasce na 1ª leitura consistente, e o criador de produto cunha o id
 * com a mesma trava). Devolve só as tabelas com linha.
 */
export async function webBornSince(
  conn: PoolConnection, schemaName: string, institutionId: number, since: Date
): Promise<WebBornRows[]> {
  const s = assertSchema(schemaName)
  const out: WebBornRows[] = []
  for (const table of SYNC_FED_TABLES) {
    const [[{ n }]] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${s}\`.${table} WHERE tb_institution_id = ? AND created_at >= ?`,
      [institutionId, since]) as any
    if (Number(n) === 0) continue
    const [ids] = await conn.query<any[]>(
      `SELECT id FROM \`${s}\`.${table} WHERE tb_institution_id = ? AND created_at >= ? ORDER BY id LIMIT ${SAMPLE}`,
      [institutionId, since])
    out.push({ table, count: Number(n), ids: (ids as any[]).map(r => Number(r.id)) })
  }
  return out
}
