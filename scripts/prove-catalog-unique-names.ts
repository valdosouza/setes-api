/**
 * PROVA do script central 77 (nomes ÚNICOS do catálogo — D-PV43, D-PV63, A-PV28; setes-api:PRIV.E7.P1.T1) em `setes_central`
 * DESCARTÁVEL `setes_uniqprobe_<pid>`: cópias VAZIAS de `setes_central.tb_interface` e `tb_privilege` (CREATE TABLE … LIKE, sem o 77) e o
 * SQL REAL do 77 com o nome `setes_central` trocado. Linhas SINTÉTICAS. NUNCA escreve em `setes_central` (confere antes/depois); apaga o
 * descartável no fim.
 *
 *   B1  o 77 aplica e REAPLICA (idempotente) e a conferência do fim passa
 *   B2  chave VIVA repetida → o 77 falha na pré-conferência, ANTES de qualquer ALTER
 *   B3  verbo repetido — dois vivos, ou um vivo e um EXCLUÍDO, ou dois excluídos → o 77 falha antes de qualquer ALTER
 *   B4  chave repetida entre uma VIVA e uma EXCLUÍDA → só relatada; o 77 passa
 *   B5  forma divergente → o 77 falha alto e não conserta: coluna VIRTUAL, índice homônimo em outra coluna, UNIQUE a mais
 *   B6  depois do 77: 'Orders' × 'orders', 'orders ' × 'orders', 'faturar' × 'FATURAR', 'FATURAR ' × 'FATURAR' → 1062 com o nome do índice
 *       (e `catalogUniqueViolated` o reconhece); renomear (UPDATE) para o nome de um verbo EXCLUÍDO → 1062
 *   B7  "estacionar" (deleted='S') tira a chave do UNIQUE: a nova linha viva com a mesma chave entra
 *   B8  `setes_central` intacta (colunas e índices das duas tabelas iguais antes e depois)
 *   B9  a sonda do boot `assertCatalogUniqueNames` no descartável: erro antes do 77, "ok" depois, erro com cada forma divergente
 *   B10 o CREATE das duas tabelas no canônico 01 nasce na forma que a sonda aceita, e o 77 sobre ele não muda nada
 *   B11 (gate adversarial) `description`/`i18n_key` em utf8mb4_bin → o 77 para antes do ALTER; trocada depois → sonda e 77 recusam
 *   B12 (gate adversarial) UNIQUE homônimo USING HASH ou com o nome em MAIÚSCULAS → o 77 falha alto e a sonda recusa
 *
 * Uso (Git Bash): SQL_DIR=D:/Analise/Gestao2027/sql npx tsx --require tsconfig-paths/register scripts/prove-catalog-unique-names.ts
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import {
  assertCatalogUniqueNames, catalogUniqueViolated, isDeadlock, retryOnDeadlock, INTERFACE_KEY_UNIQUE, PRIVILEGE_NAME_UNIQUE,
} from '@shared/auth/catalog-unique'

const PROBE = `setes_uniqprobe_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const I = `\`${PROBE}\`.\`tb_interface\``
const P = `\`${PROBE}\`.\`tb_privilege\``
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}
type Conn = mysql.PoolConnection
async function run77(conn: Conn): Promise<string | null> {
  try {
    const sql = fs.readFileSync(path.join(SQL_DIR, '77_catalog_unique_names_ddl.sql'), 'utf8').replace(/setes_central/g, PROBE)
    for (const st of splitStatements(sql)) await conn.query(st)
    return null
  } catch (e: any) { return `${e.errno ?? ''} ${String(e.message).slice(0, 160)}` }
}
async function attempt(conn: Conn, sql: string, params: unknown[] = []): Promise<any> {
  try { await conn.query(sql, params); return null } catch (e: any) { return e }
}
// o servidor do dev roda com lower_case_table_names: o nome da tabela-sinal volta em minúsculas na mensagem
const failedWith = (err: string | null, marker: string) => !!err && err.toLowerCase().includes(marker.toLowerCase())
async function probeSonda(): Promise<string> {
  try { return await assertCatalogUniqueNames(pool, PROBE) } catch (e: any) { return `ERRO ${String(e.message)}` }
}
async function shape(conn: Conn, schema: string): Promise<string> {
  const [c] = await conn.query<any[]>(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('tb_interface','tb_privilege') ORDER BY TABLE_NAME, ORDINAL_POSITION`, [schema])
  const [s] = await conn.query<any[]>(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('tb_interface','tb_privilege') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [schema])
  return JSON.stringify([c, s])
}
async function hasLive(conn: Conn): Promise<boolean> {
  const [r] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_interface' AND COLUMN_NAME = 'i18n_key_live'`, [PROBE])
  return Number(r[0].n) > 0
}
/** As duas tabelas de novo, vazias e SEM o 77 (o setes_central pode já tê-lo — a cópia volta ao estado de antes). */
async function fresh(conn: Conn): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS ${I}, ${P}`)
  await conn.query(`CREATE TABLE ${I} LIKE \`setes_central\`.\`tb_interface\``)
  await conn.query(`CREATE TABLE ${P} LIKE \`setes_central\`.\`tb_privilege\``)
  await conn.query(`ALTER TABLE ${I} DROP INDEX IF EXISTS ${INTERFACE_KEY_UNIQUE}`)
  await conn.query(`ALTER TABLE ${I} DROP COLUMN IF EXISTS i18n_key_live`)
  await conn.query(`ALTER TABLE ${P} DROP INDEX IF EXISTS ${PRIVILEGE_NAME_UNIQUE}`)
}
const iface = (conn: Conn, id: number, key: string | null, deleted = 'N') => conn.query(
  `INSERT INTO ${I} (id, i18n_key, description, kind, created_at, updated_at, deleted) VALUES (?, ?, ?, 'T', NOW(), NOW(), ?)`,
  [id, key, `tela ${id}`, deleted])
