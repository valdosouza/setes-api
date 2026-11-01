/// <reference types="jest" />
// Gate adversarial da D-IB99/D-IB100 + D-IB101 (2026-11-01, prompt_fase_ibs_cbs.md §14.3/§14.4) — PARTE VIVA, opt-in
// `IB99_ADV_LIVE=1`: schema DESCARTÁVEL `setes_ib99_adv_jest_*` criado e apagado aqui (só leitura em setes_setes/setes_central).
// Fixa os MEDIUM que a D-IB101 fechou (a opção nunca muda o que uma nota já leu — inclusive com o fuso trocado) e o LOW ADV-IB99-05.
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const live = process.env.IB99_ADV_LIVE === '1'

;(live ? describe : describe.skip)('ao vivo — a opção IBS/CBS nunca muda o que uma nota já leu (D-IB101)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config({ path: path.join(SRC, '..', '.env') })
  const tz = jest.requireMock('@shared/time-zone') as Record<string, jest.Mock>
  const actualTz = jest.requireActual('@shared/time-zone')
  let pool: any, piece: any, splitStatements: (sql: string) => string[]
  const S = `setes_ib99_adv_jest_${Date.now().toString(36)}`
  const D = '2027-03-10'
  const MIGRATION = path.join(SRC, 'migrations', 'sql', '076_establishment_ibscbs_assessment.sql')
  const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e: any) { return e?.code ?? 'erro' } }
  /**
   * O relógio REAL (ADV-D101-06 do gate do delta): a fronteira da D-IB101 usa `new Date()` DEPOIS da trava — o relógio da operação
   * não a move. Só o `Date` é falso (os temporizadores do driver seguem reais); a operação também anda junto.
   */
  const clock = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask', 'clearTimeout',
      'clearInterval', 'clearImmediate', 'hrtime', 'performance'] })
    jest.setSystemTime(new Date(iso))
    try { return await actualTz.runWithOperationClock(new Date(iso), fn) } finally { jest.useRealTimers() }
  }
  const note = (id: number, day: string) => pool.query(
    `INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, issuer, tb_entity_id, dt_emission, status) VALUES (?, 1, 1, 1, ?, 'F')`, [id, day])

  /** Recomeça as 3 tabelas por DDL (nunca DELETE de dado — PADROES §3.1), no schema descartável. */
  async function freshTables() {
    for (const t of ['tb_institution_has_config', 'tb_invoice', 'tb_entity_tax']) {
      await pool.query(`DROP TABLE IF EXISTS \`${S}\`.${t}`)
      await pool.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_setes.${t}`)
    }
    // D-IB102: o emitente é ME/EPP (opSimpNac 3) — admite a opção pelo regime regular
    await pool.query(`INSERT INTO \`${S}\`.tb_entity_tax (id, tb_institution_id, simples_regime) VALUES (1, 1, '3')`)
    const c = await pool.getConnection()
    try {
      await c.query(`USE \`${S}\``)
      await c.query('DROP TABLE IF EXISTS tb_establishment_ibscbs_assessment')
      for (const st of splitStatements(fs.readFileSync(MIGRATION, 'utf8'))) await c.query(st)
    } finally { c.release() }
    actualTz.invalidateInstitutionZone(S, 1)
  }

  beforeAll(async () => {
    tz.todayFor.mockImplementation(actualTz.todayFor)                 // o fuso REAL (config do schema)
    tz.institutionZoneFor.mockImplementation(actualTz.institutionZoneFor)
    pool = require('@shared/db/connection').default
    piece = require('@shared/ibscbs-assessment')
    splitStatements = require('../migrations/runner').splitStatements
    await pool.query(`CREATE DATABASE \`${S}\``)
  }, 30000)
  afterAll(async () => { await pool.query(`DROP DATABASE IF EXISTS \`${S}\``); await pool.end() })
  beforeEach(freshTables, 30000)

  it('ADV-IB99-01: nota de HOJE emitida com 1 → registrar 2/3 a partir de hoje é recusado (INVOICED)', async () => {
    await clock(`${D}T15:00:00Z`, async () => {   // 12:00 em Brasília
      const c = await pool.getConnection()
      try { await c.beginTransaction(); await piece.assertIbscbsAssessmentSupported(c, S, 1, D); await c.commit() } finally { c.release() }
      await note(1, D)
      expect(await codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: D, assessment: '3' }))).toBe('IBSCBS_ASSESSMENT_INVOICED')
      expect((await piece.ibscbsAssessmentAt(pool, S, 1, D, { lock: false })).assessment).toBe('1')
      // o "hoje" é D (12:00 em Brasília): sem nota em D+1, registrar a partir de D+1 passa — quem recusa é a NOTA, não a data
      expect(await codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: '2027-03-11', assessment: '3' }))).toBe('ok')
      // e o "hoje" real vale: início ONTEM = DATE_PAST
      expect(await codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: '2027-03-09', assessment: '1' }))).toBe('IBSCBS_ASSESSMENT_DATE_PAST')
    })
  })

  it('D-IB101: o registro que ESPERA o faturamento enxerga a nota que ele gravou (o retrato nasce depois da espera) e recusa', async () => {
    await clock(`${D}T15:00:00Z`, async () => {
      const billing = await pool.getConnection()
      try {
        await billing.beginTransaction()
        await piece.ibscbsAssessmentAt(billing, S, 1, D, { lock: true })          // o faturamento leu "sem linha = 1"
        const pending = codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: D, assessment: '1' }))
        await new Promise(r => setTimeout(r, 600))                                 // o registro espera a trava
        await billing.query(`INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, issuer, tb_entity_id, dt_emission, status) VALUES (9, 1, 1, 1, ?, '0')`, [D])
        await billing.commit()
        expect(await pending).toBe('IBSCBS_ASSESSMENT_INVOICED')
      } finally { billing.release() }
    })
  })

  it('D-IB101 × D-IB102: com a opção 3 (o regime é lido TRAVADO antes da trava da opção) o retrato ainda nasce depois da espera', async () => {
    await clock(`${D}T15:00:00Z`, async () => {
      const billing = await pool.getConnection()
      try {
        await billing.beginTransaction()
        await piece.ibscbsAssessmentAt(billing, S, 1, D, { lock: true })
        const pending = codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: D, assessment: '3' }))
        await new Promise(r => setTimeout(r, 600))
        await billing.query(`INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, issuer, tb_entity_id, dt_emission, status) VALUES (10, 1, 1, 1, ?, '0')`, [D])
        await billing.commit()
        expect(await pending).toBe('IBSCBS_ASSESSMENT_INVOICED')
      } finally { billing.release() }
    })
  })

  it('ADV-IB99-02: trocar o fuso (SP → Rio_Branco, opção do seed 60) não reabre a vigente nem o ontem', async () => {
    const [[itf]] = await pool.query(`SELECT id FROM setes_central.tb_interface WHERE i18n_key = 'establishment' AND deleted = 'N'`)
    await pool.query(`INSERT INTO \`${S}\`.tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (1, ?, '1', 1)`, [D])
    await note(2, D)   // emitida sob a linha que vale desde D
    await clock(`${D}T03:30:00Z`, async () => {   // 00:30 em Brasília = 22:30 do dia anterior no Acre (o "hoje" REAL volta um dia)
      await pool.query(`INSERT INTO \`${S}\`.tb_institution_has_config (tb_institution_id, tb_interface_id, name, tb_user_id, content, created_at, updated_at, deleted)
                        VALUES (1, ?, 'time_zone', 0, 'America/Rio_Branco', NOW(), NOW(), 'N')`, [itf.id])
      actualTz.invalidateInstitutionZone(S, 1)
      expect(await codeOf(piece.changeIbscbsAssessment(S, 1, 9, { validFrom: D, assessment: '3' }))).toBe('IBSCBS_ASSESSMENT_INVOICED')
      expect(await codeOf(piece.createIbscbsAssessment(S, 1, 9, { validFrom: '2027-03-09', assessment: '3' }))).toBe('IBSCBS_ASSESSMENT_INVOICED')
      expect(await codeOf(piece.removeIbscbsAssessment(S, 1, 9, D))).toBe('IBSCBS_ASSESSMENT_INVOICED')
      expect(await piece.readIbscbsAssessmentView(S, 1)).toMatchObject({ today: '2027-03-09', lastInvoice: D, firstStart: '2027-03-11' })
    })
  })

  it('D-IB102: quem não é ME/EPP nem pendente não registra 2/3 (lido TRAVADO depois da trava); a 1 sempre passa', async () => {
    await pool.query(`UPDATE \`${S}\`.tb_entity_tax SET simples_regime = '1' WHERE id = 1 AND tb_institution_id = 1`)
    expect(await codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: '2027-07-01', assessment: '3' }))).toBe('IBSCBS_ASSESSMENT_NOT_SIMPLES')
    expect(await codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: '2027-07-01', assessment: '1' }))).toBe('ok')
    expect(await piece.readIbscbsAssessmentView(S, 1)).toMatchObject({ simplesRegime: '1', regularAllowed: false })
  })

  it('ADV-D102-01: registro 2/3 de HOJE × faturamento × PUT do regime na fila — nenhum 1213 (a mesma ordem de travas)', async () => {
    await clock(`${D}T15:00:00Z`, async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const et = require('@shared/entity-tax/entity-tax.repository')
      const billing = await pool.getConnection()
      const admin = await pool.getConnection()
      try {
        await billing.beginTransaction()
        await et.emitterRegimeAt(billing, S, 1, D, { lock: true })                    // o faturamento da OS: tb_entity_tax travado
        const put = codeOf(et.upsertEntityTax(admin, S, 1, 1, { simplesRegime: '1' }))  // o PUT do regime na fila (X)
        await new Promise(r => setTimeout(r, 400))
        const reg = codeOf(piece.createIbscbsAssessment(S, 1, 7, { validFrom: D, assessment: '3' }))
        await new Promise(r => setTimeout(r, 800))
        const bill = await codeOf(piece.assertIbscbsAssessmentSupported(billing, S, 1, D))
        await billing.commit()
        const out = [bill, await put, await reg]
        expect(out).not.toContain('ER_LOCK_DEADLOCK')
        expect(bill).toBe('ok')                                                         // o faturamento não esperou o registro
      } finally { billing.release(); admin.release() }
    })
  })

  it('ADV-IB99-05: revive concorrente da mesma data → só ok/DUPLICATE, exatamente um ok', async () => {
    await pool.query(`INSERT INTO \`${S}\`.tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id, deleted) VALUES (1, '2027-07-01', '1', 1, 'S')`)
    const out = await Promise.all([1, 2, 3, 4, 5, 6].map(u => codeOf(piece.createIbscbsAssessment(S, 1, u, { validFrom: '2027-07-01', assessment: '3' }))))
    expect(out.filter(c => c === 'ok')).toHaveLength(1)
    expect(out.every(c => c === 'ok' || c === 'IBSCBS_ASSESSMENT_DUPLICATE')).toBe(true)
  })
})
