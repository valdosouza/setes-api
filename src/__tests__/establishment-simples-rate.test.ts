/// <reference types="jest" />
// Sub-recurso /api/establishment/simples-rates (IBS.E9.P5, D-IB138): a porta HTTP do percentual do Simples no IBS/CBS.
// Institution SEMPRE do token; o único parâmetro de rota é o MÊS (identidade da linha); a regra e a escrita são da peça
// (ibscbs-simples-rate.test.ts).
import { simplesRateCreateDto, simplesRateChangeDto } from '../modules/establishment/establishment.dto'
import {
  listSimplesRatesHandler, createSimplesRateHandler, changeSimplesRateHandler, removeSimplesRateHandler,
} from '../modules/establishment/establishment.controller'
import { HttpError } from '../shared/errors/http-error'
import { ErrorCodes } from '../shared/errors/error-codes'

jest.mock('../modules/establishment/establishment.service', () => ({
  __esModule: true,
  fetchEstablishment: jest.fn(), editEstablishment: jest.fn(),
  fetchSimplesRates: jest.fn().mockResolvedValue([]),
  registerSimplesRate: jest.fn().mockResolvedValue([{ competence: '2027-01' }]),
  editSimplesRate: jest.fn().mockResolvedValue([{ competence: '2027-01', ibsRate: '0.2000' }]),
  deleteSimplesRate: jest.fn().mockResolvedValue([]),
}))
const service = jest.requireMock('../modules/establishment/establishment.service') as Record<string, jest.Mock>

const institution = { institutionId: 7, userId: 3, role: 'admin', schemaName: 'setes_acme' }
const req = (body: unknown = {}, params: Record<string, string> = {}) => ({ institution, body, params }) as any
function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}

beforeEach(() => jest.clearAllMocks())

describe('DTO', () => {
  it('cadastrar: mês e os dois percentuais, texto ou número; nada além do formato (a peça confere a faixa)', () => {
    expect(simplesRateCreateDto.safeParse({ competence: '2027-01', ibsRate: '0.1000', cbsRate: 0.9 }).success).toBe(true)
    for (const bad of [
      { ibsRate: '0.1', cbsRate: '0.9' }, { competence: '2027-01', cbsRate: '0.9' }, { competence: '2027-01', ibsRate: null, cbsRate: '0.9' },
      { competence: 202701, ibsRate: '0.1', cbsRate: '0.9' },
    ]) expect(simplesRateCreateDto.safeParse(bad).success).toBe(false)
  })

  it('trocar: os dois percentuais; o mês vem da URL', () => {
    expect(simplesRateChangeDto.safeParse({ ibsRate: 1, cbsRate: '2' }).success).toBe(true)
    expect(simplesRateChangeDto.safeParse({ ibsRate: 1 }).success).toBe(false)
  })
})

describe('porta HTTP', () => {
  it('GET lista só do estabelecimento do token', async () => {
    const r = res()
    await listSimplesRatesHandler(req(), r)
    expect(service.fetchSimplesRates).toHaveBeenCalledWith(7, 'setes_acme')
    expect(r.json).toHaveBeenCalledWith({ ok: true, data: [] })
  })

  it('POST cadastra com o usuário do token e responde 201; um institutionId no corpo é ignorado', async () => {
    const r = res()
    await createSimplesRateHandler(req({ competence: '2027-01', ibsRate: '0.1', cbsRate: '0.9', institutionId: 99 }), r)
    expect(service.registerSimplesRate).toHaveBeenCalledWith(7, 'setes_acme', 3, { competence: '2027-01', ibsRate: '0.1', cbsRate: '0.9' })
    expect(r.status).toHaveBeenCalledWith(201)
  })

  it('POST com corpo fora do formato → 400 e nenhuma gravação', async () => {
    const r = res()
    await createSimplesRateHandler(req({ competence: '2027-01' }), r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(service.registerSimplesRate).not.toHaveBeenCalled()
  })

  it('PUT usa o mês da URL; DELETE idem; erro da peça sai com o código dele', async () => {
    const r = res()
    await changeSimplesRateHandler(req({ ibsRate: '0.2', cbsRate: '0.8' }, { competence: '2027-01' }), r)
    expect(service.editSimplesRate).toHaveBeenCalledWith(7, 'setes_acme', 3, { competence: '2027-01', ibsRate: '0.2', cbsRate: '0.8' })

    service.deleteSimplesRate.mockRejectedValueOnce(
      new HttpError(404, 'Percentual do Simples de 2027-05 não encontrado', undefined, ErrorCodes.IBSCBS_SIMPLES_RATE_NOT_FOUND))
    const r2 = res()
    await removeSimplesRateHandler(req({}, { competence: '2027-05' }), r2)
    expect(service.deleteSimplesRate).toHaveBeenCalledWith(7, 'setes_acme', 3, '2027-05')
    expect(r2.status).toHaveBeenCalledWith(404)
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCodes.IBSCBS_SIMPLES_RATE_NOT_FOUND }))
  })
})
