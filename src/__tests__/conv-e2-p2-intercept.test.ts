/// <reference types="jest" />
// CONV.E2.P2 — passo 3 da ficha: a criação interceptada no cadastro (D-UC4, D-UC12, D-UC16, A-UC3, A-UC7). Repositório DUBLADO: a
// gravação real (transação, trava do par e CHECKs) é provada em setes_central DESCARTÁVEL por scripts/prove-conv-e2-p2.ts.
import * as repo from '../modules/users/users.repository'
import { createUser } from '../modules/users/users.service'
import { UserCreateInput, UserScope } from '../modules/users/users.interface'

jest.mock('../modules/users/users.repository')
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
import logger from '../shared/logger/logger'

const mockFindOwner = repo.findLoginEmailOwner as jest.Mock
const mockInsert    = repo.insertUserCascade   as jest.Mock
const mockInvite    = repo.inviteToInstitution as jest.Mock

const admin: UserScope = { isSuper: false, institutionId: 5, schemaName: 'setes_acme', userId: 41 }
const sup:   UserScope = { isSuper: true,  institutionId: 1, schemaName: 'setes_setes', userId: 2 }
const input: UserCreateInput = { nameCompany: 'Nome que o admin digitou', nickTrade: 'Apelido', email: 'pessoa@x.com', active: 'S' }

beforeEach(() => {
  jest.clearAllMocks()
  mockFindOwner.mockResolvedValue(77)          // o e-mail JÁ é login da credencial 77
  mockInvite.mockResolvedValue('invited')
  mockInsert.mockResolvedValue(900)
  ;(repo.listActiveUserLinks as jest.Mock).mockResolvedValue([])
})

describe('createUser — e-mail que já é login (D-UC4)', () => {
  it('o 409 do cadastro deixou de existir: vira convite pendente no estabelecimento do JWT, perfil user, convidante = quem opera', async () => {
    const r = await createUser(admin, { ...input, institutionId: 999 })
    expect(r).toEqual({ id: 77, existingLogin: true, invite: 'pending' })
    expect(mockInvite).toHaveBeenCalledWith(77, 5, 'user', 41)
  })

  it('nenhuma credencial nova: a cascata não roda e nada do corpo (nome, senha, ativo) é gravado (A-UC7)', async () => {
    await createUser(admin, { ...input, password: 'SenhaQueSeriaNova#2026', active: 'N' })
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockInvite.mock.calls[0]).toEqual([77, 5, 'user', 41])   // só o par, o perfil e o convidante
  })

  it('quem intercepta não escolhe Administrador (A-UC3): 400 INVITE_PROFILE_USER_ONLY, nada gravado', async () => {
    await expect(createUser(admin, { ...input, kind: 'admin' })).rejects.toMatchObject({
      statusCode: 400, code: 'INVITE_PROFILE_USER_ONLY', fields: [{ field: 'kind', message: expect.any(String) }],
    })
    expect(mockInvite).not.toHaveBeenCalled()
  })

  it('a conta com vínculo de super (vivo ou adormecido) não é interceptada pelo cliente: 409 genérico de antes (D-PV11/D-PV12)', async () => {
    ;(repo.listActiveUserLinks as jest.Mock).mockResolvedValue([{ institutionId: 1, kind: 'super', alive: false, deleted: false, invite: null }])
    await expect(createUser(admin, input)).rejects.toMatchObject({
      statusCode: 409, fields: [{ field: 'email', message: 'E-mail já usado como login de outro usuário' }] })
    expect(mockInvite).not.toHaveBeenCalled()
    // D-UC20: a recusa deixa UMA linha de alarme, com quem tentou e sem o e-mail
    const warns = JSON.stringify((logger.warn as jest.Mock).mock.calls)
    expect(warns).toContain('[ALARME CONVITE]')
    expect(warns).toContain('"byUserId":41')
    expect(warns).not.toContain('pessoa@x.com')
  })

  it('o Super também passa pelo convite (D-UC16) e escolhe o perfil', async () => {
    const r = await createUser(sup, { ...input, institutionId: 7, kind: 'admin' })
    expect(r).toEqual({ id: 77, existingLogin: true, invite: 'pending' })
    expect(mockInvite).toHaveBeenCalledWith(77, 7, 'admin', 2)
  })

  it('o vínculo que já existe passa adiante o 409 do repositório (USER_ALREADY_LINKED)', async () => {
    mockInvite.mockRejectedValue(Object.assign(new Error('x'), { statusCode: 409, code: 'USER_ALREADY_LINKED' }))
    await expect(createUser(admin, input)).rejects.toMatchObject({ statusCode: 409, code: 'USER_ALREADY_LINKED' })
  })

  it('a resposta não traz nome nem estabelecimentos da pessoa (A-UC4)', async () => {
    const r = await createUser(admin, input)
    expect(Object.keys(r).sort()).toEqual(['existingLogin', 'id', 'invite'])
  })
})

describe('createUser — e-mail novo (criação de hoje)', () => {
  it('sem senha = 400 no campo (a senha só é opcional no corpo para o cadastro já existente)', async () => {
    mockFindOwner.mockResolvedValue(null)
    await expect(createUser(admin, input)).rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'password' }] })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('com senha cria a credencial e o vínculo convidado+aceito, com o convidante', async () => {
    mockFindOwner.mockResolvedValue(null)
    const r = await createUser(admin, { ...input, password: 'SenhaInicial#2026' })
    expect(r).toEqual({ id: 900 })
    expect(mockInsert.mock.calls[0][2]).toEqual({ institutionId: 5, kind: 'user', inviterId: 41 })
    expect(mockInvite).not.toHaveBeenCalled()
  })
})
