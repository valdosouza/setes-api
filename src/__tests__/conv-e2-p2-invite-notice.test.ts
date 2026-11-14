/// <reference types="jest" />
// CONV.E2.P2 — passo 5 da ficha (T2): o aviso ao titular sai no FIM do fluxo pela `@shared/mailer`; sem SMTP vai ao log; falha do
// envio não desfaz o vínculo; o texto não leva token, link de ação nem dado de outro estabelecimento (D-UC12); e-mail mascarado no log.
jest.mock('../modules/users/users.repository')
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, ...jest.requireActual('../shared/mailer/mailer'),
  sendMail: jest.fn().mockResolvedValue(undefined),
}))

import * as repo from '../modules/users/users.repository'
import logger from '../shared/logger/logger'
import { sendMail } from '../shared/mailer/mailer'
import { createUser, saveInstitutionLinks } from '../modules/users/users.service'
import { waitForPendingInviteNotices, INVITE_NOTICE_SUBJECT, inviteNoticeText } from '../shared/user/invite-notice'
import { UserScope } from '../modules/users/users.interface'

const mail = sendMail as jest.Mock
const order: string[] = []
const admin: UserScope = { isSuper: false, institutionId: 5, schemaName: 'setes_acme', userId: 41 }
const sup:   UserScope = { isSuper: true,  institutionId: 1, schemaName: 'setes_setes', userId: 2 }
const input = { nameCompany: 'x', nickTrade: 'x', email: 'pessoa@x.com', active: 'S' } as any

beforeEach(() => {
  jest.clearAllMocks()
  order.length = 0
  ;(repo.findLoginEmailOwner as jest.Mock).mockResolvedValue(77)
  ;(repo.inviteToInstitution as jest.Mock).mockImplementation(async () => { order.push('commit do convite'); return 'invited' })
  ;(repo.findInviteNoticeData as jest.Mock).mockResolvedValue({ email: 'pessoa@x.com', institutionName: 'Loja <B> & Cia' })
  ;(repo.userExists as jest.Mock).mockResolvedValue(true)
  ;(repo.listActiveUserLinks as jest.Mock).mockResolvedValue([])
  mail.mockImplementation(async () => { order.push('e-mail') })
})

describe('aviso de convite (T2)', () => {
  it('sai DEPOIS do commit do convite, ao e-mail de login, com o assunto do aviso', async () => {
    await createUser(admin, input)
    await waitForPendingInviteNotices()
    expect(order).toEqual(['commit do convite', 'e-mail'])
    expect(mail).toHaveBeenCalledTimes(1)
    expect(mail.mock.calls[0][0]).toMatchObject({ to: 'pessoa@x.com', subject: INVITE_NOTICE_SUBJECT })
    expect(repo.findInviteNoticeData).toHaveBeenCalledWith(77, 5)
  })

  it('falha do envio NÃO desfaz o vínculo: o cadastro responde, o erro vai ao log com o e-mail mascarado', async () => {
    mail.mockRejectedValue(Object.assign(new Error('SMTP fora para pessoa@x.com'), { code: 'ECONNREFUSED' }))
    await expect(createUser(admin, input)).resolves.toEqual({ id: 77, existingLogin: true, invite: 'pending' })
    await waitForPendingInviteNotices()
    const logged = JSON.stringify((logger.error as jest.Mock).mock.calls)
    expect(logged).toContain('o convite segue valendo')
    expect(logged).not.toContain('pessoa@x.com')
    expect(logged).toContain('p***@x.com')
  })

  it('convite já pendente não reenvia', async () => {
    ;(repo.inviteToInstitution as jest.Mock).mockResolvedValue('already-pending')
    await createUser(admin, input)
    await waitForPendingInviteNotices()
    expect(mail).not.toHaveBeenCalled()
  })

  it('convite renovado (depois da retirada) avisa de novo', async () => {
    ;(repo.inviteToInstitution as jest.Mock).mockResolvedValue('reinvited')
    await createUser(admin, input)
    await waitForPendingInviteNotices()
    expect(mail).toHaveBeenCalledTimes(1)
  })

  it('vínculos do Super (D-UC16): um aviso por estabelecimento que recebeu convite novo', async () => {
    ;(repo.setInstitutionLinks as jest.Mock).mockResolvedValue([7, 9])
    await saveInstitutionLinks(sup, 77, [{ institutionId: 7, kind: 'user' }, { institutionId: 9, kind: 'user' }])
    await waitForPendingInviteNotices()
    expect((repo.findInviteNoticeData as jest.Mock).mock.calls).toEqual([[77, 7], [77, 9]])
    expect(mail).toHaveBeenCalledTimes(2)
  })

  it('sem SMTP o aviso vai ao log (modo dev) e o cadastro segue', async () => {
    const real = jest.requireActual('../shared/mailer/mailer') as typeof import('../shared/mailer/mailer')
    const saved = { host: process.env.SMTP_HOST, user: process.env.SMTP_USER }
    delete process.env.SMTP_HOST; delete process.env.SMTP_USER
    try {
      mail.mockImplementation(real.sendMail)
      await expect(createUser(admin, input)).resolves.toMatchObject({ existingLogin: true })
      await waitForPendingInviteNotices()
      expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).toContain('SMTP não configurado')
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      if (saved.host !== undefined) process.env.SMTP_HOST = saved.host
      if (saved.user !== undefined) process.env.SMTP_USER = saved.user
    }
  })

  it('o texto não leva token, link nem endereço; o nome do estabelecimento sai escapado no HTML', () => {
    const { text, html } = inviteNoticeText('Loja <B> & Cia')
    for (const body of [text, html]) {
      expect(body).not.toMatch(/https?:\/\/|token|código|\?/i)
    }
    expect(html).toContain('Loja &lt;B&gt; &amp; Cia')
    expect(html).not.toContain('<B>')
  })
})
