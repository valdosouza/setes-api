/**
 * PROVA da migration 076 e da peça @shared/ibscbs-assessment (fase IBS/CBS, D-IB99/D-IB100 — prompt_fase_ibs_cbs.md §14) em
 * SCHEMA DESCARTÁVEL: cria `setes_ib99_probe_<pid>` (a FK aponta para a institution REAL do schema de origem — só leitura na
 * central), copia VAZIA a tabela de config que o fuso lê, aplica a 076 DUAS vezes (re-executável), confere o CHECK pelo NOME e pelo
 * corpo (a mesma conferência do boot), sonda o domínio, exercita a peça inteira (registrar, alterar, excluir, reviver, imutabilidade
 * do vigente, piso do regular, a recusa do faturamento) e PROVA a trava: com o faturamento lendo a opção (LOCK IN SHARE MODE), o
 * registro de uma opção com início ≤ a competência ESPERA. Apaga o schema descartável no fim (inclusive em falha). NUNCA escreve no
 * schema de origem nem na central.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-assessment.ts [schema-origem=setes_setes] [institution=1]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { todayFor } from '@shared/time-zone'
import {
  ibscbsAssessmentAt, assessmentRefusalOf, ibscbsAssessmentCheckProblem, readIbscbsAssessmentView,
  createIbscbsAssessment, changeIbscbsAssessment, removeIbscbsAssessment, IBSCBS_REGULAR_ASSESSMENT_START,
} from '@shared/ibscbs-assessment'

const SOURCE = process.argv[2] ?? 'setes_setes'
const INSTITUTION = Number(process.argv[3] ?? 1)
const PROBE = `setes_ib99_probe_${process.pid}`
const MIGRATION = path.join(__dirname, '..', 'src', 'migrations', 'sql', '076_establishment_ibscbs_assessment.sql')

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

async function main() {
  if (!/^setes_[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema de origem inválido: ${SOURCE}`)
  if (!Number.isInteger(INSTITUTION) || INSTITUTION <= 0) throw new Error(`institution inválida: ${INSTITUTION}`)
  const conn = await pool.getConnection()
  const other = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}`); ok &&= cond }
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'ok' } catch (e: any) { return e?.code ?? `${e?.statusCode ?? ''}:${e?.message}` }
  }
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_institution_has_config LIKE \`${SOURCE}\`.tb_institution_has_config`)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_invoice LIKE \`${SOURCE}\`.tb_invoice`)   // D-IB101: a última nota viva (vazia)
    await conn.query(`USE \`${PROBE}\``)
    const statements = splitStatements(fs.readFileSync(MIGRATION, 'utf8'))
    for (let run = 1; run <= 2; run++) for (const st of statements) await conn.query(st)
    check('076 aplicada DUAS vezes sem erro (re-executável)', true)

    const problem = await ibscbsAssessmentCheckProblem(conn, PROBE)
    const [ck] = await conn.query<any[]>(
      `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_establishment_ibscbs_assessment'`,
      [PROBE])
    check(`CHECK pelo NOME e corpo esperado (boot): ${problem ?? 'presente'} — corpo guardado: ${(ck as any[]).map(r => r.c).join(' | ')}`,
      problem === null)

    // Domínio (PADROES §11 regras 11/16): fora do domínio, vazio e espaço são recusados pelo CHECK de NOME certo
    const probeInsert = async (validFrom: string, value: string) => {
      try {
        await conn.query(
          `INSERT INTO tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (?, ?, ?, 1)`,
          [INSTITUTION, validFrom, value])
        return 'aceito'
      } catch (e: any) {
        return /ck_establishment_ibscbs_assessment/.test(String(e?.sqlMessage ?? e?.message)) ? 'recusado' : `erro:${e?.sqlMessage ?? e?.message}`
      }
    }
    for (const [i, v] of ['4', '0', '', ' ', 'a'].entries()) {
      check(`domínio: '${v}' recusado pelo ck_establishment_ibscbs_assessment`, await probeInsert(`2031-01-0${i + 1}`, v) === 'recusado')
    }

    const today = await todayFor(PROBE, INSTITUTION)
    console.log(`     hoje do estabelecimento (fuso): ${today}`)
    const S = PROBE

    // Sem linha = 1 (D-IB1), sem recusa
    const none = await ibscbsAssessmentAt(conn, S, INSTITUTION, '2027-03-10', { lock: false })
    check('sem linha → 1, validFrom null, faturamento passa', none.assessment === '1' && none.validFrom === null
      && assessmentRefusalOf(none, '2027-03-10') === null)

    // Escrita pela peça
    check('início antes de hoje → IBSCBS_ASSESSMENT_DATE_PAST',
      await codeOf(createIbscbsAssessment(S, INSTITUTION, 1, { validFrom: addDays(today, -1), assessment: '1' })) === 'IBSCBS_ASSESSMENT_DATE_PAST')
    const early = today < IBSCBS_REGULAR_ASSESSMENT_START ? addDays(IBSCBS_REGULAR_ASSESSMENT_START, -1) : null
    if (early) {
      check(`regular antes de ${IBSCBS_REGULAR_ASSESSMENT_START} → IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY`,
        await codeOf(createIbscbsAssessment(S, INSTITUTION, 1, { validFrom: early, assessment: '2' })) === 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY')
    }
    const start = today < IBSCBS_REGULAR_ASSESSMENT_START ? IBSCBS_REGULAR_ASSESSMENT_START : addDays(today, 1)
    check(`registra 3 a partir de ${start}`, await codeOf(createIbscbsAssessment(S, INSTITUTION, 7, { validFrom: start, assessment: '3' })) === 'ok')
    check('mesma data de novo → IBSCBS_ASSESSMENT_DUPLICATE',
      await codeOf(createIbscbsAssessment(S, INSTITUTION, 1, { validFrom: start, assessment: '1' })) === 'IBSCBS_ASSESSMENT_DUPLICATE')
    const later = addDays(start, 40)
    const at = await ibscbsAssessmentAt(conn, S, INSTITUTION, later, { lock: false })
    const refusal = assessmentRefusalOf(at, later)
    check(`competência ${later} na vigência de 3 → recusa IBSCBS_REGULAR_REGIME_UNSUPPORTED`,
      at.assessment === '3' && at.validFrom === start && refusal?.code === 'IBSCBS_REGULAR_REGIME_UNSUPPORTED')
    const before = await ibscbsAssessmentAt(conn, S, INSTITUTION, addDays(start, -1), { lock: false })
    check('véspera do início → ainda 1 (sem linha), sem recusa', before.assessment === '1' && before.validFrom === null)

    let view = await readIbscbsAssessmentView(S, INSTITUTION)
    check('visão: vigente hoje = 1 sem linha; a linha futura é editável e não suportada',
      view.current.assessment === '1' && view.current.validFrom === null && view.items.length === 1
      && view.items[0].editable && !view.items[0].supported && !view.items[0].inEffect)

    check('altera a linha futura para 2', await codeOf(changeIbscbsAssessment(S, INSTITUTION, 8, { validFrom: start, assessment: '2' })) === 'ok')
    check('altera data inexistente → IBSCBS_ASSESSMENT_NOT_FOUND',
      await codeOf(changeIbscbsAssessment(S, INSTITUTION, 8, { validFrom: addDays(start, 5), assessment: '1' })) === 'IBSCBS_ASSESSMENT_NOT_FOUND')
    check('exclui (soft) a linha futura', await codeOf(removeIbscbsAssessment(S, INSTITUTION, 9, start)) === 'ok')
    const [dead] = await conn.query<any[]>(`SELECT deleted, assessment, tb_user_id AS u FROM tb_establishment_ibscbs_assessment WHERE valid_from = ?`, [start])
    check('a linha morta FICA (soft delete) com o autor do ato', dead.length === 1 && dead[0].deleted === 'S' && Number(dead[0].u) === 9)
    check('alterar a morta → IBSCBS_ASSESSMENT_NOT_FOUND',
      await codeOf(changeIbscbsAssessment(S, INSTITUTION, 8, { validFrom: start, assessment: '1' })) === 'IBSCBS_ASSESSMENT_NOT_FOUND')
    check('registrar na mesma data REVIVE a linha', await codeOf(createIbscbsAssessment(S, INSTITUTION, 10, { validFrom: start, assessment: '1' })) === 'ok')
    const [alive] = await conn.query<any[]>(`SELECT deleted, assessment, tb_user_id AS u FROM tb_establishment_ibscbs_assessment WHERE valid_from = ?`, [start])
    check('revivida sem herdar nada (opção e autor novos)', alive[0].deleted === 'N' && alive[0].assessment === '1' && Number(alive[0].u) === 10)

    // ADV-IB99-05 (gate adversarial): 4 reviveres SIMULTÂNEOS da mesma data morta = 1 revive + 3 DUPLICATE, nunca deadlock/409 BUSY
    const raceDate = addDays(start, 10)
    await createIbscbsAssessment(S, INSTITUTION, 12, { validFrom: raceDate, assessment: '1' })
    await removeIbscbsAssessment(S, INSTITUTION, 12, raceDate)
    const race = await Promise.all([13, 14, 15, 16].map(u => codeOf(createIbscbsAssessment(S, INSTITUTION, u, { validFrom: raceDate, assessment: '1' }))))
    check(`revive x4 concorrente: ${JSON.stringify(race.sort())}`,
      race.filter(r => r === 'ok').length === 1 && race.filter(r => r === 'IBSCBS_ASSESSMENT_DUPLICATE').length === 3)
    const fresh = addDays(start, 11)
    const create = await Promise.all([17, 18, 19, 20].map(u => codeOf(createIbscbsAssessment(S, INSTITUTION, u, { validFrom: fresh, assessment: '1' }))))
    check(`criação x4 concorrente (data nova): ${JSON.stringify(create.sort())}`,
      create.filter(r => r === 'ok').length === 1 && create.filter(r => r === 'IBSCBS_ASSESSMENT_DUPLICATE').length === 3)

    // Imutabilidade do vigente: linha de hoje registrada pela peça não muda mais
    check('registra 1 a partir de HOJE', await codeOf(createIbscbsAssessment(S, INSTITUTION, 11, { validFrom: today, assessment: '1' })) === 'ok')
    check('alterar a vigente → IBSCBS_ASSESSMENT_IN_EFFECT',
      await codeOf(changeIbscbsAssessment(S, INSTITUTION, 11, { validFrom: today, assessment: '1' })) === 'IBSCBS_ASSESSMENT_IN_EFFECT')
    check('excluir a vigente → IBSCBS_ASSESSMENT_IN_EFFECT',
      await codeOf(removeIbscbsAssessment(S, INSTITUTION, 11, today)) === 'IBSCBS_ASSESSMENT_IN_EFFECT')
    view = await readIbscbsAssessmentView(S, INSTITUTION)
    check('visão: a de hoje é a vigente (inEffect, não editável)',
      view.current.validFrom === today && view.items.find(i => i.validFrom === today)?.inEffect === true
      && view.items.find(i => i.validFrom === today)?.editable === false)

    // TRAVA (PADROES §9 regra 2): o faturamento lê a opção na competência com LOCK IN SHARE MODE; o registro de uma opção com
    // início ≤ competência ESPERA o faturamento terminar — a nota nunca é decidida com uma opção que muda no meio dela. A espera
    // ORDENA, não confere: depois do commit o registro passa e cobre a nota já emitida no mesmo dia (limite da Q-IB105)
    // recomeça a tabela por DDL (nunca DELETE de dado — PADROES §3.1) e prova a 3ª execução da 076
    await conn.query('DROP TABLE tb_establishment_ibscbs_assessment')
    for (const st of statements) await conn.query(st)
    const competence = '2027-03-10'
    await other.query('SET SESSION innodb_lock_wait_timeout = 2')
    const insertBy = async (validFrom: string) => {
      try {
        await other.query(
          `INSERT INTO \`${PROBE}\`.tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (?, ?, '3', 1)`,
          [INSTITUTION, validFrom])
        return 'gravou'
      } catch (e: any) { return e?.errno === 1205 ? 'esperou' : `erro:${e?.sqlMessage ?? e?.message}` }
    }
    await conn.beginTransaction()
    await ibscbsAssessmentAt(conn, S, INSTITUTION, competence, { lock: true })   // SEM linha (o caso real: a 1ª opção)
    check('sem linha travada: registrar início = competência ESPERA', await insertBy(competence) === 'esperou')
    check('sem linha travada: registrar início < competência ESPERA', await insertBy('2027-02-01') === 'esperou')
    await conn.commit()
    await conn.query(
      `INSERT INTO tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (?, '2027-01-01', '1', 1)`,
      [INSTITUTION])
    await conn.beginTransaction()
    await ibscbsAssessmentAt(conn, S, INSTITUTION, competence, { lock: true })   // COM linha anterior
    check('com linha travada: registrar entre a linha e a competência ESPERA', await insertBy('2027-02-01') === 'esperou')
    check('com linha travada: registrar NA competência ESPERA', await insertBy(competence) === 'esperou')
    const after = await insertBy('2027-07-01')
    console.log(`     (informativo) registrar DEPOIS da competência com a leitura travada: ${after}`)
    await conn.commit()
    check('depois do commit do faturamento o registro passa', await insertBy('2027-02-01') === 'gravou')

    // D-IB101 (Valdo 2026-11-01): a espera ORDENA e o escritor da opção CONFERE — o faturamento lê a opção (travado), o registro com
    // início na competência ESPERA, o faturamento grava a nota e confirma; o registro, ao passar, enxerga a nota (o retrato da transação
    // dele nasce DEPOIS da espera) e recusa com INVOICED. Sem isso, a opção passaria a cobrir a nota que já leu a anterior.
    await conn.query('DROP TABLE tb_establishment_ibscbs_assessment')
    for (const st of statements) await conn.query(st)
    const raceDay = addDays(today, 7)
    await conn.beginTransaction()
    await ibscbsAssessmentAt(conn, S, INSTITUTION, raceDay, { lock: true })            // o faturamento leu "sem linha = 1"
    const pending = codeOf(createIbscbsAssessment(S, INSTITUTION, 21, { validFrom: raceDay, assessment: '1' }))
    await new Promise(r => setTimeout(r, 600))                                           // o registro está esperando a trava
    await conn.query(`INSERT INTO tb_invoice (id, tb_institution_id, issuer, tb_entity_id, dt_emission, status) VALUES (900001, ?, ?, 1, ?, '0')`,
      [INSTITUTION, INSTITUTION, raceDay])
    await conn.commit()
    check(`registro que esperou o faturamento enxerga a nota e recusa: ${await pending}`, (await pending) === 'IBSCBS_ASSESSMENT_INVOICED')
    const [plan] = await conn.query<any[]>(`EXPLAIN SELECT MAX(dt_emission) FROM tb_invoice WHERE tb_institution_id = ? AND deleted = 'N'`, [INSTITUTION])
    const extra = String((plan as any[])[0]?.Extra ?? '')
    check(`fronteira pelo índice da 076 (ADV-D101-02): ${extra || (plan as any[])[0]?.key}`,
      /optimized away/i.test(extra) || (plan as any[])[0]?.key === 'idx_invoice_live_emission')
    check('depois da nota, início POSTERIOR a ela passa',
      await codeOf(createIbscbsAssessment(S, INSTITUTION, 22, { validFrom: addDays(raceDay, 1), assessment: '1' })) === 'ok')
    check('registrar de novo com início ≤ a última nota = INVOICED (mesmo futuro pelo relógio)',
      await codeOf(createIbscbsAssessment(S, INSTITUTION, 23, { validFrom: raceDay, assessment: '1' })) === 'IBSCBS_ASSESSMENT_INVOICED')
  } finally {
    try { await conn.rollback() } catch { /* nada aberto */ }
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    other.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
