/**
 * `tb_institution.source_kind` nas provas em banco DESCARTÁVEL (migrations 072/081 — NOT NULL sem DEFAULT, domínio 'W' | 'D').
 *
 * As provas criam a `tb_institution` delas por `CREATE TABLE … LIKE setes_central.tb_institution`, isto é, com a estrutura da central
 * VIVA: antes da janela de publicação a coluna ainda não existe; depois dela existe e é obrigatória. O INSERT de prova tem de servir
 * aos dois estados — esta peça olha a tabela JÁ CRIADA no descartável e devolve o pedaço de coluna/valor a colar no INSERT (vazio
 * quando a coluna não existe). O valor é 'W' (institution web): nenhuma dessas provas mede a origem.
 *
 * Uso (depois do CREATE TABLE … LIKE):
 *   const sk = await institutionSourceKind(conn, PROBE)
 *   `INSERT INTO … tb_institution (id, schema_name, active, deleted${sk.col}) VALUES (1, 'x', 'S', 'N'${sk.val})`
 *   // carga em lote (`VALUES ?`): rows.map(r => [...r, ...sk.cell])
 */
type Q = { query: (sql: string, params?: any) => Promise<any> }

export interface InstitutionSourceKind {
  /** `, source_kind` — ou vazio */
  col: string
  /** `, 'W'` — ou vazio (um por tupla do VALUES) */
  val: string
  /** `['W']` — ou `[]` (para a carga em lote por `VALUES ?`) */
  cell: string[]
}

export async function institutionSourceKind(q: Q, schema: string): Promise<InstitutionSourceKind> {
  const [rows] = await q.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME = 'source_kind'`,
    [schema])
  return (rows as unknown[]).length ? { col: ', source_kind', val: `, 'W'`, cell: ['W'] } : { col: '', val: '', cell: [] }
}
