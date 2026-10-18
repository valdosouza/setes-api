/**
 * PROVA da migration 071 (cadastro de produtos, onda 1 — D-PR15/D-PR16/D-PR19/D-PR31; prompt_modulo_products.md §12/§16.2) em
 * SCHEMA DESCARTÁVEL: cria `setes_mtu_probe_<pid>` com CÓPIAS de `tb_product` e `tb_merchandise` do schema de origem (forma E
 * linhas — o ALTER roda sobre tabela populada), aplica a 071 DUAS vezes (re-executável) e confere cada garantia do banco: nível 1 com
 * fator 1, fator > 0, forma do GTIN, GTIN único entre níveis VIVOS do catálogo (e liberado pelo soft delete), (unidade, fator) único
 * entre os níveis vivos do produto, FK para medida/embalagem centrais e as DESIGNAÇÕES apontando só nível existente do mesmo produto.
 * Apaga o schema descartável no fim (inclusive em falha). NUNCA escreve no schema de origem.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-071-merchandise-trade-unit.ts [schema-origem=setes_setes]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const SOURCE = process.argv[2] ?? 'setes_setes'
const PROBE = `setes_mtu_probe_${process.pid}`
const MIGRATION = path.join(__dirname, '..', 'src', 'migrations', 'sql', '071_merchandise_trade_unit.sql')
const INST = 1
const P1 = 900001
const P2 = 900002

async function main() {
  if (!/^setes_[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema de origem inválido: ${SOURCE}`)
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean, got?: string) => {
    console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}${cond || got === undefined ? '' : `  (obtido: ${got})`}`)
    ok &&= cond
  }
  const run = async (sql: string, params: unknown[] = []): Promise<string> => {
    try {
      await conn.query(sql, params)
      return 'aceito'
    } catch (e: any) {
      const m = String(e?.sqlMessage ?? e?.message)
      const name = /(ck|uq|fk)_[a-z_]+/.exec(m)?.[0]
      return name ? `recusado:${name}` : `erro:${m}`
    }
  }
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    for (const t of ['tb_product', 'tb_merchandise']) {
      await conn.query(`CREATE TABLE \`${PROBE}\`.${t} LIKE \`${SOURCE}\`.${t}`)
      await conn.query(`INSERT INTO \`${PROBE}\`.${t} SELECT * FROM \`${SOURCE}\`.${t}`)
    }
    const [[{ n: copied }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM \`${PROBE}\`.tb_merchandise`) as any
    await conn.query(`USE \`${PROBE}\``)
    const statements = splitStatements(fs.readFileSync(MIGRATION, 'utf8'))
    for (let pass = 1; pass <= 2; pass++) for (const st of statements) await conn.query(st)
    check(`071 aplicada DUAS vezes sem erro sobre ${copied} mercadoria(s) copiada(s) (re-executável)`, true)

    const [[{ n: kept }]] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM tb_merchandise WHERE taxable_trade_level IS NULL AND default_sale_trade_level IS NULL`) as any
    check('linhas existentes ficam com as designações NULL (aditivas)', Number(kept) === Number(copied))

    // produtos de prova (ids altos — nada colide com o que veio copiado)
    for (const id of [P1, P2]) {
      await conn.query(
        `INSERT INTO tb_product (id, identifier, tb_institution_id, description, kind, tb_category_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, 'PROVA 071', 'P', 0, NOW(), NOW(), 'N')`, [id, String(id), INST])
      await conn.query(
        `INSERT INTO tb_merchandise (id, tb_institution_id, ncm, tb_brand_id, created_at, updated_at, deleted)
         VALUES (?, ?, '84713012', 1, NOW(), NOW(), 'N')`, [id, INST])
    }
    const level = (merch: number, lvl: number, measure: number, factor: number, gtin: string | null, pkg: number | null = null) =>
      run(`INSERT INTO tb_merchandise_trade_unit
             (tb_institution_id, tb_merchandise_id, level, tb_measure_id, tb_package_id, factor, gtin, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`, [INST, merch, lvl, measure, pkg, factor, gtin])

    check('nível base (1, fator 1, GTIN-13) aceito', await level(P1, 1, 1, 1, '7891234567895') === 'aceito')
    let got = await level(P2, 1, 1, 2, null)
    check('nível 1 com fator ≠ 1 recusado', got === 'recusado:ck_mtu_base_factor', got)
    got = await level(P1, 2, 1, 0, null)
    check('fator 0 recusado', got === 'recusado:ck_mtu_factor', got)
    got = await level(P1, 0, 1, 1, null)
    check('nível 0 recusado', got === 'recusado:ck_mtu_level', got)
    check('nível 2 (CX × 12, GTIN-14, embalagem) aceito', await level(P1, 2, 1, 12, '17891234567892', 1) === 'aceito')
    got = await level(P1, 3, 1, 12, null)
    check('mesma unidade E mesmo fator no MESMO produto recusado (D-PR31)', got === 'recusado:uq_mtu_live_unit_factor', got)
    check('mesma unidade com OUTRO fator aceita (CX12 × CX24)', await level(P1, 3, 1, 24, null) === 'aceito')
    got = await level(P1, 4, 2, 1, '123')
    check('GTIN fora da forma (3 dígitos) recusado', got === 'recusado:ck_mtu_gtin_form', got)
    got = await level(P1, 4, 2, 1, '78912345678A5')
    check('GTIN com letra recusado', got === 'recusado:ck_mtu_gtin_form', got)
    got = await level(P2, 1, 1, 1, '7891234567895')
    check('GTIN já vivo em OUTRO produto recusado (D-PR19)', got === 'recusado:uq_mtu_live_gtin', got)
    got = await level(P2, 1, 1, 1, '07891234567895')
    check('o MESMO GTIN-13 na forma de 14 dígitos (zero à esquerda) em OUTRO produto recusado (identidade GS1 — A-PR3)',
      got === 'recusado:uq_mtu_live_gtin', got)
    const [[kv]] = await conn.query<any[]>(
      `SELECT gtin, live_gtin FROM tb_merchandise_trade_unit WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = 1`,
      [INST, P1]) as any
    check('o GTIN é GRAVADO como digitado e o live_gtin guarda a forma de 14 dígitos',
      kv.gtin === '7891234567895' && kv.live_gtin === '07891234567895', `${kv.gtin}/${kv.live_gtin}`)
    got = await level(P1, 4, 999999, 1, null)
    check('unidade inexistente na central recusada', got === 'recusado:fk_mtu_measure', got)
    got = await level(P1, 4, 1, 3, null, 999999)
    check('embalagem inexistente na central recusada', got === 'recusado:fk_mtu_package', got)

    // soft delete libera o GTIN e o par (unidade, fator)
    await conn.query(`UPDATE tb_merchandise_trade_unit SET deleted = 'S' WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = 1`, [INST, P1])
    check('GTIN de nível EXCLUÍDO volta a ficar livre', await level(P2, 1, 1, 1, '7891234567895') === 'aceito')
    await conn.query(`UPDATE tb_merchandise_trade_unit SET deleted = 'S' WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = 2`, [INST, P1])
    check('(unidade, fator) de nível EXCLUÍDO volta a ficar livre', await level(P1, 5, 1, 12, null) === 'aceito')

    // designações (D-PR16): só nível existente do MESMO produto
    check('designação tributável = nível existente aceita',
      await run(`UPDATE tb_merchandise SET taxable_trade_level = 3 WHERE id = ? AND tb_institution_id = ?`, [P1, INST]) === 'aceito')
    got = await run(`UPDATE tb_merchandise SET taxable_trade_level = 9 WHERE id = ? AND tb_institution_id = ?`, [P1, INST])
    check('designação tributável para nível inexistente recusada', got === 'recusado:fk_merchandise_taxable_level', got)
    got = await run(`UPDATE tb_merchandise SET default_sale_trade_level = 5 WHERE id = ? AND tb_institution_id = ?`, [P2, INST])
    check('designação de venda apontando nível de OUTRO produto recusada', got === 'recusado:fk_merchandise_sale_level', got)
    check('designação NULL aceita (padrão)',
      await run(`UPDATE tb_merchandise SET default_sale_trade_level = NULL WHERE id = ? AND tb_institution_id = ?`, [P2, INST]) === 'aceito')
    got = await run(`DELETE FROM tb_merchandise_trade_unit WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = 3`, [INST, P1])
    check('DELETE FÍSICO de nível designado barrado pela FK', got.startsWith('recusado:fk_merchandise_taxable_level') || got.includes('foreign key'), got)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
