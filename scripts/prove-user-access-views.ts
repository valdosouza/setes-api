/**
 * PROVA da pilha de views do veredito de acesso (costura A1 da frente auth-api — D-AU3/D-AU6/D-AU8/D-AU12, Valdo 2026-10-31;
 * Infra-IA/prompts/prompt_frente_auth_api.md) em banco DESCARTÁVEL — nada de `setes_central` nem de schema de cliente é tocado
 * (só lidos para COPIAR a ESTRUTURA das tabelas, `CREATE TABLE … LIKE`).
 *
 *  1. Cria `prova_ua_central` (cópia vazia das tabelas centrais) e `setes_zprova_ua` (schema de cliente descartável) e aplica o SQL REAL
 *     de `sql/70_user_access_central_views.sql` e da migration `075_user_access_views.sql` (o nome do central trocado pelo descartável).
 *  2. Cenários por perfil lidos pela PRÓPRIA biblioteca (`fiscal-api/access`): super (só na Setes), admin (licença × registrado, sem a
 *     delegável), regular (licença ∩ concessão ∩ registrado), tela delegável (só usuário da Setes, nunca pela licença), vínculo/credencial/
 *     estabelecimento inativos (D-UC9), `kind` com outra caixa, par registrado inativo, concessão sobre par NÃO registrado.
 *  3. FUNDÍVEL (D-AU8 / PADROES §11.3): EXPLAIN das leituras da biblioteca sem DERIVED/MATERIALIZED.
 *  4. Colação: as leituras em duas colações de conexão (unicode_ci e general_ci) — nunca erro 1267.
 *  5. Re-executável: o SQL das views aplicado DUAS vezes.
 *  7. D-GE3 (migration 076, setes-api:GRUPO.E3.P1): a concessão é POR ESTABELECIMENTO — com a filial no MESMO schema, o privilégio
 *     da matriz não vale nela; e o preenchimento da 076 em schema descartável com a tabela ANTIGA: uma institution viva = todas as
 *     linhas vão para ela (re-executável); duas vivas = erro 1242 e nada preenchido; nenhuma = erro (a coluna nunca fica 0/NULL).
 *  6. GRANT (D-AU12, achado HIGH do guardião): um usuário DESCARTÁVEL com `SELECT ON prova\_ua\_%.*` (o curinga casa o central, como
 *     o `setes\_%` casa o `setes_central`) + a linha ESPECÍFICA do central (`SHOW VIEW`) + SELECT só na vw_user_link e na tb_interface:
 *     `SELECT password FROM <central>.tb_user` tem de ser NEGADO; a vw_user_link e as views do cliente (DEFINER) seguem legíveis.
 *  No fim apaga tudo (os dois bancos e o usuário), mesmo com falha.
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-user-access-views.ts
 * Sai com código 1 em qualquer falha.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import pool from '../src/shared/db/connection'
import { accessVerdict, reachableKeys, accessRows } from 'fiscal-api/access'
import { stripCatalogUnique } from './catalog-probe-copy'
import { institutionSourceKind, InstitutionSourceKind } from './lib/institution-source-kind'

const CENTRAL = 'prova_ua_central'
/** pedaço de coluna/valor do `source_kind` da cópia da central (072/081) — resolvido no `main`, depois do CREATE TABLE … LIKE */
let sk: InstitutionSourceKind = { col: '', val: '', cell: [] }
const CLIENT = 'setes_zprova_ua'
const BACKFILL = 'setes_zprova_uabf'
const PROBE_USER = 'prova_ua_fiscal'
const PROBE_HOSTS = ['%', 'localhost', '127.0.0.1', '::1']
const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../sql')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function statementsOf(sql: string): string[] {
  return sql.replace(/--[^\n]*\n/g, '\n').split(';').map(s => s.trim()).filter(s => s.length > 0)
}

const centralSql = () => fs.readFileSync(path.join(SQL_DIR, '70_user_access_central_views.sql'), 'utf8')
  .replace(/`setes_central`/g, `\`${CENTRAL}\``)
const migrationSql = (file: string) => fs.readFileSync(path.resolve(__dirname, '../src/migrations/sql', file), 'utf8')
  .replace(/`setes_central`/g, `\`${CENTRAL}\``)
/** As migrations do veredito no schema do cliente, na ordem do runner: as views (075) e a concessão por estabelecimento (076). */
const clientSql = () => migrationSql('075_user_access_views.sql') + '\n' + migrationSql('076_user_privilege_by_institution.sql')

async function dropAll(conn: mysql.PoolConnection): Promise<void> {
  for (const h of PROBE_HOSTS) await conn.query(`DROP USER IF EXISTS ?@?`, [PROBE_USER, h])
  await conn.query(`DROP DATABASE IF EXISTS \`${CLIENT}\``)
  await conn.query(`DROP DATABASE IF EXISTS \`${BACKFILL}\``)
  await conn.query(`DROP DATABASE IF EXISTS \`${CENTRAL}\``)
}

