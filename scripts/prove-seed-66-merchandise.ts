/**
 * PROVA do seed `sql/66_merchandise_interface_seed.sql` (cadastro de produtos, onda 1 — prompt_modulo_products.md §16.8) numa CÓPIA
 * descartável das tabelas centrais que ele toca: 1 interface com id MAX+1, os 6 pares — V/I/A/E (6, 1, 2, 3) + CATALOGAR (10, D-PR33,
 * ligado pelo NOME) + CONFIGURAR (11, D-PV25) —, page_size, catálogo de 14 campos, NENHUM contrato (D-PR14) e NENHUMA feature flag
 * (D-PV36 — módulo guardado pelo roteador não tem flag; a cópia nem traz `tb_feature_flag`: um INSERT nela derrubaria a prova).
 * Casos da conferência do fim (FALHA ALTO — D-PR74): (a) interface `merchandise` excluída → falha e não nasce linha nova; (b) privilégio
 * 10 com outro nome → falha e nenhum par ligado ao 10; (c) um 15º campo vivo não derruba a re-execução; (d) duas execuções = mesmo estado.
 * A cópia é a do `main` depois do script 77 (`catalog-probe-copy`: `CREATE TABLE … LIKE` + linhas pelas colunas NÃO geradas; os UNIQUE
 * do 77 FICAM — o seed roda depois dele). O texto do seed tem `setes_central` trocado pelo schema descartável — nada é gravado na
 * central nem em schema de cliente. O repo `sql` é o IRMÃO deste (`../../sql`) ou o `SQL_DIR`.
 * Uso: SQL_DIR=<pasta do repo sql> npx tsx --require tsconfig-paths/register scripts/prove-seed-66-merchandise.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '../src/shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { copyCatalogRows } from './catalog-probe-copy'
const P = `setes_seed66_probe_${process.pid}`
const TABLES = ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config', 'tb_interface_has_field']
const FIELDS = ['identifier', 'description', 'tb_category_id', 'tb_financial_plans_id', 'active', 'note', 'tb_brand_id', 'ncm', 'cest',
  'source', 'kind_tributary', 'tb_measure_id', 'tb_package_id', 'gtin']
async function main() {
  const c = await pool.getConnection()
  let ok = true
  const check = (l: string, cond: boolean, got?: unknown) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${l}${cond ? '' : `  (obtido: ${JSON.stringify(got)})`}`); ok &&= cond }
  const q = async (s: string, p?: unknown[]) => ((await c.query<any[]>(s, p))[0] as any[])
  const sql = fs.readFileSync(path.join(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'), '66_merchandise_interface_seed.sql'), 'utf8').replace(/setes_central/g, P)
  const statements = splitStatements(sql)
  /** cópia nova do catálogo central de hoje */
  const fresh = async () => {
    await c.query(`DROP DATABASE IF EXISTS \`${P}\``)
    await c.query(`CREATE DATABASE \`${P}\``)
    for (const t of TABLES) await c.query(`CREATE TABLE \`${P}\`.${t} LIKE setes_central.${t}`)
    for (const t of TABLES) await copyCatalogRows(c, P, t)
  }
  /** roda o seed inteiro; devolve '' ou a mensagem do erro que o derrubou */
  const run = async (): Promise<string> => {
    try { for (const st of statements) await c.query(st); return '' } catch (e: any) { return String(e?.sqlMessage ?? e?.message ?? e) }
  }
  /** o estado inteiro das tabelas que o seed toca */
  const snapshot = async () => {
    const out: Record<string, unknown> = {}
    for (const t of TABLES) out[t] = await q(`SELECT * FROM \`${P}\`.${t} ORDER BY 1, 2, 3`)
    return JSON.stringify(out)
  }
  const merchandise = () => q(`SELECT id, group_default, kind, deleted FROM \`${P}\`.tb_interface WHERE i18n_key = 'merchandise' ORDER BY id`)
  const pairsOf = async (id: number) => (await q(`SELECT tb_privilege_id p FROM \`${P}\`.tb_interface_has_privilege
    WHERE tb_interface_id = ? AND deleted = 'N' AND active = 'S' ORDER BY p`, [id])).map(r => Number(r.p))
  try {
    // ── caminho feliz + (d) duas execuções = mesmo estado ──────────────────────────────────────────────────────────────────────
    await fresh()
    const before = await merchandise()                       // depois da janela a central já tem a tela: o seed vira no-op
    const [mx] = await q(`SELECT MAX(id) m FROM \`${P}\`.tb_interface`)
    const first = await run()
    const afterFirst = await snapshot()
    const second = await run()
    check('o seed roda 2× sem erro', first === '' && second === '', { first, second })
    check('(d) duas execuções = mesmo estado (todas as linhas das 5 tabelas, datas inclusive)', afterFirst === await snapshot())
    const itf = await merchandise()
    check('1 interface merchandise (kind T, Registers, viva) depois de 2 execuções',
      itf.length === 1 && itf[0].kind === 'T' && itf[0].group_default === 'Registers' && itf[0].deleted === 'N', itf)
    const id = Number(itf[0]?.id)
    const expectedId = before.length ? Number(before[0].id) : Number(mx.m) + 1
    check('id dinâmico = MAX+1 do catálogo (ou o da tela que já existia)', id === expectedId, { id, expectedId })
    check('pares vivos e ativos: V/I/A/E + CATALOGAR + CONFIGURAR (1,2,3,6,10,11)', JSON.stringify(await pairsOf(id)) === '[1,2,3,6,10,11]', await pairsOf(id))
    const pr = await q(`SELECT id, description, deleted FROM \`${P}\`.tb_privilege WHERE id IN (10, 11) ORDER BY id`)
    check('privilégio 10 = CATALOGAR (1×) e 11 = CONFIGURAR, vivos',
      pr.length === 2 && pr[0].description === 'CATALOGAR' && pr[1].description === 'CONFIGURAR' && pr.every(r => r.deleted === 'N'), pr)
    const cf = await q(`SELECT name FROM \`${P}\`.tb_interface_has_config WHERE tb_interface_id = ?`, [id])
    check('page_size 1×', cf.length === 1 && cf[0].name === 'page_size', cf)
    check('NENHUMA feature flag (D-PV36): o seed não cita tb_feature_flag fora de comentário', !statements.some(st => /tb_feature_flag/i.test(st)))
    const fd = await q(`SELECT field_name, required FROM \`${P}\`.tb_interface_has_field WHERE tb_interface_id = ? AND deleted = 'N'`, [id])
    check('catálogo de campos (os 14 nomeados) — obrigatórios description/tb_category_id/tb_brand_id/tb_measure_id',
      fd.map(f => f.field_name).sort().join() === [...FIELDS].sort().join()
      && fd.filter(f => f.required === 'S').map(f => f.field_name).sort().join() === 'description,tb_brand_id,tb_category_id,tb_measure_id', fd)
    const ct = await q(`SELECT 1 FROM setes_setes.tb_institution_has_interface WHERE tb_interface_id = ?`, [id])
    check('NENHUM contrato gravado (D-PR14) — o seed não toca schema de cliente', (before.length > 0 || ct.length === 0) && !/setes_setes/.test(sql), ct)

    // ── (c) um 15º campo vivo na interface não derruba a re-execução (linha a mais não é falta) ─────────────────────────────────
    await c.query(`INSERT INTO \`${P}\`.tb_interface_has_field (tb_interface_id, field_name, table_name, kind, required, created_at, updated_at, deleted)
      VALUES (?, 'zz_prova_15', 'tb_product', 'String', 'N', NOW(), NOW(), 'N')`, [id])
    const with15 = await snapshot()
    const rerun15 = await run()
    check('(c) 15º campo vivo: a re-execução passa e não muda nada', rerun15 === '' && with15 === await snapshot(), rerun15)

    // ── privilégio 10 renomeado DEPOIS do seed: a re-execução falha alto ───────────────────────────────────────────────────────
    await c.query(`UPDATE \`${P}\`.tb_privilege SET description = 'OUTRO' WHERE id = 10`)
    const renamed = await run()
    check('privilégio 10 renomeado depois do seed derruba a re-execução (SEED66_FALHOU)', /SEED66_FALHOU/i.test(renamed), renamed)

    // ── (b) privilégio 10 JÁ com outro nome (cunhado antes pela tela do Super): falha alto e NENHUM par ligado ao 10 ────────────
    await fresh()
    await c.query(`DELETE FROM \`${P}\`.tb_interface_has_privilege WHERE tb_privilege_id = 10`)
    if ((await q(`SELECT 1 FROM \`${P}\`.tb_privilege WHERE id = 10`)).length) await c.query(`UPDATE \`${P}\`.tb_privilege SET description = 'OUTRO', deleted = 'N' WHERE id = 10`)
    else await c.query(`INSERT INTO \`${P}\`.tb_privilege (id, description, created_at, updated_at, deleted) VALUES (10, 'OUTRO', NOW(), NOW(), 'N')`)
    const wrongName = await run()
    const pairs10 = await q(`SELECT tb_interface_id i FROM \`${P}\`.tb_interface_has_privilege WHERE tb_privilege_id = 10`)
    const name10 = await q(`SELECT description FROM \`${P}\`.tb_privilege WHERE id = 10`)
    check('(b) privilégio 10 com outro nome: o seed FALHA ALTO (SEED66_FALHOU)', /SEED66_FALHOU/i.test(wrongName), wrongName)
    check('(b) nenhum par ligado ao 10 e o nome do 10 não é sobrescrito', pairs10.length === 0 && name10.length === 1 && name10[0].description === 'OUTRO', { pairs10, name10 })

    // ── (a) interface `merchandise` EXCLUÍDA (soft delete): falha alto e NÃO nasce linha nova ───────────────────────────────────
    await fresh()
    if ((await merchandise()).length) await c.query(`UPDATE \`${P}\`.tb_interface SET deleted = 'S' WHERE i18n_key = 'merchandise'`)
    else await c.query(`INSERT INTO \`${P}\`.tb_interface (id, group_default, i18n_key, description, kind, position, created_at, updated_at, deleted)
      SELECT COALESCE(MAX(id), 0) + 1, 'Registers', 'merchandise', 'Products', 'T', NULL, NOW(), NOW(), 'S' FROM \`${P}\`.tb_interface`)
    const deletedBefore = await merchandise()
    const [countBefore] = await q(`SELECT COUNT(*) n FROM \`${P}\`.tb_interface`)
    const onDeleted = await run()
    const deletedAfter = await merchandise()
    const [countAfter] = await q(`SELECT COUNT(*) n FROM \`${P}\`.tb_interface`)
    check('(a) interface merchandise excluída: o seed FALHA ALTO (SEED66_FALHOU)', /SEED66_FALHOU/i.test(onDeleted), onDeleted)
    check('(a) nenhuma linha nova em tb_interface (a excluída segue excluída e única)',
      Number(countAfter.n) === Number(countBefore.n) && JSON.stringify(deletedAfter) === JSON.stringify(deletedBefore)
      && deletedAfter.length === 1 && deletedAfter[0].deleted === 'S', { deletedBefore, deletedAfter, countBefore, countAfter })
  } catch (e: any) {
    check(`a prova rodou até o fim`, false, String(e?.sqlMessage ?? e?.message ?? e))
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${P}\``).catch(() => undefined)
    const [left] = await pool.query<any[]>(`SELECT COUNT(*) n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [P])
    check('schema descartável apagado', Number((left as any[])[0].n) === 0, left)
    c.release(); await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
