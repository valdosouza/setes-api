/**
 * PROVA do script central 76 (o PAPEL de quem definiu a senha vigente — D-UC19, A-UC9; setes-api:CONV.E2.P7.T1) em `setes_central`
 * DESCARTÁVEL `setes_authorprobe_<pid>`: cópia VAZIA de `setes_central.tb_user` (CREATE TABLE … LIKE) e o SQL REAL do 76 com o nome
 * `setes_central` trocado. Usuários SINTÉTICOS. NUNCA escreve em `setes_central` (confere antes/depois); apaga o descartável no fim.
 *
 *   A1  o 76 aplica e reaplica (re-executável) e a conferência do fim passa
 *   A2  as linhas de ANTES (com e sem senha) ficam com o papel NULL — nenhum preenchimento (A-UC9)
 *   A3  a coluna fica logo depois de `password_set_at`, char(1), anulável, sem padrão
 *   A4  os escritores de hoje (INSERT sem a coluna) seguem gravando, com o papel NULL
 *   A5  os caminhos legítimos: T, A e O com senha e instante; limpar a senha limpando o papel no mesmo UPDATE
 *   A6  cada CHECK recusa o seu caso pelo NOME (4025): fora do domínio ('X'), minúscula ('t' — binário), papel sem senha, papel sem instante
 *   A7  o ADD CONSTRAINT confere as linhas que já existem: uma linha com papel e sem senha faz o 76 falhar alto
 *   A8  `setes_central` intacta
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-user-password-author.ts   (SQL_DIR = o repositório sql)
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_authorprobe_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}
async function run(conn: mysql.PoolConnection): Promise<string | null> {
  try {
    const sql = fs.readFileSync(path.join(SQL_DIR, '76_user_password_author_ddl.sql'), 'utf8').replace(/setes_central/g, PROBE)
    for (const st of splitStatements(sql)) await conn.query(st)
    return null
  } catch (e: any) { return `${e.errno ?? ''} ${String(e.message).slice(0, 140)}` }
}
async function attempt(conn: mysql.PoolConnection, sql: string, params: unknown[] = []): Promise<string | null> {
  try { await conn.query(sql, params); return null } catch (e: any) { return `${e.errno} ${String(e.message)}` }
}
const refusedBy = (err: string | null, name: string) => !!err && /^4025\b/.test(err) && err.includes(name)
async function centralColumns(conn: mysql.PoolConnection): Promise<string[]> {
  const [rows] = await conn.query<any[]>(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_user' ORDER BY ORDINAL_POSITION`)
  return rows.map((r: any) => r.c)
}

async function main(): Promise<void> {
  const conn = await pool.getConnection()
  const U = `\`${PROBE}\`.\`tb_user\``
  let before: string[] = []
  try {
    await conn.query('SET NAMES utf8mb4')
    before = await centralColumns(conn)   // o retrato de antes (o 76 pode já estar aplicado no setes_central — a prova não depende disso)
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``)
    await conn.query(`CREATE DATABASE \`${PROBE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    await conn.query(`CREATE TABLE ${U} LIKE \`setes_central\`.\`tb_user\``)
    // se o setes_central já tiver o 76, a cópia nasce com ele: volta ao estado de antes para provar o 76 do zero
    await conn.query(`ALTER TABLE ${U} DROP CONSTRAINT IF EXISTS ck_user_password_author_role, DROP CONSTRAINT IF EXISTS ck_user_password_author_has_password`).catch(() => undefined)
    await conn.query(`ALTER TABLE ${U} DROP COLUMN IF EXISTS password_author_role`)
    await conn.query(`ALTER TABLE ${U} ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    // linhas de ANTES: com senha (e instante), com senha sem instante (anterior ao 70), sem senha (setes-sync)
    await conn.query(`INSERT INTO ${U} (id, password, password_set_at, active, deleted, created_at) VALUES
      (1, 'HASH1', NOW(), 'S', 'N', NOW()), (2, 'HASH2', NULL, 'S', 'N', NOW()), (3, NULL, NULL, 'N', 'N', NOW())`)

    const r1 = await run(conn), r2 = await run(conn)
    check('A1: o 76 aplica (com a conferência do fim)', r1 === null, String(r1))
    check('A1: o 76 reaplica sem erro (re-executável)', r2 === null, String(r2))

    const [old] = await conn.query<any[]>(`SELECT id, password_author_role r FROM ${U} ORDER BY id`)
    check('A2: as linhas de antes ficam com o papel NULL (A-UC9 — nada se inventa)', old.every((x: any) => x.r === null), JSON.stringify(old))

    const [cols] = await conn.query<any[]>(`SELECT COLUMN_NAME c, DATA_TYPE t, CHARACTER_MAXIMUM_LENGTH l, IS_NULLABLE n, COLUMN_DEFAULT d
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user' ORDER BY ORDINAL_POSITION`, [PROBE])
    const names = cols.map((c: any) => c.c)
    const col = cols.find((c: any) => c.c === 'password_author_role')
    check('A3: logo depois de password_set_at, char(1), anulável, sem padrão',
      names.indexOf('password_author_role') === names.indexOf('password_set_at') + 1 && col?.t === 'char' && Number(col?.l) === 1
        && col?.n === 'YES' && (col?.d === null || col?.d === 'NULL'), JSON.stringify(col))

    const a4 = await attempt(conn, `INSERT INTO ${U} (id, password, password_set_at, active, deleted, created_at) VALUES (4, 'H4', NOW(), 'S', 'N', NOW())`)
    const [[r4]] = await conn.query<any[]>(`SELECT password_author_role r FROM ${U} WHERE id = 4`) as any
    check('A4: o INSERT de hoje (sem a coluna) segue gravando, com papel NULL', a4 === null && r4?.r === null, String(a4))

    const legit: Array<[string, string, unknown[]]> = [
      ['T com senha e instante', `UPDATE ${U} SET password_author_role = 'T' WHERE id = 1`, []],
      ['A na criação', `INSERT INTO ${U} (id, password, password_set_at, password_author_role, active, deleted, created_at) VALUES (5, 'H5', NOW(), 'A', 'S', 'N', NOW())`, []],
      ['O pelo operador', `UPDATE ${U} SET password = 'H4b', password_set_at = NOW(), password_author_role = 'O' WHERE id = 4`, []],
      ['limpar a senha limpando o papel no mesmo UPDATE', `UPDATE ${U} SET password = NULL, password_set_at = NULL, password_author_role = NULL WHERE id = 5`, []],
    ]
    for (const [label, sql, p] of legit) {
      const e = await attempt(conn, sql, p)
      check(`A5: ${label}`, e === null, String(e))
    }

    const bad: Array<[string, string, string]> = [
      ['fora do domínio (X)', `UPDATE ${U} SET password_author_role = 'X' WHERE id = 1`, 'ck_user_password_author_role'],
      ['minúscula (t — o domínio é binário)', `UPDATE ${U} SET password_author_role = 't' WHERE id = 1`, 'ck_user_password_author_role'],
      ['papel sem senha', `UPDATE ${U} SET password_author_role = 'T' WHERE id = 3`, 'ck_user_password_author_has_password'],
      ['papel sem o instante', `UPDATE ${U} SET password_author_role = 'A' WHERE id = 2`, 'ck_user_password_author_has_password'],
      ['limpar a senha deixando o papel', `UPDATE ${U} SET password = NULL WHERE id = 1`, 'ck_user_password_author_has_password'],
    ]
    for (const [label, sql, name] of bad) {
      const e = await attempt(conn, sql)
      check(`A6: o banco recusa ${label} pelo CHECK ${name}`, refusedBy(e, name), String(e))
    }

    // A7 — uma linha violando (papel sem senha) existe ANTES: o 76 tem de falhar alto (o ADD confere as linhas)
    await conn.query(`ALTER TABLE ${U} DROP CONSTRAINT IF EXISTS ck_user_password_author_has_password`)
    await conn.query(`UPDATE ${U} SET password_author_role = 'T' WHERE id = 3`)
    const r7 = await run(conn)
    check('A7: com uma linha violando, o 76 FALHA alto (4025) em vez de seguir', !!r7 && /4025/.test(r7), String(r7))
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    const after = await centralColumns(conn)
    check('A8: setes_central intacta (mesmas colunas antes e depois)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
    conn.release()
    await pool.end()
  }
  console.log(failures === 0 ? '\nPROVA OK' : `\nPROVA FALHOU (${failures})`)
  if (failures > 0) process.exitCode = 1
}

main().catch(async (e) => {
  console.error('ERRO', e)
  process.exitCode = 1
  try { await pool.end() } catch { /* já fechado */ }
})