// ── dados: institutions 1 (Setes) e 2 (cliente); interfaces; pares; vínculos; licenças; concessões ─────────────────────────────
const IFACE = { orders: 10, customers: 11, 'institution-interfaces': 12, cfop: 13 } as const
const PRIV = { VISUALIZAR: 6, ALTERAR: 2, FATURAR: 5, TRANSMITIR: 9 } as const

async function seed(conn: mysql.PoolConnection): Promise<void> {
  const now = 'NOW()'
  await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution (id, schema_name, active, deleted${sk.col}) VALUES
    (1, 'setes_zprova_ua1', 'S', 'N'${sk.val}), (2, 'setes_zprova_ua', 'S', 'N'${sk.val}), (3, 'setes_zprova_ua3', 'N', 'N'${sk.val})`)
  const users: [number, string, string][] = [
    [1, 'S', 'N'], [2, 'S', 'N'], [3, 'S', 'N'], [4, 'S', 'N'], [5, 'S', 'N'], [6, 'S', 'N'], [7, 'S', 'S'], [8, 'N', 'N'], [9, 'S', 'N'],
  ]
  for (const [id, active, deleted] of users) {
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_user (id, password, active, deleted, created_at) VALUES (?, 'HASH', ?, ?, ${now})`,
      [id, active, deleted])
  }
  // vínculos: 1 super na Setes; 2 admin no cliente 2; 3 regular no cliente 2; 4 'super' no cliente 2 (vira user); 5 admin da Setes;
  // 6 'Admin' (caixa) no cliente 2; 7 credencial excluída; 8 credencial inativa; 9 vínculo INATIVO no cliente 2; 2 também no 3 (inativo)
  // (cada linha = [usuário, estabelecimento, kind, ativo])
  const links: [number, number, string, string][] = [
    [1, 1, 'super', 'S'], [2, 2, 'admin', 'S'], [2, 3, 'user', 'S'], [3, 2, 'user', 'S'], [4, 2, 'super', 'S'], [5, 1, 'admin', 'S'],
    [6, 2, 'Admin', 'S'], [7, 2, 'admin', 'S'], [8, 2, 'admin', 'S'], [9, 2, 'admin', 'N'],
  ]
  for (const [user, inst, kind, active] of links) {
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted)
      VALUES (?, ?, ?, ?, 'N')`, [inst, user, kind, active])
  }
  for (const [k, id] of Object.entries(IFACE)) {
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_interface (id, i18n_key, description, kind, group_default, deleted)
      VALUES (?, ?, ?, 'T', ?, 'N')`, [id, k, k, k === 'institution-interfaces' || k === 'cfop' ? 'Super' : 'Comercial'])
  }
  for (const [name, id] of Object.entries(PRIV)) {
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_privilege (id, description, deleted) VALUES (?, ?, 'N')`, [id, name])
  }
  // pares: orders V/A/F/T; customers V/A (ALTERAR INATIVO); institution-interfaces V/A; cfop V
  const pairs: [number, number, string][] = [
    [10, 6, 'S'], [10, 2, 'S'], [10, 5, 'S'], [10, 9, 'S'], [11, 6, 'S'], [11, 2, 'N'], [12, 6, 'S'], [12, 2, 'S'], [13, 6, 'S'],
  ]
  for (const [i, p, active] of pairs) {
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted)
      VALUES (?, ?, ?, 'N')`, [i, p, active])
  }
  // licenças: cliente 2 tem orders e customers e (pela aba do Super) a DELEGÁVEL; a Setes tem orders; cliente 3 (inativo) tem orders
  const lic: [number, number][] = [[2, 10], [2, 11], [2, 12], [1, 10], [3, 10]]
  for (const [inst, i] of lic) {
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted)
      VALUES (?, ?, 'S', 'N')`, [inst, i])
  }
  // concessões (D-GE3: cada uma NUM estabelecimento): regular 3 no cliente 2 → orders V + FATURAR + par NÃO registrado (orders × 7) +
  // customers ALTERAR (par inativo); admin da Setes 5 na Setes (1) → institution-interfaces V (delegada pelo Super)
  const grants: [number, number, number, number][] = [[3, 2, 10, 6], [3, 2, 10, 5], [3, 2, 10, 7], [3, 2, 11, 2], [5, 1, 12, 6]]
  for (const [u, inst, i, p] of grants) {
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_institution_id, tb_interface_id, tb_privilege_id,
      active, deleted) VALUES (?, ?, ?, ?, 'S', 'N')`, [u, inst, i, p])
  }
}

