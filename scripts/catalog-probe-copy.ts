/**
 * Cópia do catálogo central para as provas em banco DESCARTÁVEL, depois do script 77 (nomes únicos — D-PV43/D-PV63, setes-api:PRIV.E7.P1).
 *
 * O `CREATE TABLE … LIKE setes_central.tb_interface/tb_privilege` passou a copiar a coluna gerada `i18n_key_live` e os dois UNIQUE. As
 * provas antigas que plantam de propósito o lixo que o banco agora recusa ('orders ' ao lado de 'orders', 'FATURAR ' ao lado de 'FATURAR')
 * medem a DEFESA DAS VIEWS, não o índice: na cópia delas o 77 sai (`stripCatalogUnique`). A cópia com dados lista as colunas que não são
 * geradas (`copyCatalogRows` — o `INSERT … SELECT *` mandaria valor à coluna gerada) e MANTÉM o UNIQUE quando não planta nome torto (o
 * replay dos seeds em `adv-a1-delta-probe.ts` e a medição `measure-access-reads.ts`). O UNIQUE em si é provado em
 * `prove-catalog-unique-names.ts`.
 */
type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** Tira da cópia descartável (`schema`) o que o 77 pôs — só nas tabelas do catálogo que existem nela. Nunca em `setes_central`. */
export async function stripCatalogUnique(q: Q, schema: string): Promise<void> {
  if (schema === 'setes_central') throw new Error('stripCatalogUnique: só em cópia descartável')
  const [rows] = await q.query(`SELECT TABLE_NAME AS t FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('tb_interface', 'tb_privilege')`, [schema])
  const has = new Set((rows as any[]).map(r => String(r.t)))
  if (has.has('tb_interface')) {
    await q.query(`ALTER TABLE \`${schema}\`.tb_interface DROP INDEX IF EXISTS uq_interface_i18n_key_live`)
    await q.query(`ALTER TABLE \`${schema}\`.tb_interface DROP COLUMN IF EXISTS i18n_key_live`)
  }
  if (has.has('tb_privilege')) await q.query(`ALTER TABLE \`${schema}\`.tb_privilege DROP INDEX IF EXISTS uq_privilege_description`)
}

/** Copia as linhas de `setes_central.<table>` para `<schema>.<table>` pelas colunas que NÃO são geradas (as mesmas nos dois lados). */
export async function copyCatalogRows(q: Q, schema: string, table: string): Promise<void> {
  const [cols] = await q.query(`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = ? AND UPPER(EXTRA) NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION`, [table])
  const list = (cols as any[]).map(r => `\`${r.c}\``).join(', ')
  await q.query(`INSERT INTO \`${schema}\`.\`${table}\` (${list}) SELECT ${list} FROM setes_central.\`${table}\``)
}
