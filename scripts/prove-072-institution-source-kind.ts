/**
 * PROVA da migration 072 (`tb_institution.source_kind` + `transition_ended_at` — cadastro de produtos, Rodada 7: D-PR47/D-PR48, parecer
 * do guardião 2026-10-20) em SCHEMA DESCARTÁVEL, com CÓPIAS das tabelas da central (`CREATE TABLE … LIKE` da `setes_central` REAL — a
 * DDL de hoje, ainda SEM as colunas) e a migration TAL COMO ESTÁ com `setes_central` trocado pelo schema de prova:
 *  1. roda: colunas nascem, backfill (chave VIVA — ativa ou pausada — = 'L', demais 'W'), NOT NULL sem DEFAULT, os dois CHECKs pelo NOME;
 *  2. roda DE NOVO (o runner executa por schema de cliente): idempotente — nada muda, nenhum erro;
 *  3. o motor APLICA os CHECKs (PADROES §11 regra 11): 'X', a minúscula 'l', o '' que o modo não estrito grava quando a coluna falta
 *     no INSERT, e "L com data" — cada um recusado pela constraint ESPERADA (o nome na mensagem); 'W'/'P' com data passam;
 *  4. ordem FK × CHECK para a sonda do boot (INSERT com id sem entity): o que o motor acusa primeiro — registrado (a sonda do boot é
 *     UPDATE da linha real por isso);
 *  5. a 073 (categorias padrão) TAL COMO ESTÁ sobre a cópia: cria só para W/P, nada para L; idempotente.
 * Apaga o schema de prova no fim (inclusive em falha). NUNCA escreve em `setes_central` nem em schema de cliente.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-072-institution-source-kind.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_sk_probe_${process.pid}`
const M072 = path.join(__dirname, '..', 'src', 'migrations', 'sql', '072_institution_source_kind.sql')
const M073 = path.join(__dirname, '..', 'src', 'migrations', 'sql', '073_default_categories.sql')
const A = 900101, B = 900102, C = 900103, D = 900104   // A = chave ativa (L) · B = sem chave (W) · C = chave PAUSADA (L — ADV-R7-06) · D = chave excluída (W)

async function main() {
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}${cond || got === undefined ? '' : `  (obtido: ${JSON.stringify(got)})`}`)
    ok &&= cond
  }
  const refusedBy = async (sql: string, params: unknown[]): Promise<string> => {
    try { await conn.query(sql, params); return 'ACEITOU' } catch (e: any) { return `${e.errno}:${/CONSTRAINT `?(\w+)`?/.exec(e.message)?.[1] ?? e.message.slice(0, 60)}` }
  }
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_entity LIKE setes_central.tb_entity`)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_institution LIKE setes_central.tb_institution`)      // LIKE não copia FK
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_sync_api_key LIKE setes_central.tb_sync_api_key`)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_category LIKE setes_setes.tb_category`)
    const [uq] = await conn.query<any[]>(
      `SELECT DISTINCT index_name AS n FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = 'tb_institution' AND column_name = 'schema_name' AND non_unique = 0`, [PROBE])
    for (const u of uq as any[]) await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution DROP INDEX \`${u.n}\``)
    const [cols0] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME IN ('source_kind','transition_ended_at')`, [PROBE])
    check('a cópia da central de HOJE ainda não tem as colunas (a migration é quem cria)', (cols0 as any[]).length === 0, cols0)

    for (const [id, schema] of [[A, 'setes_a'], [B, 'setes_b'], [C, 'setes_c'], [D, 'setes_d']] as const) {
      await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (id) VALUES (?)`, [id]).catch(async () => {
        // tb_entity exige colunas NOT NULL além do id? então insere com o mínimo que o DDL real pedir
        const [need] = await conn.query<any[]>(`SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_entity' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL AND COLUMN_NAME <> 'id'`, [PROBE])
        const cols = ['id', ...(need as any[]).map(r => r.c)]
        const vals = [id, ...(need as any[]).map(r => /int|decimal/.test(r.t) ? 0 : (/date|time/.test(r.t) ? '2026-01-01' : 'x'))]
        await conn.query(`INSERT INTO \`${PROBE}\`.tb_entity (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
      })
      await conn.query(`INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, active, created_at, updated_at, deleted) VALUES (?, ?, 'S', NOW(), NOW(), 'N')`, [id, schema])
    }
    await conn.query(`INSERT INTO \`${PROBE}\`.tb_sync_api_key (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at, deleted) VALUES
      (1, 'a', ?, 'SETES_A', 'S', NOW(), NOW(), 'N'), (2, 'c', ?, 'SETES_C', 'N', NOW(), NOW(), 'N'), (3, 'd', ?, 'SETES_D', 'S', NOW(), NOW(), 'S')`, [A, C, D])

    const statements = splitStatements(fs.readFileSync(M072, 'utf8')).map(s => s.replace(/setes_central/g, PROBE))
    check('072 tem 21 statements (4 blocos SET/SET/PREPARE/EXECUTE/DEALLOCATE — 2 ADD COLUMN, MODIFY NOT NULL, CHECKs — + o UPDATE do backfill)', statements.length === 21, statements.length)

    const run = async () => { for (const st of statements) await conn.query(st) }
    await run()
    const [cols] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c, IS_NULLABLE n, COLUMN_DEFAULT d, COLUMN_TYPE t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME IN ('source_kind','transition_ended_at') ORDER BY ORDINAL_POSITION`, [PROBE])
    // MariaDB 10.4: COLUMN_DEFAULT da coluna nullable com DEFAULT NULL vem como a STRING 'NULL' (sem default = null) — conhecimento negativo
    const noDefault = (d: unknown) => d === null || d === 'NULL'
    check('1. source_kind CHAR(1) NOT NULL sem DEFAULT; transition_ended_at DATETIME NULL — logo depois de schema_name',
      JSON.stringify((cols as any[]).map(r => [r.c, r.n, noDefault(r.d), r.t])) === JSON.stringify([['source_kind', 'NO', true, 'char(1)'], ['transition_ended_at', 'YES', true, 'datetime']])
      && (cols as any[])[0].d === null, cols)
    const [facts] = await conn.query<any[]>(`SELECT id, source_kind k, transition_ended_at e FROM \`${PROBE}\`.tb_institution ORDER BY id`)
    check('1. backfill: chave ativa = L e chave PAUSADA = L (a pausa não muda o dono — ADV-R7-06); sem chave e chave excluída = W; data NULL em todas',
      JSON.stringify((facts as any[]).map(r => [r.id, r.k, r.e])) === JSON.stringify([[A, 'L', null], [B, 'W', null], [C, 'L', null], [D, 'W', null]]), facts)
    const [cks] = await conn.query<any[]>(`SELECT CONSTRAINT_NAME n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_institution' ORDER BY 1`, [PROBE])
    check('1. os dois CHECKs existem pelo NOME', JSON.stringify((cks as any[]).map(r => r.n)) === JSON.stringify(['ck_institution_source_kind', 'ck_institution_transition_ended']), cks)

    await conn.query(`UPDATE \`${PROBE}\`.tb_sync_api_key SET active = 'N' WHERE id = 1`)      // a pausa NÃO muda o fato (D-PR48)
    await run()
    const [facts2] = await conn.query<any[]>(`SELECT id, source_kind k FROM \`${PROBE}\`.tb_institution ORDER BY id`)
    check('2. re-execução (runner por schema): nenhum erro, backfill não reescreve (A segue L com a chave pausada), CHECKs não duplicam',
      JSON.stringify((facts2 as any[]).map(r => r.k)) === JSON.stringify(['L', 'W', 'L', 'W']), facts2)
    // zero ALTER no re-run: com a coluna NOT NULL e os 2 CHECKs presentes, os 4 blocos guardados resolvem para 'SELECT 1'
    const [[v1]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'tb_institution' AND column_name = 'source_kind' AND is_nullable = 'YES'`, [PROBE]) as any
    const [[v2]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.CHECK_CONSTRAINTS WHERE constraint_schema = ? AND table_name = 'tb_institution' AND constraint_name IN ('ck_institution_source_kind', 'ck_institution_transition_ended')`, [PROBE]) as any
    check('2. as guardas do MODIFY e dos CHECKs resolvem para "nada a fazer" (zero ALTER no re-run — gate socrático R7)', Number(v1.n) === 0 && Number(v2.n) === 2, { v1, v2 })
    const [cks2] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_institution'`, [PROBE])
    check('2. ainda 2 CHECKs', Number((cks2 as any[])[0].n) === 2, cks2)

    const upd = `UPDATE \`${PROBE}\`.tb_institution SET source_kind = ? WHERE id = ?`
    check("3. 'X' recusado por ck_institution_source_kind", (await refusedBy(upd, ['X', B])) === '4025:ck_institution_source_kind')
    check("3. a minúscula 'l' recusada por ck_institution_source_kind (CHECK binário)", (await refusedBy(upd, ['l', B])) === '4025:ck_institution_source_kind')
    check("3. 'p' minúscula recusada", (await refusedBy(upd, ['p', B])) === '4025:ck_institution_source_kind')
    check("3. 'L' com data recusado por ck_institution_transition_ended", (await refusedBy(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'L', transition_ended_at = NOW() WHERE id = ?`, [A])) === '4025:ck_institution_transition_ended')
    check("3. o ato L → W com data passa", (await refusedBy(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'W', transition_ended_at = NOW() WHERE id = ? AND source_kind = 'L' AND transition_ended_at IS NULL`, [A])) === 'ACEITOU')
    const [[a]] = await conn.query<any[]>(`SELECT source_kind k, transition_ended_at e FROM \`${PROBE}\`.tb_institution WHERE id = ?`, [A]) as any
    check('3. A virou W com a data', a.k === 'W' && a.e !== null, a)
    check("3. repetir o ato (condição no comando) afeta 0 linhas",
      Number(((await conn.query<any>(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'P', transition_ended_at = NOW() WHERE id = ? AND source_kind = 'L' AND transition_ended_at IS NULL`, [A]))[0]).affectedRows) === 0)
    check("3. INSERT sem source_kind: o modo não estrito gravaria '' — o CHECK recusa (fato declarado por construção)",
      (await refusedBy(`INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, active, created_at, updated_at, deleted) VALUES (?, 'setes_e', 'S', NOW(), NOW(), 'N')`, [900105])) === '4025:ck_institution_source_kind')
    const [[sqlMode]] = await conn.query<any[]>(`SELECT @@sql_mode m`) as any
    console.log(`     (sql_mode da sessão: ${sqlMode.m})`)

    // 4. FK × CHECK — para a sonda do boot (que por isso é UPDATE da linha real, não INSERT)
    await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution ADD CONSTRAINT fk_probe_entity FOREIGN KEY (id) REFERENCES \`${PROBE}\`.tb_entity (id)`)
    const order = await refusedBy(`INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, source_kind, active, created_at, updated_at, deleted) VALUES (-1, 'setes_probe', 'X', 'S', NOW(), NOW(), 'N')`, [])
    console.log(`     4. INSERT com id sem entity E source_kind inválido → o motor acusa primeiro: ${order}`)
    check('4. registrado: a sonda do boot NÃO pode depender de INSERT (CHECK ou FK primeiro é detalhe do motor) — por isso é UPDATE da linha real, desfeito', true)

    // 5. a 073 sobre a cópia: só W/P ganham categorias
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'L', transition_ended_at = NULL WHERE id = ?`, [A])   // A volta a L só para a prova da 073
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET source_kind = 'P' WHERE id = ?`, [C])   // C vira P só para a prova da 073
    const st073 = splitStatements(fs.readFileSync(M073, 'utf8')).map(s => s.replace(/setes_central/g, PROBE))
    await conn.query(`USE \`${PROBE}\``)
    // a 073 filtra `i.schema_name = DATABASE()` — na prova, todos apontam para o próprio schema de prova
    await conn.query(`UPDATE \`${PROBE}\`.tb_institution SET schema_name = ? WHERE id IN (?, ?, ?, ?)`, [PROBE, A, B, C, D]).catch(() => undefined)
    for (const st of st073) await conn.query(st)
    for (const st of st073) await conn.query(st)   // idempotente
    const [cats] = await conn.query<any[]>(`SELECT tb_institution_id i, kind k, COUNT(*) n FROM \`${PROBE}\`.tb_category GROUP BY 1, 2 ORDER BY 1, 2`)
    check('5. 073: nada para L (A); "Produtos" e "Serviços" para W (B, D) e P (C); duas passadas não duplicam',
      JSON.stringify((cats as any[]).map(r => [r.i, r.k, Number(r.n)])) === JSON.stringify([[B, 'P', 1], [B, 'S', 1], [C, 'P', 1], [C, 'S', 1], [D, 'P', 1], [D, 'S', 1]]), cats)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA 072/073: TUDO OK' : '\nPROVA 072/073: FALHOU')
  process.exit(ok ? 0 : 1)
}

main().catch(err => { console.error('[prove-072] FALHA:', err); process.exit(1) })
