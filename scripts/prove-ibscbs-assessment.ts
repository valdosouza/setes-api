/**
 * PROVA da migration 077 e da peça @shared/ibscbs-assessment (fase IBS/CBS, D-IB99/D-IB100 — prompt_fase_ibs_cbs.md §14) em
 * SCHEMA DESCARTÁVEL: cria `setes_ib99_probe_<pid>` (a FK aponta para a institution REAL do schema de origem — só leitura na
 * central), copia VAZIA a tabela de config que o fuso lê, aplica a 077 DUAS vezes (re-executável), confere o CHECK pelo NOME e pelo
 * corpo (a mesma conferência do boot), sonda o domínio, exercita a peça inteira (registrar, alterar, excluir, reviver, imutabilidade
 * do vigente, piso do regular, a recusa do faturamento) e PROVA a trava: com o faturamento lendo a opção (LOCK IN SHARE MODE), o
 * registro de uma opção com início ≤ a competência ESPERA. Apaga o schema descartável no fim (inclusive em falha). NUNCA escreve no
 * schema de origem nem na central.
 *
 * setes-api:IBS.E6.P7 (D-IB127/D-IB128/D-IB129 — prompt_fase_ibs_cbs.md §17): também a VIEW publicada (migration 078) — aplicada duas
 * vezes, colunas = o contrato do núcleo, EXPLAIN fundido pela PK, linha morta fora dela, o seletor IMPORTADO sobre a view = a peça, e o
 * usuário da API fiscal lendo a view e recusado no INSERT na tabela (credencial por `FISCAL_DB_USER`/`FISCAL_DB_PASSWORD` no ambiente —
 * a do `.env` da nfse-api; nunca impressa; sem ela a prova FALHA; `FISCAL_DB_HOST` opcional = o DB_HOST da nfse-api). E a trava de novo, com a vigente escolhida pelo seletor importado.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-assessment.ts [schema-origem=setes_setes] [institution=1]
 */
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW, ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS, ibscbsAssessmentOf } from 'fiscal-api/ibscbs-assessment'
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
const MIGRATION = path.join(__dirname, '..', 'src', 'migrations', 'sql', '077_establishment_ibscbs_assessment.sql')
const MIGRATION_VIEW = path.join(__dirname, '..', 'src', 'migrations', 'sql', '078_establishment_ibscbs_assessment_view.sql')
const VIEW = ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW

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
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_invoice_event LIKE \`${SOURCE}\`.tb_invoice_event`)   // D-IB103: só nota do ERP web conta
    // D-IB102: o emitente é ME/EPP (opSimpNac 3) — admite a opção pelo regime regular
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_entity_tax LIKE \`${SOURCE}\`.tb_entity_tax`)
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity_tax (id, tb_institution_id, simples_regime) VALUES (?, ?, '3')`, [INSTITUTION, INSTITUTION])
    await conn.query(`USE \`${PROBE}\``)
    const statements = splitStatements(fs.readFileSync(MIGRATION, 'utf8'))
    for (let run = 1; run <= 2; run++) for (const st of statements) await conn.query(st)
    check('077 aplicada DUAS vezes sem erro (re-executável)', true)
    const viewStatements = splitStatements(fs.readFileSync(MIGRATION_VIEW, 'utf8'))
    for (let run = 1; run <= 2; run++) for (const st of viewStatements) await conn.query(st)
    check('078 (view) aplicada DUAS vezes sem erro (re-executável)', true)
    /** DROP da tabela invalida a view: a 077 e a 078 são reaplicadas JUNTAS. */
    const reapply = async () => { for (const st of [...statements, ...viewStatements]) await conn.query(st) }

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

    // ── VIEW publicada (D-IB127/D-IB129) — antes do 1º DROP da tabela ──────────────────────────────────────────────────────────
    const [cols] = await conn.query<any[]>(
      `SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [PROBE, VIEW])
    const contract = ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS
    check(`view: colunas NA ORDEM = contrato do núcleo (${(cols as any[]).map(r => `${r.c}:${r.t}`).join(', ')})`,
      JSON.stringify((cols as any[]).map(r => r.c)) === JSON.stringify(contract.map(c => c[0]))
      && contract.every(([c, , kind]) => kind !== 'date' || (cols as any[]).find(r => r.c === c)?.t === 'date'))
    // 30 linhas vivas de datas variadas (2040+, longe de tudo acima) + 1 morta — o dado do EXPLAIN e do seletor
    for (let i = 0; i < 30; i++) {
      await conn.query(
        `INSERT INTO tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id, deleted) VALUES (?, ?, ?, 1, 'N')`,
        [INSTITUTION, `${2040 + Math.floor(i / 3)}-${String(1 + (i % 3) * 4).padStart(2, '0')}-01`, String(1 + (i % 3))])
    }
    const deadDate = '2045-03-01'
    await conn.query(
      `INSERT INTO tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id, deleted) VALUES (?, ?, '3', 1, 'S')`,
      [INSTITUTION, deadDate])
    await conn.query('ANALYZE TABLE tb_establishment_ibscbs_assessment')
    const [vplan] = await conn.query<any[]>(
      `EXPLAIN SELECT tb_institution_id, DATE_FORMAT(valid_from, '%Y-%m-%d') AS validFrom, assessment FROM ${VIEW}
        WHERE tb_institution_id = ? AND valid_from <= ?`, [INSTITUTION, '2045-06-01'])
    check(`view: EXPLAIN fundido pela PK (${(vplan as any[]).map(r => `${r.select_type}/${r.table}/${r.type}/${r.key ?? '-'}`).join(' ')})`,
      (vplan as any[]).length === 1 && (vplan as any[]).every(r => r.select_type === 'SIMPLE' && (r.table === 'a' || r.table === 'tb_establishment_ibscbs_assessment')
        && r.key === 'PRIMARY' && /^(range|ref)$/.test(String(r.type))))
    const viewRows = async (q: { query: (s: string, p?: unknown[]) => Promise<any> }) => {
      const [r] = await q.query(
        `SELECT DATE_FORMAT(valid_from, '%Y-%m-%d') AS validFrom, assessment FROM \`${PROBE}\`.${VIEW} WHERE tb_institution_id = ?`, [INSTITUTION])
      return r as { validFrom: string; assessment: any }[]
    }
    const vr = await viewRows(conn)
    check('view: a linha morta (deleted = S) NÃO aparece; as vivas sim', !vr.some(r => r.validFrom === deadDate) && vr.length >= 30)
    const same = await Promise.all(['2026-11-30', '2041-05-15', deadDate, '2049-12-31'].map(async d =>
      JSON.stringify(ibscbsAssessmentOf(vr.filter(r => r.validFrom <= d) as any, d)) === JSON.stringify(
        { ...await ibscbsAssessmentAt(conn, S, INSTITUTION, d, { lock: false }) })))
    check('view: o seletor IMPORTADO sobre as linhas da view = ibscbsAssessmentAt da peça (4 datas, inclusive a da linha morta)', same.every(Boolean))
    // o usuário da API fiscal (GRANT SELECT em setes\_% — §17.1 R4): lê a view; INSERT na tabela recusado por permissão
    const fiscalUser = process.env.FISCAL_DB_USER
    const fiscalPassword = process.env.FISCAL_DB_PASSWORD
    if (!fiscalUser || !fiscalPassword) {
      check('usuário da API fiscal: NÃO PROVADO (FISCAL_DB_USER/FISCAL_DB_PASSWORD ausentes no ambiente)', false)
    } else {
      const fiscal = await mysql.createConnection({
        // o MESMO host da nfse-api (`FISCAL_DB_HOST` = o DB_HOST do .env dela): o servidor tem uma conta por host (@localhost, @127.0.0.1…)
        host: process.env.FISCAL_DB_HOST ?? process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: fiscalUser, password: fiscalPassword,
      }).catch((e: any) => { check(`usuário ${fiscalUser}: NÃO CONECTOU (${e?.code ?? e?.message}) — a trava segue provada abaixo`, false); return null })
      if (fiscal) try {
        const fr = await viewRows(fiscal)
        check(`usuário ${fiscalUser}: lê a view (${fr.length} linhas, as mesmas da peça)`, JSON.stringify(fr) === JSON.stringify(vr))
        let denied = 'gravou'
        try {
          await fiscal.query(
            `INSERT INTO \`${PROBE}\`.tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (?, '2050-01-01', '1', 1)`,
            [INSTITUTION])
        } catch (e: any) { denied = e?.errno === 1142 ? 'recusado' : `erro:${e?.code}` }
        check(`usuário ${fiscalUser}: INSERT na tabela recusado por permissão (1142): ${denied}`, denied === 'recusado')
      } finally { await fiscal.end() }
    }

    // TRAVA (PADROES §9 regra 2): o faturamento lê a opção na competência com LOCK IN SHARE MODE; o registro de uma opção com
    // início ≤ competência ESPERA o faturamento terminar — a nota nunca é decidida com uma opção que muda no meio dela. A espera
    // ORDENA, não confere: depois do commit o registro passa e cobre a nota já emitida no mesmo dia (limite da Q-IB105)
    // recomeça a tabela por DDL (nunca DELETE de dado — PADROES §3.1) e prova a 3ª execução da 077
    await conn.query('DROP TABLE tb_establishment_ibscbs_assessment')
    await reapply()
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
    // IBS.E6.P7 (gate da ficha): sem o LIMIT 1 a leitura trava TODAS as linhas vivas ≤ competência — linha FUTURA não pode ganhar espera
    // nova. Uma vizinha imediata (o InnoDB trava o registro seguinte do intervalo — informativo) e uma distante (tem de passar)
    for (const d of ['2027-05-01', '2027-11-01']) {
      await conn.query(
        `INSERT INTO tb_establishment_ibscbs_assessment (tb_institution_id, valid_from, assessment, tb_user_id) VALUES (?, ?, '1', 1)`, [INSTITUTION, d])
    }
    const updateBy = async (validFrom: string) => {
      try {
        await other.query(
          `UPDATE \`${PROBE}\`.tb_establishment_ibscbs_assessment SET tb_user_id = 2 WHERE tb_institution_id = ? AND valid_from = ?`,
          [INSTITUTION, validFrom])
        return 'gravou'
      } catch (e: any) { return e?.errno === 1205 ? 'esperou' : `erro:${e?.sqlMessage ?? e?.message}` }
    }
    await conn.beginTransaction()
    await ibscbsAssessmentAt(conn, S, INSTITUTION, competence, { lock: true })   // COM linha anterior
    check('com linha travada: registrar entre a linha e a competência ESPERA', await insertBy('2027-02-01') === 'esperou')
    check('com linha travada: registrar NA competência ESPERA', await insertBy(competence) === 'esperou')
    check('com linha travada: alterar linha FUTURA distante (2027-11-01) NÃO espera', await updateBy('2027-11-01') === 'gravou')
    console.log(`     (informativo) alterar a linha futura VIZINHA (2027-05-01) com a leitura travada: ${await updateBy('2027-05-01')}`)
    const after = await insertBy('2027-07-01')
    console.log(`     (informativo) registrar DEPOIS da competência com a leitura travada: ${after}`)
    await conn.commit()
    check('depois do commit do faturamento o registro passa', await insertBy('2027-02-01') === 'gravou')

    // D-IB101 (Valdo 2026-11-01): a espera ORDENA e o escritor da opção CONFERE — o faturamento lê a opção (travado), o registro com
    // início na competência ESPERA, o faturamento grava a nota e confirma; o registro, ao passar, enxerga a nota (o retrato da transação
    // dele nasce DEPOIS da espera) e recusa com INVOICED. Sem isso, a opção passaria a cobrir a nota que já leu a anterior.
    await conn.query('DROP TABLE tb_establishment_ibscbs_assessment')
    await reapply()
    const raceDay = addDays(today, 7)
    await conn.beginTransaction()
    await ibscbsAssessmentAt(conn, S, INSTITUTION, raceDay, { lock: true })            // o faturamento leu "sem linha = 1"
    const pending = codeOf(createIbscbsAssessment(S, INSTITUTION, 21, { validFrom: raceDay, assessment: '1' }))
    await new Promise(r => setTimeout(r, 600))                                           // o registro está esperando a trava
    await conn.query(`INSERT INTO tb_invoice (id, tb_institution_id, issuer, tb_entity_id, dt_emission, status) VALUES (900001, ?, ?, 1, ?, '0')`,
      [INSTITUTION, INSTITUTION, raceDay])
    await conn.query(`INSERT INTO tb_invoice_event (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record) VALUES (?, 900001, 0, 1, 'E', ?)`,
      [INSTITUTION, raceDay])   // o evento E que o issueInvoice grava (D-IB103: nota do ERP web)
    await conn.commit()
    check(`registro que esperou o faturamento enxerga a nota e recusa: ${await pending}`, (await pending) === 'IBSCBS_ASSESSMENT_INVOICED')
    const [plan] = await conn.query<any[]>(
      `EXPLAIN SELECT e.dt_record FROM tb_invoice_event e STRAIGHT_JOIN tb_invoice i
         ON i.id = e.tb_invoice_id AND i.tb_institution_id = e.tb_institution_id AND i.terminal = e.terminal AND i.deleted = 'N'
       WHERE e.tb_institution_id = ? AND e.kind = 'E' AND e.deleted = 'N' ORDER BY e.dt_record DESC LIMIT 1`, [INSTITUTION])
    const steps = (plan as any[]).map(r => `${r.select_type}:${r.table}:${r.key}`)
    check(`fronteira (D-IB103) pelos EVENTOS, sem materializar (ADV-D103-01): ${steps.join(' → ')}`,
      (plan as any[])[0]?.table === 'e' && (plan as any[])[0]?.key === 'idx_invoice_event_issue'
      && !(plan as any[]).some(r => /MATERIALIZED|SUBQUERY/i.test(String(r.select_type))))
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
