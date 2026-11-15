/// <reference types="jest" />
// D-IB105 (Valdo 2026-11-01, Q-IB108 "Avisa sem bloquear" — prompt_fase_ibs_cbs.md §14.8): o PUT do estabelecimento que o TIRA do
// Simples (opSimpNac gravado 3/4 → outro) com opção FUTURA 2/3 de apuração do IBS/CBS registrada DEVOLVE o aviso (a data da 1ª linha
// futura 2/3) e NÃO recusa — o salvamento grava como sempre. Duas camadas: a peça (o fato: a 1ª linha futura 2/3) e o service (a
// transição deste PUT).
import { firstFutureRegularAssessmentFrom, leavesRegularOptionRegimes } from '../shared/ibscbs-assessment'
import * as repo from '../modules/establishment/establishment.repository'
import { editEstablishment } from '../modules/establishment/establishment.service'
import { EntityFiscalFull } from '@shared/entity'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
const pool = jest.requireMock('../shared/db/connection').default as { query: jest.Mock }
const tz = jest.requireMock('@shared/time-zone') as { todayFor: jest.Mock }

jest.mock('../modules/establishment/establishment.repository')
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({
  ...jest.requireActual('../shared/entity-tax/entity-tax.repository'),
  getEntityTax: jest.fn().mockResolvedValue(null),
  upsertEntityTax: jest.fn().mockResolvedValue(undefined),
}))
const entityTaxRepo = jest.requireMock('../shared/entity-tax/entity-tax.repository') as { getEntityTax: jest.Mock; upsertEntityTax: jest.Mock }

const TABLE = 'setes_acme.tb_establishment_ibscbs_assessment'

function chainJ(): EntityFiscalFull {
  return {
    id: 5, entity: { nameCompany: 'Acme Ltda', nickTrade: 'Acme', aniversary: null }, personType: 'J', person: null,
    company: { cnpj: '12345678000199', ie: null, im: null, dtFoundation: null }, noDoc: null,
    addresses: [], phones: [], socialMedia: [],
  }
}
const baseInput = { nameCompany: 'Acme Ltda', nickTrade: 'Acme', ie: null, im: null, addresses: [], phones: [], socials: [] }
const meEpp = { taxRegime: '1 - Simples Nacional', simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6,
  specialTaxRegime: null, cnae: null }

/** O banco da peça: devolve `futureFrom` à consulta da 1ª linha futura 2/3 (null = nenhuma). */
function futureLine(futureFrom: string | null) {
  pool.query.mockImplementation(async (sql: string) => {
    if (/FROM \?\? WHERE tb_institution_id = \? AND deleted = 'N' AND valid_from > \?/.test(sql)) {
      return [futureFrom === null ? [] : [{ validFrom: futureFrom }]]
    }
    throw new Error(`SQL inesperado: ${sql}`)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  tz.todayFor.mockResolvedValue('2026-11-15')
  ;(repo.getEstablishmentChain as jest.Mock).mockResolvedValue(chainJ())
  ;(repo.saveEstablishmentChain as jest.Mock).mockResolvedValue(undefined)
  entityTaxRepo.getEntityTax.mockResolvedValue(meEpp)
  futureLine(null)
})

describe('peça: a 1ª opção FUTURA 2/3 (D-IB105)', () => {
  it('lê só linha viva, depois de HOJE do estabelecimento (fuso), de opção 2 ou 3, a mais cedo', async () => {
    futureLine('2027-01-01')
    await expect(firstFutureRegularAssessmentFrom('setes_acme', 5)).resolves.toBe('2027-01-01')
    expect(tz.todayFor).toHaveBeenCalledWith('setes_acme', 5, expect.anything())
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/deleted = 'N'/)
    expect(sql).toMatch(/valid_from > \?/)
    expect(sql).toMatch(/ORDER BY valid_from LIMIT 1/)
    expect(sql).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)   // aviso, não decisão: sem trava
    expect(params).toEqual([TABLE, 5, '2026-11-15', ['2', '3']])
  })

  it('sem linha futura 2/3 = null (sem aviso)', async () => {
    await expect(firstFutureRegularAssessmentFrom('setes_acme', 5)).resolves.toBeNull()
  })

  it('a transição: só sair de 3/4 para outro (inclusive limpar) conta', () => {
    expect(leavesRegularOptionRegimes('3', '1')).toBe(true)
    expect(leavesRegularOptionRegimes('3', '2')).toBe(true)
    expect(leavesRegularOptionRegimes('4', '1')).toBe(true)
    expect(leavesRegularOptionRegimes('3', null)).toBe(true)
    expect(leavesRegularOptionRegimes('3', '3')).toBe(false)
    expect(leavesRegularOptionRegimes('3', '4')).toBe(false)
    expect(leavesRegularOptionRegimes('1', '2')).toBe(false)
    expect(leavesRegularOptionRegimes(null, '1')).toBe(false)
    expect(leavesRegularOptionRegimes(undefined, '1')).toBe(false)
  })
})

