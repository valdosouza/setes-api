/**
 * PROVA do script central 75 (convite, aceite e retirada no vínculo — D-UC10/D-UC12/D-UC14/D-UC15; setes-api:CONV.E2.P1) em
 * `setes_central` DESCARTÁVEL `setes_convprobe_<pid>`: cópia VAZIA (CREATE TABLE … LIKE) das tabelas centrais que o script e a
 * `vw_user_link` (sql/70) leem, e o SQL REAL dos scripts com o nome `setes_central` trocado pelo descartável. Usuários e institutions
 * SINTÉTICOS. NUNCA escreve em `setes_central` (confere antes/depois); apaga o descartável no fim, inclusive em falha.
 *
 *   C1  o 75 aplica e reaplica (re-executável) e a conferência do fim passa
 *   C2  os vínculos que JÁ existiam (ativo, inativo, `active` NULL, `kind='SYNC'`) ficam "sem convite" (as quatro colunas vazias) e a
 *       `vw_user_link` devolve exatamente o mesmo antes e depois (nenhum leitor do acesso muda)
 *   C3  os escritores de hoje (INSERT sem as colunas novas — setes-api, setes-sync, seed 02) seguem gravando, sem convite
 *   C4  os caminhos legítimos: criação no 1º estabelecimento (convite = aceite = agora, ativo), convite pendente (inativo), aceite pelo
 *       login (o UPDATE do write-once), retirada, novo convite depois da retirada
 *   C5  cada CHECK recusa o seu caso pelo NOME (4025), inclusive `'s'` minúsculo como ativo e ativar o pendente sem o aceite; a fk do
 *       convidante recusa usuário inexistente (1452)
 *   C6  a leitura "aguardando aceite" (convite, sem aceite, sem retirada) devolve só os pendentes — nunca o vínculo sem convite inativo
 *   C7  o ADD CONSTRAINT confere as linhas que já existem: uma linha pendente ATIVA faz o 75 falhar alto
 *   C8  a conferência do fim FALHA de verdade (sessão com `check_constraint_checks = 0` → SQL75_FALHOU)
 *   C9  `setes_central` intacta (as colunas novas NÃO nascem lá por esta prova)
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-institution-user-invite.ts   (SQL_DIR = o repositório sql)
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_convprobe_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const CENTRAL_TABLES = ['tb_user', 'tb_institution', 'tb_institution_has_user', 'tb_interface', 'tb_privilege',
  'tb_interface_has_privilege']
const NEW_COLUMNS = ['tb_user_inviter_id', 'invited_at', 'accepted_at', 'invite_withdrawn_at']

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const scriptSql = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/setes_central/g, PROBE)

async function run(conn: mysql.PoolConnection, file: string): Promise<string | null> {
  try {
    for (const st of splitStatements(scriptSql(file))) await conn.query(st)
    return null
  } catch (e: any) {
    return `${e.errno ?? ''} ${e.code ?? ''} ${String(e.message).slice(0, 120)}`.trim()
  }
}

/** Executa e devolve o erro (null = passou) — para as recusas dos CHECKs. */
async function attempt(conn: mysql.PoolConnection, sql: string, params: unknown[] = []): Promise<string | null> {
  try { await conn.query(sql, params); return null } catch (e: any) { return `${e.errno} ${String(e.message)}` }
}
const refusedBy = (err: string | null, name: string) => !!err && /^4025\b/.test(err) && err.includes(name)

