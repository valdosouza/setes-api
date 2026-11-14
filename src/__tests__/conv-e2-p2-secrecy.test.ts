/// <reference types="jest" />
// CONV.E2.P2 — passo 6 da ficha (T3): nenhuma resposta do cadastro diz ONDE o e-mail é login nem o NOME da pessoa; quem intercepta não
// altera o nome da credencial (A-UC4, A-UC7); o PUT não ativa convite pendente (A-UC8). As consultas reais (lista, busca, GET) estão
// provadas em setes_central descartável (scripts/prove-conv-e2-p2.ts, P14).
import * as repo from '../modules/users/users.repository'
import { createUser, editUser } from '../modules/users/users.service'
import { USER_SEARCH_CRITERIA } from '../modules/users/users.repository'
import { UserScope } from '../modules/users/users.interface'

jest.mock('../modules/users/users.repository', () => ({
  ...jest.requireActual('../modules/users/users.repository'),
  getUser: jest.fn(), listActiveUserLinks: jest.fn(), updateUserCascade: jest.fn(),
  findLoginEmailOwner: jest.fn(), inviteToInstitution: jest.fn(), findInviteNoticeData: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

const mockGet    = repo.getUser             as jest.Mock
const mockLinks  = repo.listActiveUserLinks as jest.Mock
const mockUpdate = repo.updateUserCascade   as jest.Mock

const adminX: UserScope = { isSuper: false, institutionId: 5, schemaName: 'setes_acme', userId: 41 }
const sup:    UserScope = { isSuper: true,  institutionId: 1, schemaName: 'setes_setes', userId: 2 }
const current = { id: 9, nameCompany: 'Nome Da Pessoa', nickTrade: 'Pessoa', email: 'p@x.com', active: 'S', hasCredential: true }
const put = { nameCompany: 'Nome Da Pessoa', nickTrade: 'Pessoa', email: 'p@x.com' }
const link = (institutionId: number, alive: boolean, invite: string | null = null) =>
  ({ institutionId, kind: 'user', alive, deleted: false, invite })

beforeEach(() => {
  jest.clearAllMocks()
  mockGet.mockResolvedValue(current)
  mockUpdate.mockResolvedValue(undefined)
})

describe('A-UC7 — o nome é da pessoa', () => {
  it('quem criou corrige o nome enquanto não há vínculo ATIVO em outro estabelecimento', async () => {
    mockLinks.mockResolvedValue([link(5, true, 'accepted'), link(7, false, 'pending')])
    await expect(editUser(adminX, 9, { ...put, nickTrade: 'Corrigido' } as any)).resolves.toBeUndefined()
    expect(mockUpdate).toHaveBeenCalled()
  })
  it('com vínculo ATIVO em outro estabelecimento, o admin não altera o nome: 409 USER_NAME_MANAGED_BY_SUPER, nada gravado', async () => {
    mockLinks.mockResolvedValue([link(5, true, 'accepted'), link(7, true, 'accepted')])
    await expect(editUser(adminX, 9, { ...put, nameCompany: 'Outro Nome' } as any)).rejects.toMatchObject({
      statusCode: 409, code: 'USER_NAME_MANAGED_BY_SUPER' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })
  it('… mas o mesmo nome (com espaços nas pontas) passa — editar o ativo do próprio vínculo continua possível', async () => {
    mockLinks.mockResolvedValue([link(5, true, 'accepted'), link(7, true, null)])
    await expect(editUser(adminX, 9, { ...put, nickTrade: ' Pessoa ', active: 'N' } as any)).resolves.toBeUndefined()
  })
  it('o Super altera o nome em qualquer caso', async () => {
    mockLinks.mockResolvedValue([link(5, true, 'accepted'), link(7, true, 'accepted')])
    await expect(editUser(sup, 9, { ...put, nameCompany: 'Outro Nome' } as any)).resolves.toBeUndefined()
  })
})

describe('A-UC8 / D-UC15 — o convite no PUT', () => {
  it('o admin cujo vínculo é convite nunca aceito não edita a credencial (pendente ou retirado): 409 INVITE_PENDING', async () => {
    for (const invite of ['pending', 'withdrawn']) {
      mockLinks.mockResolvedValue([link(5, false, invite), link(7, true, 'accepted')])
      await expect(editUser(adminX, 9, put as any)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_PENDING' })
    }
    expect(mockUpdate).not.toHaveBeenCalled()
  })
  it('nem o Super ativa um convite pendente pelo cadastro (só o login do titular)', async () => {
    mockLinks.mockResolvedValue([link(7, false, 'pending')])
    await expect(editUser(sup, 9, { ...put, active: 'S', institutionId: 7 } as any)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_PENDING' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })
  it('nem o Super ativa um convite RETIRADO (nunca aceito) pelo cadastro — achado da fixture do P6', async () => {
    mockLinks.mockResolvedValue([link(7, false, 'withdrawn')])
    await expect(editUser(sup, 9, { ...put, active: 'S', institutionId: 7 } as any)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_PENDING' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('reativar um vínculo já aceito continua direto (A-UC8)', async () => {
    mockLinks.mockResolvedValue([link(5, false, 'accepted')])
    await expect(editUser(adminX, 9, { ...put, active: 'S' } as any)).resolves.toBeUndefined()
    expect(mockUpdate).toHaveBeenCalledWith(9, expect.anything(), null, 5)
  })
})

describe('A-UC4 — nada revela onde nem o nome', () => {
  it('o POST interceptado devolve só id, existingLogin e invite', async () => {
    ;(repo.findLoginEmailOwner as jest.Mock).mockResolvedValue(77)
    ;(repo.inviteToInstitution as jest.Mock).mockResolvedValue('already-pending')
    const r = await createUser(adminX, { nameCompany: 'x', nickTrade: 'x', email: 'p@x.com', active: 'S' } as any)
    expect(r).toEqual({ id: 77, existingLogin: true, invite: 'pending' })
  })
  it('o critério "nome" da pesquisa avançada esconde o nome no foco do convite nunca aceito', () => {
    const name = USER_SEARCH_CRITERIA.find(c => c.key === 'name')!
    for (const expr of name.expr as readonly string[]) {
      expect(expr).toMatch(/^CASE WHEN \(ihu\.invited_at IS NOT NULL AND ihu\.accepted_at IS NULL\) THEN NULL ELSE e\.(nick_trade|name_company) END$/)
    }
  })
})
