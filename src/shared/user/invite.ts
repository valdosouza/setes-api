import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { LOGIN_GROUP_ID } from './index'

/**
 * Peça `user` — o CONVITE no vínculo (`setes_central.tb_institution_has_user`, script central 75; D-UC10, D-UC14, D-UC15).
 *
 * Estado DERIVADO das quatro colunas (nunca coluna própria):
 *   aguardando aceite = `invited_at` preenchido E `accepted_at` vazio E `invite_withdrawn_at` vazio
 *   convite retirado  = `invite_withdrawn_at` preenchido
 *   sem convite       = `invited_at` vazio (vínculos de antes do 75 e os do setes-sync) — o login nunca os ativa (D-UC14)
 * Os quatro CHECKs do 75 são a rede de segurança no banco: convite pendente nunca ativo (A-UC8), aceite só depois do convite, retirada
 * só de convite nunca aceito.
 */

/** As quatro colunas do script 75 que o código lê e grava. */
export const INVITE_COLUMNS = ['tb_user_inviter_id', 'invited_at', 'accepted_at', 'invite_withdrawn_at'] as const

/** Os quatro CHECKs do script 75 (nome no banco). */
export const INVITE_CHECKS = [
  'ck_ihu_inviter_has_invite', 'ck_ihu_pending_inactive', 'ck_ihu_accept_after_invite', 'ck_ihu_withdraw_pending',
] as const

/** SQL (sem alias) do "aguardando aceite" sobre `tb_institution_has_user` — o prefixo é o alias da tabela, com o ponto. */
export function pendingInviteSql(alias = ''): string {
  return `(${alias}invited_at IS NOT NULL AND ${alias}accepted_at IS NULL AND ${alias}invite_withdrawn_at IS NULL)`
}

const SCRIPT = 'sql/75_institution_user_invite_ddl.sql'

/**
 * Boot (recomendação do guardião no CONV.E2.P1): sem as colunas do 75 o setes-api NÃO sobe — senão o cadastro viraria 500 na 1ª
 * criação; sem os CHECKs ele também não sobe — eles são a trava de que convite pendente nunca fica ativo, e o código conta com ela.
 */
export async function assertInviteSchema(q: Pick<typeof pool, 'query'> = pool): Promise<string> {
  try {
    await q.query(`SELECT ${INVITE_COLUMNS.join(', ')} FROM setes_central.tb_institution_has_user LIMIT 0`)
  } catch (err: any) {
    if (err?.errno === 1054 || err?.code === 'ER_BAD_FIELD_ERROR') {
      throw new Error(`setes_central.tb_institution_has_user sem as colunas do convite — aplique o script ${SCRIPT} `
        + 'em setes_central ANTES do setes-api (D-UC14/D-UC15)')
    }
    throw err
  }
  const [rows] = await q.query<any[]>(
    `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user'`)
  const present = new Set((rows as any[]).map(r => String(r.name)))
  // re-gate adversarial do CONV.E2.P6 (D3a): a versão antiga do 75 recusava só o PENDENTE ativo; a nova recusa todo convite NUNCA aceito
  // (pendente OU retirado). O corpo antigo cita `invite_withdrawn_at` — com ele o boot não sobe
  const pending = (rows as any[]).find(r => String(r.name) === 'ck_ihu_pending_inactive')
  if (pending && /invite_withdrawn_at/i.test(String(pending.clause ?? ''))) {
    throw new Error(`setes_central.tb_institution_has_user com a versão ANTIGA do CHECK ck_ihu_pending_inactive — reaplique o script ${SCRIPT} `
      + '(ele troca o CHECK) ANTES do setes-api (A-UC8: convite nunca aceito nunca ativo)')
  }
  const missing = INVITE_CHECKS.filter(name => !present.has(name))
  if (missing.length > 0) {
    throw new Error(`setes_central.tb_institution_has_user sem o(s) CHECK(s) ${missing.join(', ')} — aplique o script ${SCRIPT} `
      + 'em setes_central ANTES do setes-api (A-UC8: convite pendente nunca ativo)')
  }
  return `ok (${INVITE_COLUMNS.length} colunas, ${INVITE_CHECKS.length} CHECKs)`
}

/** Situação do convite de um vínculo: `null` = sem convite (anterior ao 75, do setes-sync). */
export type LinkInviteState = 'pending' | 'withdrawn' | 'accepted' | null

/** CASE do estado do convite sobre `tb_institution_has_user` — o prefixo é o alias da tabela, com o ponto. */
export const INVITE_STATE_SQL = (a: string) =>
  `CASE WHEN ${a}invited_at IS NULL THEN NULL
        WHEN ${a}accepted_at IS NOT NULL THEN 'accepted'
        WHEN ${a}invite_withdrawn_at IS NOT NULL THEN 'withdrawn'
        ELSE 'pending' END`

