/// <reference types="jest" />
// CONV.E2.P2 — passo 4 da ficha: os vínculos do Super passam pelo convite (D-UC16) e a retirada do convite (D-UC15, T4). Repositório
// DUBLADO; a gravação real (cada caso do par, a retirada do pendente que sai da lista, os CHECKs) é provada em setes_central
// DESCARTÁVEL por scripts/prove-conv-e2-p2.ts.
import * as repo from '../modules/users/users.repository'
import { saveInstitutionLinks, withdrawUserInvite } from '../modules/users/users.service'
import { UserScope } from '../modules/users/users.interface'

jest.mock('../modules/users/users.repository')

const mockExists   = repo.userExists          as jest.Mock
const mockSetLinks = repo.setInstitutionLinks as jest.Mock
const mockWithdraw = repo.withdrawInvite      as jest.Mock

const admin: UserScope = { isSuper: false, institutionId: 5, schemaName: 'setes_acme', userId: 41 }
const sup:   UserScope = { isSuper: true,  institutionId: 1, schemaName: 'setes_setes', userId: 2 }

beforeEach(() => {
  jest.clearAllMocks()
  mockExists.mockResolvedValue(true)
  mockSetLinks.mockResolvedValue([])
  mockWithdraw.mockResolvedValue(undefined)
})

describe('saveInstitutionLinks (D-UC16)', () => {
  it('o Super é o convidante dos vínculos novos', async () => {
    await saveInstitutionLinks(sup, 77, [{ institutionId: 7, kind: 'user' }])
    expect(mockSetLinks).toHaveBeenCalledWith(77, [{ institutionId: 7, kind: 'user' }], 2)
  })
  it('o admin continua sem acesso (403)', async () => {
    await expect(saveInstitutionLinks(admin, 77, [])).rejects.toMatchObject({ statusCode: 403 })
    expect(mockSetLinks).not.toHaveBeenCalled()
  })
})

describe('withdrawUserInvite (D-UC15 — T4)', () => {
  it('o admin retira no PRÓPRIO estabelecimento, qualquer que seja o institutionId pedido', async () => {
    await withdrawUserInvite(admin, 77, 999)
    expect(mockWithdraw).toHaveBeenCalledWith(77, 5)
  })
  it('o Super informa o estabelecimento; sem ele, 400 no campo', async () => {
    await withdrawUserInvite(sup, 77, 7)
    expect(mockWithdraw).toHaveBeenCalledWith(77, 7)
    await expect(withdrawUserInvite(sup, 77, null)).rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'institutionId' }] })
  })
  it('sem convite pendente o 409 INVITE_NOT_PENDING passa adiante', async () => {
    mockWithdraw.mockRejectedValue(Object.assign(new Error('x'), { statusCode: 409, code: 'INVITE_NOT_PENDING' }))
    await expect(withdrawUserInvite(admin, 77, null)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_NOT_PENDING' })
  })
})
