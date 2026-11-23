/**
 * PROVA do aceite do convite pelo LOGIN do titular (setes-api:CONV.E2.P3 — D-UC12, D-UC14, D-UC15, A-UC8) em `setes_central`
 * DESCARTÁVEL `setes_convp3_<pid>`: cópia VAZIA (CREATE TABLE … LIKE) das tabelas centrais que o login e o cadastro leem, com os scripts
 * REAIS 70 (vw_user_link) e 75 (convite) aplicados; um schema de cliente descartável `setes_convp3c_<pid>_<estab>` (um por estabelecimento) só com `tb_salesman` (o
 * contexto da sessão). O SQL executado é o do CÓDIGO REAL (`login()`, `createUser`, `withdrawUserInvite`, `editUser`,
 * `acceptPendingInvites`): só nesta prova o pool troca `setes_central.` pelo descartável no TEXTO do SQL (molde `prove-login-lock.ts` /
 * `prove-conv-e2-p2.ts`). Chave de assinatura descartável. Usuários e estabelecimentos SINTÉTICOS. NUNCA escreve em `setes_central`
 * (confere antes/depois); apaga os descartáveis no fim, inclusive em falha.
 *
 *   A  vínculo aceito + convite pendente (nascido pelo cadastro REAL do P2): o login aceita o convite e devolve a SELEÇÃO com os dois;
 *      `accepted_at` gravado e ativo; o 2º login não regrava o aceite (write-once)
 *   B  só o convite: o login entra DIRETO no estabelecimento do convite (antes do aceite seria a recusa "sem vínculo")
 *   C  convite retirado e vínculo antigo sem convite (inativo, e um `SYNC`) nunca ativam pelo login
 *   D  senha errada e credencial inativa: nada aceito (a mesma 401)
 *   E  corrida pela mesma linha: retirada × aceite e aceite × retirada (duas conexões) — um vence, o outro não muda nada; o CHECK nunca cai
 *   F  A-UC8 (T2): antes do aceite o PUT do admin não ativa (409); depois, o admin inativa e reativa sem novo aceite (accepted_at intacto)
 *   G  `setes_central` intacta
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-p3.ts   (SQL_DIR = o repositório sql)
 */
import 'dotenv/config'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { institutionSourceKind } from './lib/institution-source-kind'
import { resetJwtKeyRing } from '@shared/auth/product-token'
import { detectLockWaitSupport } from '@shared/db/counters'
import { hashPassword } from '@shared/auth/password'
import { login, setLoginRefusalFloor } from '@modules/auth/auth.service'
import { acceptPendingInvites } from '@modules/auth/auth.repository'
import { createUser, editUser, withdrawUserInvite } from '@modules/users/users.service'
import { UserScope } from '@modules/users/users.interface'

const PROBE = `setes_convp3_${process.pid}`
const CLIENT = `setes_convp3c_${process.pid}`
const INSTITUTIONS = [10, 20, 30, 40, 50]
const clientOf = (i: number) => `${CLIENT}_${i}`
const DATABASES = [PROBE, ...INSTITUTIONS.map(clientOf)]
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const TABLES = ['tb_entity', 'tb_user', 'tb_mailing', 'tb_entity_has_mailing', 'tb_institution', 'tb_institution_has_user',
  'tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_user_login_failure', 'tb_user_login_block_notice', 'tb_crashlytics']
const PASSWORD = 'Prova#Convite#2026'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const rawQuery = pool.query.bind(pool)
const rawGetConnection = pool.getConnection.bind(pool)
const redirect = (sql: any) => typeof sql === 'string' ? sql.replace(/setes_central\./g, `\`${PROBE}\`.`) : sql
async function probeConnection(): Promise<any> {
  const conn = await rawGetConnection()
  const q = conn.query.bind(conn)
  ;(conn as any).query = (sql: any, params?: any) => q(redirect(sql), params)
  return conn
}
function installRedirect(): void {
  ;(pool as any).query = (sql: any, params?: any) => rawQuery(redirect(sql), params)
  ;(pool as any).getConnection = probeConnection
}
function removeRedirect(): void {
  ;(pool as any).query = rawQuery
  ;(pool as any).getConnection = rawGetConnection
}

