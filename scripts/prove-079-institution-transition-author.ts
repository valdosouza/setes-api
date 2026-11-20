/**
 * PROVA da migration 079 (autor e motivo do ato "encerrar a transição" — D-PR53/D-PR57, passo setes-api:PROD.E6.P2) em SCHEMA
 * DESCARTÁVEL, com CÓPIAS das tabelas da central (`CREATE TABLE … LIKE` da `setes_central` REAL — LIKE não copia FK) e as migrations
 * 072 e 079 TAL COMO ESTÃO, com `setes_central` trocado pelo schema de prova:
 *  1. a 072 e depois a 079 rodam: as duas colunas nascem anuláveis (INT e VARCHAR(255)) logo depois de `transition_ended_at`; os dois
 *     CHECKs e a FK existem pelo NOME;
 *  2. a 079 roda DE NOVO (o runner executa por schema de cliente): nenhum erro, nenhum ALTER (a guarda resolve para SELECT 1);
 *  3. o motor APLICA as constraints (PADROES §11 regra 11): as 6 combinações parciais de (data, autor, motivo) recusadas por
 *     `ck_institution_transition_author`; motivo só branco recusado por `ck_institution_transition_reason`; os três juntos aceitos em
 *     W e em P; L com os três recusado por `ck_institution_transition_ended` (072); autor inexistente recusado pela FK (1452); o ato
 *     de quatro campos com a condição no comando passa uma vez e a repetição afeta 0 linhas;
 *  4. estado parcial (uma peça sem as outras): a 079 NÃO repara nem falha (não pode quebrar o onboarding se uma migration futura mexer
 *     nestas peças — gate socrático da PROD.E6.P2); quem recusa é o boot, pelos nomes — a prova mostra a peça faltando depois do re-run;
 *  5. linha encerrada SEM autor (dado de antes da 079) faz a 079 falhar alto pelo CHECK — sem backfill.
 * Apaga o schema de prova no fim (inclusive em falha). NUNCA escreve em `setes_central` nem em schema de cliente.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-079-institution-transition-author.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_ta_probe_${process.pid}`
const SQL = (f: string) => path.join(__dirname, '..', 'src', 'migrations', 'sql', f)
const M072 = SQL('072_institution_source_kind.sql')
const M079 = SQL('079_institution_transition_author.sql')
const W = 900201, L = 900202, P = 900203, U = 900290   // institutions de prova (W nativo, L em transição, P nativo) · U = usuário autor

async function main() {
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}${cond || got === undefined ? '' : `  (obtido: ${JSON.stringify(got)})`}`)
    ok &&= cond
  }
  const refusedBy = async (sql: string, params: unknown[]): Promise<string> => {
    try { await conn.query(sql, params); return 'ACEITOU' } catch (e: any) {
      if (e.errno === 1452) return '1452:FK'
      return `${e.errno}:${/CONSTRAINT `?(\w+)`?/.exec(e.message)?.[1] ?? e.message.slice(0, 80)}`
    }
  }
  const sqlOf = (file: string) => splitStatements(fs.readFileSync(file, 'utf8')).map(s => s.replace(/setes_central/g, PROBE))
  const insertEntity = async (id: number) => {
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (id) VALUES (?)`, [id]).catch(async () => {
      const [need] = await conn.query<any[]>(`SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_entity' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL AND COLUMN_NAME <> 'id'`, [PROBE])
      const cols = ['id', ...(need as any[]).map(r => r.c)]
      const vals = [id, ...(need as any[]).map(r => /int|decimal/.test(r.t) ? 0 : (/date|time/.test(r.t) ? '2026-01-01' : 'x'))]
      await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
    })
  }
  const counts = async () => {
    const [[c]] = await conn.query<any[]>(`SELECT
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = ? AND table_name = 'tb_institution' AND column_name IN ('transition_ended_by','transition_end_reason')) cols,
        (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE constraint_schema = ? AND table_name = 'tb_institution' AND constraint_name IN ('ck_institution_transition_author','ck_institution_transition_reason')) cks,
        (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE constraint_schema = ? AND table_name = 'tb_institution' AND constraint_name = 'fk_institution_transition_ended_by') fks`,
      [PROBE, PROBE, PROBE]) as any
    return { cols: Number(c.cols), cks: Number(c.cks), fks: Number(c.fks) }
  }
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    for (const t of ['tb_entity', 'tb_user', 'tb_institution', 'tb_sync_api_key']) {
      await conn.query(`CREATE TABLE \`${PROBE}\`.${t} LIKE setes_central.${t}`)
    }
    const [cols0] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution'
          AND COLUMN_NAME IN ('source_kind','transition_ended_at','transition_ended_by','transition_end_reason')`, [PROBE])
    if ((cols0 as any[]).length > 0) {
      // pré-condição (gate socrático da PROD.E6.P2): a prova aplica a 072 e a 079 sobre a central de HOJE, ainda sem elas. Central já
      // migrada = esta prova não se aplica como está (as linhas de prova sem source_kind falhariam com erro enganoso) — pare alto.
      throw new Error(`a central já tem colunas da 072/079 (${(cols0 as any[]).map(r => r.c).join(', ')}) — esta prova supõe a central sem elas`)
    }
    check('pré-condição: a cópia da central de HOJE ainda não tem as colunas da 072 nem da 079', true)
    const [uq] = await conn.query<any[]>(
      `SELECT DISTINCT index_name AS n FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = 'tb_institution' AND column_name = 'schema_name' AND non_unique = 0`, [PROBE])
    for (const u of uq as any[]) await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution DROP INDEX \`${u.n}\``)
    for (const id of [W, L, P, U]) await insertEntity(id)
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_user (id, active, created_at, updated_at, deleted) VALUES (?, 'S', NOW(), NOW(), 'N')`, [U])
    for (const [id, schema] of [[W, 'setes_w'], [L, 'setes_l'], [P, 'setes_p']] as const) {
      await conn.query(`INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, active, created_at, updated_at, deleted) VALUES (?, ?, 'S', NOW(), NOW(), 'N')`, [id, schema])
    }
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_sync_api_key (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at, deleted) VALUES (1, 'l', ?, 'SETES_L', 'S', NOW(), NOW(), 'N')`, [L])
    for (const st of sqlOf(M072)) await conn.query(st)
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'P' WHERE id = ?`, [P])   // P não nasce do backfill da 072

    const st079 = sqlOf(M079)
    check('079 tem 5 statements (SET das colunas, SET @ddl, PREPARE, EXECUTE, DEALLOCATE)', st079.length === 5, st079.length)
    const run079 = async () => { for (const st of st079) await conn.query(st) }

    // 5 (antes do 1): dado de antes da 079 — linha encerrada sem autor → a 079 falha ALTO pelo CHECK, sem backfill
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'W', transition_ended_at = NOW() WHERE id = ?`, [L])
    let firstErr = 'ACEITOU'
    try { await run079() } catch (e: any) { firstErr = `${e.errno}:${/CONSTRAINT `?(\w+)`?/.exec(e.message)?.[1] ?? e.message.slice(0, 80)}` }
    check('5. linha encerrada sem autor: a 079 falha alto por ck_institution_transition_author (sem backfill)', firstErr === '4025:ck_institution_transition_author', firstErr)
    check('5. e o ALTER é atômico: nenhuma peça ficou para trás', JSON.stringify(await counts()) === JSON.stringify({ cols: 0, cks: 0, fks: 0 }), await counts())
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'L', transition_ended_at = NULL WHERE id = ?`, [L])

    // 1. roda
    await run079()
    const [cols] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c, IS_NULLABLE n, COLUMN_TYPE t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME IN ('transition_ended_at','transition_ended_by','transition_end_reason') ORDER BY ORDINAL_POSITION`, [PROBE])
    check('1. transition_ended_at, transition_ended_by INT NULL, transition_end_reason VARCHAR(255) NULL — nessa ordem',
      JSON.stringify((cols as any[]).map(r => [r.c, r.n, r.t])) === JSON.stringify([['transition_ended_at', 'YES', 'datetime'], ['transition_ended_by', 'YES', 'int(11)'], ['transition_end_reason', 'YES', 'varchar(255)']]), cols)
    check('1. os dois CHECKs e a FK existem pelo NOME', JSON.stringify(await counts()) === JSON.stringify({ cols: 2, cks: 2, fks: 1 }), await counts())
    const [[fk]] = await conn.query<any[]>(`SELECT REFERENCED_TABLE_NAME t FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE constraint_schema = ? AND constraint_name = 'fk_institution_transition_ended_by'`, [PROBE]) as any
    check('1. a FK aponta para tb_user', fk?.t === 'tb_user', fk)
    const [facts] = await conn.query<any[]>(`SELECT id, transition_ended_by b, transition_end_reason r FROM \`${PROBE}\`.tb_institution ORDER BY id`)
    check('1. sem backfill: autor e motivo NULL em todas', (facts as any[]).every(r => r.b === null && r.r === null), facts)

    // 2. re-run
    let rerun = 'ok'
    try { await run079() } catch (e: any) { rerun = e.message }
    check('2. re-execução (runner por schema): nenhum erro, nada duplica', rerun === 'ok' && JSON.stringify(await counts()) === JSON.stringify({ cols: 2, cks: 2, fks: 1 }), { rerun, c: await counts() })
    const [[g]] = await conn.query<any[]>(`SELECT @ddl d`) as any
    check('2. a guarda resolveu para SELECT 1 (zero ALTER no re-run)', g.d === 'SELECT 1', g.d)

    // 3. o motor aplica
    const upd = `UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'W', transition_ended_at = ?, transition_ended_by = ?, transition_end_reason = ? WHERE id = ?`
    const D = '2026-11-20 10:00:00', R = 'cliente migrou para a web'
    const partial: Array<[string, unknown, unknown, unknown]> = [
      ['só data', D, null, null], ['só autor', null, U, null], ['só motivo', null, null, R],
      ['data + autor', D, U, null], ['data + motivo', D, null, R], ['autor + motivo', null, U, R],
    ]
    for (const [label, d, u, r] of partial) {
      check(`3. ${label} → recusado por ck_institution_transition_author`, (await refusedBy(upd, [d, u, r, W])) === '4025:ck_institution_transition_author')
    }
    check("3. motivo só branco ('   ') → recusado por ck_institution_transition_reason", (await refusedBy(upd, [D, U, '   ', W])) === '4025:ck_institution_transition_reason')
    check('3. autor inexistente → recusado pela FK (1452)', (await refusedBy(upd, [D, 999999999, R, W])) === '1452:FK')
    check("3. L com os três → recusado por ck_institution_transition_ended (072)",
      (await refusedBy(`UPDATE \`${PROBE}\`.tb_institution SET transition_ended_at = ?, transition_ended_by = ?, transition_end_reason = ? WHERE id = ?`, [D, U, R, L])) === '4025:ck_institution_transition_ended')
    check('3. os três juntos em W → aceito', (await refusedBy(upd, [D, U, R, W])) === 'ACEITOU')
    check('3. os três juntos em P → aceito',
      (await refusedBy(`UPDATE \`${PROBE}\`.tb_institution SET transition_ended_at = ?, transition_ended_by = ?, transition_end_reason = ? WHERE id = ?`, [D, U, R, P])) === 'ACEITOU')
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET transition_ended_at = NULL, transition_ended_by = NULL, transition_end_reason = NULL WHERE id IN (?, ?)`, [W, P])
    const act = `UPDATE \`${PROBE}\`.tb_institution SET source_kind = ?, transition_ended_at = NOW(), transition_ended_by = ?, transition_end_reason = ?, updated_at = NOW()
                  WHERE id = ? AND source_kind = 'L' AND transition_ended_at IS NULL`
    const [a1] = await conn.query<any>(act, ['W', U, R, L])
    check('3. o ato de quatro campos (condição no comando) passa uma vez', Number(a1.affectedRows) === 1, a1.affectedRows)
    const [[l]] = await conn.query<any[]>(`SELECT source_kind k, transition_ended_at e, transition_ended_by b, transition_end_reason r FROM \`${PROBE}\`.tb_institution WHERE id = ?`, [L]) as any
    check('3. L virou W com data, autor e motivo', l.k === 'W' && l.e !== null && Number(l.b) === U && l.r === R, l)
    const [a2] = await conn.query<any>(act, ['W', U, 'outro motivo', L])
    check('3. repetir o ato afeta 0 linhas (write-once)', Number(a2.affectedRows) === 0, a2.affectedRows)
    // o SELECT do GET /:id (institutions.repository.ts getInstitution) TAL COMO ESTÁ, contra o motor — o nome do autor (D-PR57)
    const repoSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'institutions', 'institutions.repository.ts'), 'utf8')
    const getSql = /`(SELECT i\.schema_name AS schemaName[\s\S]*?WHERE i\.id = \? AND i\.deleted = 'N')`/.exec(repoSrc)?.[1]
    check('3. o SELECT do GET /:id foi achado no repositório', !!getSql)
    await conn.query(`UPDATE \`${PROBE}\`.tb_entity SET nick_trade = 'AUTOR DA PROVA' WHERE id = ?`, [U]).catch(() => undefined)
    const [[g1]] = await conn.query<any[]>(getSql!.replace(/setes_central/g, PROBE), [L]) as any
    const [[g0]] = await conn.query<any[]>(getSql!.replace(/setes_central/g, PROBE), [W]) as any
    check('3. GET: o autor, o NOME dele e o motivo; sem ato, tudo nulo',
      Number(g1.transitionEndedBy) === U && g1.transitionEndedByName === 'AUTOR DA PROVA' && g1.transitionEndReason === R
      && g0.transitionEndedBy === null && g0.transitionEndedByName === null && g0.transitionEndReason === null, { g1, g0 })

    // 4. estado parcial → a 079 não repara nem falha; a peça segue faltando (o boot a recusa pelo nome)
    await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution DROP CONSTRAINT ck_institution_transition_reason`)
    let partialErr = 'ok'
    try { await run079() } catch (e: any) { partialErr = e.message }
    check('4. estado parcial (falta um CHECK): a 079 roda sem erro e sem ALTER (não quebra onboarding)', partialErr === 'ok', partialErr)
    check('4. … e NÃO repara: a peça segue faltando — quem recusa é o boot, pelo nome', JSON.stringify(await counts()) === JSON.stringify({ cols: 2, cks: 1, fks: 1 }), await counts())
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA 079: TUDO OK' : '\nPROVA 079: FALHOU')
  process.exit(ok ? 0 : 1)
}

main().catch(err => { console.error('[prove-079] FALHA:', err); process.exit(1) })
