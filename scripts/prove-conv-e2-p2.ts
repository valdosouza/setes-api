/**
 * PROVA da criação interceptada no cadastro (setes-api:CONV.E2.P2 — D-UC4, D-UC12, D-UC14, D-UC15, D-UC16, A-UC3, A-UC7, A-UC8) em
 * `setes_central` DESCARTÁVEL `setes_convp2_<pid>`: cópia VAZIA (CREATE TABLE … LIKE) das tabelas centrais do cadastro, com o script
 * central 75 REAL aplicado (nome do schema trocado). O SQL executado é o do CÓDIGO REAL do service e do repositório: só nesta prova o
 * pool troca `setes_central.` pelo descartável no TEXTO do SQL (nenhuma costura no código de produção — molde
 * `scripts/prove-login-lock.ts`). Usuários e estabelecimentos SINTÉTICOS. NUNCA escreve em `setes_central` (confere antes/depois);
 * apaga o descartável no fim, inclusive em falha.
 *
 *   P1  o boot (`assertInviteSchema`) recusa a tabela sem o 75 e aceita depois dele
 *   P2  e-mail novo: credencial + vínculo nascido convidado e aceito no mesmo instante, ativo, com o convidante
 *   P3  e-mail que já é login, outro estabelecimento: NENHUMA credencial nova, nada da credencial muda (nome, senha), vínculo
 *       PENDENTE (inativo, `user`, convidante, `invited_at`) — e o "aguardando aceite" em SQL o acha
 *   P4  o mesmo convite de novo: nada muda (já pendente)
 *   P5  o estabelecimento onde a pessoa já é usuária: 409 USER_ALREADY_LINKED, nada gravado
 *   P6  quem intercepta pede Administrador: 400 INVITE_PROFILE_USER_ONLY, nada gravado
 *   P7  retirar (T4): grava `invite_withdrawn_at`; retirar de novo = 409 INVITE_NOT_PENDING; o retirado não é "aguardando"
 *   P8  convidar de novo depois da retirada: convite renovado, retirada limpa
 *   P9  o banco recusa ativar o pendente direto (CHECK ck_ihu_pending_inactive — A-UC8)
 *   P10 vínculos do Super (D-UC16): par novo = pendente com o Super convidante; pendente fora da lista = RETIRADO; aceito segue ativo;
 *       vínculo antigo sem convite segue o regime de antes (ativa na lista, inativa fora dela, nunca vira convite)
 *   P11 a lista de vínculos do Super mostra o pendente como concedido, com `invite = 'pending'`
 *   P12 `setes_central` intacta
 *   P14 A-UC4/A-UC8: no foco do convite nunca aceito a lista e o GET não trazem o nome, a busca por nome não o acha (pelo e-mail
 *       sim), e o PUT não ativa o pendente nem deixa o admin desse estabelecimento editar a credencial
 *   P13 os dados do aviso (T2) saem do banco: o e-mail de LOGIN do titular e o nome do estabelecimento que convidou — nada mais
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-conv-e2-p2.ts   (SQL_DIR = o repositório sql)
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { assertInviteSchema, pendingInviteSql } from '@shared/user/invite'
import { createUser, saveInstitutionLinks, withdrawUserInvite } from '@modules/users/users.service'
import { listInstitutionLinks, findInviteNoticeData, listUsers, getUser } from '@modules/users/users.repository'
import { NO_CRITERIA } from '@shared/list'
import { editUser } from '@modules/users/users.service'
import { UserScope } from '@modules/users/users.interface'

const PROBE = `setes_convp2_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const TABLES = ['tb_entity', 'tb_user', 'tb_mailing', 'tb_entity_has_mailing', 'tb_institution', 'tb_institution_has_user']

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** O pool do código real, com `setes_central.` trocado pelo descartável no TEXTO do SQL (só nesta prova). */
const rawQuery = pool.query.bind(pool)
const rawGetConnection = pool.getConnection.bind(pool)
const redirect = (sql: any) => typeof sql === 'string' ? sql.replace(/setes_central\./g, `\`${PROBE}\`.`) : sql
function installRedirect(): void {
  ;(pool as any).query = (sql: any, params?: any) => rawQuery(redirect(sql), params)
  ;(pool as any).getConnection = async () => {
    const conn = await rawGetConnection()
    const q = conn.query.bind(conn)
    ;(conn as any).query = (sql: any, params?: any) => q(redirect(sql), params)
    return conn
  }
}
function removeRedirect(): void {
  ;(pool as any).query = rawQuery
  ;(pool as any).getConnection = rawGetConnection
}