/** Resultado do convite: novo vínculo, convite renovado (retirado antes, ou vínculo excluído) ou já pendente (nada muda). */
export type InviteOutcome = 'invited' | 'reinvited' | 'already-pending'

/**
 * Grava o CONVITE do usuário (credencial que JÁ existe) no estabelecimento, numa transação com a linha do par travada:
 *   sem vínculo                       → INSERT pendente (inativo, `kind`, convidante, `invited_at` = agora)
 *   convite retirado ou vínculo excluído (nunca aceito) → regrava o convite e limpa a retirada (D-UC15)
 *   convite pendente                  → nada muda ('already-pending': sem novo aviso)
 *   vínculo aceito, ativo ou sem convite → 409 USER_ALREADY_LINKED (o admin já vê esse usuário na própria lista)
 */
export async function inviteToInstitution(
  userId: number, institutionId: number, kind: string, inviterId: number | null
): Promise<InviteOutcome> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT deleted, ${INVITE_STATE_SQL('')} AS invite
         FROM setes_central.tb_institution_has_user
        WHERE tb_institution_id = ? AND tb_user_id = ?
        FOR UPDATE`,
      [institutionId, userId]
    )
    let outcome: InviteOutcome
    if (rows.length === 0) {
      await conn.query(
        `INSERT INTO setes_central.tb_institution_has_user
           (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted, tb_user_inviter_id, invited_at)
         VALUES (?, ?, ?, 'N', NOW(), NOW(), 'N', ?, NOW())`,
        [institutionId, userId, kind, inviterId]
      )
      outcome = 'invited'
    } else {
      const row = rows[0]
      const invite = (row.invite ?? null) as LinkInviteState
      if (invite === 'pending' && row.deleted !== 'S') {
        // o convite repetido não reenvia o aviso, mas o perfil escolhido agora vale (gate socrático do P6, LOW)
        await conn.query(
          `UPDATE setes_central.tb_institution_has_user SET kind = ?, updated_at = NOW()
            WHERE tb_institution_id = ? AND tb_user_id = ? AND kind <> ?`,
          [kind, institutionId, userId, kind]
        )
        outcome = 'already-pending'
      } else if (invite === 'withdrawn' || (row.deleted === 'S' && invite !== 'accepted')) {
        // o novo convite regrava os campos do convite e limpa a retirada; o histórico fica no log (D-UC15)
        await conn.query(
          `UPDATE setes_central.tb_institution_has_user
              SET kind = ?, active = 'N', deleted = 'N', tb_user_inviter_id = ?, invited_at = NOW(),
                  accepted_at = NULL, invite_withdrawn_at = NULL, updated_at = NOW()
            WHERE tb_institution_id = ? AND tb_user_id = ?`,
          [kind, inviterId, institutionId, userId]
        )
        outcome = 'reinvited'
      } else {
        const msg = 'Este e-mail já é de um usuário deste estabelecimento — edite-o na lista'
        throw new HttpError(409, msg, [{ field: 'email', message: msg }], ErrorCodes.USER_ALREADY_LINKED)
      }
    }
    await conn.commit()
    return outcome
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Dados do aviso de convite (D-UC12): o e-mail de LOGIN do titular e o nome do estabelecimento que convidou — nada mais. */
export async function findInviteNoticeData(
  userId: number, institutionId: number
): Promise<{ email: string; institutionName: string } | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT m.email,
            COALESCE(NULLIF(ie.nick_trade, ''), ie.name_company) AS institutionName
       FROM setes_central.tb_entity_has_mailing ehm
       INNER JOIN setes_central.tb_mailing m ON m.id = ehm.tb_mailing_id AND m.deleted = 'N'
       INNER JOIN setes_central.tb_entity ie ON ie.id = ?
      WHERE ehm.tb_entity_id = ? AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID} AND ehm.deleted = 'N'
      LIMIT 1`,
    [institutionId, userId]
  )
  const r = rows[0]
  return r && r.email && r.institutionName ? { email: String(r.email), institutionName: String(r.institutionName) } : null
}

/**
 * A credencial tem vínculo de SUPER (vivo ou adormecido)? D-UC22 (Valdo, 2026-11-14): o onboarding não convida conta de super como 1º
 * admin de um cliente — o Super se vincula a clientes só pela tela de vínculos (como na D-UC17 para o cadastro do cliente).
 */
export async function hasSuperLink(userId: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_institution_has_user WHERE tb_user_id = ? AND BINARY kind = 'super' LIMIT 1`,
    [userId]
  )
  return rows.length > 0
}
