/// <reference types="jest" />
// CONV.E2.P3 (D-UC12, A-UC8): o LOGIN do titular é o aceite. Banco dublado (molde `auth-login.test.ts`): a ORDEM sob a trava e o que
// o login faz com o aceite. O SQL real (write-once, retirado, sem convite, corrida aceite × retirada, PUT antes/depois) é provado em
// setes_central DESCARTÁVEL por scripts/prove-conv-e2-p3.ts.
import * as authRepo from '../modules/auth/auth.repository'
import * as sessionRepo from '../shared/session-context/session-context.repository'
import { login, setLoginRefusalFloor, LOGIN_REFUSAL_FLOOR_MS } from '../modules/auth/auth.service'
import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'

jest.mock('../modules/auth/auth.repository', () => ({
  ...jest.requireActual('../modules/auth/auth.repository'),
  findUserByEmail: jest.fn(), getInstitutionsForUser: jest.fn(), countLoginFailuresInWindow: jest.fn(),
  lockUserCredential: jest.fn(), insertLoginFailure: jest.fn(), rehashPassword: jest.fn().mockResolvedValue(true),
  acceptPendingInvites: jest.fn(), hasPendingInvites: jest.fn(),
}))
jest.mock('../shared/session-context/session-context.repository')
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

const MD5_12345 = '827CCB0EEA8A706C4C34A16891F84E7B'
const mockFindUser = authRepo.findUserByEmail as jest.Mock
const mockInst     = authRepo.getInstitutionsForUser as jest.Mock
const mockCount    = authRepo.countLoginFailuresInWindow as jest.Mock
const mockLock     = authRepo.lockUserCredential as jest.Mock
const mockAccept   = authRepo.acceptPendingInvites as jest.Mock
const mockHasPending = authRepo.hasPendingInvites as jest.Mock
const fakeConn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn() }
const order: string[] = []
const link7 = { institutionId: 7, schemaName: 'setes_alpha', name: 'Alpha', profile: 'user' }
const link1 = { institutionId: 1, schemaName: 'setes_setes', name: 'Setes', profile: 'admin' }

beforeAll(() => setLoginRefusalFloor(0))
afterAll(() => setLoginRefusalFloor(LOGIN_REFUSAL_FLOOR_MS))
beforeEach(() => {
  jest.clearAllMocks()
  order.length = 0
  ;(sessionRepo.existsSalesman as jest.Mock).mockResolvedValue(false)
  mockFindUser.mockResolvedValue({ id: 9, password: MD5_12345, active: 'S' })
  mockCount.mockResolvedValue(0)
  // CONV.E2.P7 (D-UC19): a senha é do TITULAR ('T') nos casos do P3 — os de terceiro estão no describe abaixo
  mockLock.mockImplementation(async () => { order.push('trava'); return { id: 9, password: MD5_12345, active: 'S', passwordAuthorRole: 'T' } })
  mockHasPending.mockResolvedValue(false)
  fakeConn.commit.mockImplementation(async () => { order.push('commit') })
  ;(pool.getConnection as jest.Mock).mockResolvedValue(fakeConn)
})