const T = (t: string) => `\`${PROBE}\`.\`${t}\``
async function link(u: number, i: number): Promise<any | null> {
  const [r] = await rawQuery<any[]>(`SELECT kind, active, deleted, tb_user_inviter_id inviter, invited_at, accepted_at, invite_withdrawn_at,
      ${pendingInviteSql()} AS pending FROM ${T('tb_institution_has_user')} WHERE tb_user_id = ? AND tb_institution_id = ?`, [u, i])
  return r[0] ?? null
}
async function count(t: string): Promise<number> {
  const [r] = await rawQuery<any[]>(`SELECT COUNT(*) n FROM ${T(t)}`)
  return Number(r[0].n)
}
async function expectHttp(p: Promise<unknown>, status: number, code?: string): Promise<string> {
  try { await p; return 'passou (devia recusar)' } catch (e: any) {
    return e?.statusCode === status && (code === undefined || e?.code === code) ? 'ok' : `${e?.statusCode} ${e?.code} ${e?.message}`
  }
}
async function centralColumns(): Promise<string[]> {
  const [rows] = await rawQuery<any[]>(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user' ORDER BY ORDINAL_POSITION`)
  return rows.map((r: any) => r.c)
}

const ADMIN_A: UserScope = { isSuper: false, institutionId: 10, schemaName: 'setes_zp2a', userId: 501 }
const ADMIN_B: UserScope = { isSuper: false, institutionId: 20, schemaName: 'setes_zp2b', userId: 502 }
const SUPER:   UserScope = { isSuper: true,  institutionId: 1,  schemaName: 'setes_setes', userId: 503 }
const EMAIL = 'pessoa.convp2@example.invalid'

async function main(): Promise<void> {
  const centralBefore = await centralColumns()
  await rawQuery(`DROP DATABASE IF EXISTS \`${PROBE}\``)
  await rawQuery(`CREATE DATABASE \`${PROBE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  try {
    for (const t of TABLES) await rawQuery(`CREATE TABLE ${T(t)} LIKE \`setes_central\`.\`${t}\``)
    const probeQ = { query: (sql: string, p?: any) => rawQuery(redirect(sql).replace(/'setes_central'/g, `'${PROBE}'`), p) } as any

    // P1 — sem o 75 o boot recusa; com ele, aceita
    let before = 'subiu'
    try { await assertInviteSchema(probeQ) } catch (e: any) { before = String(e.message) }
    check('P1: sem o 75 o boot NÃO sobe e nomeia o script', /sql\/75_institution_user_invite_ddl\.sql/.test(before), before.slice(0, 90))

    // sintéticos: convidantes 501..503 e as entidades dos estabelecimentos 10..40
    for (const id of [501, 502, 503]) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [id, `Convidante ${id}`, `C${id}`])
      await rawQuery(`INSERT INTO ${T('tb_user')} (id, password, active, deleted, created_at) VALUES (?, 'HASH', 'S', 'N', NOW())`, [id])
    }
    for (const i of [10, 20, 30, 40]) {
      await rawQuery(`INSERT INTO ${T('tb_entity')} (id, name_company, nick_trade, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [i, `Estab ${i}`, `E${i}`])
      await rawQuery(`INSERT INTO ${T('tb_institution')} (id, schema_name, active, deleted) VALUES (?, ?, 'S', 'N')`, [i, `setes_zp2_${i}`])
    }

    // o 75 REAL no descartável
    for (const st of splitStatements(fs.readFileSync(path.join(SQL_DIR, '75_institution_user_invite_ddl.sql'), 'utf8')
      .replace(/setes_central/g, PROBE))) await rawQuery(st)
    let after = ''
    try { after = await assertInviteSchema(probeQ) } catch (e: any) { after = String(e.message) }
    check('P1: com o 75 o boot sobe', after === 'ok (4 colunas, 4 CHECKs)', after)

    installRedirect()

    // P2 — e-mail novo no estabelecimento 10
    const created = await createUser(ADMIN_A, { nameCompany: 'Pessoa Original', nickTrade: 'Pessoa', email: EMAIL,
      password: 'Senha#Inicial#2026', active: 'S' } as any)
    const uid = created.id
    const l10 = await link(uid, 10)
    check('P2: e-mail novo cria a credencial (resposta só com o id)', JSON.stringify(Object.keys(created)) === '["id"]', JSON.stringify(created))
    check('P2: vínculo nasce ativo, convidado E aceito no mesmo instante, com o convidante',
      l10?.active === 'S' && l10?.inviter === 501 && !!l10?.invited_at && String(l10?.invited_at) === String(l10?.accepted_at)
        && l10?.invite_withdrawn_at === null && Number(l10?.pending) === 0, JSON.stringify(l10))
    const [[cred0]] = await rawQuery<any[]>(`SELECT password FROM ${T('tb_user')} WHERE id = ?`, [uid]) as any
    const users0 = await count('tb_user')
    const entities0 = await count('tb_entity')

    // P3 — o mesmo e-mail no estabelecimento 20: interceptado
    const intercepted = await createUser(ADMIN_B, { nameCompany: 'Nome Que O Admin B Digitou', nickTrade: 'Outro', email: EMAIL,
      password: 'Outra#Senha#2026', active: 'S' } as any)
    const l20 = await link(uid, 20)
    const [[ent]] = await rawQuery<any[]>(`SELECT name_company n, nick_trade k FROM ${T('tb_entity')} WHERE id = ?`, [uid]) as any
    const [[cred1]] = await rawQuery<any[]>(`SELECT password FROM ${T('tb_user')} WHERE id = ?`, [uid]) as any
    check('P3: resposta = mesmo id, existingLogin, pendente — sem nome nem estabelecimentos',
      JSON.stringify(intercepted) === JSON.stringify({ id: uid, existingLogin: true, invite: 'pending' }), JSON.stringify(intercepted))
    check('P3: nenhuma credencial nem entidade nova', (await count('tb_user')) === users0 && (await count('tb_entity')) === entities0)
    check('P3: nome e senha da credencial intactos (A-UC7)', ent?.n === 'Pessoa Original' && ent?.k === 'Pessoa' && cred1?.password === cred0?.password,
      JSON.stringify(ent))
    check('P3: vínculo PENDENTE — inativo, user, convidante 502, invited_at, sem aceite',
      l20?.active === 'N' && l20?.kind === 'user' && l20?.inviter === 502 && !!l20?.invited_at && l20?.accepted_at === null
        && Number(l20?.pending) === 1, JSON.stringify(l20))

    // P4 — de novo: nada muda
    await createUser(ADMIN_B, { nameCompany: 'x', nickTrade: 'x', email: EMAIL, active: 'S' } as any)
    const l20b = await link(uid, 20)
    check('P4: o mesmo convite de novo não muda nada (já pendente)', JSON.stringify(l20b) === JSON.stringify(l20), JSON.stringify(l20b))

    // P5 — onde já é usuária
    const usersBefore5 = await count('tb_institution_has_user')
    const r5 = await expectHttp(createUser(ADMIN_A, { nameCompany: 'x', nickTrade: 'x', email: EMAIL, active: 'S' } as any), 409, 'USER_ALREADY_LINKED')
    check('P5: no estabelecimento onde já é usuária = 409 USER_ALREADY_LINKED, nada gravado',
      r5 === 'ok' && (await count('tb_institution_has_user')) === usersBefore5 && JSON.stringify(await link(uid, 10)) === JSON.stringify(l10), r5)

    // P6 — quem intercepta pede admin
    const r6 = await expectHttp(createUser({ ...ADMIN_A, institutionId: 30 }, { nameCompany: 'x', nickTrade: 'x', email: EMAIL,
      active: 'S', kind: 'admin' } as any), 400, 'INVITE_PROFILE_USER_ONLY')
    check('P6: quem intercepta pedindo Administrador = 400 INVITE_PROFILE_USER_ONLY, nada gravado', r6 === 'ok' && (await link(uid, 30)) === null, r6)

    // P7 — retirar
    await withdrawUserInvite(ADMIN_B, uid, null)
    const l20w = await link(uid, 20)
    check('P7: retirada grava invite_withdrawn_at; o retirado deixa de ser "aguardando"',
      !!l20w?.invite_withdrawn_at && l20w?.active === 'N' && Number(l20w?.pending) === 0, JSON.stringify(l20w))
    const r7 = await expectHttp(withdrawUserInvite(ADMIN_B, uid, null), 409, 'INVITE_NOT_PENDING')
    check('P7: retirar de novo = 409 INVITE_NOT_PENDING', r7 === 'ok', r7)
    const r7b = await expectHttp(withdrawUserInvite(ADMIN_A, uid, null), 409, 'INVITE_NOT_PENDING')
    check('P7: retirar vínculo aceito = 409 INVITE_NOT_PENDING (só convite nunca aceito)', r7b === 'ok', r7b)

    // P8 — convidar de novo
    await createUser(ADMIN_B, { nameCompany: 'x', nickTrade: 'x', email: EMAIL, active: 'S' } as any)
    const l20r = await link(uid, 20)
    check('P8: novo convite depois da retirada = pendente de novo, retirada limpa',
      l20r?.invite_withdrawn_at === null && Number(l20r?.pending) === 1 && l20r?.active === 'N', JSON.stringify(l20r))

    // P9 — o banco recusa ativar o pendente direto
    let r9 = 'passou'
    try {
      await rawQuery(`UPDATE ${T('tb_institution_has_user')} SET active = 'S' WHERE tb_user_id = ? AND tb_institution_id = 20`, [uid])
    } catch (e: any) { r9 = `${e.errno} ${e.message}` }
    check('P9: ativar o pendente direto é recusado pelo CHECK ck_ihu_pending_inactive (A-UC8)', /^4025\b/.test(r9) && r9.includes('ck_ihu_pending_inactive'), r9)

    // P10 — vínculos do Super. Antes: 10 aceito ativo, 20 pendente; um vínculo ANTIGO sem convite no 40 (inativo, como os de antes do 75)
    await rawQuery(`INSERT INTO ${T('tb_institution_has_user')} (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
      VALUES (40, ?, 'user', 'N', NOW(), NOW(), 'N')`, [uid])
    await saveInstitutionLinks(SUPER, uid, [{ institutionId: 10, kind: 'user' }, { institutionId: 30, kind: 'admin' }, { institutionId: 40, kind: 'user' }])
    const [s10, s20, s30, s40] = [await link(uid, 10), await link(uid, 20), await link(uid, 30), await link(uid, 40)]
    check('P10: par novo (30) = convite PENDENTE com o Super convidante e o perfil escolhido',
      s30?.active === 'N' && s30?.kind === 'admin' && s30?.inviter === 503 && Number(s30?.pending) === 1, JSON.stringify(s30))
    check('P10: pendente fora da lista (20) = RETIRADO (o login não o aceitaria depois)',
      !!s20?.invite_withdrawn_at && Number(s20?.pending) === 0 && s20?.active === 'N', JSON.stringify(s20))
    check('P10: aceito na lista (10) segue ativo e aceito', s10?.active === 'S' && !!s10?.accepted_at, JSON.stringify(s10))
    check('P10: antigo sem convite na lista (40) ativa como antes e NÃO vira convite',
      s40?.active === 'S' && s40?.invited_at === null, JSON.stringify(s40))
    await saveInstitutionLinks(SUPER, uid, [{ institutionId: 10, kind: 'user' }, { institutionId: 30, kind: 'user' }])
    const [t30, t40] = [await link(uid, 30), await link(uid, 40)]
    check('P10: pendente que fica na lista só muda o perfil (continua pendente, nunca ativo)',
      t30?.kind === 'user' && t30?.active === 'N' && Number(t30?.pending) === 1 && String(t30?.invited_at) === String(s30?.invited_at), JSON.stringify(t30))
    check('P10: antigo sem convite fora da lista inativa como antes', t40?.active === 'N' && t40?.invited_at === null, JSON.stringify(t40))

    // P11 — a lista do Super
    const grants = await listInstitutionLinks(uid)
    const g = (i: number) => grants.find(x => Number(x.institutionId) === i)
    check('P11: a lista do Super mostra o pendente como concedido, com invite=pending; o aceito sem marca; o retirado não concedido',
      g(30)?.granted === 'S' && g(30)?.invite === 'pending' && g(10)?.granted === 'S' && g(10)?.invite === null && g(20)?.granted === 'N',
      JSON.stringify(grants.map(x => [x.institutionId, x.granted, x.invite])))

    // P13 — os dados do aviso por e-mail
    const notice = await findInviteNoticeData(uid, 30)
    check('P13: o aviso lê só o e-mail de login e o nome do estabelecimento',
      JSON.stringify(notice) === JSON.stringify({ email: EMAIL, institutionName: 'E30' }), JSON.stringify(notice))

    // P14 — o nome some no foco do convite nunca aceito (30 está pendente); aparece no foco aceito (10) e sem foco
    const q = (filter: string) => ({ filter, page: 1, pageSize: 25, offset: 0, criteria: NO_CRITERIA }) as any
    const in30 = (await listUsers(q(''), 30)).rows.find(r => Number(r.id) === uid)
    const in10 = (await listUsers(q(''), 10)).rows.find(r => Number(r.id) === uid)
    check('P14: lista no foco pendente = sem nome, com e-mail e invite=pending; no foco aceito o nome aparece',
      in30?.name === null && in30?.email === EMAIL && in30?.invite === 'pending' && in10?.name === 'Pessoa', JSON.stringify([in30, in10]))
    const byName30 = (await listUsers(q('Pessoa Original'), 30)).rows.length
    const byMail30 = (await listUsers(q('pessoa.convp2'), 30)).rows.length
    const byName10 = (await listUsers(q('Pessoa Original'), 10)).rows.length
    check('P14: a busca por nome NÃO acha o pendente (pelo e-mail acha; no foco aceito o nome acha)',
      byName30 === 0 && byMail30 === 1 && byName10 === 1, JSON.stringify({ byName30, byMail30, byName10 }))
    const g30 = await getUser(uid, 30)
    const gAll = await getUser(uid, null)
    check('P14: GET no foco pendente sem nome; sem foco (Super) com nome',
      g30?.nameCompany === null && g30?.nickTrade === null && (g30 as any)?.invite === 'pending' && gAll?.nickTrade === 'Pessoa',
      JSON.stringify([g30, gAll]))
    const ADMIN_30: UserScope = { isSuper: false, institutionId: 30, schemaName: 'setes_zp2_30', userId: 501 }
    const put = { nameCompany: 'Pessoa Original', nickTrade: 'Pessoa', email: EMAIL }
    const r14a = await expectHttp(editUser(ADMIN_30, uid, { ...put, nickTrade: 'Renomeado' } as any), 409, 'INVITE_PENDING')
    const r14b = await expectHttp(editUser(SUPER, uid, { ...put, active: 'S', institutionId: 30 } as any), 409, 'INVITE_PENDING')
    const s30b = await link(uid, 30)
    check('P14: o PUT não ativa o pendente (nem o Super) e o admin do convite não edita a credencial (A-UC8/A-UC7)',
      r14a === 'ok' && r14b === 'ok' && s30b?.active === 'N' && Number(s30b?.pending) === 1, JSON.stringify([r14a, r14b]))
  } finally {
    removeRedirect()
    await rawQuery(`DROP DATABASE IF EXISTS \`${PROBE}\``)
    const centralAfter = await centralColumns()
    check('P12: setes_central intacta (mesmas colunas antes e depois)',
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