const T = (t: string) => `\`${PROBE}\`.\`${t}\``
async function link(u: number, i: number): Promise<any | null> {
  const [r] = await rawQuery<any[]>(`SELECT kind, active, invited_at, accepted_at, invite_withdrawn_at
    FROM ${T('tb_institution_has_user')} WHERE tb_user_id = ? AND tb_institution_id = ?`, [u, i])
  return r[0] ?? null
}
/** D-UC19: o titular definiu a PRÓPRIA senha (o efeito da troca com código ou da "minha senha" — provadas no P5 e no P7). */
async function ownPassword(id: number): Promise<void> {
  await rawQuery(`UPDATE ${T('tb_user')} SET password_author_role = 'T', password_set_at = NOW() WHERE id = ?`, [id])
}
async function newUser(id: number, email: string, hash: string, active = 'S'): Promise<void> {
  await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [id, `Pessoa ${id}`, `P${id}`])
  // D-UC19 (CONV.E2.P7): a senha destes usuários de prova foi definida pelo PRÓPRIO titular ('T') — a que aceita convite
  await rawQuery(`INSERT INTO ${T('tb_user')} (id, password, password_set_at, password_author_role, active, deleted, created_at)
    VALUES (?, ?, NOW(), 'T', ?, 'N', NOW())`, [id, hash, active])
  await rawQuery(`INSERT INTO ${T('tb_mailing')} (id, email, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`, [id, email])
  await rawQuery(`INSERT INTO ${T('tb_entity_has_mailing')} (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
    VALUES (?, ?, 2, NOW(), NOW(), 'N')`, [id, id])
}
async function pendingInvite(u: number, i: number, inviter: number | null = null): Promise<void> {
  await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted,
    tb_user_inviter_id, invited_at) VALUES (?, ?, 'user', 'N', NOW(), NOW(), 'N', ?, NOW())`, [i, u, inviter])
}
async function tryLogin(email: string, password: string): Promise<any> {
  try { return await login(email, password) } catch (e: any) { return { refused: e?.statusCode ?? String(e) } }
}
const tokenInstitution = (r: any) => (jwt.decode(r?.token) as any)?.institutionId
async function centralColumns(): Promise<string[]> {
  const [rows] = await rawQuery<any[]>(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user' ORDER BY ORDINAL_POSITION`)
  return rows.map((r: any) => r.c)
}

const ADMIN_10: UserScope = { isSuper: false, institutionId: 10, schemaName: clientOf(10), userId: 501 }
const ADMIN_20: UserScope = { isSuper: false, institutionId: 20, schemaName: clientOf(20), userId: 502 }

