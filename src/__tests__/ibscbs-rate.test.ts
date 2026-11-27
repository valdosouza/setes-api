/// <reference types="jest" />
// IBS.E9.P4 — peça @shared/ibscbs-rate: a tabela central de alíquotas vira as linhas que o motor pede (D-IB135, A-IB143f).
import { ibscbsRateAlerts, loadIbscbsAliqTable } from '@shared/ibscbs-rate'
import { IBSCBS_LEGAL_ALIQS, ibscbsAliqAt } from '@shared/ibscbs-calculation'

type Row = Record<string, unknown>
const dbOf = (rows: Row[]) => {
  const sqls: string[] = []
  return { sqls, query: async (sql: string) => { sqls.push(sql); return [rows] } }
}

// A tabela como o seed do script 81 a grava (texto do banco por `CAST … AS CHAR`; datas como o driver devolve com dateStrings)
const SEED: Row[] = [
  { tax: 'C', validFrom: '2025-01-01', validUntil: '2026-12-31', rate: '0.9000' },
  { tax: 'M', validFrom: '2025-01-01', validUntil: '2026-12-31', rate: '0.0000' },
  { tax: 'M', validFrom: '2027-01-01', validUntil: '2028-12-31', rate: '0.0500' },
  { tax: 'U', validFrom: '2025-01-01', validUntil: '2026-12-31', rate: '0.1000' },
  { tax: 'U', validFrom: '2027-01-01', validUntil: '2028-12-31', rate: '0.0500' },
]

describe('@shared/ibscbs-rate — loadIbscbsAliqTable', () => {
  it('o texto do banco vira milionésimos sem perda (0.1 → 1000; 0.9 → 9000; 0.05 → 500) e U, M, C viram os tributos do motor', async () => {
    const lines = await loadIbscbsAliqTable(dbOf(SEED))
    expect(lines).toContainEqual({ tax: 'IBS_UF', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 1000 })
    expect(lines).toContainEqual({ tax: 'IBS_MUN', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 0 })
    expect(lines).toContainEqual({ tax: 'CBS', validFrom: '2025-01-01', validUntil: '2026-12-31', ppm: 9000 })
    expect(lines).toContainEqual({ tax: 'IBS_UF', validFrom: '2027-01-01', validUntil: '2028-12-31', ppm: 500 })
  })

  it('a tabela do seed dá ao motor as MESMAS linhas que a constante da norma (IBSCBS_LEGAL_ALIQS)', async () => {
    const key = (l: { tax: string; validFrom: string }) => `${l.tax}|${l.validFrom}`
    const fromDb = (await loadIbscbsAliqTable(dbOf(SEED))).sort((a, b) => key(a).localeCompare(key(b)))
    const fromLaw = [...IBSCBS_LEGAL_ALIQS].sort((a, b) => key(a).localeCompare(key(b)))
    expect(fromDb).toEqual(fromLaw)
  })

  it('o motor lê a tabela: emissão de 2026 acha as três alíquotas; a CBS de 2027 NÃO tem linha (null, nunca inventada)', async () => {
    const table = await loadIbscbsAliqTable(dbOf(SEED))
    expect([ibscbsAliqAt(table, 'IBS_UF', '2026-11-10'), ibscbsAliqAt(table, 'IBS_MUN', '2026-11-10'), ibscbsAliqAt(table, 'CBS', '2026-11-10')])
      .toEqual([1000, 0, 9000])
    expect(ibscbsAliqAt(table, 'IBS_UF', '2027-01-15')).toBe(500)
    expect(ibscbsAliqAt(table, 'CBS', '2027-01-15')).toBeNull()
  })

  it('lê pelo texto (CAST AS CHAR), só as linhas vivas, e só do schema central', async () => {
    const db = dbOf(SEED)
    await loadIbscbsAliqTable(db)
    expect(db.sqls[0]).toContain('CAST(rate AS CHAR)')
    expect(db.sqls[0]).toContain("deleted = 'N'")
    expect(db.sqls[0]).toContain('setes_central.tb_tax_ibscbs_rate')
    await expect(loadIbscbsAliqTable(dbOf(SEED), 'x; DROP TABLE y')).rejects.toThrow(/schema central inválido/)
  })

  it('dado fora do contrato SOBE — tributo desconhecido ou percentual que não é de 0 a 100 nunca vira "sem alíquota"', async () => {
    await expect(loadIbscbsAliqTable(dbOf([{ tax: 'X', validFrom: '2026-01-01', validUntil: null, rate: '1.0000' }]))).rejects.toThrow(/fora de U, M e C/)
    for (const rate of ['100.0001', '-1.0000', 'abc', '']) {
      await expect(loadIbscbsAliqTable(dbOf([{ tax: 'U', validFrom: '2026-01-01', validUntil: null, rate }]))).rejects.toThrow(/percentual inválido/)
    }
  })

  it('data do driver como Date vale pelo dia; validUntil nulo = em aberto', async () => {
    const [line] = await loadIbscbsAliqTable(dbOf([{ tax: 'C', validFrom: new Date('2029-01-01T00:00:00Z'), validUntil: null, rate: '8.8000' }]))
    expect(line).toEqual({ tax: 'CBS', validFrom: '2029-01-01', validUntil: null, ppm: 88000 })
  })
})

describe('ibscbsRateAlerts — o boot avisa quando a tabela não sustenta o regime regular (A-IB143f)', () => {
  const lines = [...IBSCBS_LEGAL_ALIQS]

  it('2026-11-26: IBS vigente hoje e até o horizonte de 45 dias; a CBS some em 2027-01-10 → avisa só a CBS', () => {
    expect(ibscbsRateAlerts(lines, '2026-11-26')).toEqual([
      expect.stringMatching(/^a alíquota de CBS deixa de ter linha vigente até 2027-01-10/),
    ])
  })

  it('mais de 45 dias antes do fim da faixa: nada a avisar', () => {
    expect(ibscbsRateAlerts(lines, '2026-10-01')).toEqual([])
  })

  it('tabela vazia: os três tributos sem alíquota hoje', () => {
    expect(ibscbsRateAlerts([], '2026-11-26')).toEqual([
      expect.stringMatching(/sem alíquota de IBS da UF vigente hoje \(2026-11-26\)/),
      expect.stringMatching(/sem alíquota de IBS do município vigente hoje/),
      expect.stringMatching(/sem alíquota de CBS vigente hoje/),
    ])
  })

  it('já em 2027 sem CBS: avisa que não há CBS hoje', () => {
    expect(ibscbsRateAlerts(lines, '2027-02-01')).toEqual([expect.stringMatching(/sem alíquota de CBS vigente hoje \(2027-02-01\)/)])
  })
})
