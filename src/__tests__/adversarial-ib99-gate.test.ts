/// <reference types="jest" />
// Gate adversarial da D-IB99/D-IB100 (2026-11-01, prompt_fase_ibs_cbs.md §14.3): achados LOW confirmados viram teste permanente.
// ADV-IB99-03 (competência inválida falha fechado) e ADV-IB99-05 (revive concorrente) moram em ibscbs-assessment.test.ts; aqui o
// ADV-IB99-04 pela porta HTTP real (app inteiro, banco MOCADO — nada toca o MariaDB).
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() } }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../app').default

describe('ADV-IB99-04 — :validFrom com URI malformada = 400 no envelope da casa (nunca 500 sem code)', () => {
  const ADMIN = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_x' }
  it.each([['put', '%E0%A4%A'], ['delete', '%'], ['delete', '2027-07-01%2']])('%s %s', async (method, segment) => {
    const res = await (request(app) as any)[method](`/api/establishment/ibscbs-assessments/${segment}`)
      .set('Authorization', `Bearer ${testToken(ADMIN)}`).send({ assessment: '1' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', fields: expect.any(Array) })
  })

  it('a rota segue fechada a quem não é admin e a quem não tem token (o 400 não abre a porta)', async () => {
    const user = await request(app).delete('/api/establishment/ibscbs-assessments/%')
      .set('Authorization', `Bearer ${testToken({ institutionId: 1, userId: 3, role: 'user', schemaName: 'setes_x' })}`)
    expect(user.status).toBe(403)
    const anon = await request(app).delete('/api/establishment/ibscbs-assessments/2027-07-01')
    expect(anon.status).toBe(401)
  })
})