async function main(): Promise<void> {
  const keyFile = path.join(os.tmpdir(), `setes-convp3-${process.pid}.pem`)
  fs.writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = keyFile
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  resetJwtKeyRing()
  setLoginRefusalFloor(0)
  await detectLockWaitSupport()

  const centralBefore = await centralColumns()
  for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
  for (const db of DATABASES) await rawQuery(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  try {
    for (const t of TABLES) await rawQuery(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    const sk = await institutionSourceKind({ query: rawQuery }, PROBE)   // central viva com ou sem source_kind (072/081)
    await rawQuery(`ALTER TABLE ${T('tb_user')} ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password,
      ADD COLUMN IF NOT EXISTS password_author_role CHAR(1) NULL DEFAULT NULL AFTER password_set_at`)
    for (const i of INSTITUTIONS) await rawQuery(`CREATE TABLE \`${clientOf(i)}\`.tb_salesman (id int NOT NULL, tb_institution_id int NOT NULL,
      deleted char(1) NOT NULL DEFAULT 'N', active char(1) NOT NULL DEFAULT 'S', PRIMARY KEY (id, tb_institution_id))`)
    for (const file of ['70_user_access_central_views.sql', '75_institution_user_invite_ddl.sql', '76_user_password_author_ddl.sql']) {
      for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/setes_central/g, PROBE))) await rawQuery(st)
    }
    for (const i of INSTITUTIONS) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [i, `Estab ${i}`, `E${i}`])
      await rawQuery(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted${sk.col}) VALUES (?, ?, 'S', 'N'${sk.val})`, [i, clientOf(i)])
    }
    const hash = await hashPassword(PASSWORD)
    for (const id of [501, 502]) await newUser(id, `admin${id}@example.invalid`, hash)

    installRedirect()

    // A — U: criado no 10 (cadastro REAL), interceptado no 20 (cadastro REAL do P2), convite retirado no 30, antigo sem convite no 40
    const U_EMAIL = 'u.convp3@example.invalid'
    const { id: U } = await createUser(ADMIN_10, { nameCompany: 'Pessoa U', nickTrade: 'U', email: U_EMAIL, password: PASSWORD, active: 'S' } as any)
    await ownPassword(U)   // D-UC19: o titular definiu a própria senha (a do cadastro é do admin)
    await createUser(ADMIN_20, { nameCompany: 'x', nickTrade: 'x', email: U_EMAIL, active: 'S' } as any)
    await pendingInvite(U, 30, 501)
    await withdrawUserInvite({ ...ADMIN_10, institutionId: 30 }, U, null)
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
      VALUES (40, ?, 'user', 'N', NOW(), NOW(), 'N'), (50, ?, 'SYNC', 'N', NOW(), NOW(), 'N')`, [U, U])

    // F (antes do aceite) — o PUT do admin do 20 não ativa
    let f1 = 'passou'
    try { await editUser(ADMIN_20, U, { nameCompany: 'Pessoa U', nickTrade: 'U', email: U_EMAIL, active: 'S' } as any) } catch (e: any) { f1 = `${e?.statusCode} ${e?.code}` }
    check('F: antes do aceite o PUT do admin não ativa o convite (409 INVITE_PENDING)', f1 === '409 INVITE_PENDING', f1)

    const r1 = await tryLogin(U_EMAIL, PASSWORD)
    const a20 = await link(U, 20)
    check('A: o login aceita o convite e devolve a SELEÇÃO com o vínculo de antes e o aceito',
      r1?.status === 'select' && JSON.stringify((r1.institutions ?? []).map((i: any) => i.institutionId).sort()) === '[10,20]', JSON.stringify(r1?.institutions ?? r1))
    check('A: o convite virou vínculo ativo com accepted_at', a20?.active === 'S' && !!a20?.accepted_at, JSON.stringify(a20))
    await new Promise(r => setTimeout(r, 1100))
    await tryLogin(U_EMAIL, PASSWORD)
    const a20b = await link(U, 20)
    check('A: o 2º login não regrava o aceite (write-once)', String(a20b?.accepted_at) === String(a20?.accepted_at), JSON.stringify(a20b))

    // C — retirado, antigo sem convite e SYNC não ativam
    const [c30, c40, c50] = [await link(U, 30), await link(U, 40), await link(U, 50)]
    check('C: convite retirado não ativa pelo login', c30?.active === 'N' && c30?.accepted_at === null, JSON.stringify(c30))
    check('C: vínculo antigo sem convite e o SYNC não ativam pelo login', c40?.active === 'N' && c50?.active === 'N' && c40?.accepted_at === null,
      JSON.stringify([c40, c50]))

    // B — só o convite: entra direto
    const V_EMAIL = 'v.convp3@example.invalid'
    await newUser(601, V_EMAIL, hash)
    await pendingInvite(601, 20, 502)
    const r2 = await tryLogin(V_EMAIL, PASSWORD)
    check('B: só com o convite o login entra DIRETO no estabelecimento do convite', r2?.status === 'ok' && tokenInstitution(r2) === 20, JSON.stringify(r2?.refused ?? r2?.status))

    // D — senha errada e credencial inativa: nada aceito
    const W_EMAIL = 'w.convp3@example.invalid'
    await newUser(602, W_EMAIL, hash)
    await pendingInvite(602, 20, 502)
    const r3 = await tryLogin(W_EMAIL, 'Errada#Senha#2026')
    check('D: senha errada = 401 e o convite segue pendente', r3?.refused === 401 && (await link(602, 20))?.accepted_at === null, JSON.stringify(r3))
    const X_EMAIL = 'x.convp3@example.invalid'
    await newUser(603, X_EMAIL, hash, 'N')
    await pendingInvite(603, 20, 502)
    const r4 = await tryLogin(X_EMAIL, PASSWORD)
    check('D: credencial inativa = 401 e o convite segue pendente', r4?.refused === 401 && (await link(603, 20))?.accepted_at === null, JSON.stringify(r4))

    // E — corrida pela mesma linha (duas conexões), sem a trava do login (o pior caso: a retirada não toma a trava da credencial)
    await newUser(604, 'y.convp3@example.invalid', hash)
    await pendingInvite(604, 20, 502)
    {
      const a = await probeConnection(); const b = await probeConnection()
      try {
        await a.beginTransaction()
        await a.query(`UPDATE setes_central.tb_institution_has_user SET invite_withdrawn_at = NOW()
          WHERE tb_institution_id = 20 AND tb_user_id = 604 AND invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL`)
        await b.beginTransaction()
        const pendingB = acceptPendingInvites(b, 604)
        await new Promise(r => setTimeout(r, 400))
        await a.commit()
        const acceptedB = await pendingB
        await b.commit()
        const e1 = await link(604, 20)
        check('E: retirada confirmada primeiro — o aceite que esperava a linha não aceita (filtro do pendente)',
          acceptedB.length === 0 && e1?.active === 'N' && !!e1?.invite_withdrawn_at && e1?.accepted_at === null, JSON.stringify({ acceptedB, e1 }))
      } catch (e: any) {
        check('E: retirada × aceite sem erro de CHECK', false, `${e?.errno} ${e?.message}`)
        await a.rollback().catch(() => undefined); await b.rollback().catch(() => undefined)
      } finally { a.release(); b.release() }
    }
    await newUser(605, 'z.convp3@example.invalid', hash)
    await pendingInvite(605, 20, 502)
    {
      const a = await probeConnection()
      try {
        await a.beginTransaction()
        const accepted = await acceptPendingInvites(a, 605)
        let withdraw = 'esperando'
        const w = withdrawUserInvite(ADMIN_20, 605, null).then(() => { withdraw = 'retirou' }, (e: any) => { withdraw = `${e?.statusCode} ${e?.code}` })
        await new Promise(r => setTimeout(r, 400))
        const whileOpen = withdraw
        await a.commit()
        await w
        const e2 = await link(605, 20)
        check('E: aceite confirmado primeiro — a retirada esperou a linha e recebeu 409 INVITE_NOT_PENDING; o vínculo fica aceito',
          JSON.stringify(accepted) === '[20]' && whileOpen === 'esperando' && withdraw === '409 INVITE_NOT_PENDING' && e2?.active === 'S'
            && !!e2?.accepted_at && e2?.invite_withdrawn_at === null, JSON.stringify({ accepted, whileOpen, withdraw, e2 }))
      } catch (e: any) {
        check('E: aceite × retirada sem erro de CHECK', false, `${e?.errno} ${e?.message}`)
        await a.rollback().catch(() => undefined)
      } finally { a.release() }
    }

    // F (depois do aceite) — o admin do 20 inativa e reativa sem novo aceite
    const put = { nameCompany: 'Pessoa U', nickTrade: 'U', email: U_EMAIL }
    await editUser(ADMIN_20, U, { ...put, active: 'N' } as any)
    const f2 = await link(U, 20)
    await editUser(ADMIN_20, U, { ...put, active: 'S' } as any)
    const f3 = await link(U, 20)
    check('F: depois do aceite o admin inativa e reativa o próprio vínculo sem novo aceite (accepted_at intacto)',
      f2?.active === 'N' && f3?.active === 'S' && String(f3?.accepted_at) === String(a20?.accepted_at), JSON.stringify([f2, f3]))
  } finally {
    removeRedirect()
    for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
    fs.rmSync(keyFile, { force: true })
    const centralAfter = await centralColumns()
    check('G: setes_central intacta (mesmas colunas antes e depois)',
      JSON.stringify(centralAfter) === JSON.stringify(centralBefore), JSON.stringify(centralAfter))
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
