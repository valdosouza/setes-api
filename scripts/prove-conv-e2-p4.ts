/**
 * PROVA do 1º admin do cliente com login que já existe (setes-api:CONV.E2.P4 — A-UC6, D-UC4, D-UC12) em `setes_central` DESCARTÁVEL
 * `setes_convp4_<pid>` (molde `prove-conv-e2-p3.ts`: cópia vazia das tabelas centrais, scripts REAIS 70 e 75, pool com `setes_central.`
 * trocado só nesta prova, chave de assinatura descartável). O onboarding INTEIRO (`createInstitution`) não roda aqui: ele provisiona um
 * schema de cliente de verdade (DDL fora de transação) — a ORDEM dele (convite depois do provisionamento, ativação, aviso no fim, falha =
 * inativo) é provada com o banco dublado em `onboarding.test.ts`. Aqui roda o que é NOVO, com o código REAL: o estabelecimento como o
 * onboarding o deixa (ativo, com o schema) e o ramo do convite (`inviteToInstitution(dono, estab, 'admin', Super)`), depois o `login()`.
 *
 *   A  o ramo do convite grava o vínculo `admin` PENDENTE (inativo, Super convidante, `invited_at`), sem credencial nem entidade nova
 *   B  o login do titular o aceita: a seleção traz o estabelecimento de antes e o novo, este com perfil `admin` (vw_user_link)
 *   C  o aviso lê o e-mail de login e o nome do NOVO estabelecimento
 *   D  `setes_central` intacta
 *   E  D-UC22: a leitura que o onboarding usa para recusar conta de super (vínculo `super` vivo ou adormecido)
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-p4.ts   (SQL_DIR = o repositório sql)
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
import { login, setLoginRefusalFloor } from '@modules/auth/auth.service'
import { createUser } from '@modules/users/users.service'
import { inviteToInstitution, findInviteNoticeData, hasSuperLink } from '@shared/user/invite'
import { UserScope } from '@modules/users/users.interface'

const PROBE = `setes_convp4_${process.pid}`
const CLIENT = `setes_convp4c_${process.pid}`
const INSTITUTIONS = [10, 60]
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

const ADMIN_10: UserScope = { isSuper: false, institutionId: 10, schemaName: clientOf(10), userId: 501 }
const SUPER_ID = 503

async function counts(): Promise<{ u: number; e: number }> {
  const [r] = await rawQuery<any[]>(`SELECT (SELECT COUNT(*) FROM ${T('tb_user')}) u, (SELECT COUNT(*) FROM ${T('tb_entity')}) e`)
  return { u: Number(r[0].u), e: Number(r[0].e) }
}

async function main(): Promise<void> {
  const keyFile = path.join(os.tmpdir(), `setes-convp4-${process.pid}.pem`)
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
    await rawQuery(`ALTER TABLE ${T('tb_user')} ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    for (const i of INSTITUTIONS) await rawQuery(`CREATE TABLE \`${clientOf(i)}\`.tb_salesman (id int NOT NULL, tb_institution_id int NOT NULL,
      deleted char(1) NOT NULL DEFAULT 'N', active char(1) NOT NULL DEFAULT 'S', PRIMARY KEY (id, tb_institution_id))`)
    for (const file of ['70_user_access_central_views.sql', '75_institution_user_invite_ddl.sql']) {
      for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/setes_central/g, PROBE))) await rawQuery(st)
    }
    const names: Record<number, string> = { 10: 'Cliente Antigo', 60: 'Cliente Novo' }
    for (const i of INSTITUTIONS) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [i, names[i], names[i]])
      await rawQuery(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted) VALUES (?, ?, 'S', 'N')`, [i, clientOf(i)])
    }
    const hash = await hashPassword(PASSWORD)
    for (const id of [501, SUPER_ID]) await newUser(id, `admin${id}@example.invalid`, hash)

    installRedirect()

    const EMAIL = 'dono.convp4@example.invalid'
    const { id: U } = await createUser(ADMIN_10, { nameCompany: 'Dono Original', nickTrade: 'Dono', email: EMAIL, password: PASSWORD, active: 'S' } as any)
    const c0 = await counts()

    // A — o ramo do convite do onboarding (o mesmo chamado de createInstitution)
    const outcome = await inviteToInstitution(U, 60, 'admin', SUPER_ID)
    const l60 = await link(U, 60)
    const c1 = await counts()
    const [inv] = await rawQuery<any[]>(`SELECT tb_user_inviter_id i FROM ${T('tb_institution_has_user')} WHERE tb_user_id = ? AND tb_institution_id = 60`, [U])
    check('A: convite admin PENDENTE no novo estabelecimento, Super convidante',
      outcome === 'invited' && l60?.kind === 'admin' && l60?.active === 'N' && !!l60?.invited_at && l60?.accepted_at === null && inv[0]?.i === SUPER_ID,
      JSON.stringify({ outcome, l60, inviter: inv[0]?.i }))
    check('A: nenhuma credencial nem entidade nova', c1.u === c0.u && c1.e === c0.e, JSON.stringify([c0, c1]))

    // B — o login do titular aceita; perfil admin no novo
    const r = await tryLogin(EMAIL, PASSWORD)
    const byId: Record<number, string> = Object.fromEntries((r?.institutions ?? []).map((i: any) => [i.institutionId, i.profile]))
    const l60b = await link(U, 60)
    check('B: o login aceita e a seleção traz os dois estabelecimentos, o novo com perfil admin',
      r?.status === 'select' && byId[10] === 'user' && byId[60] === 'admin' && l60b?.active === 'S' && !!l60b?.accepted_at,
      JSON.stringify({ status: r?.status ?? r, byId }))

    // C — os dados do aviso
    const notice = await findInviteNoticeData(U, 60)
    check('C: o aviso lê o e-mail de login e o nome do NOVO estabelecimento',
      JSON.stringify(notice) === JSON.stringify({ email: EMAIL, institutionName: 'Cliente Novo' }), JSON.stringify(notice))

    // E — D-UC22: a leitura que o onboarding usa para recusar conta de super
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
      VALUES (10, ?, 'super', 'N', NOW(), NOW(), 'N')`, [SUPER_ID])
    const sup = await hasSuperLink(SUPER_ID), plain = await hasSuperLink(U)
    check('E: hasSuperLink acha a conta de super (vínculo super mesmo adormecido) e não acha a conta comum (D-UC22)', sup && !plain, JSON.stringify({ sup, plain }))
  } finally {
    removeRedirect()
    for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
    fs.rmSync(keyFile, { force: true })
    const centralAfter = await centralColumns()
    check('D: setes_central intacta (mesmas colunas antes e depois)',
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
