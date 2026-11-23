/**
 * PROVA do aceite só com a senha do PRÓPRIO titular (setes-api:CONV.E2.P7 — D-UC19, D-UC23, A-UC9; script central 76) em `setes_central`
 * DESCARTÁVEL `setes_convp7_<pid>` (molde `prove-conv-e2-p5.ts`: cópia vazia das tabelas centrais, scripts REAIS 70, 75 e 76, pool com
 * `setes_central.` trocado só nesta prova, chave descartável, rotas HTTP REAIS por `supertest`; dev sem SMTP — o código vai ao log).
 *
 *   W  os escritores gravam o papel: a criação pelo admin = A; a 1ª senha da conta do sync pelo admin (A-PV23) = A
 *   X4 com a senha inicial (do admin) o login entra só nos vínculos que já tem, NÃO aceita o convite do outro cliente e avisa (D-UC23)
 *   M  a "minha senha" grava T e o login seguinte aceita
 *   R  a troca com código ("Esqueci minha senha") grava T e o login seguinte aceita
 *   L  a senha de antes do 76 (papel NULL — A-UC9) não aceita e avisa
 *   H  o rehash (MD5 → scrypt) não muda o papel
 *   Z  `setes_central` intacta
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-p7.ts   (SQL_DIR = o repositório sql)
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
import { hashPassword, md5Password } from '@shared/auth/password'
import { login, setLoginRefusalFloor, setPasswordResetResponseFloor, waitForPendingPasswordResets } from '@modules/auth/auth.service'
import request from 'supertest'
import logger from '@shared/logger/logger'
import app from '../src/app'
import { createUser, editUser } from '@modules/users/users.service'
import { UserScope } from '@modules/users/users.interface'

const PROBE = `setes_convp7_${process.pid}`
const CLIENT = `setes_convp7c_${process.pid}`
const INSTITUTIONS = [10, 20]
const clientOf = (i: number) => `${CLIENT}_${i}`
const DATABASES = [PROBE, ...INSTITUTIONS.map(clientOf)]
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const TABLES = ['tb_entity', 'tb_user', 'tb_mailing', 'tb_entity_has_mailing', 'tb_institution', 'tb_institution_has_user',
  'tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_user_login_failure', 'tb_user_login_block_notice', 'tb_crashlytics',
  'tb_user_password_reset', 'tb_user_password_reset_notice']
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

let lastCode: string | null = null
const ADMIN_A: UserScope = { isSuper: false, institutionId: 10, schemaName: clientOf(10), userId: 501 }
const ADMIN_B: UserScope = { isSuper: false, institutionId: 20, schemaName: clientOf(20), userId: 502 }
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
async function httpLogin(email: string, password: string): Promise<any> {
  return (await request(app).post('/auth/login').send({ email, password })).body
}
async function role(id: number): Promise<string | null> {
  const [r] = await rawQuery<any[]>(`SELECT password_author_role r FROM ${T('tb_user')} WHERE id = ?`, [id])
  return r[0]?.r ?? null
}
const ids = (b: any) => JSON.stringify((b?.institutions ?? []).map((i: any) => i.institutionId).sort())

async function main(): Promise<void> {
  const keyFile = path.join(os.tmpdir(), `setes-convp7-${process.pid}.pem`)
  fs.writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = keyFile
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  delete process.env.SMTP_HOST
  resetJwtKeyRing()
  setLoginRefusalFloor(0)
  setPasswordResetResponseFloor(0)
  await detectLockWaitSupport()
  const info = logger.info.bind(logger)
  ;(logger as any).info = (msg: any, meta?: any) => {
    if (typeof msg === 'string' && /^Código (da minha senha|de recuperação)/.test(msg) && meta?.code) lastCode = String(meta.code)
    return info(msg, meta)
  }

  const centralBefore = await centralColumns()
  for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
  for (const db of DATABASES) await rawQuery(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  try {
    for (const t of TABLES) await rawQuery(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    const sk = await institutionSourceKind({ query: rawQuery }, PROBE)   // central viva com ou sem source_kind (072/081)
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

    // W — os escritores gravam o papel
    const X = 'x.convp7@example.invalid'
    const { id: xid } = await createUser(ADMIN_A, { nameCompany: 'X', nickTrade: 'X', email: X, password: PASSWORD, active: 'S' } as any)
    check('W1: a criação pelo admin grava o papel A (senha de terceiro — D-UC8)', (await role(xid)) === 'A', String(await role(xid)))
    // conta vinda do sync, sem senha, no estabelecimento A: a 1ª senha pelo admin (A-PV23) = A
    await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (701, 'Sync', 'Sync', NOW(), NOW())`)
    await rawQuery(`INSERT INTO ${T('tb_user')} (id, password, active, deleted, created_at) VALUES (701, NULL, 'S', 'N', NOW())`)
    await rawQuery(`INSERT INTO ${T('tb_mailing')} (id, email, created_at, updated_at) VALUES (701, 'sync.convp7@example.invalid', NOW(), NOW())`)
    await rawQuery(`INSERT INTO ${T('tb_entity_has_mailing')} (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted) VALUES (701, 701, 2, NOW(), NOW(), 'N')`)
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted) VALUES (10, 701, 'SYNC', 'S', NOW(), NOW(), 'N')`)
    check('W2: a conta do sync nasce sem senha e sem papel', (await role(701)) === null)
    await editUser(ADMIN_A, 701, { nameCompany: 'Sync', nickTrade: 'Sync', email: 'sync.convp7@example.invalid', password: PASSWORD } as any)
    check('W2: a 1ª senha da conta do sync pelo admin (A-PV23) grava o papel A', (await role(701)) === 'A', String(await role(701)))

    // X4 — a senha inicial (do admin) NÃO aceita o convite do outro cliente; a resposta avisa (D-UC23)
    await createUser(ADMIN_B, { nameCompany: 'x', nickTrade: 'x', email: X, active: 'S' } as any)
    const r1 = await httpLogin(X, PASSWORD)
    const l20a = await link(xid, 20)
    check('X4: com a senha inicial o login entra só no A, NÃO aceita o convite do B e avisa (pendingInvitesNeedOwnPassword)',
      !!r1?.token && (jwt.decode(r1.token) as any)?.institutionId === 10 && r1?.pendingInvitesNeedOwnPassword === true
        && l20a?.accepted_at === null && l20a?.active === 'N', JSON.stringify({ r1: { token: !!r1?.token, flag: r1?.pendingInvitesNeedOwnPassword }, l20a }))

    // M — a "minha senha" marca T e o login SEGUINTE aceita
    const NEW1 = 'Senha#Do#Titular#X#2026'
    const c1 = await request(app).post('/auth/my-password/code').set(bearer(r1.token)).send({ currentPassword: PASSWORD })
    await waitForPendingPasswordResets()
    const ch1 = await request(app).post('/auth/my-password').set(bearer(r1.token)).send({ code: lastCode, newPassword: NEW1 })
    check('M: a "minha senha" grava o papel T (D-UC19)', c1.status === 202 && ch1.status === 200 && (await role(xid)) === 'T',
      JSON.stringify({ c1: c1.status, ch1: ch1.status, role: await role(xid) }))
    await new Promise(r => setTimeout(r, 1100))
    const r2 = await httpLogin(X, NEW1)
    const l20b = await link(xid, 20)
    check('M: com a senha própria o login aceita o convite e a seleção traz A e B; sem aviso',
      r2?.select === true && ids(r2) === '[10,20]' && !!l20b?.accepted_at && r2?.pendingInvitesNeedOwnPassword === undefined, JSON.stringify({ ids: ids(r2), l20b }))

    // R — a troca com código ("Esqueci minha senha") também marca T
    const Y = 'y.convp7@example.invalid'
    const { id: yid } = await createUser(ADMIN_A, { nameCompany: 'Y', nickTrade: 'Y', email: Y, password: PASSWORD, active: 'S' } as any)
    await createUser(ADMIN_B, { nameCompany: 'x', nickTrade: 'x', email: Y, active: 'S' } as any)
    lastCode = null
    await request(app).post('/auth/recovery-password').send({ email: Y })
    await waitForPendingPasswordResets()
    const NEW2 = 'Senha#Do#Titular#Y#2026'
    const ch2 = await request(app).post('/auth/change-password').send({ email: Y, code: lastCode, newPassword: NEW2 })
    await new Promise(r => setTimeout(r, 1100))
    const r3 = await httpLogin(Y, NEW2)
    check('R: a troca com código grava T e o login seguinte aceita o convite',
      ch2.status === 200 && (await role(yid)) === 'T' && r3?.select === true && ids(r3) === '[10,20]', JSON.stringify({ ch2: ch2.status, role: await role(yid), ids: ids(r3) }))

    // L — a senha de ANTES do 76 (papel NULL — A-UC9) não aceita
    const L = 'legado.convp7@example.invalid'
    await newUser(9702, L, hash)
    await rawQuery(`UPDATE ${T('tb_user')} SET password_author_role = NULL WHERE id = 9702`)
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted, invited_at, accepted_at)
      VALUES (10, 9702, 'user', 'S', NOW(), NOW(), 'N', NOW(), NOW())`)
    await createUser(ADMIN_B, { nameCompany: 'x', nickTrade: 'x', email: L, active: 'S' } as any)
    const r4 = await httpLogin(L, PASSWORD)
    check('L: senha de antes do 76 (papel desconhecido — A-UC9) não aceita o convite e avisa',
      !!r4?.token && r4?.pendingInvitesNeedOwnPassword === true && (await link(9702, 20))?.accepted_at === null, JSON.stringify({ flag: r4?.pendingInvitesNeedOwnPassword }))

    // H — o rehash (MD5 legado → scrypt) NÃO muda o papel
    const H = 'rehash.convp7@example.invalid'
    await newUser(9703, H, md5Password(PASSWORD))
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted, invited_at, accepted_at)
      VALUES (10, 9703, 'user', 'S', NOW(), NOW(), 'N', NOW(), NOW())`)
    const [[b4]] = await rawQuery<any[]>(`SELECT password p FROM ${T('tb_user')} WHERE id = 9703`) as any
    await httpLogin(H, PASSWORD)
    const [[a4]] = await rawQuery<any[]>(`SELECT password p, password_author_role r FROM ${T('tb_user')} WHERE id = 9703`) as any
    check('H: o login regrava o MD5 em scrypt e o papel continua T (o rehash não é senha nova)',
      b4.p !== a4.p && /^scrypt\$/.test(a4.p) && a4.r === 'T', JSON.stringify({ antes: String(b4.p).slice(0, 8), depois: String(a4.p).slice(0, 8), r: a4.r }))
  } finally {
    await waitForPendingPasswordResets().catch(() => undefined)
    removeRedirect()
    for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
    fs.rmSync(keyFile, { force: true })
    const centralAfter = await centralColumns()
    check('Z: setes_central intacta (mesmas colunas antes e depois)', JSON.stringify(centralAfter) === JSON.stringify(centralBefore), JSON.stringify(centralAfter))
    await pool.end()
  }
  console.log(failures === 0 ? '\nPROVA OK' : `\nPROVA FALHOU (${failures})`)
  if (failures > 0) process.exitCode = 1
  setTimeout(() => process.exit(), 500).unref()
}

main().catch(async (e) => {
  console.error('ERRO', e)
  process.exitCode = 1
  try { await pool.end() } catch { /* já fechado */ }
})
