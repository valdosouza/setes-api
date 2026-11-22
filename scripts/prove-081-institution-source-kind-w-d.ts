/**
 * PROVA da migration 081 (origem dos cadastros só W e D — D-OI10, D-PR70/D-PR75, passo setes-api:PROD.E10.P1) em SCHEMA DESCARTÁVEL,
 * com CÓPIAS das tabelas da central (`CREATE TABLE … LIKE` da `setes_central` REAL — LIKE não copia FK) e as migrations 072, 079 e 081
 * TAL COMO ESTÃO, com `setes_central` trocado pelo schema de prova:
 *  1. 072 (domínio antigo) → linhas W, L (com chave viva — backfill da 072) e P → 079 → 081: L virou D, P virou W, W ficou W;
 *  2. os CHECKs existem pelo NOME com o domínio novo (e o do autor refeito — D-PR75); `source_kind` segue NOT NULL, sem DEFAULT, com a MESMA colação; os COMMENTs
 *     falam de W/D;
 *  3. o motor APLICA (PADROES §11 regra 11): 'L', 'P', 'X' e 'd' (minúscula de válido) recusados por `ck_institution_source_kind`;
 *     "D com data" (com autor e motivo, para isolar) recusado por `ck_institution_transition_ended`; "W com data, autor e motivo" aceito;
 *     "W com data e autor, SEM motivo" aceito (D-PR75) e as formas parciais recusadas pelo `ck_institution_transition_author`; a troca
 *     D → W com a condição no comando passa uma vez e a repetição afeta 0 linhas;
 *  4. re-execução (o runner roda a central POR SCHEMA de cliente): nenhum erro e nenhum ALTER (as duas guardas resolvem para SELECT 1);
 *  5. estado parcial (execução interrompida depois do DROP e antes do ADD — DDL não é transacional): a 081 de novo REPARA (os três
 *     CHECKs voltam com o domínio novo).
 * Apaga o schema de prova no fim (inclusive em falha). NUNCA escreve em `setes_central` nem em schema de cliente.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-081-institution-source-kind-w-d.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_wd_probe_${process.pid}`
const SQL = (f: string) => path.join(__dirname, '..', 'src', 'migrations', 'sql', f)
const M072 = SQL('072_institution_source_kind.sql')
const M079 = SQL('079_institution_transition_author.sql')
const M081 = SQL('081_institution_source_kind_w_d.sql')
const W = 900301, L = 900302, P = 900303, U = 900390   // institutions de prova (W nativo, L com chave viva, P declarada) · U = autor

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
  const run = async (file: string) => { for (const st of sqlOf(file)) await conn.query(st) }
  const insertEntity = async (id: number) => {
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (id) VALUES (?)`, [id]).catch(async () => {
      const [need] = await conn.query<any[]>(`SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_entity' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL AND COLUMN_NAME <> 'id'`, [PROBE])
      const cols = ['id', ...(need as any[]).map(r => r.c)]
      const vals = [id, ...(need as any[]).map(r => /int|decimal/.test(r.t) ? 0 : (/date|time/.test(r.t) ? '2026-01-01' : 'x'))]
      await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
    })
  }
  const checks = async (): Promise<Record<string, string>> => {
    const [rows] = await conn.query<any[]>(
      `SELECT CONSTRAINT_NAME n, CHECK_CLAUSE c FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_institution'
          AND CONSTRAINT_NAME IN ('ck_institution_source_kind', 'ck_institution_transition_ended', 'ck_institution_transition_author')`, [PROBE])
    return Object.fromEntries((rows as any[]).map(r => [r.n, String(r.c)]))
  }
  const column = async () => {
    const [[c]] = await conn.query<any[]>(
      `SELECT IS_NULLABLE n, COLUMN_DEFAULT d, COLLATION_NAME k, COLUMN_TYPE t, COLUMN_COMMENT m FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME = 'source_kind'`, [PROBE]) as any
    return c
  }
  const newAuthor = (ck: Record<string, string>) =>
    !!ck.ck_institution_transition_author && !/transition_end_reason`\s+IS NOT NULL/i.test(ck.ck_institution_transition_author)
  const newDomain = (ck: Record<string, string>) =>
    !!ck.ck_institution_source_kind && !!ck.ck_institution_transition_ended
    && /'W'/.test(ck.ck_institution_source_kind) && /'D'/.test(ck.ck_institution_source_kind)
    && !/'L'|'P'/.test(ck.ck_institution_source_kind)
    && /'D'/.test(ck.ck_institution_transition_ended) && !/'L'/.test(ck.ck_institution_transition_ended)
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    for (const t of ['tb_entity', 'tb_user', 'tb_institution', 'tb_sync_api_key']) {
      await conn.query(`CREATE TABLE \`${PROBE}\`.${t} LIKE setes_central.${t}`)
    }
    const [cols0] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution'
          AND COLUMN_NAME IN ('source_kind','transition_ended_at','transition_ended_by','transition_end_reason')`, [PROBE])
    if ((cols0 as any[]).length > 0) {
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
    await run(M072)
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'P' WHERE id = ?`, [P])   // P não nasce do backfill da 072
    // P com chave viva (era a dos PDVs): vira W mantendo a chave ativa — a prova CONTA o caso (gate socrático L6)
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_sync_api_key (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at, deleted) VALUES (2, 'p', ?, 'SETES_P', 'S', NOW(), NOW(), 'N')`, [P])
    await run(M079)
    const [before] = await conn.query<any[]>(`SELECT id, source_kind k FROM \`${PROBE}\`.tb_institution ORDER BY id`)
    check('pré: depois da 072/079 as linhas são W, L e P', JSON.stringify((before as any[]).map(r => r.k)) === '["W","L","P"]', before)
    const col0 = await column()
    await insertEntity(900398)
    const pre = await refusedBy(`INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, source_kind, transition_ended_at, transition_ended_by, transition_end_reason, active, created_at, updated_at, deleted)
       VALUES (900398, 'setes_y', 'W', NOW(), ?, NULL, 'N', NOW(), NOW(), 'S')`, [U])
    check('pré: com o CHECK da 079, "W com data e autor, SEM motivo" é recusado (é o que a 081 muda — D-PR75)', pre === '4025:ck_institution_transition_author', pre)

    // 1. a 081 converte
    await run(M081)
    const [after] = await conn.query<any[]>(`SELECT id, source_kind k FROM \`${PROBE}\`.tb_institution ORDER BY id`)
    check('1. a 081 converte: W→W, L→D, P→W', JSON.stringify((after as any[]).map(r => r.k)) === '["W","D","W"]', after)
    const [[wk]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM \`${PROBE}\`.tb_institution i JOIN \`${PROBE}\`.tb_sync_api_key k ON k.tb_institution_id = i.id AND k.deleted = 'N' AND k.active = 'S' WHERE i.source_kind = 'W'`) as any
    check('1. limite conhecido: a P que tinha chave viva vira W com a chave ATIVA (conferir na janela PROD.E7.P2 — esperado 0 nos schemas reais)', Number(wk.n) === 1, wk)

    // 2. forma
    const ck1 = await checks()
    check('2. os CHECKs existem pelo NOME com o domínio novo (W/D; nada de L/P) e o do autor sem exigir motivo (D-PR75)', newDomain(ck1) && newAuthor(ck1), ck1)
    const col1 = await column()
    check('2. source_kind segue char(1) NOT NULL sem DEFAULT, com a MESMA colação de antes',
      col1.t === 'char(1)' && col1.n === 'NO' && (col1.d === null || col1.d === 'NULL') && col1.k === col0.k, { col0, col1 })
    check('2. o COMMENT de source_kind fala de W/D (D-OI10)', /D-OI10/.test(col1.m) && !/\bP PDV\b/.test(col1.m), col1.m)

    // 3. o motor aplica
    const ins = (kind: string, ended: 'NULL' | 'NOW()', author: number | null, reason: string | null) => refusedBy(
      `INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, source_kind, transition_ended_at, transition_ended_by, transition_end_reason, active, created_at, updated_at, deleted)
       VALUES (900399, 'setes_x', ?, ${ended}, ?, ?, 'N', NOW(), NOW(), 'S')`, [kind, author, reason])
    for (const k of ['L', 'P', 'X', 'd']) {
      check(`3. '${k}' recusado por ck_institution_source_kind`, (await ins(k, 'NULL', null, null)) === '4025:ck_institution_source_kind')
    }
    check('3. "D com data" (com autor e motivo) recusado por ck_institution_transition_ended',
      (await ins('D', 'NOW()', U, 'motivo da prova')) === '4025:ck_institution_transition_ended')
    await insertEntity(900399)
    check('3. "W com data, autor e motivo" aceito', (await ins('W', 'NOW()', U, 'motivo da prova')) === 'ACEITOU')
    await conn.query(`DELETE FROM \`${PROBE}\`.tb_institution WHERE id = 900399`)   // schema descartável — a linha é da prova
    // D-PR75: a troca D → W grava data e autor SEM motivo — o CHECK do autor refeito pela 081
    check('3. "W com data e autor, SEM motivo" aceito (D-PR75)', (await ins('W', 'NOW()', U, null)) === 'ACEITOU')
    await conn.query(`DELETE FROM \`${PROBE}\`.tb_institution WHERE id = 900399`)
    check('3. "W com data, sem autor" recusado por ck_institution_transition_author', (await ins('W', 'NOW()', null, null)) === '4025:ck_institution_transition_author')
    check('3. "W com data e motivo, sem autor" recusado por ck_institution_transition_author', (await ins('W', 'NOW()', null, 'motivo')) === '4025:ck_institution_transition_author')
    check('3. "W sem data, com autor" recusado por ck_institution_transition_author', (await ins('W', 'NULL', U, null)) === '4025:ck_institution_transition_author')
    check('3. "W sem data, com motivo" recusado por ck_institution_transition_author', (await ins('W', 'NULL', null, 'motivo')) === '4025:ck_institution_transition_author')
    check('3. motivo só branco recusado por ck_institution_transition_reason', (await ins('W', 'NOW()', U, '   ')) === '4025:ck_institution_transition_reason')
    // a troca D → W como o repositório a faz (D-PR73/D-PR75/D-PR76): quem e quando, sem motivo, condição no comando
    const act = `UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'W', transition_ended_at = NOW(), transition_ended_by = ?, updated_at = NOW()
                  WHERE id = ? AND source_kind = 'D' AND transition_ended_at IS NULL`
    const [a1] = await conn.query<any>(act, [U, L])
    check('3. a troca D → W (data e autor, condição no comando) passa uma vez', Number(a1.affectedRows) === 1, a1.affectedRows)
    const [a2] = await conn.query<any>(act, [U, L])
    check('3. repetir a troca afeta 0 linhas (write-once; W → D impossível)', Number(a2.affectedRows) === 0, a2.affectedRows)
    const [[lr]] = await conn.query<any[]>(`SELECT source_kind k, transition_ended_by b, transition_end_reason r FROM \`${PROBE}\`.tb_institution WHERE id = ?`, [L]) as any
    check('3. L virou D e depois W, com o autor e sem motivo', lr.k === 'W' && Number(lr.b) === U && lr.r === null, lr)
    const ck3 = await checks()

    // 4. re-run
    let rerun = 'ok'
    try { await run(M081) } catch (e: any) { rerun = e.message }
    const [[g]] = await conn.query<any[]>(`SELECT @old_domain o, @ck_count c, @author_old ao, @author_count ac, @ddl d, @to_convert t, @dml m`) as any
    check('4. re-execução (runner por schema): nenhum erro, nenhum ALTER e nenhum UPDATE (as guardas → SELECT 1)',
      rerun === 'ok' && Number(g.o) === 0 && Number(g.c) === 2 && Number(g.ao) === 0 && Number(g.ac) === 1 && g.d === 'SELECT 1'
      && Number(g.t) === 0 && g.m === 'SELECT 1', { rerun, g })
    check('4. … e nada mudou', JSON.stringify(await checks()) === JSON.stringify(ck3))

    // 5. estado parcial: os CHECKs derrubados (execução interrompida entre o DROP e o ADD) → a 081 repara
    await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution DROP CONSTRAINT ck_institution_source_kind, DROP CONSTRAINT ck_institution_transition_ended, DROP CONSTRAINT ck_institution_transition_author`)
    check('5. pré: sem os três CHECKs', Object.keys(await checks()).length === 0)
    await run(M081)
    const ck5 = await checks()
    check('5. a 081 repara: os três CHECKs voltam com o domínio novo', newDomain(ck5) && newAuthor(ck5), ck5)
    check('5. … e a colação de source_kind segue a mesma', (await column()).k === col0.k)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA 081: TUDO OK' : '\nPROVA 081: FALHOU')
  process.exit(ok ? 0 : 1)
}

main().catch(err => { console.error('[prove-081] FALHA:', err); process.exit(1) })