describe('CONV.E2.P3 — o login é o aceite (T1)', () => {
  it('só com o convite: aceita SOB a trava, pela conexão da transação, ANTES de ler os vínculos — e entra direto (não é a recusa "sem vínculo")', async () => {
    let accepted = false
    mockAccept.mockImplementation(async (conn: unknown) => { order.push('aceite'); expect(conn).toBe(fakeConn); accepted = true; return [7] })
    mockInst.mockImplementation(async (_u: number, conn: unknown) => { order.push('vínculos'); expect(conn).toBe(fakeConn); return accepted ? [link7] : [] })
    const r = await login('pessoa@x.com', '12345')
    expect(r.status).toBe('ok')
    expect(order).toEqual(['trava', 'aceite', 'vínculos', 'commit'])
    expect(mockAccept).toHaveBeenCalledWith(fakeConn, 9)
  })

  it('vínculo de antes + convite: a seleção traz os dois', async () => {
    mockAccept.mockResolvedValue([7])
    mockInst.mockResolvedValue([link1, link7])
    const r: any = await login('pessoa@x.com', '12345')
    expect(r.status).toBe('select')
    expect(r.institutions.map((i: any) => i.institutionId)).toEqual([1, 7])
  })

  it('a trilha do aceite sai no log DEPOIS do commit, sem e-mail; a resposta não ganha campo novo (D-EA6)', async () => {
    mockAccept.mockResolvedValue([7])
    mockInst.mockResolvedValue([link7])
    ;(logger.info as jest.Mock).mockImplementation((msg: string) => { if (/Convite aceito/.test(msg)) order.push('log') })
    const r: any = await login('pessoa@x.com', '12345')
    expect(order.slice(-2)).toEqual(['commit', 'log'])
    expect(logger.info).toHaveBeenCalledWith('Convite aceito pelo login do titular', { userId: 9, institutionIds: [7] })
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('pessoa@x.com')
    expect(Object.keys(r).sort()).toEqual(['context', 'status', 'token'])
  })

  it('sem convite: nenhum log de aceite e o login segue igual', async () => {
    mockAccept.mockResolvedValue([])
    mockInst.mockResolvedValue([link7])
    await login('pessoa@x.com', '12345')
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('Convite aceito')
  })

  it('senha errada não aceita nada (a mesma 401)', async () => {
    await expect(login('pessoa@x.com', 'errada')).rejects.toMatchObject({ statusCode: 401 })
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('credencial inativa não aceita nada (a mesma 401)', async () => {
    mockLock.mockResolvedValue({ id: 9, password: MD5_12345, active: 'N', passwordAuthorRole: 'T' })
    await expect(login('pessoa@x.com', '12345')).rejects.toMatchObject({ statusCode: 401 })
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('conta bloqueada não aceita nada (nem confere a senha)', async () => {
    mockCount.mockResolvedValue(10)
    await expect(login('pessoa@x.com', '12345')).rejects.toMatchObject({ statusCode: 401 })
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('falha no aceite = a mesma recusa neutra, transação desfeita (nunca 500 — seria oráculo)', async () => {
    mockAccept.mockRejectedValue(Object.assign(new Error('boom'), { errno: 4025 }))
    await expect(login('pessoa@x.com', '12345')).rejects.toMatchObject({ statusCode: 401, message: 'Email ou senha inválidos' })
    expect(fakeConn.rollback).toHaveBeenCalled()
    expect(fakeConn.commit).not.toHaveBeenCalled()
  })
})

describe('CONV.E2.P7 — o aceite só com a senha do PRÓPRIO titular (D-UC19) e o aviso (D-UC23)', () => {
  for (const role of ['A', 'O', null]) {
    it(`senha de terceiro (${role ?? 'desconhecida — A-UC9'}): entra nos vínculos que já tem, NÃO aceita, e a resposta avisa`, async () => {
      mockLock.mockResolvedValue({ id: 9, password: MD5_12345, active: 'S', passwordAuthorRole: role })
      mockHasPending.mockResolvedValue(true)
      mockInst.mockResolvedValue([link1])
      const r: any = await login('pessoa@x.com', '12345')
      expect(mockAccept).not.toHaveBeenCalled()
      expect(mockHasPending).toHaveBeenCalledWith(fakeConn, 9)
      expect(r).toMatchObject({ status: 'ok', pendingInvitesNeedOwnPassword: true })
    })
  }
  it('senha de terceiro SEM convite esperando: nenhum aviso (a resposta de sempre)', async () => {
    mockLock.mockResolvedValue({ id: 9, password: MD5_12345, active: 'S', passwordAuthorRole: 'A' })
    mockHasPending.mockResolvedValue(false)
    mockInst.mockResolvedValue([link1, link7])
    const r: any = await login('pessoa@x.com', '12345')
    expect(r.status).toBe('select')
    expect(r.pendingInvitesNeedOwnPassword).toBeUndefined()
  })
  it('só o convite e a senha de terceiro: a MESMA recusa de "sem vínculo" (D-EA6 — o aviso nunca vaza numa recusa)', async () => {
    mockLock.mockResolvedValue({ id: 9, password: MD5_12345, active: 'S', passwordAuthorRole: 'A' })
    mockHasPending.mockResolvedValue(true)
    mockInst.mockResolvedValue([])
    await expect(login('pessoa@x.com', '12345')).rejects.toMatchObject({ statusCode: 401, message: 'Email ou senha inválidos' })
    expect(mockAccept).not.toHaveBeenCalled()
  })
  it("'t' minúscula ou com espaço não vale como titular (comparação exata)", async () => {
    for (const role of ['t', 'T ']) {
      mockAccept.mockClear()
      mockLock.mockResolvedValue({ id: 9, password: MD5_12345, active: 'S', passwordAuthorRole: role })
      mockHasPending.mockResolvedValue(true)
      mockInst.mockResolvedValue([link1])
      await login('pessoa@x.com', '12345')
      expect(mockAccept).not.toHaveBeenCalled()
    }
  })
})

