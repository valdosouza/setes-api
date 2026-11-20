import pool from '@shared/db/connection'

/**
 * Nomes ÚNICOS do catálogo central (script central 77 — D-PV43, D-PV63, A-PV28; setes-api:PRIV.E7.P1).
 *
 *   tb_interface  coluna gerada STORED `i18n_key_live` (= `i18n_key` só nas VIVAS, colação utf8mb4_general_ci) + UNIQUE
 *                 `uq_interface_i18n_key_live` — a chave não se repete entre as vivas; a excluída não colide no banco.
 *   tb_privilege  UNIQUE `uq_privilege_description` em TODAS as linhas — nome e id do verbo são 1:1 para sempre.
 *
 * Os cadastros conferem ANTES (409 legível — inclusive contra linha EXCLUÍDA, que a tela nunca revive); o 1062 que escapar numa corrida
 * vira o MESMO 409 pelo nome do índice (`catalogUniqueViolated`). Conhecimento negativo: o conserto de DUPLICATA da tela Interfaces
 * (excluir uma das duas linhas vivas de mesma chave — D-PV15/D-PV45) saiu do código com este script; o estado que ele consertava não
 * existe mais. Consequência para quem escreve nas duas tabelas: nada de `ON DUPLICATE KEY UPDATE` (PADROES §9 regra 10 — cerca na suíte).
 */
export const INTERFACE_KEY_UNIQUE = 'uq_interface_i18n_key_live'
export const PRIVILEGE_NAME_UNIQUE = 'uq_privilege_description'
export const INTERFACE_KEY_LIVE_COLUMN = 'i18n_key_live'
const SCRIPT = 'sql/77_catalog_unique_names_ddl.sql'