const verb = (conn: Conn, id: number, name: string, deleted = 'N') => conn.query(
  `INSERT INTO ${P} (id, description, created_at, updated_at, deleted) VALUES (?, ?, NOW(), NOW(), ?)`, [id, name, deleted])

async function main(): Promise<void> {
  const conn = await pool.getConnection()
  let before = ''
  try {
    await conn.query('SET NAMES utf8mb4')
    before = await shape(conn, 'setes_central')
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``)
    await conn.query(`CREATE DATABASE \`${PROBE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)

    // ---- B9 (antes) + B1 + B6 + B7 + B4 sobre o mesmo par de tabelas
    await fresh(conn)
    await iface(conn, 1, 'orders'); await iface(conn, 2, 'customers'); await iface(conn, 3, null); await iface(conn, 4, null)
    await verb(conn, 1, 'INSERIR'); await verb(conn, 5, 'FATURAR'); await verb(conn, 7, 'CANCELAR', 'S')
    check('B9  a sonda recusa ANTES do 77', (await probeSonda()).startsWith('ERRO'), await probeSonda())
    check('B1  o 77 aplica', (await run77(conn)) === null)
    const second = await run77(conn)
    check('B1  o 77 REAPLICA sem erro (idempotente)', second === null, second ?? '')
    check('B9  a sonda diz ok depois do 77', (await probeSonda()) === 'ok (coluna gerada e 2 UNIQUE)', await probeSonda())
    const [gen] = await conn.query<any[]>(`SELECT id, i18n_key_live k FROM ${I} ORDER BY id`)
    check('B1  a coluna gerada = a chave nas vivas, NULL sem chave', JSON.stringify(gen.map((r: any) => r.k)) === '["orders","customers",null,null]')
    check('B1  duas interfaces vivas SEM chave convivem (NULL não colide)', true)

    for (const [label, sql, params, kind] of [
      ["B6  'Orders' × 'orders' (caixa)", `INSERT INTO ${I} (id, i18n_key, description, kind, deleted) VALUES (10, ?, 'x', 'T', 'N')`, ['Orders'], 'interface-key'],
      ["B6  'orders ' × 'orders' (PAD SPACE)", `INSERT INTO ${I} (id, i18n_key, description, kind, deleted) VALUES (11, ?, 'x', 'T', 'N')`, ['orders '], 'interface-key'],
      ["B6  'faturar' × 'FATURAR'", `INSERT INTO ${P} (id, description, deleted) VALUES (20, ?, 'N')`, ['faturar'], 'privilege-name'],
      ["B6  'FATURAR ' × 'FATURAR'", `INSERT INTO ${P} (id, description, deleted) VALUES (21, ?, 'N')`, ['FATURAR '], 'privilege-name'],
      ['B6  verbo novo com o nome de um EXCLUÍDO (CANCELAR, id 7)', `INSERT INTO ${P} (id, description, deleted) VALUES (22, ?, 'N')`, ['Cancelar'], 'privilege-name'],
      ['B6  renomear (UPDATE) INSERIR para o nome do EXCLUÍDO', `UPDATE ${P} SET description = ? WHERE id = 1`, ['CANCELAR'], 'privilege-name'],
      ['B6  dar a chave viva a outra linha (UPDATE)', `UPDATE ${I} SET i18n_key = ? WHERE id = 3`, ['customers'], 'interface-key'],
    ] as const) {
      const err = await attempt(conn, sql, [...params])
      check(label, !!err && err.errno === 1062 && catalogUniqueViolated(err) === kind, err ? `${err.errno} ${String(err.message).slice(0, 90)}` : 'GRAVOU')
    }
    check('B6  1062 de outro índice (a PK) não é confundido', catalogUniqueViolated(await attempt(conn, `INSERT INTO ${P} (id, description) VALUES (1, 'NOVO')`)) === null)

    await conn.query(`UPDATE ${I} SET deleted = 'S' WHERE id = 1`)                               // estacionar
    const park = await attempt(conn, `INSERT INTO ${I} (id, i18n_key, description, kind, deleted) VALUES (12, 'orders', 'x', 'T', 'N')`)
    check('B7  estacionar (deleted=S) libera a chave para a nova linha viva', park === null, park?.message ?? '')
    const revive = await attempt(conn, `UPDATE ${I} SET deleted = 'N' WHERE id = 1`)
    check('B7  reviver a estacionada com a chave já viva em outra → 1062', revive?.errno === 1062 && catalogUniqueViolated(revive) === 'interface-key')
    const again = await run77(conn)
    check('B4  chave repetida viva × EXCLUÍDA (orders 1:S, 12:N) → relatada, o 77 passa', again === null, again ?? '')

    // ---- B2: duas vivas com a mesma chave (comparadas como o UNIQUE compara) → para antes do ALTER
    await fresh(conn)
    await iface(conn, 1, 'orders'); await iface(conn, 2, 'Orders')
    const b2 = await run77(conn)
    check('B2  chave viva repetida (orders × Orders) → o 77 falha', failedWith(b2, 'SQL77_FALHOU_chave_viva_repetida'), b2 ?? 'PASSOU')
    check('B2  … ANTES de qualquer ALTER (nenhuma coluna criada)', !(await hasLive(conn)))

    // ---- B3: verbo repetido em qualquer combinação
    for (const [label, rows] of [
      ['dois vivos', [['FATURAR', 'N'], ['faturar', 'N']]],
      ['um vivo e um EXCLUÍDO', [['FATURAR', 'N'], ['FATURAR', 'S']]],
      ['dois EXCLUÍDOS', [['ANTIGO', 'S'], ['antigo ', 'S']]],
    ] as const) {
      await fresh(conn)
      await verb(conn, 1, rows[0][0], rows[0][1]); await verb(conn, 2, rows[1][0], rows[1][1])
      const b3 = await run77(conn)
      check(`B3  verbo repetido (${label}) → o 77 falha antes do ALTER`, failedWith(b3, 'SQL77_FALHOU_verbo_repetido') && !(await hasLive(conn)), b3 ?? 'PASSOU')
    }

    // ---- B5: forma divergente → falha alto, sem consertar; a sonda também recusa
    await fresh(conn)
    await conn.query(`ALTER TABLE ${I} ADD COLUMN i18n_key_live varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
      GENERATED ALWAYS AS (CASE WHEN deleted = 'N' THEN i18n_key END) VIRTUAL`)
    const b5a = await run77(conn)
    check('B5  coluna VIRTUAL homônima → o 77 falha', failedWith(b5a, 'SQL77_FALHOU_coluna_i18n_key_live_com_outra_forma'), b5a ?? 'PASSOU')
    check('B9  … e a sonda recusa', (await probeSonda()).includes('outra forma'))

    await fresh(conn)
    await conn.query(`ALTER TABLE ${P} ADD UNIQUE KEY ${PRIVILEGE_NAME_UNIQUE} (id, description)`)
    const b5b = await run77(conn)
    check('B5  índice homônimo sobre outras colunas → o 77 falha', failedWith(b5b, 'SQL77_FALHOU_indice_uq_privilege_description_com_outra_forma'), b5b ?? 'PASSOU')

    await fresh(conn)
    await conn.query(`ALTER TABLE ${I} ADD UNIQUE KEY uq_interface_description (description)`)
    const b5c = await run77(conn)
    check('B5  UNIQUE a mais (§9 regra 10) → a conferência do 77 falha', failedWith(b5c, 'SQL77_FALHOU_conferencia_dos_nomes_unicos'), b5c ?? 'PASSOU')
    check('B9  … e a sonda recusa citando o índice a mais', (await probeSonda()).includes('tb_interface.uq_interface_description'))

    // ---- B11 (gate adversarial do PRIV.E7.P1): a colação É a regra — `description`/`i18n_key` em utf8mb4_bin → o 77 para ANTES do ALTER
    for (const [table, column] of [['tb_privilege', 'description'], ['tb_interface', 'i18n_key']] as const) {
      await fresh(conn)
      await conn.query(`ALTER TABLE \`${PROBE}\`.\`${table}\` MODIFY \`${column}\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL`)
      if (table === 'tb_interface') { await iface(conn, 1, 'orders'); await iface(conn, 2, 'Orders') }
      const e = await run77(conn)
      check(`B11 ${table}.${column} em utf8mb4_bin → o 77 falha antes do ALTER`,
        failedWith(e, 'SQL77_FALHOU_colacao_de_i18n_key_ou_description') && !(await hasLive(conn)), e ?? 'PASSOU')
    }
    // a colação trocada DEPOIS do 77 → a sonda recusa
    await fresh(conn)
    check('B11 o 77 aplica numa cópia limpa', (await run77(conn)) === null)
    await conn.query(`ALTER TABLE ${P} MODIFY description varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL`)
    check('B11 description em bin depois do 77 → a sonda recusa', (await probeSonda()).includes('tb_privilege.description fora da colação'))
    const e11 = await run77(conn)
    check('B11 … e o 77 também (conferência 2a)', failedWith(e11, 'SQL77_FALHOU_colacao'), e11 ?? 'PASSOU')

    // ---- B12: UNIQUE USING HASH e homônimo em MAIÚSCULAS → o 77 falha alto e a sonda recusa
    await fresh(conn)
    await conn.query(`ALTER TABLE ${P} ADD UNIQUE KEY ${PRIVILEGE_NAME_UNIQUE} (description) USING HASH`)
    const [ht] = await conn.query<any[]>(`SELECT INDEX_TYPE t FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_privilege'
      AND INDEX_NAME = ?`, [PROBE, PRIVILEGE_NAME_UNIQUE])
    const e12a = await run77(conn)
    check(`B12 UNIQUE homônimo ${ht[0]?.t ?? '?'} → o 77 falha (só BTREE é idêntico)`,
      ht[0]?.t === 'BTREE' ? true : failedWith(e12a, 'SQL77_FALHOU_indice_uq_privilege_description_com_outra_forma'), e12a ?? 'PASSOU')
    await fresh(conn)
    await conn.query(`ALTER TABLE ${P} ADD UNIQUE KEY UQ_PRIVILEGE_DESCRIPTION (description)`)
    const e12b = await run77(conn)
    check('B12 homônimo em MAIÚSCULAS → o 77 falha alto (não passa por idêntico)', e12b !== null, e12b ?? 'PASSOU')
    check('B12 … e a sonda recusa', (await probeSonda()).startsWith('ERRO'))

    // ---- B13 (re-gate do delta, M1): corrida REAL de dois POST de verbo com duas conexões — o MESMO SQL do `privileges.repository`
    // (conferência do nome; MAX+1 FOR UPDATE + INSERT numa transação) sob `retryOnDeadlock`, como o service. Mesmo nome: 1 grava e o outro
    // termina no "nome tomado" (conferência ou 1062), nunca 2 gravações; nomes diferentes: os dois gravam (antes o perdedor era 1213).
    await fresh(conn)
    await run77(conn)
    await verb(conn, 1, 'INSERIR')
    const c1 = await pool.getConnection(), c2 = await pool.getConnection()
    const post = async (c: Conn, name: string): Promise<string> => {
      try {
        return await retryOnDeadlock(async () => {
          const [seen] = await c.query<any[]>(`SELECT id FROM ${P} WHERE description = ?`, [name])
          if (seen.length) return 'tomado'
          await c.beginTransaction()
          try {
            const [mx] = await c.query<any[]>(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${P} FOR UPDATE`)
            await c.query(`INSERT INTO ${P} (id, description, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`, [mx[0].n, name])
            await c.commit()
            return 'gravou'
          } catch (e) { await c.rollback().catch(() => undefined); throw e }
        })
      } catch (e: any) {
        if (catalogUniqueViolated(e) === 'privilege-name') return 'tomado'
        return isDeadlock(e) ? 'ocupado(1213)' : `ERRO ${e.errno ?? ''} ${e.message}`
      }
    }
    const same: Record<string, number> = {}, diff: Record<string, number> = {}
    for (let i = 0; i < 30; i++) {
      const r = await Promise.all([post(c1, `RACE${i}`), post(c2, `race${i}`)])
      const k = r.slice().sort().join('+'); same[k] = (same[k] ?? 0) + 1
      const d = await Promise.all([post(c1, `A${i}`), post(c2, `B${i}`)])
      const kd = d.slice().sort().join('+'); diff[kd] = (diff[kd] ?? 0) + 1
    }
    c1.release(); c2.release()
    check('B13 mesmo nome em paralelo (30 pares): sempre 1 grava e o outro vê o nome tomado', Object.keys(same).every(k => k === 'gravou+tomado'),
      JSON.stringify(same))
    check('B13 nomes diferentes em paralelo (30 pares): os dois gravam', Object.keys(diff).every(k => k === 'gravou+gravou'), JSON.stringify(diff))

    // ---- B10: o espelho no canônico 01 — o CREATE das duas tabelas, sozinho, nasce na forma que a sonda aceita (base nova = já com o 77)
    await conn.query(`DROP TABLE IF EXISTS ${I}, ${P}`)
    const canon = fs.readFileSync(path.join(SQL_DIR, '01_setes_central_ddl.sql'), 'utf8').replace(/\r\n/g, '\n')
    for (const table of ['tb_privilege', 'tb_interface']) {
      const m = new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\` \\([\\s\\S]*?\\n\\) ENGINE[^;]*;`).exec(canon)
      if (!m) { check(`B10 o 01 tem o CREATE de ${table}`, false); continue }
      for (const st of splitStatements(m[0].replace(`\`${table}\``, `\`${PROBE}\`.\`${table}\``))) await conn.query(st)
    }
    check('B10 o CREATE do 01 nasce com a coluna e os 2 UNIQUE na forma da sonda', (await probeSonda()) === 'ok (coluna gerada e 2 UNIQUE)', await probeSonda())
    const b10 = await run77(conn)
    check('B10 … e o 77 sobre ele não muda nada (idêntico)', b10 === null, b10 ?? '')
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    check('B8  setes_central intacta (colunas e índices das duas tabelas)', (await shape(conn, 'setes_central')) === before)
    conn.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} FALHA(S)` : '\nTODAS OK')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
