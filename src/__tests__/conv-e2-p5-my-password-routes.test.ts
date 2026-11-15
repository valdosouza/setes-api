/// <reference types="jest" />
// CONV.E2.P5 — as rotas da "minha senha" (D-UC7, D-UC8, D-UC18): o titular vem SEMPRE do token (nunca do corpo), os campos obrigatórios
// e as recusas da rota LOGADA (nunca 401 — o app leria "a sessão caiu"). Serviço dublado; o fluxo inteiro (a senha atual contando como
// login, a peça do código, a sessão de antes recusada — D-EA7) é provado de ponta a ponta em setes_central DESCARTÁVEL por
// scripts/prove-conv-e2-p5.ts.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import * as service from '../modules/auth/auth.service'
import { HttpError } from '../shared/errors/http-error'

jest.mock('../modules/auth/auth.service', () => ({
  ...jest.requireActual('../modules/auth/auth.service'),
  requestMyPasswordCode: jest.fn(), changeMyPassword: jest.fn(),
}))
jest.mock('../shared/access', () => ({
  ...jest.requireActual('../shared/access'),
  liveSession: jest.fn(async (p: any) => p),
}))

import app from '../app'

const mockRequest = service.requestMyPasswordCode as jest.Mock
const mockChange  = service.changeMyPassword as jest.Mock
const token = () => testToken({ userId: 42, institutionId: 7, role: 'user', schemaName: 'setes_alpha' } as any)

beforeEach(() => { jest.clearAllMocks(); mockRequest.mockResolvedValue(undefined); mockChange.mockResolvedValue(undefined) })

describe('POST /auth/my-password/code', () => {
  it('o titular vem do TOKEN — um userId/e-mail no corpo é ignorado', async () => {
    const r = await request(app).post('/auth/my-password/code').set('Authorization', `Bearer ${token()}`)
      .send({ currentPassword: 'Atual#2026#x', userId: 1, email: 'outro@x.com' })
    expect(r.status).toBe(202)
    expect(mockRequest).toHaveBeenCalledWith(42, 'Atual#2026#x')
  })
  it('sem token = 401; sem a senha atual = 400 (nada chamado)', async () => {
    expect((await request(app).post('/auth/my-password/code').send({ currentPassword: 'x' })).status).toBe(401)
    expect((await request(app).post('/auth/my-password/code').set('Authorization', `Bearer ${token()}`).send({})).status).toBe(400)
    expect(mockRequest).not.toHaveBeenCalled()
  })
  it('a recusa sai com o code e os fields do serviço (422 MY_PASSWORD_REFUSED)', async () => {
    mockRequest.mockRejectedValue(new HttpError(422, 'Senha atual incorreta', [{ field: 'currentPassword', message: 'x' }], 'MY_PASSWORD_REFUSED'))
    const r = await request(app).post('/auth/my-password/code').set('Authorization', `Bearer ${token()}`).send({ currentPassword: 'x' })
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ code: 'MY_PASSWORD_REFUSED', fields: [{ field: 'currentPassword' }] })
  })
})

describe('POST /auth/my-password', () => {
  it('o titular vem do TOKEN; a resposta pede para entrar de novo (reauth)', async () => {
    const r = await request(app).post('/auth/my-password').set('Authorization', `Bearer ${token()}`)
      .send({ code: '123456', newPassword: 'Nova#Senha#2026', userId: 1 })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, reauth: true })
    expect(mockChange).toHaveBeenCalledWith(42, '123456', 'Nova#Senha#2026')
  })
  it('campos ausentes ou senha que não é texto = 400 (nada chamado)', async () => {
    for (const body of [{}, { code: '1' }, { newPassword: 'x' }, { code: '1', newPassword: {} }]) {
      expect((await request(app).post('/auth/my-password').set('Authorization', `Bearer ${token()}`).send(body)).status).toBe(400)
    }
    expect(mockChange).not.toHaveBeenCalled()
  })
})

describe('serviço — a recusa da rota logada nunca é 401', () => {
  it('requestMyPasswordCode sem conta ativa = 422 MY_PASSWORD_REFUSED', async () => {
    const real = jest.requireActual('../modules/auth/auth.service') as typeof service
    const repo = require('../modules/auth/auth.repository')
    const spy = jest.spyOn(repo, 'findAuthUserById').mockResolvedValue(null)
    await expect(real.requestMyPasswordCode(42, 'x')).rejects.toMatchObject({ statusCode: 422, code: 'MY_PASSWORD_REFUSED' })
    await expect(real.changeMyPassword(42, '123456', 'Nova#Senha#2026')).rejects.toMatchObject({ statusCode: 422, code: 'MY_PASSWORD_CODE_INVALID' })
    spy.mockRestore()
  })
})