async function centralColumns(conn: mysql.PoolConnection): Promise<string[]> {
  const [rows] = await conn.query<any[]>(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user' ORDER BY ORDINAL_POSITION`)
  return rows.map((r: any) => r.c)
}

async function main(): Promise<void> {
  const conn = await pool.getConnection()
  const T = (t: string) => `\`${PROBE}\`.\`${t}\``
  const IHU = T('tb_institution_has_user')
  try {
    await conn.query('SET NAMES utf8mb4')
    const centralBefore = await centralColumns(conn)
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``)
    await conn.query(`CREATE DATABASE \`${PROBE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    for (const t of CENTRAL_TABLES) await conn.query(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    // a cópia é do setes_central de HOJE: sem as colunas do 75 (se já tiverem nascido lá, a prova não vale)
    check('C9 (antes): o setes_central do dev ainda não tem as colunas do 75',
      NEW_COLUMNS.every(c => !centralBefore.includes(c)), JSON.stringify(centralBefore))

    // dados sintéticos: usuários 1..6, institutions 1..3; vínculos do regime de hoje (antes do 75)
    for (let u = 1; u <= 6; u++) {
      await conn.query(`INSERT INTO ${T('tb_user')} (id, password, active, deleted, created_at) VALUES (?, 'HASH', 'S', 'N', NOW())`, [u])
    }
    await conn.query(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted) VALUES
      (1, 'setes_zconv1', 'S', 'N'), (2, 'setes_zconv2', 'S', 'N'), (3, 'setes_zconv3', 'S', 'N')`)
    await conn.query(`INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, created_at, deleted) VALUES
      (1, 1, 'admin', 'S', NOW(), 'N'), (1, 2, 'user', 'N', NOW(), 'N'), (1, 3, 'user', NULL, NULL, 'N'), (2, 4, 'SYNC', 'N', NOW(), 'N'),
      (2, 1, 'admin', 'S', NOW(), 'N')`)

    // a vw_user_link (sql/70) ANTES do 75
    const r70 = await run(conn, '70_user_access_central_views.sql')
    check('sql/70 aplicado no descartável (para comparar a vw_user_link)', r70 === null, String(r70))
    const linkRows = async () => (await conn.query<any[]>(`SELECT tb_user_id u, tb_institution_id i, profile FROM ${T('vw_user_link')}
      ORDER BY 2, 1`))[0].map((r: any) => `${r.i}/${r.u}:${r.profile}`)
    const linkBefore = await linkRows()

    // C1 — aplica e reaplica
    const first = await run(conn, '75_institution_user_invite_ddl.sql')
    const second = await run(conn, '75_institution_user_invite_ddl.sql')
    check('C1: o 75 aplica (com a conferência do fim)', first === null, String(first))
    check('C1: o 75 reaplica sem erro (re-executável)', second === null, String(second))

    // C2 — o que já existia fica sem convite; a vw_user_link não muda
    const [legacy] = await conn.query<any[]>(`SELECT COUNT(*) n FROM ${IHU}
      WHERE tb_user_inviter_id IS NULL AND invited_at IS NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL`)
    check('C2: os 5 vínculos de antes (ativo, inativo, active NULL, SYNC) ficam sem convite — nada inventado', Number(legacy[0].n) === 5,
      JSON.stringify(legacy))
    const linkAfter = await linkRows()
    check('C2: a vw_user_link devolve o mesmo antes e depois do 75', eq(linkBefore, linkAfter), `${JSON.stringify(linkBefore)} / ${JSON.stringify(linkAfter)}`)

    // C3 — os escritores de hoje (sem as colunas novas)
    const w = await attempt(conn, `INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
      VALUES (3, 5, 'SYNC', 'N', NOW(), NOW(), 'N') ON DUPLICATE KEY UPDATE active = 'S', updated_at = NOW()`)
    const w2 = await attempt(conn, `INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
      VALUES (3, 5, 'SYNC', 'S', NOW(), NOW(), 'N') ON DUPLICATE KEY UPDATE active = 'S', updated_at = NOW()`)
    check('C3: o upsert do escritor de hoje (sem as colunas) grava e ativa o vínculo SEM convite', w === null && w2 === null, `${w} / ${w2}`)

    // C4 — caminhos legítimos
    const created = await attempt(conn, `INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, tb_user_inviter_id, invited_at,
      accepted_at, created_at, deleted) VALUES (3, 6, 'admin', 'S', 1, NOW(), NOW(), NOW(), 'N')`)
    check('C4: criação no 1º estabelecimento (convite = aceite = agora, ativo)', created === null, String(created))
    const invited = await attempt(conn, `INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, tb_user_inviter_id, invited_at,
      created_at, deleted) VALUES (2, 2, 'user', 'N', 1, NOW(), NOW(), 'N')`)
    const invited2 = await attempt(conn, `INSERT INTO ${IHU} (tb_institution_id, tb_user_id, kind, active, tb_user_inviter_id, invited_at,
      created_at, deleted) VALUES (2, 3, 'user', 'N', NULL, NOW(), NOW(), 'N')`)
    check('C4: convite pendente (inativo), com e sem quem convidou', invited === null && invited2 === null, `${invited} / ${invited2}`)

    // C6 — a leitura "aguardando aceite"
    const pending = async () => (await conn.query<any[]>(`SELECT tb_institution_id i, tb_user_id u FROM ${IHU}
      WHERE invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL AND deleted = 'N' ORDER BY 1, 2`))[0]
      .map((r: any) => `${r.i}/${r.u}`)
    check('C6: aguardando aceite = só os convites pendentes (o vínculo inativo sem convite e o SYNC ficam fora)',
      eq(await pending(), ['2/2', '2/3']), JSON.stringify(await pending()))

    const [acc] = await conn.query<any>(`UPDATE ${IHU} SET active = 'S', accepted_at = NOW(), updated_at = NOW()
      WHERE tb_user_id = 2 AND invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL AND deleted = 'N'`)
    const [acc2] = await conn.query<any>(`UPDATE ${IHU} SET active = 'S', accepted_at = NOW(), updated_at = NOW()
      WHERE tb_user_id = 2 AND invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL AND deleted = 'N'`)
    const [st2] = await conn.query<any[]>(`SELECT tb_institution_id i, active a FROM ${IHU} WHERE tb_user_id = 2 ORDER BY 1`)
    check('C4: o aceite pelo login ativa SÓ o convite pendente (1 linha) e é write-once (a 2ª vez = 0); o inativo sem convite fica inativo',
      acc.affectedRows === 1 && acc2.affectedRows === 0 && eq(st2.map((r: any) => `${r.i}:${r.a}`), ['1:N', '2:S']),
      `${acc.affectedRows}/${acc2.affectedRows} ${JSON.stringify(st2)}`)

    const wd = await attempt(conn, `UPDATE ${IHU} SET invite_withdrawn_at = NOW() WHERE tb_institution_id = 2 AND tb_user_id = 3`)
    check('C4: retirar o convite pendente', wd === null && eq(await pending(), []), `${wd} ${JSON.stringify(await pending())}`)
    const [accW] = await conn.query<any>(`UPDATE ${IHU} SET active = 'S', accepted_at = NOW()
      WHERE tb_user_id = 3 AND invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL AND deleted = 'N'`)
    check('C4: o login de quem teve o convite retirado não o ativa', accW.affectedRows === 0, String(accW.affectedRows))
    const reinv = await attempt(conn, `UPDATE ${IHU} SET tb_user_inviter_id = 1, invited_at = NOW(), invite_withdrawn_at = NULL
      WHERE tb_institution_id = 2 AND tb_user_id = 3`)
    check('C4: novo convite depois da retirada volta a ficar pendente', reinv === null && eq(await pending(), ['2/3']),
      `${reinv} ${JSON.stringify(await pending())}`)

    // C5 — cada CHECK pelo nome
    check('C5: quem convidou sem o instante do convite → ck_ihu_inviter_has_invite',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET tb_user_inviter_id = 1 WHERE tb_institution_id = 1 AND tb_user_id = 2`),
        'ck_ihu_inviter_has_invite'))
    check('C5: ativar o convite pendente sem o aceite → ck_ihu_pending_inactive',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET active = 'S' WHERE tb_institution_id = 2 AND tb_user_id = 3`), 'ck_ihu_pending_inactive'))
    check("C5: 's' minúsculo também conta como ativo → ck_ihu_pending_inactive",
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET active = 's' WHERE tb_institution_id = 2 AND tb_user_id = 3`), 'ck_ihu_pending_inactive'))
    check('C5: aceite sem convite → ck_ihu_accept_after_invite',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET accepted_at = NOW() WHERE tb_institution_id = 1 AND tb_user_id = 2`),
        'ck_ihu_accept_after_invite'))
    check('C5: aceite antes do convite → ck_ihu_accept_after_invite',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET accepted_at = invited_at - INTERVAL 1 SECOND WHERE tb_institution_id = 2 AND tb_user_id = 3`),
        'ck_ihu_accept_after_invite'))
    check('C5: retirar convite já aceito → ck_ihu_withdraw_pending',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET invite_withdrawn_at = NOW() WHERE tb_institution_id = 2 AND tb_user_id = 2`),
        'ck_ihu_withdraw_pending'))
    check('C5: retirar sem convite → ck_ihu_withdraw_pending',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET invite_withdrawn_at = NOW() WHERE tb_institution_id = 1 AND tb_user_id = 2`),
        'ck_ihu_withdraw_pending'))
    check('C5: retirada antes do convite → ck_ihu_withdraw_pending',
      refusedBy(await attempt(conn, `UPDATE ${IHU} SET invite_withdrawn_at = invited_at - INTERVAL 1 SECOND WHERE tb_institution_id = 2 AND tb_user_id = 3`),
        'ck_ihu_withdraw_pending'))
    const fk = await attempt(conn, `UPDATE ${IHU} SET tb_user_inviter_id = 999 WHERE tb_institution_id = 2 AND tb_user_id = 3`)
    check('C5: convidante inexistente → fk_ihu_inviter_to_user (1452)', !!fk && /^1452\b/.test(fk) && fk.includes('fk_ihu_inviter_to_user'), String(fk))

    // C7 — o ADD CONSTRAINT confere as linhas que já existem
    await conn.query(`ALTER TABLE ${IHU} DROP CONSTRAINT ck_ihu_pending_inactive`)
    await conn.query(`UPDATE ${IHU} SET active = 'S' WHERE tb_institution_id = 2 AND tb_user_id = 3`)
    const bad = await run(conn, '75_institution_user_invite_ddl.sql')
    check('C7: com uma linha pendente ATIVA, o 75 falha alto (o CHECK confere as linhas existentes)', !!bad && /^4025\b/.test(bad), String(bad))
    await conn.query(`UPDATE ${IHU} SET active = 'N' WHERE tb_institution_id = 2 AND tb_user_id = 3`)
    const fixed = await run(conn, '75_institution_user_invite_ddl.sql')
    check('C7: corrigida a linha, o 75 reaplica e recria o CHECK', fixed === null, String(fixed))

    // C8 — a conferência falha de verdade
    await conn.query('SET SESSION check_constraint_checks = 0')
    const conf = await run(conn, '75_institution_user_invite_ddl.sql')
    await conn.query('SET SESSION check_constraint_checks = 1')
    check('C8: com CHECK desligado na sessão, a conferência do fim FALHA o script (SQL75_FALHOU)', !!conf && /sql75_falhou/i.test(conf), String(conf))

    // C9 — setes_central intacta
    check('C9: setes_central intacta (nenhuma coluna nova nasceu lá)', eq(await centralColumns(conn), centralBefore))
  } catch (e: any) {
    check('execução da prova', false, e.message)
  } finally {
    try { await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``) } catch { /* segue */ }
    conn.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} FALHA(S)` : '\nPROVA OK')
  if (failures) process.exitCode = 1
}

void main()
