import pool from '@shared/db/connection'

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
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user'`)
  const present = new Set((rows as any[]).map(r => String(r.name)))
  const missing = INVITE_CHECKS.filter(name => !present.has(name))
  if (missing.length > 0) {
    throw new Error(`setes_central.tb_institution_has_user sem o(s) CHECK(s) ${missing.join(', ')} — aplique o script ${SCRIPT} `
      + 'em setes_central ANTES do setes-api (A-UC8: convite pendente nunca ativo)')
  }
  return `ok (${INVITE_COLUMNS.length} colunas, ${INVITE_CHECKS.length} CHECKs)`
}