/** A tabela como a 003 a criou (sem a institution; as fks centrais ficam de fora — o descartável não tem o central de verdade). */
const OLD_TABLE = (schema: string) => `CREATE TABLE \`${schema}\`.tb_user_has_privilege (
  tb_user_id INT NOT NULL, tb_interface_id INT NOT NULL, tb_privilege_id INT NOT NULL, active CHAR(1) DEFAULT NULL,
  created_at DATETIME DEFAULT NULL, updated_at DATETIME DEFAULT NULL, deleted CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (tb_user_id, tb_interface_id, tb_privilege_id)) ENGINE=InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci`

/** Aplica SÓ a 076 no schema descartável; devolve o código do erro (null = passou). */
async function apply076(conn: mysql.PoolConnection, schema: string): Promise<string | null> {
  await conn.query(`USE \`${schema}\``)
  try {
    for (const st of statementsOf(migrationSql('076_user_privilege_by_institution.sql'))) await conn.query(st)
    return null
  } catch (e: any) {
    return `${e.errno ?? ''} ${e.code ?? ''}`.trim()
  }
}

async function resetOld(conn: mysql.PoolConnection): Promise<void> {
  await conn.query(`DROP DATABASE IF EXISTS \`${BACKFILL}\``)
  await conn.query(`CREATE DATABASE \`${BACKFILL}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.query(OLD_TABLE(BACKFILL))
  // o schema como a 075 o deixou (a 076 recria a vw_user_access sobre a vw_user_reach dela — a ordem do runner)
  await conn.query(`CREATE TABLE \`${BACKFILL}\`.tb_institution_has_interface LIKE \`${CLIENT}\`.tb_institution_has_interface`)
  await conn.query(`USE \`${BACKFILL}\``)
  for (const st of statementsOf(migrationSql('075_user_access_views.sql'))) await conn.query(st)
  await conn.query(`INSERT INTO \`${BACKFILL}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted)
    VALUES (3, 10, 6, 'S', 'N'), (3, 10, 9, 'S', 'N'), (4, 11, 2, 'N', 'N')`)
}

async function proveBackfill(conn: mysql.PoolConnection): Promise<void> {
  const rowsOf = async () => (await conn.query<any[]>(`SELECT tb_institution_id i FROM \`${BACKFILL}\`.tb_user_has_privilege ORDER BY 1`))[0]
    .map((r: any) => r.i)
  // uma institution viva no schema: todas as linhas vão para ela; a 076 roda DUAS vezes
  await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution (id, schema_name, active, deleted${sk.col}) VALUES (20, ?, 'S', 'N'${sk.val}), (22, ?, 'S', 'S'${sk.val})`,
    [BACKFILL, BACKFILL])
  await resetOld(conn)
  const first = await apply076(conn, BACKFILL)
  const second = await apply076(conn, BACKFILL)
  check('076 (uma institution viva; a excluída não conta): as 3 concessões vão para ela, inclusive a inativa',
    first === null && eq(await rowsOf(), [20, 20, 20]), `${first} · ${JSON.stringify(await rowsOf())}`)
  check('076 re-executável (2ª aplicação sem erro e sem mudar nada)', second === null && eq(await rowsOf(), [20, 20, 20]), String(second))
  const [nn] = await conn.query<any[]>(`SELECT IS_NULLABLE n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user_has_privilege' AND COLUMN_NAME = 'tb_institution_id'`, [BACKFILL])
  check('076: tb_institution_id NOT NULL', nn[0]?.n === 'NO', JSON.stringify(nn))
  // duas institutions vivas no schema: a 076 PARA (erro 1242) e nada é preenchido
  await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution (id, schema_name, active, deleted${sk.col}) VALUES (21, ?, 'S', 'N'${sk.val})`, [BACKFILL])
  await resetOld(conn)
  const two = await apply076(conn, BACKFILL)
  check('076 com DUAS institutions vivas no schema: para com o erro 1242 e não preenche nenhuma linha',
    /^1242\b/.test(String(two)) && eq(await rowsOf(), [null, null, null]), `${two} · ${JSON.stringify(await rowsOf())}`)
  // nenhuma institution viva com concessão: a 076 também PARA (a coluna nunca fica NULL nem 0)
  await conn.query(`UPDATE \`${CENTRAL}\`.tb_institution SET deleted = 'S' WHERE id IN (20, 21)`)
  await resetOld(conn)
  const none = await apply076(conn, BACKFILL)
  const [after] = await conn.query<any[]>(`SELECT COUNT(*) n FROM \`${BACKFILL}\`.tb_user_has_privilege
    WHERE tb_institution_id IS NOT NULL`)
  check('076 sem institution viva: para na trava (4025) e nenhuma linha ganha institution (nem 0)', /^4025\b/.test(String(none))
    && Number(after[0].n) === 0,
    `${none} · ${JSON.stringify(after)}`)
  // ...e o boot seguinte, com a institution de volta, termina a 076 sobre o que a tentativa anterior deixou (coluna NULL)
  await conn.query(`UPDATE \`${CENTRAL}\`.tb_institution SET deleted = 'N' WHERE id = 20`)
  const retry = await apply076(conn, BACKFILL)
  check('076 depois da falha: com a institution de volta, a reexecução completa e preenche', retry === null && eq(await rowsOf(), [20, 20, 20]),
    `${retry} · ${JSON.stringify(await rowsOf())}`)
  // a tentativa que MORREU entre os dois ALTER (a trava gravada, o MODIFY não): o boot seguinte completa a 076 (re-gate socrático)
  await resetOld(conn)
  await conn.query(`ALTER TABLE \`${BACKFILL}\`.tb_user_has_privilege ADD COLUMN tb_institution_id INT NULL AFTER tb_user_id`)
  await conn.query(`UPDATE \`${BACKFILL}\`.tb_user_has_privilege SET tb_institution_id = 20`)
  await conn.query(`ALTER TABLE \`${BACKFILL}\`.tb_user_has_privilege ADD CONSTRAINT ck_uhp_institution_filled
    CHECK (tb_institution_id IS NOT NULL AND tb_institution_id <> 0)`)
  const leftover = await apply076(conn, BACKFILL)
  const [cks] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_user_has_privilege' AND CONSTRAINT_NAME = 'ck_uhp_institution_filled'`, [BACKFILL])
  check('076 com a trava sobrando de uma tentativa interrompida: completa, preenche e não deixa a trava',
    leftover === null && eq(await rowsOf(), [20, 20, 20]) && Number(cks[0].n) === 0, `${leftover} · ${JSON.stringify(cks)}`)
  const [idx] = await conn.query<any[]>(`SELECT DISTINCT INDEX_NAME i FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user_has_privilege' ORDER BY 1`, [BACKFILL])
  check('076: a fk da institution usa o idx_uhp_institution (nenhum índice a mais que o canônico)',
    eq(idx.map((r: any) => r.i), ['idx_uhp_institution', 'PRIMARY']), JSON.stringify(idx))
  await conn.query(`DROP DATABASE IF EXISTS \`${BACKFILL}\``)
  await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_institution WHERE id IN (20, 21, 22)`)
  await conn.query(`USE \`${CLIENT}\``)
}