describe('PUT do estabelecimento (D-IB105: avisa sem bloquear)', () => {
  it('ME/EPP → não optante com opção futura 2/3: GRAVA e devolve o aviso com a data da 1ª linha', async () => {
    futureLine('2027-01-01')
    const out = await editEstablishment(5, 'setes_acme', { ...baseInput, simplesRegime: '1' }, 9)
    expect(out.ibscbsAssessmentNotice).toEqual({ validFrom: '2027-01-01' })
    expect(entityTaxRepo.upsertEntityTax).toHaveBeenCalledWith(expect.anything(), 'setes_acme', 5, 5,
      expect.objectContaining({ simplesRegime: '1', simplesAssessment: null, simplesTotalTaxAliquot: null }))
    expect(repo.saveEstablishmentChain).toHaveBeenCalled()
  })

  it('ME/EPP → MEI com opção futura 2/3: também avisa', async () => {
    futureLine('2027-07-01')
    const out = await editEstablishment(5, 'setes_acme', { ...baseInput, simplesRegime: '2' }, 9)
    expect(out.ibscbsAssessmentNotice).toEqual({ validFrom: '2027-07-01' })
  })

  it('saiu do Simples SEM opção futura 2/3 (nenhuma, só 1, ou só passada/vigente): sem aviso', async () => {
    futureLine(null)
    const out = await editEstablishment(5, 'setes_acme', { ...baseInput, simplesRegime: '1' }, 9)
    expect(out.ibscbsAssessmentNotice).toBeNull()
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('continua no Simples (3 → 3) ou o PUT não toca o opSimpNac: nem consulta a opção', async () => {
    futureLine('2027-01-01')
    const kept = await editEstablishment(5, 'setes_acme',
      { ...baseInput, simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6 }, 9)
    const untouched = await editEstablishment(5, 'setes_acme', { ...baseInput, cnae: '6201501' }, 9)
    const nothing = await editEstablishment(5, 'setes_acme', baseInput, 9)
    for (const out of [kept, untouched, nothing]) expect(out.ibscbsAssessmentNotice).toBeNull()
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('a leitura do aviso falhou: o PUT aborta ANTES de gravar (nunca 500 com o salvamento feito — ADV-IB105-02)', async () => {
    pool.query.mockRejectedValue(new Error('banco fora'))
    await expect(editEstablishment(5, 'setes_acme', { ...baseInput, simplesRegime: '1' }, 9)).rejects.toThrow('banco fora')
    expect(repo.saveEstablishmentChain).not.toHaveBeenCalled()
    expect(entityTaxRepo.upsertEntityTax).not.toHaveBeenCalled()
  })

  it('controller: o aviso sai em data.ibscbsAssessmentNotice da resposta do PUT', async () => {
    futureLine('2027-01-01')
    const { update } = await import('../modules/establishment/establishment.controller')
    const r: any = {}
    r.status = jest.fn(() => r)
    r.json = jest.fn(() => r)
    await update({ institution: { institutionId: 5, userId: 9, role: 'admin', schemaName: 'setes_acme' },
      body: { ...baseInput, simplesRegime: '1' }, params: {} } as any, r)
    expect(r.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ ibscbsAssessmentNotice: { validFrom: '2027-01-01' } }) })
  })

  it('já estava fora do Simples (1 → 2): não é a transição da D-IB105 — sem aviso', async () => {
    entityTaxRepo.getEntityTax.mockResolvedValue({ ...meEpp, simplesRegime: '1', simplesAssessment: null, simplesTotalTaxAliquot: null })
    futureLine('2027-01-01')
    const out = await editEstablishment(5, 'setes_acme', { ...baseInput, simplesRegime: '2' }, 9)
    expect(out.ibscbsAssessmentNotice).toBeNull()
    expect(pool.query).not.toHaveBeenCalled()
  })
})
