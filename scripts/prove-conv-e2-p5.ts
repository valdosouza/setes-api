/**
 * PROVA da "minha senha" (setes-api:CONV.E2.P5 — D-UC7, D-UC8, D-UC18, D-EA5, D-EA7) em `setes_central` DESCARTÁVEL `setes_convp5_<pid>`
 * (molde `prove-conv-e2-p3.ts`: cópia vazia das tabelas centrais, scripts REAIS 70 e 75, pool com `setes_central.` trocado só nesta prova,
 * chave de assinatura descartável). De PONTA A PONTA pelas rotas HTTP REAIS (`supertest` sobre o `app`): o login, a guarda da sessão
 * (`authMiddleware` → `vw_user_link` com o `password_set_at`), as duas rotas novas e a peça do código da recuperação. Dev sem SMTP: o
 * código vai ao log (D-RS5) e a prova o lê de lá.
 *
 *   A  senha atual errada = 422 MY_PASSWORD_REFUSED, gravada na janela do login (D-UC18), nenhum código emitido
 *   B  sem token = 401
 *   C  senha atual certa = 202, um código na `tb_user_password_reset` (a mesma peça da recuperação)
 *   D  política antes do código (400); código errado = 422 e conta no código; igual à atual = 422 PASSWORD_SAME_AS_CURRENT
 *   E  troca certa = 200 reauth; a sessão de ANTES é recusada (401 SESSION_REVOKED — T2); a senha antiga não entra, a nova entra; o código
 *      usado não vale de novo
 *   F  10 erradas na janela bloqueiam o login e o pedido de código, mesmo com a senha certa (D-UC18)
 *   G  `setes_central` intacta
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-p5.ts   (SQL_DIR = o repositório sql)
 */
import 'dotenv/config'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { resetJwtKeyRing } from '@shared/auth/product-token'
import { detectLockWaitSupport } from '@shared/db/counters'
import { hashPassword } from '@shared/auth/password'
import { login, setLoginRefusalFloor, setPasswordResetResponseFloor, waitForPendingPasswordResets } from '@modules/auth/auth.service'
import request from 'supertest'
import logger from '@shared/logger/logger'
import app from '../src/app'

const PROBE = `setes_convp5_${process.pid}`
const CLIENT = `setes_convp5c_${process.pid}`
const INSTITUTIONS = [10]
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
async function newUser(id: number, email: string, hash: string, active = 'S'): Promise<void> {
  await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [id, `Pessoa ${id}`, `P${id}`])
  await rawQuery(`INSERT INTO ${T('tb_user')} (id, password, active, deleted, created_at) VALUES (?, ?, ?, 'N', NOW())`, [id, hash, active])
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

const EMAIL = 'titular.convp5@example.invalid'
const NEW_PASSWORD = 'Nova#Senha#Titular#2026'
let lastCode: string | null = null