const who = (userId: number, institutionId: number) => ({ userId, institutionId, schemaName: CLIENT })
async function verbsOf(userId: number, institutionId: number): Promise<string[]> {
  return (await accessRows(pool, who(userId, institutionId))).map(r => `${r.interfaceKey}:${r.privilege}`).sort()
}

async function main(): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.query('SET NAMES utf8mb4')
    await dropAll(conn)
    await conn.query(`CREATE DATABASE \`${CENTRAL}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    await conn.query(`CREATE DATABASE \`${CLIENT}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    for (const t of ['tb_user', 'tb_institution', 'tb_institution_has_user', 'tb_interface', 'tb_privilege', 'tb_interface_has_privilege']) {
      await conn.query(`CREATE TABLE \`${CENTRAL}\`.\`${t}\` LIKE \`setes_central\`.\`${t}\``)
    }
    // script 77 (PRIV.E7.P1): esta prova planta 'orders ' e 'FATURAR ' para medir a defesa das VIEWS — os UNIQUE saem da cópia
    await stripCatalogUnique(conn, CENTRAL)
    sk = await institutionSourceKind(conn, CENTRAL)
    // D-GE3 (gate socrático do GRUPO.E3.P1): hoje `schema_name` é ÚNICO no central (uma institution por schema); a matriz e a filial no
    // MESMO schema só existem a partir da onda 3 do grupo. Só no central DESCARTÁVEL a chave única sai, para provar o grupo.
    await conn.query(`ALTER TABLE \`${CENTRAL}\`.tb_institution DROP INDEX IF EXISTS \`schema_name\``)
    for (const t of ['tb_institution_has_interface', 'tb_user_has_privilege']) {
      await conn.query(`CREATE TABLE \`${CLIENT}\`.\`${t}\` LIKE \`setes_setes\`.\`${t}\``)
    }
    // 5. re-executável: as views aplicadas DUAS vezes (o 2º CREATE OR REPLACE não falha)
    for (let round = 0; round < 2; round++) {
      for (const st of statementsOf(centralSql())) await conn.query(st)
      await conn.query(`USE \`${CLIENT}\``)
      for (const st of statementsOf(clientSql())) await conn.query(st)
    }
    check('views criadas e recriadas (re-executável)', true)
    await seed(conn)

    // ── 2. cenários ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const [link] = await conn.query<any[]>(`SELECT tb_user_id u, tb_institution_id i, profile, vendor FROM \`${CENTRAL}\`.vw_user_link
      ORDER BY tb_institution_id, tb_user_id`)
    check('vw_user_link: só vínculo, credencial e estabelecimento VIVOS; super só na Setes; kind por binário',
      eq(link.map((r: any) => `${r.i}/${r.u}:${r.profile}:${r.vendor}`),
        ['1/1:super:S', '1/5:admin:S', '2/2:admin:N', '2/3:user:N', '2/4:user:N', '2/6:user:N']),
      JSON.stringify(link))

    check('super (Setes): todo par REGISTRADO e ativo de toda interface, inclusive a não contratada e a delegável',
      eq(await verbsOf(1, 1), ['cfop:VISUALIZAR', 'customers:VISUALIZAR', 'institution-interfaces:ALTERAR',
        'institution-interfaces:VISUALIZAR', 'orders:ALTERAR', 'orders:FATURAR', 'orders:TRANSMITIR', 'orders:VISUALIZAR']),
      JSON.stringify(await verbsOf(1, 1)))
    check('admin do cliente: licença × registrado; SEM a delegável (mesmo com a linha de licença) e sem o par inativo',
      eq(await verbsOf(2, 2), ['customers:VISUALIZAR', 'orders:ALTERAR', 'orders:FATURAR', 'orders:TRANSMITIR', 'orders:VISUALIZAR']),
      JSON.stringify(await verbsOf(2, 2)))
    check('regular: licença ∩ concessão ∩ par registrado e ativo (o par não registrado e o inativo ficam fora)',
      eq(await verbsOf(3, 2), ['orders:FATURAR', 'orders:VISUALIZAR']), JSON.stringify(await verbsOf(3, 2)))
    check("'super' fora da Setes = regular (nada concedido → nada)", eq(await verbsOf(4, 2), []))
    check('admin da Setes: a delegável SÓ pela concessão do Super (V), nunca pelo perfil (sem o A)',
      eq(await verbsOf(5, 1), ['institution-interfaces:VISUALIZAR', 'orders:ALTERAR', 'orders:FATURAR', 'orders:TRANSMITIR',
        'orders:VISUALIZAR']), JSON.stringify(await verbsOf(5, 1)))
    check("kind 'Admin' (outra caixa) NÃO é admin", eq(await verbsOf(6, 2), []))
    for (const [u, i, why] of [[7, 2, 'credencial excluída'], [8, 2, 'credencial inativa'], [9, 2, 'vínculo inativo (D-UC9)'],
      [2, 3, 'estabelecimento inativo']] as [number, number, string][]) {
      check(`sem acesso: ${why}`, eq(await verbsOf(u, i), []))
    }
    check('veredito pela biblioteca: regular FATURAR em orders = ok', (await accessVerdict(pool, who(3, 2), ['orders'], 'FATURAR')) === 'ok')
    check('veredito: regular ALTERAR em orders (alcança, sem concessão) = no-privilege',
      (await accessVerdict(pool, who(3, 2), ['orders'], 'ALTERAR')) === 'no-privilege')
    check('veredito: admin do cliente em cfop (não contratada) = not-contracted',
      (await accessVerdict(pool, who(2, 2), ['cfop'], 'VISUALIZAR')) === 'not-contracted')
    check('veredito: chave EXATA (`Orders` não é `orders`)',
      (await accessVerdict(pool, who(1, 1), ['Orders'], 'VISUALIZAR')) === 'not-contracted')
    check('veredito: verbo EXATO pelo nome (`Faturar` fora do vocabulário nega — o motivo é o verbo)',
      (await accessVerdict(pool, who(3, 2), ['orders'], 'Faturar' as any)) === 'no-privilege')
    check('alcance do admin do cliente: a delegável NÃO (mesmo licenciada)',
      eq(await reachableKeys(pool, who(2, 2), ['orders', 'customers', 'institution-interfaces', 'cfop']), ['orders', 'customers']))
    check('alcance do admin da Setes: a delegável SIM (vendor), cfop não',
      eq(await reachableKeys(pool, who(5, 1), ['orders', 'institution-interfaces', 'cfop']), ['orders', 'institution-interfaces']))

    // ── 7. D-GE3: a filial 4 no MESMO schema do cliente 2 (o grupo); o regular 3 e o admin 2 também têm vínculo nela ─────────────
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution (id, schema_name, active, deleted${sk.col}) VALUES (4, ?, 'S', 'N'${sk.val})`, [CLIENT])
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted)
      VALUES (4, 3, 'user', 'S', 'N'), (4, 2, 'user', 'S', 'N')`)
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted)
      VALUES (4, 10, 'S', 'N'), (4, 11, 'S', 'N')`)
    check('D-GE3: o privilégio da matriz (cliente 2: orders V + FATURAR) NÃO vale na filial do mesmo schema', eq(await verbsOf(3, 4), []),
      JSON.stringify(await verbsOf(3, 4)))
    check('D-GE3: FATURAR na filial negado pela biblioteca (o fisco lê o mesmo veredito)',
      (await accessVerdict(pool, who(3, 4), ['orders'], 'FATURAR')) === 'no-privilege')
    check('D-GE3: o admin da matriz é só usuário na filial — sem concessão lá, nada', eq(await verbsOf(2, 4), []))
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_institution_id, tb_interface_id, tb_privilege_id,
      active, deleted) VALUES (3, 4, 10, 6, 'S', 'N')`)
    check('D-GE3: a concessão dada NA filial vale só nela (VISUALIZAR) e a da matriz segue a dela',
      eq(await verbsOf(3, 4), ['orders:VISUALIZAR']) && eq(await verbsOf(3, 2), ['orders:FATURAR', 'orders:VISUALIZAR']),
      `${JSON.stringify(await verbsOf(3, 4))} / ${JSON.stringify(await verbsOf(3, 2))}`)
    await conn.query(`UPDATE \`${CLIENT}\`.tb_user_has_privilege SET active = 'N' WHERE tb_user_id = 3 AND tb_institution_id = 4`)
    check('D-GE3: revogar na filial não toca a matriz',
      eq(await verbsOf(3, 4), []) && eq(await verbsOf(3, 2), ['orders:FATURAR', 'orders:VISUALIZAR']))
    const [pk] = await conn.query<any[]>(`SELECT COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user_has_privilege' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, [CLIENT])
    check('D-GE3: chave primária (usuário, institution, interface, privilégio)',
      eq(pk.map((r: any) => r.c), ['tb_user_id', 'tb_institution_id', 'tb_interface_id', 'tb_privilege_id']), JSON.stringify(pk))
    await conn.query(`DELETE FROM \`${CLIENT}\`.tb_user_has_privilege WHERE tb_institution_id = 4`)
    await conn.query(`DELETE FROM \`${CLIENT}\`.tb_institution_has_interface WHERE tb_institution_id = 4`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_institution_has_user WHERE tb_institution_id = 4`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_institution WHERE id = 4`)

    // ── 7b. preenchimento da 076 sobre a tabela ANTIGA (a da 003, sem a institution) ─────────────────────────────────────────
    await proveBackfill(conn)

    // revogação NA HORA (sem cache): inativar a concessão e reler
    await conn.query(`UPDATE \`${CLIENT}\`.tb_user_has_privilege SET active = 'N' WHERE tb_user_id = 3 AND tb_privilege_id = 5`)
    check('revogação na hora: a concessão inativada some na leitura seguinte',
      (await accessVerdict(pool, who(3, 2), ['orders'], 'FATURAR')) === 'no-privilege')
    await conn.query(`UPDATE \`${CENTRAL}\`.tb_institution_has_user SET active = 'N' WHERE tb_user_id = 3 AND tb_institution_id = 2`)
    check('D-UC9: vínculo inativado → nenhuma linha na hora', eq(await verbsOf(3, 2), []))

    // ── PAD SPACE (gate adversarial da A1): o `utf8mb4_bin` do MariaDB 10.4 iguala 'x ' a 'x' — kind, chave e verbo com espaço no fim
    // nunca DECIDEM (sql/70 + 075: `CHAR_LENGTH(x) = CHAR_LENGTH(RTRIM(x))`) ──────────────────────────────────────────────────────────
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_user (id, password, active, deleted, created_at) VALUES (10, 'HASH', 'S', 'N', NOW()), (11, 'HASH', 'S', 'N', NOW())`)
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted)
      VALUES (2, 10, 'admin ', 'S', 'N'), (1, 10, 'super ', 'S', 'N'), (2, 11, 'user', 'S', 'N')`)
    const [padKind] = await conn.query<any[]>(`SELECT tb_institution_id i, profile FROM \`${CENTRAL}\`.vw_user_link WHERE tb_user_id = 10 ORDER BY 1`)
    check("PAD SPACE: kind 'admin ' e 'super ' (espaço no fim) viram 'user' — como 'SYNC'",
      eq(padKind.map((r: any) => `${r.i}:${r.profile}`), ['1:user', '2:user']), JSON.stringify(padKind))
    // a interface 'orders ' (outra linha, licenciada, com par e concessão) NUNCA responde por 'orders'
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_interface (id, i18n_key, description, kind, group_default, deleted)
      VALUES (14, 'orders ', 'orders torta', 'T', 'Comercial', 'N')`)
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted) VALUES (14, 5, 'S', 'N')`)
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted) VALUES (2, 14, 'S', 'N')`)
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_institution_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (11, 2, 14, 5, 'S', 'N')`)
    // o 2º verbo 'FATURAR ' (outro id) registrado em orders e concedido NUNCA vale como o FATURAR
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_privilege (id, description, deleted) VALUES (15, 'FATURAR ', 'N')`)
    await conn.query(`INSERT INTO \`${CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted) VALUES (10, 15, 'S', 'N')`)
    await conn.query(`INSERT INTO \`${CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_institution_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (11, 2, 10, 15, 'S', 'N')`)
    const [padRaw] = await conn.query<any[]>(`SELECT COUNT(*) n FROM \`${CLIENT}\`.vw_user_access
      WHERE tb_user_id = 11 AND tb_institution_id = 2 AND interface_key = 'orders' AND privilege = 'FATURAR'`)
    check("PAD SPACE: a interface 'orders ' e o verbo 'FATURAR ' não dão FATURAR em 'orders' (SQL cru na view)", Number(padRaw[0].n) === 0,
      JSON.stringify(padRaw))
    check('PAD SPACE: a biblioteca nega o FATURAR ao usuário 11 em orders', await accessVerdict(pool, who(11, 2), ['orders'], 'FATURAR') !== 'ok')
    const [padReach] = await conn.query<any[]>(`SELECT COUNT(*) n FROM \`${CLIENT}\`.vw_user_reach WHERE tb_interface_id = 14`)
    check("PAD SPACE: a interface 'orders ' (licenciada) fica fora do alcance de todos — fora do catálogo", Number(padReach[0].n) === 0,
      JSON.stringify(padReach))
    check('PAD SPACE: nada disso mexeu no FATURAR legítimo (o super em orders segue ok)',
      await accessVerdict(pool, who(1, 1), ['orders'], 'FATURAR') === 'ok')
    await conn.query(`DELETE FROM \`${CLIENT}\`.tb_user_has_privilege WHERE tb_user_id = 11`)
    await conn.query(`DELETE FROM \`${CLIENT}\`.tb_institution_has_interface WHERE tb_interface_id = 14`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_interface_has_privilege WHERE tb_interface_id = 14 OR tb_privilege_id = 15`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_privilege WHERE id = 15`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_interface WHERE id = 14`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_institution_has_user WHERE tb_user_id IN (10, 11)`)
    await conn.query(`DELETE FROM \`${CENTRAL}\`.tb_user WHERE id IN (10, 11)`)

    // ── D-EA7: a sessão compara o iat com o instante em que a senha foi definida (a MESMA leitura da biblioteca) ───────────────
    const sessionRows = async (u: number, i: number, iatLiteral: string) => (await conn.query<any[]>(
      `SELECT profile FROM \`${CENTRAL}\`.vw_user_link
        WHERE tb_user_id = ? AND tb_institution_id = ? AND schema_name = ? AND (password_set_at IS NULL OR password_set_at <= ?) LIMIT 2`,
      [u, i, CLIENT, iatLiteral]))[0].length
    check('D-EA7: password_set_at NULL (senha anterior à regra) → a sessão vale', await sessionRows(2, 2, '2026-10-31 12:00:00') === 1)
    await conn.query(`UPDATE \`${CENTRAL}\`.tb_user SET password_set_at = '2026-10-31 12:00:00' WHERE id = 2`)
    check('D-EA7: token com iat ANTERIOR à troca → sem sessão', await sessionRows(2, 2, '2026-10-31 11:59:59') === 0)
    check('D-EA7: iat = T (mesmo segundo) VALE — o token reemitido na mesma resposta', await sessionRows(2, 2, '2026-10-31 12:00:00') === 1)
    check('D-EA7: iat posterior → a sessão vale', await sessionRows(2, 2, '2026-10-31 12:00:01') === 1)
    const [col] = await conn.query<any[]>(`SELECT COLUMN_TYPE t, IS_NULLABLE n, COLUMN_DEFAULT d, EXTRA e FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user' AND COLUMN_NAME = 'password_set_at'`, [CENTRAL])
    check('D-EA7: coluna DATETIME NULL, sem DEFAULT nem ON UPDATE', !!col[0] && col[0].t === 'datetime' && col[0].n === 'YES'
      && (col[0].d === null || col[0].d === 'NULL') && !/on update/i.test(String(col[0].e)), JSON.stringify(col[0] ?? null))

    // ── 3. fundível ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    const plans: [string, string, any[]][] = [
      ['veredito', `SELECT 1 FROM \`${CLIENT}\`.vw_user_access WHERE tb_user_id = ? AND tb_institution_id = ? AND interface_key IN (?) AND privilege = ? LIMIT 1`, [2, 2, ['orders'], 'FATURAR']],
      ['alcance', `SELECT interface_key FROM \`${CLIENT}\`.vw_user_reach WHERE tb_user_id = ? AND tb_institution_id = ? AND interface_key IN (?)`, [2, 2, ['orders']]],
      ['menu', `SELECT tb_interface_id, interface_key, privilege FROM \`${CLIENT}\`.vw_user_access WHERE tb_user_id = ? AND tb_institution_id = ?`, [2, 2]],
      ['sessão', `SELECT profile, vendor FROM \`${CENTRAL}\`.vw_user_link WHERE tb_user_id = ? AND tb_institution_id = ? AND schema_name = ? LIMIT 2`, [2, 2, CLIENT]],
    ]
    for (const [label, sql, params] of plans) {
      const [rows] = await conn.query<any[]>(`EXPLAIN ${sql}`, params)
      const bad = rows.filter((r: any) => /DERIVED|MATERIALIZED|UNION/i.test(String(r.select_type)) || r.table == null)
      check(`EXPLAIN ${label}: fundida (sem DERIVED/MATERIALIZED; vínculo VIVO — plano real)`, bad.length === 0,
        rows.map((r: any) => `${r.select_type}:${r.table}:${r.type}`).join(' · '))
    }

    // ── 4. colação da conexão ─────────────────────────────────────────────────────────────────────────────────────────────────
    for (const coll of ['utf8mb4_unicode_ci', 'utf8mb4_general_ci']) {
      const c2 = await pool.getConnection()
      try {
        await c2.query(`SET NAMES utf8mb4 COLLATE ${coll}`)
        const [r] = await c2.query<any[]>(`SELECT COUNT(*) n FROM \`${CLIENT}\`.vw_user_access
          WHERE tb_user_id = 1 AND tb_institution_id = 1 AND interface_key IN ('orders') AND privilege = 'TRANSMITIR'
            AND profile = 'super' AND delegable = 'N'`)
        const [l] = await c2.query<any[]>(`SELECT COUNT(*) n FROM \`${CENTRAL}\`.vw_user_link WHERE profile = 'super' AND vendor = 'S'`)
        check(`colação ${coll}: comparações sem erro 1267`, Number(r[0].n) === 1 && Number(l[0].n) === 1)
      } catch (e: any) {
        check(`colação ${coll}: comparações sem erro 1267`, false, e.message)
      } finally { c2.release() }
    }

    // ── 6. GRANT: a linha específica do central SOMBREIA o curinga ────────────────────────────────────────────────────────────
    const secret = crypto.randomBytes(18).toString('base64url')
    for (const h of PROBE_HOSTS) {
      await conn.query(`CREATE USER ?@? IDENTIFIED BY ?`, [PROBE_USER, h, secret])
      await conn.query(`GRANT SELECT ON \`prova\\_ua\\_%\`.* TO ?@?`, [PROBE_USER, h])                 // o curinga casa o central
      await conn.query(`GRANT SELECT ON \`${CLIENT}\`.* TO ?@?`, [PROBE_USER, h])
      await conn.query(`GRANT SHOW VIEW ON \`${CENTRAL}\`.* TO ?@?`, [PROBE_USER, h])                  // a linha ESPECÍFICA
      await conn.query(`GRANT SELECT ON \`${CENTRAL}\`.\`vw_user_link\` TO ?@?`, [PROBE_USER, h])
      await conn.query(`GRANT SELECT ON \`${CENTRAL}\`.\`tb_interface\` TO ?@?`, [PROBE_USER, h])
    }
    const probe = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: PROBE_USER, password: secret,
    })
    try {
      const denied = async (sql: string) => {
        try { await probe.query(sql); return false } catch (e: any) { return /denied/i.test(e.message) }
      }
      check('GRANT: tb_user.password NEGADO apesar do curinga', await denied(`SELECT password FROM \`${CENTRAL}\`.tb_user`))
      check('GRANT: tb_institution_has_user NEGADO', await denied(`SELECT * FROM \`${CENTRAL}\`.tb_institution_has_user`))
      const [l] = await probe.query<any[]>(`SELECT COUNT(*) n FROM \`${CENTRAL}\`.vw_user_link`)
      check('GRANT: vw_user_link legível (DEFINER)', Number(l[0].n) > 0)
      const [ps] = await probe.query<any[]>(`SELECT password_set_at FROM \`${CENTRAL}\`.vw_user_link LIMIT 1`)
      check('GRANT: o instante da senha (D-EA7) legível pela view, sem o hash', Array.isArray(ps))
      const [i] = await probe.query<any[]>(`SELECT COUNT(*) n FROM \`${CENTRAL}\`.tb_interface`)
      check('GRANT: tb_interface legível (listada)', Number(i[0].n) > 0)
      const [a] = await probe.query<any[]>(`SELECT COUNT(*) n FROM \`${CLIENT}\`.vw_user_access WHERE tb_user_id = 1`)
      check('GRANT: vw_user_access do cliente legível sem SELECT nas tabelas centrais (DEFINER)', Number(a[0].n) > 0)
    } finally {
      await probe.end()
    }
  } catch (e: any) {
    check('execução da prova', false, e.message)
  } finally {
    try { await dropAll(conn) } catch (e: any) { check('limpeza', false, e.message) }
    conn.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} FALHA(S)` : '\nPROVA OK')
  process.exit(failures ? 1 : 0)
}

main()
