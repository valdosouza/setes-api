/**
 * PROVA da migration 080 (fabricante da mercadoria, `tb_merchandise_factory` — D-PR65, passo setes-api:PROD.E9.P1) em SCHEMA DESCARTÁVEL,
 * com CÓPIA da estrutura de `tb_merchandise` de um schema de cliente REAL (`CREATE TABLE … LIKE` — só leitura do real; LIKE não copia FK
 * nem dados) e a migration 080 TAL COMO ESTÁ, rodada com `USE` no schema de prova (como o runner faz por schema):
 *  1. a 080 roda: a tabela nasce com as colunas (tipos e nulos), a PK (institution, mercadoria), o índice, a FK para `tb_merchandise` e
 *     os dois CHECKs pelo NOME;
 *  2. a 080 roda DE NOVO (o runner executa por schema): nenhum erro, nada duplica;
 *  3. o motor APLICA (PADROES §11 regra 11): aceita CNPJ numérico e alfanumérico canônicos; recusa 13 posições, minúscula, máscara,
 *     letra nas duas últimas posições e espaço no meio (ck_mf_cnpj_form, errno 4025); recusa CNPJ NULL (1048); recusa `deleted` fora de
 *     N/S (ck_mf_deleted); recusa mercadoria inexistente e mercadoria de OUTRA institution (FK, 1452); recusa a 2ª linha da mesma
 *     mercadoria (PK, 1062); o upsert pela PK troca o CNPJ e revive a linha morta com o CNPJ NOVO. LIMITE CONHECIDO: 15 posições é
 *     TRUNCADO para 14 pelo modo de sessão não estrito do servidor (como na 079) — o DTO recusa antes.
 * Apaga o schema de prova no fim (inclusive em falha). NUNCA escreve em schema real.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-080-merchandise-factory.ts [schema_fonte=setes_setes]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const PROBE = `setes_mf_probe_${process.pid}`
const SOURCE = process.argv[2] ?? 'setes_setes'
const M080 = path.join(__dirname, '..', 'src', 'migrations', 'sql', '080_merchandise_factory.sql')
const I1 = 1, I2 = 2, M1 = 900301, M2 = 900302, M3 = 900303   // institutions e mercadorias de prova
const NUM = '11222333000181', ALFA = '12ABC34501DE35'   // CNPJ numérico e alfanumérico (exemplo da NT Conjunta 2025.001)

async function main() {
  if (!/^[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema fonte inválido: ${SOURCE}`)
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}${cond || got === undefined ? '' : `  (obtido: ${JSON.stringify(got)})`}`)
    ok &&= cond
  }
  const outcome = async (sql: string, params: unknown[]): Promise<string> => {
    try { await conn.query(sql, params); return 'ACEITOU' } catch (e: any) {
      if (e.errno === 4025) return `4025:${/CONSTRAINT `?(\w+)`?/.exec(e.message)?.[1] ?? '?'}`
      return String(e.errno)
    }
  }
  const insertMerchandise = async (id: number, inst: number) => {
    const [need] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
          AND COLUMN_NAME NOT IN ('id', 'tb_institution_id') AND EXTRA NOT LIKE '%GENERATED%'`, [PROBE])
    const cols = ['id', 'tb_institution_id', ...(need as any[]).map(r => r.c)]
    const vals = [id, inst, ...(need as any[]).map(r => /int|decimal/.test(r.t) ? 1 : (/date|time/.test(r.t) ? '2026-01-01' : 'x'))]
    await conn.query(`INSERT INTO tb_merchandise (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
  }
  try {
    // Órfãos de uma rodada morta antes do finally (Ctrl+C/SIGKILL — gate adversarial LOW-8): só o prefixo desta prova, nunca outro schema.
    const [orphans] = await conn.query<any[]>(`SELECT SCHEMA_NAME n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'setes\\_mf\\_probe\\_%'`)
    for (const o of orphans as any[]) {
      if (!/^setes_mf_probe_\d+$/.test(o.n)) continue
      await conn.query(`DROP DATABASE \`${o.n}\``)
      console.log(`limpo: schema de prova órfão ${o.n}`)
    }
    console.log(`schema de prova: ${PROBE} (apagado no fim)`)
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_merchandise LIKE \`${SOURCE}\`.tb_merchandise`)
    await conn.query(`USE \`${PROBE}\``)
    const [[pre]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory'`, [SOURCE]) as any
    check(`pré-condição: o schema fonte (${SOURCE}) ainda não tem a tb_merchandise_factory (só leitura)`, Number(pre.n) === 0, pre.n)
    await insertMerchandise(M1, I1)
    await insertMerchandise(M2, I1)
    await insertMerchandise(M3, I1)

    const st080 = splitStatements(fs.readFileSync(M080, 'utf8'))
    check('080 tem 1 statement (CREATE TABLE IF NOT EXISTS com as constraints no CREATE)', st080.length === 1, st080.length)
    const run080 = async () => { for (const st of st080) await conn.query(st) }

    // 1. roda
    await run080()
    const [cols] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c, COLUMN_TYPE t, IS_NULLABLE n, COLUMN_DEFAULT d FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory' ORDER BY ORDINAL_POSITION`, [PROBE])
    check('1. colunas: tb_institution_id INT NN, tb_merchandise_id INT NN, cnpj CHAR(14) NN, created_at, updated_at, deleted CHAR(1) NN',
      JSON.stringify((cols as any[]).map(r => [r.c, r.t, r.n])) === JSON.stringify([
        ['tb_institution_id', 'int(11)', 'NO'], ['tb_merchandise_id', 'int(11)', 'NO'], ['cnpj', 'char(14)', 'NO'],
        ['created_at', 'datetime', 'YES'], ['updated_at', 'datetime', 'YES'], ['deleted', 'char(1)', 'NO']]), cols)
    const [pk] = await conn.query<any[]>(
      `SELECT COLUMN_NAME c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory'
          AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`, [PROBE])
    check('1. PK = (tb_institution_id, tb_merchandise_id)', JSON.stringify((pk as any[]).map(r => r.c)) === JSON.stringify(['tb_institution_id', 'tb_merchandise_id']), pk)
    const [[ix]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory' AND INDEX_NAME = 'idx_mf_merchandise'`, [PROBE]) as any
    check('1. índice idx_mf_merchandise existe', Number(ix.n) === 2, ix.n)
    const [[fk]] = await conn.query<any[]>(`SELECT REFERENCED_TABLE_NAME t FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = 'fk_mf_merchandise'`, [PROBE]) as any
    check('1. a FK fk_mf_merchandise aponta para tb_merchandise', fk?.t === 'tb_merchandise', fk)
    const [cks] = await conn.query<any[]>(`SELECT CONSTRAINT_NAME n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory' ORDER BY 1`, [PROBE])
    check('1. os CHECKs ck_mf_cnpj_form e ck_mf_deleted existem pelo NOME', JSON.stringify((cks as any[]).map(r => r.n)) === JSON.stringify(['ck_mf_cnpj_form', 'ck_mf_deleted']), cks)

    // 2. re-run
    let rerun = 'ok'
    try { await run080() } catch (e: any) { rerun = e.message }
    const [[nck]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_merchandise_factory'`, [PROBE]) as any
    check('2. re-execução (runner por schema): nenhum erro, nada duplica', rerun === 'ok' && Number(nck.n) === 2, { rerun, n: nck.n })

    // 3. o motor aplica
    const ins = `INSERT INTO tb_merchandise_factory (tb_institution_id, tb_merchandise_id, cnpj, created_at, updated_at, deleted) VALUES (?, ?, ?, NOW(), NOW(), ?)`
    const refuse: Array<[string, string]> = [
      ['13 posições', '1122233300018'], ['minúscula', '12abc34501de35'],
      ['máscara', '11.222.333/0001-81'.slice(0, 14)], ['letra nas duas últimas', '12ABC34501DEAB'], ['espaço no meio', '1122233 000181'],
      ['vazio', ''],
    ]
    for (const [label, v] of refuse) check(`3. CNPJ ${label} → recusado por ck_mf_cnpj_form`, (await outcome(ins, [I1, M1, v, 'N'])) === '4025:ck_mf_cnpj_form')
    // LIMITE CONHECIDO (o mesmo da 079): o modo de sessão do servidor NÃO é estrito — texto acima de 14 é TRUNCADO antes do CHECK
    // (aviso 1265, não erro). Quem recusa o 15º caractere é o DTO (isValidCnpj exige exatamente a forma canônica), antes do banco.
    const long = await outcome(ins, [I1, M3, '112223330001810', 'N'])
    const [[t]] = await conn.query<any[]>(`SELECT cnpj FROM tb_merchandise_factory WHERE tb_institution_id = ? AND tb_merchandise_id = ?`, [I1, M3]) as any
    check('3. CNPJ de 15 posições: recusado OU truncado para 14 pelo modo de sessão (limite conhecido — o DTO recusa antes)',
      long !== 'ACEITOU' || t?.cnpj === '11222333000181', { long, t })
    check('3. CNPJ NULL → recusado (1048)', (await outcome(ins, [I1, M1, null, 'N'])) === '1048')
    check("3. deleted = 'X' → recusado por ck_mf_deleted", (await outcome(ins, [I1, M1, NUM, 'X'])) === '4025:ck_mf_deleted')
    check('3. mercadoria inexistente → recusado pela FK (1452)', (await outcome(ins, [I1, 999999999, NUM, 'N'])) === '1452')
    check('3. mercadoria de OUTRA institution → recusado pela FK (1452)', (await outcome(ins, [I2, M1, NUM, 'N'])) === '1452')
    check('3. CNPJ numérico canônico → aceito', (await outcome(ins, [I1, M1, NUM, 'N'])) === 'ACEITOU')
    check('3. CNPJ alfanumérico canônico → aceito (D-PR64)', (await outcome(ins, [I1, M2, ALFA, 'N'])) === 'ACEITOU')
    check('3. 2ª linha da mesma mercadoria → recusada pela PK (1062)', (await outcome(ins, [I1, M1, ALFA, 'N'])) === '1062')
    const upsert = `INSERT INTO tb_merchandise_factory (tb_institution_id, tb_merchandise_id, cnpj, created_at, updated_at, deleted)
                    VALUES (?, ?, ?, NOW(), NOW(), 'N')
                    ON DUPLICATE KEY UPDATE cnpj = VALUES(cnpj), deleted = 'N', updated_at = NOW()`
    await conn.query(upsert, [I1, M1, ALFA])
    const [[r1]] = await conn.query<any[]>(`SELECT cnpj, deleted FROM tb_merchandise_factory WHERE tb_institution_id = ? AND tb_merchandise_id = ?`, [I1, M1]) as any
    check('3. upsert pela PK troca o CNPJ na mesma linha', r1.cnpj === ALFA && r1.deleted === 'N', r1)
    await conn.query(`UPDATE tb_merchandise_factory SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND deleted = 'N'`, [I1, M1])
    await conn.query(upsert, [I1, M1, NUM])
    const [[r2]] = await conn.query<any[]>(`SELECT cnpj, deleted FROM tb_merchandise_factory WHERE tb_institution_id = ? AND tb_merchandise_id = ?`, [I1, M1]) as any
    check('3. reviver a linha morta grava o CNPJ NOVO (nunca herda o velho)', r2.cnpj === NUM && r2.deleted === 'N', r2)
    const [[cnt]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM tb_merchandise_factory`) as any
    check('3. nenhuma linha extra nasceu (3 mercadorias com no máximo 1 linha cada)', Number(cnt.n) <= 3, cnt.n)
  } finally {
    try { await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``) } catch (e: any) { console.log(`FALHA ao apagar ${PROBE}: ${e.message}`); ok = false }
    const [[gone]] = await conn.query<any[]>(`SELECT COUNT(*) n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [PROBE]) as any
    check(`fim: schema de prova ${PROBE} apagado`, Number(gone.n) === 0, gone.n)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA 080: TUDO OK' : '\nPROVA 080: FALHOU')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