async function loginToken(password: string): Promise<string | null> {
  const r = await request(app).post('/auth/login').send({ email: EMAIL, password })
  return r.status === 200 && r.body?.token ? String(r.body.token) : null
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
async function failuresInWindow(u: number): Promise<number> {
  const [r] = await rawQuery<any[]>(`SELECT COUNT(*) n FROM ${T('tb_user_login_failure')} WHERE tb_user_id = ?`, [u])
  return Number(r[0].n)
}
async function resetsOf(u: number): Promise<number> {
  const [r] = await rawQuery<any[]>(`SELECT COUNT(*) n FROM ${T('tb_user_password_reset')} WHERE tb_user_id = ?`, [u])
  return Number(r[0].n)
}

async function main(): Promise<void> {
  const keyFile = path.join(os.tmpdir(), `setes-convp5-${process.pid}.pem`)
  fs.writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = keyFile
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  delete process.env.SMTP_HOST                      // dev sem SMTP: o código vai ao log (D-RS5) — a prova o lê de lá
  resetJwtKeyRing()
  setLoginRefusalFloor(0)
  setPasswordResetResponseFloor(0)
  await detectLockWaitSupport()
  const info = logger.info.bind(logger)
  ;(logger as any).info = (msg: any, meta?: any) => {
    if (typeof msg === 'string' && msg.startsWith('Código da minha senha') && meta?.code) lastCode = String(meta.code)
    return info(msg, meta)
  }

  const centralBefore = await centralColumns()
  for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
  for (const db of DATABASES) await rawQuery(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  try {
    for (const t of TABLES) await rawQuery(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    await rawQuery(`ALTER TABLE ${T('tb_user')} ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    for (const i of INSTITUTIONS) await rawQuery(`CREATE TABLE \`${clientOf(i)}\`.tb_salesman (id int NOT NULL, tb_institution_id int NOT NULL,
      deleted char(1) NOT NULL DEFAULT 'N', active char(1) NOT NULL DEFAULT 'S', PRIMARY KEY (id, tb_institution_id))`)
    for (const file of ['70_user_access_central_views.sql', '75_institution_user_invite_ddl.sql']) {
      for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/setes_central/g, PROBE))) await rawQuery(st)
    }
    for (const i of INSTITUTIONS) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [i, `Estab ${i}`, `E${i}`])
      await rawQuery(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted) VALUES (?, ?, 'S', 'N')`, [i, clientOf(i)])
    }
    const hash = await hashPassword(PASSWORD)
    await newUser(701, EMAIL, hash)
    await rawQuery(`UPDATE ${T('tb_user')} SET password_set_at = NOW() - INTERVAL 1 DAY WHERE id = 701`)
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted,
      invited_at, accepted_at) VALUES (10, 701, 'user', 'S', NOW(), NOW(), 'N', NOW(), NOW())`)

    installRedirect()

    const oldToken = await loginToken(PASSWORD)
    check('0: o titular entra (sessão ANTES da troca)', !!oldToken)

    // A — senha atual errada conta como falha de login (D-UC18) e não emite código
    const wrong = await request(app).post('/auth/my-password/code').set(bearer(oldToken!)).send({ currentPassword: 'Errada#2026#xx' })
    check('A: senha atual errada = 422 MY_PASSWORD_REFUSED (nunca 401 — a sessão não "cai")',
      wrong.status === 422 && wrong.body?.code === 'MY_PASSWORD_REFUSED', `${wrong.status} ${JSON.stringify(wrong.body)}`)
    check('A: a errada foi gravada na janela do login (D-EA2) e nenhum código saiu', (await failuresInWindow(701)) === 1 && (await resetsOf(701)) === 0)

    // B — sem token: 401 (rota logada)
    const anon = await request(app).post('/auth/my-password/code').send({ currentPassword: PASSWORD })
    check('B: sem token = 401', anon.status === 401, String(anon.status))

    // C — senha atual certa: código emitido pela peça da recuperação e enviado (em dev, ao log)
    const ok = await request(app).post('/auth/my-password/code').set(bearer(oldToken!)).send({ currentPassword: PASSWORD })
    await waitForPendingPasswordResets()
    check('C: senha atual certa = 202, um código na tb_user_password_reset (a mesma peça) e o código no log de dev',
      ok.status === 202 && (await resetsOf(701)) === 1 && /^\d{6}$/.test(lastCode ?? ''), `${ok.status} code=${lastCode ? 'sim' : 'não'}`)

    // D — política e código errado
    const weak = await request(app).post('/auth/my-password').set(bearer(oldToken!)).send({ code: lastCode, newPassword: 'curta' })
    check('D: senha nova fora da política = 400 no campo newPassword (antes do código)', weak.status === 400 && weak.body?.fields?.[0]?.field === 'newPassword',
      `${weak.status} ${JSON.stringify(weak.body)}`)
    const bad = await request(app).post('/auth/my-password').set(bearer(oldToken!)).send({ code: '000000' === lastCode ? '111111' : '000000', newPassword: NEW_PASSWORD })
    const [[att]] = await rawQuery<any[]>(`SELECT failed_attempts f FROM ${T('tb_user_password_reset')} WHERE tb_user_id = 701`) as any
    check('D: código errado = 422 MY_PASSWORD_CODE_INVALID e conta 1 no código (5 esgotam — a mesma peça)',
      bad.status === 422 && bad.body?.code === 'MY_PASSWORD_CODE_INVALID' && Number(att.f) === 1, `${bad.status} ${JSON.stringify(bad.body)} f=${att?.f}`)
    const same = await request(app).post('/auth/my-password').set(bearer(oldToken!)).send({ code: lastCode, newPassword: PASSWORD })
    check('D: código certo com a senha igual à atual = 422 PASSWORD_SAME_AS_CURRENT (o código segue valendo)',
      same.status === 422 && same.body?.code === 'PASSWORD_SAME_AS_CURRENT', `${same.status} ${JSON.stringify(same.body)}`)

    // E — a troca; T2: a sessão de antes cai, a nova entra
    await new Promise(r => setTimeout(r, 1100))      // o iat (segundos) da sessão de antes fica estritamente antes do password_set_at
    const changed = await request(app).post('/auth/my-password').set(bearer(oldToken!)).send({ code: lastCode, newPassword: NEW_PASSWORD })
    const [[u]] = await rawQuery<any[]>(`SELECT password_set_at p FROM ${T('tb_user')} WHERE id = 701`) as any
    check('E: código certo = 200 { reauth: true } e o password_set_at regravado agora',
      changed.status === 200 && changed.body?.reauth === true && Date.now() - new Date(u.p).getTime() < 60_000, `${changed.status} ${JSON.stringify(changed.body)}`)
    const old = await request(app).post('/auth/switch-institution').set(bearer(oldToken!)).send({ institutionId: 10 })
    check('E (T2): a sessão aberta ANTES da troca é recusada (401 SESSION_REVOKED — D-EA7)',
      old.status === 401 && old.body?.code === 'SESSION_REVOKED', `${old.status} ${JSON.stringify(old.body)}`)
    const byOld = await loginToken(PASSWORD)
    const fresh = await loginToken(NEW_PASSWORD)
    const freshCall = fresh ? await request(app).post('/auth/switch-institution').set(bearer(fresh)).send({ institutionId: 10 }) : null
    check('E: a senha antiga não entra mais; a nova entra e a sessão nova passa pela guarda',
      byOld === null && !!fresh && freshCall?.status === 200, `antiga=${byOld ? 'entrou' : 'recusada'} nova=${freshCall?.status}`)
    const reuse = await request(app).post('/auth/my-password').set(bearer(fresh!)).send({ code: lastCode, newPassword: 'Outra#Senha#Nova#2026' })
    check('E: o código usado não vale de novo (422)', reuse.status === 422 && reuse.body?.code === 'MY_PASSWORD_CODE_INVALID', `${reuse.status}`)

    // F — 10 erradas bloqueiam também o login (a mesma janela da D-EA2)
    for (let k = 0; k < 9; k++) {
      await request(app).post('/auth/my-password/code').set(bearer(fresh!)).send({ currentPassword: `Errada#${k}#2026` })
    }
    const blockedLogin = await loginToken(NEW_PASSWORD)
    const blockedCode = await request(app).post('/auth/my-password/code').set(bearer(fresh!)).send({ currentPassword: NEW_PASSWORD })
    check('F: 10 erradas na janela (a do passo A, a senha antiga no login do passo E e as do laço) bloqueiam o login e o pedido de código, com a senha CERTA (D-UC18)',
      (await failuresInWindow(701)) === 10 && blockedLogin === null && blockedCode.status === 422, `falhas=${await failuresInWindow(701)} código=${blockedCode.status}`)
  } finally {
    await waitForPendingPasswordResets().catch(() => undefined)
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
  setTimeout(() => process.exit(), 500).unref()
}

main().catch(async (e) => {
  console.error('ERRO', e)
  process.exitCode = 1
  try { await pool.end() } catch { /* já fechado */ }
})