/** A expressão da coluna gerada, normalizada (sem crase, aspas duplas, espaço; minúsculas) — a MESMA comparação do script 77. */
export const INTERFACE_KEY_LIVE_EXPRESSION = "casewhendeleted='n'theni18n_keyend"
export function normalizeGeneration(expr: unknown): string {
  return String(expr ?? '').replace(/[`" ]/g, '').toLowerCase()
}

type Querier = Pick<typeof pool, 'query'>

/**
 * Boot (D-PV43 — "a sonda do UNIQUE pelo NOME no boot"): sem a coluna gerada NA FORMA (varchar(100), utf8mb4_general_ci, STORED, a
 * expressão), sem os dois UNIQUE (nome com caixa + única coluna, BTREE, sem prefixo), com `i18n_key`/`description` fora da
 * utf8mb4_general_ci ou com OUTRO UNIQUE além da PK e destes (a §9 regra 10 conta com isso), o setes-api NÃO sobe — os cadastros contam com o banco para fechar a corrida. `schema` só muda na prova em descartável.
 */
export async function assertCatalogUniqueNames(q: Querier = pool, schema = 'setes_central'): Promise<string> {
  const problems: string[] = []
  const [cols] = await q.query<any[]>(
    `SELECT DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len, COLLATION_NAME AS coll, EXTRA AS extra,
            GENERATION_EXPRESSION AS expr
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_interface' AND COLUMN_NAME = ?`, [schema, INTERFACE_KEY_LIVE_COLUMN])
  const col = (cols as any[])[0]
  if (!col) problems.push(`tb_interface sem a coluna ${INTERFACE_KEY_LIVE_COLUMN}`)
  else if (String(col.type).toLowerCase() !== 'varchar' || Number(col.len) !== 100 || col.coll !== 'utf8mb4_general_ci'
    || !/STORED GENERATED/i.test(String(col.extra ?? '')) || normalizeGeneration(col.expr) !== INTERFACE_KEY_LIVE_EXPRESSION) {
    problems.push(`tb_interface.${INTERFACE_KEY_LIVE_COLUMN} com outra forma (tipo/colação/STORED/expressão)`)
  }
  // gate adversarial do PRIV.E7.P1 (MEDIUM): a colação das colunas NOMEADAS é a regra do UNIQUE — em utf8mb4_bin, 'faturar' entraria ao
  // lado de 'FATURAR' com o índice "na forma"
  const [base] = await q.query<any[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS coll FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND ((TABLE_NAME = 'tb_interface' AND COLUMN_NAME = 'i18n_key')
                               OR (TABLE_NAME = 'tb_privilege' AND COLUMN_NAME = 'description'))`, [schema])
  for (const [t, c] of [['tb_interface', 'i18n_key'], ['tb_privilege', 'description']]) {
    const b = (base as any[]).find(r => r.t === t && r.c === c)
    if (!b || b.coll !== 'utf8mb4_general_ci') problems.push(`${t}.${c} fora da colação utf8mb4_general_ci (${b?.coll ?? 'ausente'})`)
  }
  const [idx] = await q.query<any[]>(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, SUB_PART AS sub, INDEX_TYPE AS type
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('tb_interface', 'tb_privilege') AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'`, [schema])
  const rows = idx as any[]
  const expected: Record<string, [string, string]> = {
    [INTERFACE_KEY_UNIQUE]: ['tb_interface', INTERFACE_KEY_LIVE_COLUMN],
    [PRIVILEGE_NAME_UNIQUE]: ['tb_privilege', 'description'],
  }
  for (const [name, [table, column]] of Object.entries(expected)) {
    const parts = rows.filter(r => r.t === table && r.name === name)
    if (!parts.length) problems.push(`${table} sem o UNIQUE ${name}`)
    else if (parts.length !== 1 || parts[0].col !== column || Number(parts[0].seq) !== 1 || parts[0].sub !== null
      || String(parts[0].type ?? '').toUpperCase() !== 'BTREE') {
      problems.push(`${table}.${name} com outra forma (tem de ser UNIQUE BTREE só sobre ${column}, sem prefixo)`)
    }
  }
  const extra = [...new Set(rows.filter(r => !(r.name in expected) || expected[r.name][0] !== r.t).map(r => `${r.t}.${r.name}`))]
  if (extra.length) problems.push(`UNIQUE a mais (PADROES §9 regra 10): ${extra.join(', ')}`)
  if (problems.length) {
    throw new Error(`${schema}: nomes únicos do catálogo fora da forma — ${problems.join('; ')} — aplique o script ${SCRIPT} `
      + 'em setes_central ANTES do setes-api (D-PV43/D-PV63); forma diferente o script recusa: conserte à mão')
  }
  return 'ok (coluna gerada e 2 UNIQUE)'
}

/**
 * Deadlock (1213)? No MariaDB o `MAX(id)+1 … FOR UPDATE` dos dois cadastros NÃO serializa dois POST simultâneos: o perdedor sai com 1213,
 * não com 1062 (provado no gate adversarial do PRIV.E7.P1 — 29 de 30 pares; com nomes diferentes também).
 */
export function isDeadlock(err: unknown): boolean {
  const e = err as { errno?: number; code?: string } | null
  return !!e && (e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK')
}

/**
 * Refaz o cadastro INTEIRO (conferência do nome + gravação) quando a transação perde por deadlock — o InnoDB já desfez a do perdedor. Só
 * reler o nome no 1213 não basta: o vencedor quase nunca fez COMMIT ainda (re-gate do delta, M1 — 4 de 29). A nova tentativa espera a trava,
 * vê o vencedor e cai no 409 legível (mesmo nome) ou grava (nome diferente — antes era RESOURCE_BUSY). Esgotadas as tentativas, o 1213
 * segue e vira 409 RESOURCE_BUSY no `handleError`. Nunca repete outro erro.
 */
export async function retryOnDeadlock<T>(attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await attempt() } catch (err) {
      if (!isDeadlock(err) || i >= tries) throw err
      await new Promise(r => setTimeout(r, 15 * i + Math.floor(Math.random() * 15)))
    }
  }
}

/**
 * O 1062 (ER_DUP_ENTRY) é de um dos dois UNIQUE do 77? Reconhecido pelo NOME do índice no FIM da mensagem — `for key 'uq_…'` (MariaDB)
 * ou `for key 'tabela.uq_…'` (MySQL 8). Ancorado: a mensagem traz também o VALOR digitado, que pode conter o nome do outro índice
 * (gate socrático do PRIV.E7.P1, L3).
 */
export function catalogUniqueViolated(err: unknown): 'interface-key' | 'privilege-name' | null {
  const e = err as { errno?: number; code?: string; message?: string } | null
  if (!e || (e.errno !== 1062 && e.code !== 'ER_DUP_ENTRY')) return null
  const key = /for key '(?:[^'.]*\.)?([^'.]+)'\s*$/.exec(String(e.message ?? ''))?.[1]
  if (key === INTERFACE_KEY_UNIQUE) return 'interface-key'
  if (key === PRIVILEGE_NAME_UNIQUE) return 'privilege-name'
  return null
}
