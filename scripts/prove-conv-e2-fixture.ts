/**
 * FIXTURE da onda do convidado (setes-api:CONV.E2.P6.T1 — §11 item 6 do prompt do convidado: "2 clientes em schemas diferentes + o
 * grupo (2 institutions no mesmo schema) — as duas frentes passam pela mesma barreira") em `setes_central` DESCARTÁVEL
 * `setes_convfx_<pid>` (molde `prove-conv-e2-p5.ts`: cópia vazia das tabelas centrais, scripts REAIS 70 e 75, pool com `setes_central.`
 * trocado só nesta prova, chave descartável, rotas HTTP reais por `supertest`). O GRUPO usa uma cópia SEM o UNIQUE do `schema_name` —
 * no central de hoje duas institutions no mesmo schema é inalcançável (achado do GRUPO.E3.P1; o grupo é a onda 3, D-GE4).
 *
 *   (a) dois clientes: a resposta e a lista do convidante não dizem onde nem o nome; a busca por nome não acha; o admin do outro cliente
 *       não retira nem ativa; quem convida não toma a conta nem ativa sem o aceite; o login de outra pessoa não aceita; o login do titular
 *       aceita; inativar no cliente B derruba só a sessão do B; o já aceito reativa sem novo aceite; o nunca aceito (retirado) não
 *       reativa pelo admin nem pelo Super e o login não o aceita
 *   (b) o grupo: o convite da matriz não aparece na filial; a filial não retira nem ativa o da matriz; o login aceita só a matriz; a
 *       filial não derruba a sessão da matriz
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-fixture.ts   (SQL_DIR = o repositório sql)
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
import { createUser, editUser, withdrawUserInvite } from '@modules/users/users.service'
import { listUsers } from '@modules/users/users.repository'
import { UserScope } from '@modules/users/users.interface'
import { NO_CRITERIA } from '@shared/list'

const PROBE = `setes_convfx_${process.pid}`
const CLIENT = `setes_convfxc_${process.pid}`
const INSTITUTIONS = [10, 20]
const GROUP = `setes_convfxg_${process.pid}`
const clientOf = (i: number) => `${CLIENT}_${i}`
const DATABASES = [PROBE, ...INSTITUTIONS.map(clientOf), GROUP]
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

const PASS_ALL = 'Fixture#Convidado#2026'
const A = 10, B = 20, MATRIZ = 30, FILIAL = 31
const scopeOf = (institutionId: number, userId: number, isSuper = false): UserScope =>
  ({ isSuper, institutionId, schemaName: isSuper ? 'setes_setes' : clientOf(institutionId), userId })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
async function httpLogin(email: string): Promise<any> {
  return (await request(app).post('/auth/login').send({ email, password: PASS_ALL })).body
}
async function finalToken(email: string, institutionId: number): Promise<string | null> {
  const r = await httpLogin(email)
  if (r?.token) return (jwt.decode(r.token) as any)?.institutionId === institutionId ? r.token : null
  if (r?.select !== true) return null
  const s = await request(app).post('/auth/select-institution').set(bearer(r.selectionToken)).send({ institutionId })
  return s.status === 200 ? s.body?.token ?? null : null
}
async function alive(token: string, institutionId: number): Promise<number> {
  return (await request(app).post('/auth/switch-institution').set(bearer(token)).send({ institutionId })).status
}
const q = (filter = '') => ({ filter, page: 1, pageSize: 50, offset: 0, criteria: NO_CRITERIA }) as any
async function expectCode(p: Promise<unknown>): Promise<string> {
  try { await p; return 'passou' } catch (e: any) { return `${e?.statusCode} ${e?.code ?? ''}`.trim() }
}

async function main(): Promise<void> {
  const keyFile = path.join(os.tmpdir(), `setes-convfx-${process.pid}.pem`)
  fs.writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = keyFile
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  delete process.env.SMTP_HOST
  resetJwtKeyRing()
  setLoginRefusalFloor(0)
  await detectLockWaitSupport()

  const centralBefore = await centralColumns()
  for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
  for (const db of DATABASES) await rawQuery(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  try {
    for (const t of TABLES) await rawQuery(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    await rawQuery(`ALTER TABLE ${T('tb_user')} ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    // o GRUPO (onda 3 — D-GE4): duas institutions no MESMO schema; o central de hoje não deixa (UNIQUE `schema_name`) — só esta cópia
    await rawQuery(`ALTER TABLE ${T('tb_institution')} DROP INDEX \`schema_name\``)
    for (const db of DATABASES.slice(1)) await rawQuery(`CREATE TABLE \`${db}\`.tb_salesman (id int NOT NULL, tb_institution_id int NOT NULL,
      deleted char(1) NOT NULL DEFAULT 'N', active char(1) NOT NULL DEFAULT 'S', PRIMARY KEY (id, tb_institution_id))`)
    for (const file of ['70_user_access_central_views.sql', '75_institution_user_invite_ddl.sql']) {
      for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/setes_central/g, PROBE))) await rawQuery(st)
    }
    const schemaOf: Record<number, string> = { [A]: clientOf(A), [B]: clientOf(B), [MATRIZ]: GROUP, [FILIAL]: GROUP }
    for (const i of [A, B, MATRIZ, FILIAL]) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [i, `Estab ${i}`, `E${i}`])
      await rawQuery(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted) VALUES (?, ?, 'S', 'N')`, [i, schemaOf[i]])
    }
    const hash = await hashPassword(PASS_ALL)
    // admins de cada estabelecimento (vínculo admin aceito)
    const admins: Record<number, number> = { [A]: 801, [B]: 802, [MATRIZ]: 803, [FILIAL]: 804 }
    for (const [inst, uid] of Object.entries(admins)) {
      await newUser(uid, `admin${uid}@example.invalid`, hash)
      await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted,
        invited_at, accepted_at) VALUES (?, ?, 'admin', 'S', NOW(), NOW(), 'N', NOW(), NOW())`, [Number(inst), uid])
    }
    await newUser(805, 'super.convfx@example.invalid', hash)

    installRedirect()

    // ======================= (a) DOIS CLIENTES, SCHEMAS DIFERENTES =======================
    const P = 'pessoa.convfx@example.invalid'
    const { id: pid } = await createUser(scopeOf(A, admins[A]), { nameCompany: 'Pessoa Real', nickTrade: 'Pessoa', email: P, password: PASS_ALL, active: 'S' } as any)
    const inv = await createUser(scopeOf(B, admins[B]), { nameCompany: 'Chute do B', nickTrade: 'B', email: P, active: 'S' } as any)
    check('a1: o cliente B recebe só "cadastro existente, convite pendente" — nenhum nome, nenhum estabelecimento',
      JSON.stringify(inv) === JSON.stringify({ id: pid, existingLogin: true, invite: 'pending' }), JSON.stringify(inv))
    const listA = (await listUsers(q(), A)).rows.find(r => Number(r.id) === pid)
    const listB = (await listUsers(q(), B)).rows.find(r => Number(r.id) === pid)
    check('a2: na lista do A a pessoa aparece com nome e sem convite; na do B, sem nome e pendente',
      listA?.name === 'Pessoa' && listA?.invite === 'accepted' && listB?.name === null && listB?.invite === 'pending', JSON.stringify([listA, listB]))
    check('a3: o B não acha a pessoa pelo nome (enumeração além de "existe em algum lugar")',
      (await listUsers(q('Pessoa Real'), B)).rows.length === 0 && (await listUsers(q('Pessoa Real'), A)).rows.length === 1)
    const wA = await expectCode(withdrawUserInvite(scopeOf(A, admins[A]), pid, B))
    const actA = await expectCode(editUser(scopeOf(A, admins[A]), pid, { nameCompany: 'Pessoa Real', nickTrade: 'Pessoa', email: P, active: 'S', institutionId: B } as any))
    const l20 = await link(pid, B)
    check('a4: o admin do A não retira nem ativa o convite do B (o alvo é forçado ao próprio estabelecimento)',
      wA === '409 INVITE_NOT_PENDING' && actA === 'passou' && l20?.active === 'N' && l20?.accepted_at === null && l20?.invite_withdrawn_at === null,
      JSON.stringify({ wA, actA, l20 }))
    const takeB = await expectCode(editUser(scopeOf(B, admins[B]), pid, { nameCompany: 'Tomada', nickTrade: 'Tomada', email: P } as any))
    const actB = await expectCode(editUser(scopeOf(B, admins[B]), pid, { nameCompany: 'Pessoa Real', nickTrade: 'Pessoa', email: P, active: 'S' } as any))
    const [ent] = await rawQuery<any[]>(`SELECT nick_trade n FROM ${T('tb_entity')} WHERE id = ?`, [pid])
    check('a5: quem convida não toma a conta (não edita a credencial) e não ativa sem o aceite',
      takeB === '409 INVITE_PENDING' && actB === '409 INVITE_PENDING' && ent[0]?.n === 'Pessoa', JSON.stringify({ takeB, actB, nome: ent[0]?.n }))
    const otherLogin = await httpLogin('admin802@example.invalid')
    check('a6: o login de OUTRA pessoa (o admin do B) não aceita o convite da pessoa',
      !!otherLogin?.token && (await link(pid, B))?.accepted_at === null)

    const sel = await httpLogin(P)
    check('a7: o login da pessoa aceita o convite e a seleção traz A e B',
      sel?.select === true && JSON.stringify((sel.institutions ?? []).map((i: any) => i.institutionId).sort()) === JSON.stringify([A, B]), JSON.stringify(sel?.institutions))
    const tokA = await finalToken(P, A), tokB = await finalToken(P, B)
    check('a8: sessões nos dois clientes', !!tokA && !!tokB && (await alive(tokA!, A)) === 200 && (await alive(tokB!, B)) === 200)
    await new Promise(r => setTimeout(r, 50))
    await editUser(scopeOf(B, admins[B]), pid, { nameCompany: 'Pessoa Real', nickTrade: 'Pessoa', email: P, active: 'N' } as any)
    check('a9: o B inativa o PRÓPRIO vínculo: a sessão no B cai na hora (token velho = 401); a do A segue',
      (await alive(tokB!, B)) === 401 && (await alive(tokA!, A)) === 200)
    await editUser(scopeOf(B, admins[B]), pid, { nameCompany: 'Pessoa Real', nickTrade: 'Pessoa', email: P, active: 'S' } as any)
    const l20r = await link(pid, B)
    check('a10: o vínculo JÁ aceito reativa sem novo aceite (A-UC8)', l20r?.active === 'S' && !!l20r?.accepted_at, JSON.stringify(l20r))

    // retirada e reativar nunca aceito
    const R = 'retirada.convfx@example.invalid'
    const { id: rid } = await createUser(scopeOf(A, admins[A]), { nameCompany: 'Ret', nickTrade: 'Ret', email: R, password: PASS_ALL, active: 'S' } as any)
    await createUser(scopeOf(B, admins[B]), { nameCompany: 'x', nickTrade: 'x', email: R, active: 'S' } as any)
    await withdrawUserInvite(scopeOf(B, admins[B]), rid, null)
    const reactW = await expectCode(editUser(scopeOf(B, admins[B]), rid, { nameCompany: 'Ret', nickTrade: 'Ret', email: R, active: 'S' } as any))
    const supW = await expectCode(editUser(scopeOf(1, 805, true), rid, { nameCompany: 'Ret', nickTrade: 'Ret', email: R, active: 'S', institutionId: B } as any))
    await httpLogin(R)
    const lr = await link(rid, B)
    check('a11: vínculo nunca aceito (retirado) não reativa pelo admin nem pelo Super, e o login não o aceita (A-UC8)',
      reactW === '409 INVITE_PENDING' && supW === '409 INVITE_PENDING' && lr?.active === 'N' && lr?.accepted_at === null,
      JSON.stringify({ reactW, supW, lr }))

    // ======================= (b) O GRUPO: MATRIZ E FILIAL NO MESMO SCHEMA =======================
    const G = 'grupo.convfx@example.invalid'
    const { id: gid } = await createUser(scopeOf(A, admins[A]), { nameCompany: 'Pessoa Grupo', nickTrade: 'Grupo', email: G, password: PASS_ALL, active: 'S' } as any)
    await createUser(scopeOf(MATRIZ, admins[MATRIZ]), { nameCompany: 'x', nickTrade: 'x', email: G, active: 'S' } as any)
    const inFilial = (await listUsers(q(), FILIAL)).rows.find(r => Number(r.id) === gid)
    const inMatriz = (await listUsers(q(), MATRIZ)).rows.find(r => Number(r.id) === gid)
    check('b1: o convite da matriz não aparece na filial (mesmo schema); na matriz, pendente e sem nome',
      inFilial === undefined && inMatriz?.invite === 'pending' && inMatriz?.name === null, JSON.stringify({ inFilial, inMatriz }))
    const wF = await expectCode(withdrawUserInvite(scopeOf(FILIAL, admins[FILIAL]), gid, MATRIZ))
    const aF = await expectCode(editUser(scopeOf(FILIAL, admins[FILIAL]), gid, { nameCompany: 'Pessoa Grupo', nickTrade: 'Grupo', email: G, active: 'S', institutionId: MATRIZ } as any))
    const lm = await link(gid, MATRIZ)
    check('b2: o admin da filial não retira nem ativa o convite da matriz (o alvo é a filial)',
      wF === '409 INVITE_NOT_PENDING' && aF !== 'passou' && lm?.active === 'N' && lm?.invite_withdrawn_at === null, JSON.stringify({ wF, aF, lm }))
    const gl = await httpLogin(G)
    check('b3: o login aceita SÓ a matriz (onde há convite); a filial não ganha vínculo',
      gl?.select === true && JSON.stringify((gl.institutions ?? []).map((i: any) => i.institutionId).sort()) === JSON.stringify([A, MATRIZ])
        && (await link(gid, FILIAL)) === null, JSON.stringify(gl?.institutions))
    const tokM = await finalToken(G, MATRIZ)
    await editUser(scopeOf(FILIAL, admins[FILIAL]), gid, { nameCompany: 'Pessoa Grupo', nickTrade: 'Grupo', email: G, active: 'N' } as any).catch(() => undefined)
    check('b4: a filial tentando inativar a pessoa não derruba a sessão da matriz (não há vínculo da filial)',
      !!tokM && (await alive(tokM!, MATRIZ)) === 200 && (await link(gid, MATRIZ))?.active === 'S')
  } finally {
    removeRedirect()
    for (const db of DATABASES) await rawQuery(`DROP DATABASE IF EXISTS \`${db}\``)
    fs.rmSync(keyFile, { force: true })
    const centralAfter = await centralColumns()
    check('z: setes_central intacta (mesmas colunas antes e depois)',
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
