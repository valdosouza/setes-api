import logger from '@shared/logger/logger'
import { sendMail, maskEmail, mailErrorForLog } from '@shared/mailer/mailer'
import { findInviteNoticeData } from './users.repository'

/**
 * Aviso ao TITULAR de que um estabelecimento o convidou (D-UC4/D-UC12 — setes-api:CONV.E2.P2.T2). Sai no FIM do fluxo, DEPOIS do
 * commit do vínculo, pela peça `@shared/mailer`:
 *   - sem SMTP o `sendMail` só registra no log (modo dev); falha do envio vai ao log e NUNCA desfaz o vínculo (o convite vale sem o
 *     aviso — o titular o vê no próximo login, que é o aceite);
 *   - o texto não leva token, link de ação nem dado de OUTRO estabelecimento (D-UC12: o login é o aceite; nenhuma porta pública nova);
 *   - o e-mail vai ao log sempre mascarado (D-EA21).
 * O envio corre fora da resposta (o admin não espera o SMTP); `waitForPendingInviteNotices` serve aos testes e ao desligamento.
 */

export const INVITE_NOTICE_SUBJECT = 'Setes — você foi adicionado a um estabelecimento'

const pending = new Set<Promise<void>>()

export async function waitForPendingInviteNotices(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export function inviteNoticeText(institutionName: string): { text: string; html: string } {
  const text = `${institutionName} adicionou você como usuário no sistema de gestão da Setes. `
    + 'Para começar a usar, entre no aplicativo com o seu e-mail e a sua senha de sempre — o seu próximo acesso confirma o convite. '
    + 'Se você não reconhece este estabelecimento, não entre: peça a quem o administra para retirar o convite.'
  const name = escapeHtml(institutionName)
  const html = '<div style="font-family:Arial,sans-serif">'
    + `<p><strong>${name}</strong> adicionou você como usuário no sistema de gestão da Setes.</p>`
    + '<p>Para começar a usar, entre no aplicativo com o seu e-mail e a sua senha de sempre — o seu próximo acesso confirma o convite.</p>'
    + '<p>Se você não reconhece este estabelecimento, não entre: peça a quem o administra para retirar o convite.</p></div>'
  return { text, html }
}

/** Dispara o aviso (nunca lança): chamado depois do commit do convite. */
export function notifyInvite(userId: number, institutionId: number): void {
  const job: Promise<void> = (async () => {
    let to: string | null = null
    try {
      const data = await findInviteNoticeData(userId, institutionId)
      if (!data) {
        logger.warn('Aviso de convite NÃO enviado — credencial sem e-mail de login ou estabelecimento sem nome', { userId, institutionId })
        return
      }
      to = data.email
      await sendMail({ to, subject: INVITE_NOTICE_SUBJECT, ...inviteNoticeText(data.institutionName) })
    } catch (err) {
      logger.error('Falha no aviso de convite por e-mail — o convite segue valendo', {
        userId, institutionId, to: maskEmail(to), ...mailErrorForLog(err),
      })
    }
  })().finally(() => pending.delete(job))
  pending.add(job)
}
