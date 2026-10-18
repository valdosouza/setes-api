/**
 * PROVA do seed `sql/66_merchandise_interface_seed.sql` (cadastro de produtos, onda 1 — prompt_modulo_products.md §16.8) numa CÓPIA
 * descartável das tabelas centrais que ele toca, rodado DUAS vezes (idempotência): 1 interface com id MAX+1, privilégios V/I/A/E +
 * CATALOGAR (D-PR33), page_size, flag por institution, catálogo de campos, NENHUM contrato (D-PR14). O texto do seed tem `setes_central`
 * trocado pelo schema descartável — nada é gravado na central nem em schema de cliente. O repo `sql` é o IRMÃO deste (`../../sql`).
 * Uso: DOTENV_CONFIG_PATH=<.env> npx tsx --require dotenv/config --require tsconfig-paths/register scripts/prove-seed-66-merchandise.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '../src/shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
const P = `setes_seed66_probe_${process.pid}`
const TABLES = ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config', 'tb_feature_flag', 'tb_institution', 'tb_interface_has_field']
async function main() {
  const c = await pool.getConnection()
  let ok = true
  const check = (l: string, cond: boolean, got?: unknown) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${l}${cond ? '' : `  (obtido: ${JSON.stringify(got)})`}`); ok &&= cond }
  try {
    await c.query(`CREATE DATABASE \`${P}\``)
    for (const t of TABLES) {
      await c.query(`CREATE TABLE \`${P}\`.${t} LIKE setes_central.${t}`)
      await c.query(`INSERT INTO \`${P}\`.${t} SELECT * FROM setes_central.${t}`)
    }
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', '66_merchandise_interface_seed.sql'), 'utf8').replace(/setes_central/g, P)
    for (let pass = 1; pass <= 2; pass++) for (const st of splitStatements(sql)) await c.query(st)
    const q = async (s: string) => ((await c.query<any[]>(s))[0] as any[])
    const itf = await q(`SELECT id, group_default, kind, deleted FROM \`${P}\`.tb_interface WHERE i18n_key = 'merchandise'`)
    check('1 interface merchandise (kind T, Registers) depois de 2 execuções', itf.length === 1 && itf[0].kind === 'T' && itf[0].group_default === 'Registers', itf)
    const id = itf[0]?.id
    const [[mx]] = await c.query<any[]>(`SELECT MAX(id) m FROM setes_central.tb_interface`) as any
    check('id dinâmico = MAX+1 da central', Number(id) === Number(mx.m) + 1, { id, max: mx.m })
    const pv = await q(`SELECT tb_privilege_id p FROM \`${P}\`.tb_interface_has_privilege WHERE tb_interface_id = ${Number(id)} AND deleted = 'N' ORDER BY p`)
    check('privilégios V/I/A/E + CATALOGAR (1,2,3,6,10)', JSON.stringify(pv.map(r => r.p)) === '[1,2,3,6,10]', pv)
    const pr = await q('SELECT id, description FROM `' + P + '`.tb_privilege WHERE id = 10')
    check('privilégio 10 CATALOGAR criado 1×', pr.length === 1 && pr[0].description === 'CATALOGAR', pr)
    const cf = await q(`SELECT name FROM \`${P}\`.tb_interface_has_config WHERE tb_interface_id = ${Number(id)}`)
    check('page_size 1×', cf.length === 1 && cf[0].name === 'page_size', cf)
    const [[inst]] = await c.query<any[]>(`SELECT COUNT(*) n FROM setes_central.tb_institution WHERE deleted = 'N'`) as any
    const ff = await q(`SELECT tb_institution_id FROM \`${P}\`.tb_feature_flag WHERE module_key = 'merchandise'`)
    check('flag 1× por institution viva', ff.length === Number(inst.n), { flags: ff.length, inst: inst.n })
    const [[dup]] = await c.query<any[]>(`SELECT COUNT(*) - COUNT(DISTINCT id) d FROM \`${P}\`.tb_feature_flag`) as any
    check('ids de flag sem repetição', Number(dup.d) === 0, dup)
    const fd = await q(`SELECT field_name, required FROM \`${P}\`.tb_interface_has_field WHERE tb_interface_id = ${Number(id)}`)
    check('catálogo de campos (14) — obrigatórios description/tb_category_id/tb_brand_id/tb_measure_id',
      fd.length === 14 && fd.filter(f => f.required === 'S').map(f => f.field_name).sort().join() === 'description,tb_brand_id,tb_category_id,tb_measure_id', fd)
    const ct = await q(`SELECT 1 FROM setes_setes.tb_institution_has_interface WHERE tb_interface_id = ${Number(id)}`)
    check('NENHUM contrato gravado (D-PR14) — o seed não toca schema de cliente', ct.length === 0 && !/setes_setes/.test(sql), ct)
    // a conferência FALHA ALTO se o id 10 não for o CATALOGAR (nascido antes pela tela do Super)
    await c.query('UPDATE `' + P + "`.tb_privilege SET description = 'OUTRO' WHERE id = 10")
    let failed = ''
    try { for (const st of splitStatements(sql)) await c.query(st) } catch (e: any) { failed = String(e?.sqlMessage ?? e?.message) }
    check('privilégio 10 que NÃO é o CATALOGAR derruba o seed (SEED66_FALHOU)', /SEED66_FALHOU/i.test(failed), failed)
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${P}\``).catch(() => undefined)
    c.release(); await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
