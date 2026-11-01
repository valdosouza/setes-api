/// <reference types="jest" />
// Sub-recurso /api/establishment/ibscbs-assessments (D-IB99/D-IB100 — prompt_fase_ibs_cbs.md §14): a porta HTTP da opção de apuração
// do IBS/CBS. Institution SEMPRE do token; o único parâmetro de rota é a DATA (identidade da linha do PRÓPRIO estabelecimento); o
// motor de campos confere SÓ as colunas desta porta (`onlyFields`); a regra e a escrita são da peça (ibscbs-assessment.test.ts).
import {
  ibscbsAssessmentCreateDto, ibscbsAssessmentChangeDto, IBSCBS_ASSESSMENT_CATALOG_FIELDS, establishmentUpdateDto,
} from '../modules/establishment/establishment.dto'
import {
  listIbscbsAssessments, createIbscbsAssessment, changeIbscbsAssessment, removeIbscbsAssessment,
} from '../modules/establishment/establishment.controller'

jest.mock('../modules/establishment/establishment.service', () => ({
  __esModule: true,
  fetchEstablishment: jest.fn(), editEstablishment: jest.fn(),
  fetchIbscbsAssessments: jest.fn().mockResolvedValue({ items: [] }),
  registerIbscbsAssessment: jest.fn().mockResolvedValue({ items: ['novo'] }),
  editIbscbsAssessment: jest.fn().mockResolvedValue({ items: ['trocado'] }),
  deleteIbscbsAssessment: jest.fn().mockResolvedValue({ items: [] }),
}))
jest.mock('../shared/field-config', () => ({ __esModule: true, assertClientRequired: jest.fn().mockResolvedValue(undefined) }))
const service = jest.requireMock('../modules/establishment/establishment.service') as Record<string, jest.Mock>
const fieldConfig = jest.requireMock('../shared/field-config') as { assertClientRequired: jest.Mock }

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
  it('registrar: data de calendário real + opção do domínio da NT 009; nada além', () => {
    expect(ibscbsAssessmentCreateDto.safeParse({ validFrom: '2027-01-01', assessment: '3' }).success).toBe(true)
    for (const bad of [
      { validFrom: '2027-02-30', assessment: '1' }, { validFrom: '01/01/2027', assessment: '1' },
      { validFrom: '2027-01-01', assessment: '4' }, { validFrom: '2027-01-01', assessment: 1 }, { validFrom: '2027-01-01' },
    ]) {
      expect(ibscbsAssessmentCreateDto.safeParse(bad).success).toBe(false)
    }
    expect(ibscbsAssessmentChangeDto.safeParse({ assessment: '2' }).success).toBe(true)
    expect(IBSCBS_ASSESSMENT_CATALOG_FIELDS).toEqual(['valid_from', 'assessment'])
  })

  it('o PUT do estabelecimento NÃO recebe a opção (escritor único = o sub-recurso)', () => {
    const parsed = establishmentUpdateDto.safeParse({
      nameCompany: 'Acme', nickTrade: null, addresses: [], phones: [], socials: [], ibscbsAssessment: '3', assessment: '3',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && ('ibscbsAssessment' in parsed.data || 'assessment' in parsed.data)).toBe(false)
  })
})

describe('controller', () => {
  it('GET: a visão do PRÓPRIO estabelecimento (institution do token)', async () => {
    const r = res()
    await listIbscbsAssessments(req(), r)
    expect(service.fetchIbscbsAssessments).toHaveBeenCalledWith(7, 'setes_acme')
    expect(r.json).toHaveBeenCalledWith({ ok: true, data: { items: [] } })
  })

  it('POST: 201 com a visão; o motor de campos confere SÓ as colunas desta porta; autor = usuário do token', async () => {
    const r = res()
    await createIbscbsAssessment(req({ validFrom: '2027-01-01', assessment: '3', institutionId: 99 }), r)
    expect(fieldConfig.assertClientRequired).toHaveBeenCalledWith(institution, 'establishment',
      { validFrom: '2027-01-01', assessment: '3' }, {}, ['valid_from', 'assessment'])
    expect(service.registerIbscbsAssessment).toHaveBeenCalledWith(7, 'setes_acme', 3, { validFrom: '2027-01-01', assessment: '3' })
    expect(r.status).toHaveBeenCalledWith(201)
  })

  it('POST inválido: 400 VALIDATION_FAILED com fields[] e nada gravado', async () => {
    const r = res()
    await createIbscbsAssessment(req({ validFrom: '2027-02-30', assessment: '3' }), r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json.mock.calls[0][0]).toMatchObject({ code: 'VALIDATION_FAILED', fields: [expect.objectContaining({ field: 'validFrom' })] })
    expect(service.registerIbscbsAssessment).not.toHaveBeenCalled()
  })

  it('PUT/DELETE: a data da ROTA é a identidade; data inválida = 400 antes de qualquer leitura', async () => {
    const r1 = res()
    await changeIbscbsAssessment(req({ assessment: '2' }, { validFrom: '2027-01-01' }), r1)
    expect(service.editIbscbsAssessment).toHaveBeenCalledWith(7, 'setes_acme', 3, { validFrom: '2027-01-01', assessment: '2' })
    expect(fieldConfig.assertClientRequired.mock.calls[0][4]).toEqual(['valid_from', 'assessment'])
    const r2 = res()
    await removeIbscbsAssessment(req({}, { validFrom: '2027-01-01' }), r2)
    expect(service.deleteIbscbsAssessment).toHaveBeenCalledWith(7, 'setes_acme', 3, '2027-01-01')
    for (const bad of ['2027-02-30', '1', "2027-01-01' OR 1=1"]) {
      const r = res()
      await removeIbscbsAssessment(req({}, { validFrom: bad }), r)
      expect(r.status).toHaveBeenCalledWith(400)
      const r3 = res()
      await changeIbscbsAssessment(req({ assessment: '1' }, { validFrom: bad }), r3)
      expect(r3.status).toHaveBeenCalledWith(400)
    }
    expect(service.deleteIbscbsAssessment).toHaveBeenCalledTimes(1)
    expect(service.editIbscbsAssessment).toHaveBeenCalledTimes(1)
  })

  it('erro tipado da peça sai pelo envelope da casa (status + code)', async () => {
    const { HttpError } = jest.requireActual('../shared/errors/http-error')
    service.registerIbscbsAssessment.mockRejectedValueOnce(
      new HttpError(422, 'passado', [{ field: 'validFrom', message: 'x' }], 'IBSCBS_ASSESSMENT_DATE_PAST'))
    const r = res()
    await createIbscbsAssessment(req({ validFrom: '2026-01-01', assessment: '1' }), r)
    expect(r.status).toHaveBeenCalledWith(422)
    expect(r.json.mock.calls[0][0]).toMatchObject({ code: 'IBSCBS_ASSESSMENT_DATE_PAST', fields: [{ field: 'validFrom' }] })
  })
})
