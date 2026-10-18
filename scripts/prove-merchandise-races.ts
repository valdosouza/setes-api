/**
 * RE-PROVA das corridas e bordas do cadastro de mercadorias (onda 1 — gates adversariais de 2026-10-18; prompt_modulo_products.md §16.8)
 * com as funções REAIS do repositório num SCHEMA DESCARTÁVEL (a 071 aplicada só nele). Esperado depois da correção: V1–V3 → 400 no DTO;
 * V4/V5 níveis preservados; V6/V7 corridas de GTIN → 409 GTIN_TAKEN com o id do dono, nenhum nível alheio tocado; V8 13×14 dígitos → 409;
 * V10 serviço invisível; V12 8 criações concorrentes na central (protocolo da trava nomeada, numa CÓPIA da tb_brand) → 8 ok, 0 duplicata.
 * Uso: DOTENV_CONFIG_PATH=<.env> npx tsx --require dotenv/config --require tsconfig-paths/register scripts/prove-merchandise-races.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import * as repo from '../src/modules/merchandise/merchandise.repository'
import { merchandiseDto, tradeUnitsDto } from '../src/modules/merchandise/merchandise.dto'
import { ensureCatalogItem, linkCatalogItem, BRAND_CATALOG } from '../src/shared/central-catalog'

const WT = path.join(__dirname, '..')
const P = `setes_advm_probe_${process.pid}`
const INST = 1
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function gtin13(base12: string): string {
  const d = base12.split('').map(Number)
  let sum = 0
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w
  return base12 + String((10 - (sum % 10)) % 10)
}

function classify(err: any): string {
  if (err?.statusCode) return `HTTP ${err.statusCode} ${err.code ?? ''} ${JSON.stringify(err.fields ?? [])}`
  if (err?.code === 'ER_LOCK_DEADLOCK' || err?.code === 'ER_LOCK_WAIT_TIMEOUT') return `409 RESOURCE_BUSY (${err.code})`
  return `500 (${err?.code ?? ''}: ${String(err?.sqlMessage ?? err?.message).slice(0, 140)})`
}

const out: string[] = []
const log = (s: string) => { console.log(s); out.push(s) }

const base = (over: Record<string, unknown> = {}) => merchandiseDto.parse({
  description: 'PROVA ADV', categoryId: 1, brandId: 1, baseUnit: { measureId: 1 }, ...over,
})
const tu = (levels: any[], over: Record<string, unknown> = {}) => tradeUnitsDto.parse({ levels, ...over })

async function levelsOf(id: number): Promise<any[]> {
  const [r] = await pool.query<any[]>(
    `SELECT level, tb_measure_id m, factor, gtin, deleted FROM \`${P}\`.tb_merchandise_trade_unit
      WHERE tb_institution_id = ? AND tb_merchandise_id = ? ORDER BY level`, [INST, id])
  return r
}
const live = (rows: any[]) => rows.filter(r => r.deleted === 'N').map(r => `${r.level}:m${r.m}×${Number(r.factor)}${r.gtin ? `#${r.gtin}` : ''}`).join(' ')

async function newProduct(over: Record<string, unknown> = {}): Promise<number> {
  return repo.insertMerchandise(base(over) as any, P, INST)
}

async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE DATABASE \`${P}\``)
    for (const t of ['tb_product', 'tb_merchandise', 'tb_category', 'tb_financial_plans', 'tb_price', 'tb_price_list',
      'tb_institution_has_brand', 'tb_institution_has_measure', 'tb_institution_has_package', 'tb_tax_rule']) {
      await conn.query(`CREATE TABLE \`${P}\`.${t} LIKE setes_setes.${t}`)
    }
    await conn.query(`CREATE TABLE \`${P}\`.tb_brand LIKE setes_central.tb_brand`)
    await conn.query(`INSERT INTO \`${P}\`.tb_brand SELECT * FROM setes_central.tb_brand`)
    await conn.query(`USE \`${P}\``)
    for (const st of splitStatements(fs.readFileSync(path.join(WT, 'src/migrations/sql/071_merchandise_trade_unit.sql'), 'utf8'))) await conn.query(st)
    await conn.query(`USE setes_central`)
    await conn.query(`INSERT INTO \`${P}\`.tb_category (id, tb_institution_id, description, posit_level, kind, active, deleted)
                      VALUES (1, ?, 'CAT P', '001', 'P', 'S', 'N'), (2, ?, 'CAT S', '002', 'S', 'S', 'N')`, [INST, INST])
    await conn.query(`INSERT INTO \`${P}\`.tb_price_list (id, tb_institution_id, description, deleted) VALUES (1, ?, 'NORMAL', 'N')`, [INST])
    await conn.query(`INSERT INTO \`${P}\`.tb_institution_has_brand (tb_institution_id, tb_brand_id, active, deleted) VALUES (?, 1, 'S', 'N')`, [INST])
    for (const m of [1, 2, 3]) {
      await conn.query(`INSERT INTO \`${P}\`.tb_institution_has_measure (tb_institution_id, tb_measure_id, active, deleted) VALUES (?, ?, 'S', 'N')`, [INST, m])
    }
    const [[mode]] = await conn.query<any[]>(`SELECT @@SESSION.sql_mode AS m`) as any
    log(`sql_mode da sessão do pool: ${mode.m}`)

    // ---- V1: preço acima do DECIMAL(13,6) — validado ≠ gravado
    try {
      const id = await newProduct({ prices: [{ priceListId: 1, priceTag: 12345678901.25 }] })
      const [[r]] = await pool.query<any[]>(`SELECT price_tag FROM \`${P}\`.tb_price WHERE tb_product_id = ?`, [id]) as any
      log(`V1 preço enviado 12345678901.25 → gravado ${r.price_tag} (POST respondeu id ${id}, sem erro)`)
    } catch (e: any) { log(`V1 preço 12345678901.25 → ${e?.issues ? '400 DTO: ' + e.issues.map((i: any) => i.message).join('; ') : classify(e)}`) }
    // ---- V2: fator que arredonda para 0 no DECIMAL(14,6)
    {
      const id = await newProduct()
      try {
        await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 0.0000004 }]) as any, P, INST)
        log(`V2 fator 0.0000004 → aceito; níveis: ${live(await levelsOf(id))}`)
      } catch (e: any) { log(`V2 fator 0.0000004 → ${e?.issues ? '400 DTO: ' + e.issues.map((i: any) => i.message).join('; ') : classify(e)}`) }
    }
    // ---- V3: dois níveis NOVOS que só diferem abaixo da 6ª casa (12 × 12.0000001) — UNIQUE via ON DUPLICATE KEY
    {
      const id = await newProduct()
      const gA = gtin13('789100000101'), gB = gtin13('789100000102')
      try {
        await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 },
          { measureId: 2, factor: 12, gtin: gA }, { measureId: 2, factor: 12.0000001, gtin: gB }]) as any, P, INST)
        log(`V3 PUT com 2 níveis novos (KG×12 #${gA}, KG×12.0000001 #${gB}) → ok:true; níveis vivos: ${live(await levelsOf(id))}`)
      } catch (e: any) { log(`V3 → ${e?.issues ? '400 DTO: ' + e.issues.map((i: any) => i.message).join('; ') : classify(e)}`) }
    }
    // ---- V4: nível NOVO antes de um nível existente que muda (unidade, fator) — mesma requisição
    {
      const id = await newProduct()
      await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 12 }]) as any, P, INST)
      const g = gtin13('789100000201')
      try {
        await repo.saveTradeUnits(id, tu([{ measureId: 2, factor: 12, gtin: g }, { level: 1, measureId: 1, factor: 1 },
          { level: 2, measureId: 2, factor: 24 }]) as any, P, INST)
        log(`V4 grade [novo KG×12 #${g}, 1, 2→KG×24] → ok:true; níveis vivos: ${live(await levelsOf(id))} (esperado 3 níveis vivos)`)
      } catch (e) { log(`V4 → ${classify(e)}`) }
    }
    // ---- V5: troca de (unidade, fator) entre dois níveis existentes
    {
      const id = await newProduct()
      await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 12 }, { measureId: 2, factor: 24 }]) as any, P, INST)
      try {
        await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 }, { level: 2, measureId: 2, factor: 24 },
          { level: 3, measureId: 2, factor: 12 }]) as any, P, INST)
        log(`V5 troca 2↔3 → ok; ${live(await levelsOf(id))}`)
      } catch (e) { log(`V5 troca (KG×12 ↔ KG×24) entre os níveis 2 e 3 (estado final VÁLIDO) → ${classify(e)}`) }
    }
    // ---- V6: corrida de GTIN entre DOIS produtos pela sub-rota (sem trava comum) — o 2º "insere" atualizando o nível do OUTRO
    {
      const a = await newProduct({ description: 'PRODUTO A' })
      const b = await newProduct({ description: 'PRODUTO B' })
      const g = gtin13('789100000301')
      const t = await pool.getConnection()
      await t.beginTransaction()
      // T_A = o MESMO upsert que saveTradeUnits(A) executa para um nível novo, ainda NÃO comitado (A já passou do assertGtinFree)
      await t.query(`INSERT INTO \`${P}\`.tb_merchandise_trade_unit
         (tb_institution_id, tb_merchandise_id, level, tb_measure_id, tb_package_id, factor, gtin, created_at, updated_at, deleted)
       VALUES (?, ?, 2, 2, NULL, 7, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE tb_measure_id = VALUES(tb_measure_id), tb_package_id = VALUES(tb_package_id),
                               factor = VALUES(factor), gtin = VALUES(gtin), deleted = 'N', updated_at = NOW()`, [INST, a, g])
      const pb = repo.saveTradeUnits(b, tu([{ level: 1, measureId: 1, factor: 1 }, { measureId: 3, factor: 6, gtin: g }]) as any, P, INST)
        .then(() => 'ok:true', classify)
      await sleep(250)
      await t.commit(); t.release()
      const res = await pb
      log(`V6 A=${a} (T_A: nível 2 = KG×7 #${g}) ∥ PUT trade-units de B=${b} com LT×6 #${g} → B: ${res}`)
      log(`    níveis vivos de A: ${live(await levelsOf(a))}   |   níveis vivos de B: ${live(await levelsOf(b))}`)
    }
    // ---- V7: corrida POST (produto novo com GTIN na base) × nível novo de OUTRO produto ainda não comitado
    {
      const a = await newProduct({ description: 'PRODUTO A7' })
      const g = gtin13('789100000401')
      const t = await pool.getConnection()
      await t.beginTransaction()
      await t.query(`INSERT INTO \`${P}\`.tb_merchandise_trade_unit
         (tb_institution_id, tb_merchandise_id, level, tb_measure_id, tb_package_id, factor, gtin, created_at, updated_at, deleted)
       VALUES (?, ?, 2, 2, NULL, 9, ?, NOW(), NOW(), 'N')`, [INST, a, g])
      const pc = newProduct({ description: 'PRODUTO C7', baseUnit: { measureId: 3, gtin: g } }).then(id => `201 id ${id}`, classify)
      await sleep(150)
      await t.commit(); t.release()
      const res = await pc
      const cId = Number(/id (\d+)/.exec(res)?.[1] ?? 0)
      log(`V7 A=${a} (T_A: nível 2 = KG×9 #${g}) ∥ POST de C com base LT #${g} → ${res}`)
      log(`    níveis vivos de A: ${live(await levelsOf(a))}   |   níveis vivos de C: ${cId ? live(await levelsOf(cId)) || '(nenhum — sem unidade-base)' : '-'}`)
    }
    // ---- V8: o MESMO GTIN em 13 e em 14 dígitos (zero à esquerda) em dois produtos
    {
      try {
        const a = await newProduct({ description: 'EAN13', baseUnit: { measureId: 1, gtin: '7891234567895' } })
        const b = await newProduct({ description: 'EAN14', baseUnit: { measureId: 1, gtin: '07891234567895' } })
        log(`V8 GTIN 7891234567895 no produto ${a} E 07891234567895 no produto ${b} → ambos aceitos (mesmo GTIN pela GS1)`)
      } catch (e) { log(`V8 → ${classify(e)}`) }
    }
    // ---- V9: código em branco recebe o id — e o id já é o código digitado de outro produto
    {
      const [[mx]] = await pool.query<any[]>(`SELECT COALESCE(MAX(id),0)+1 n FROM \`${P}\`.tb_product WHERE tb_institution_id = ?`, [INST]) as any
      const a = await newProduct({ identifier: String(Number(mx.n) + 1) })
      try {
        await newProduct({ identifier: null })
        log(`V9 → aceito`)
      } catch (e) { log(`V9 produto ${a} digitou o código "${Number(mx.n) + 1}"; o próximo, com o código EM BRANCO → ${classify(e)}`) }
    }
    // ---- V10: código de SERVIÇO (kind S) — case diferente
    {
      await pool.query(`INSERT INTO \`${P}\`.tb_product (id, identifier, tb_institution_id, description, kind, tb_category_id, deleted)
                        VALUES (5000, 'SRV-1', ?, 'SERVICO', 'S', 2, 'N')`, [INST])
      try { await newProduct({ identifier: 'srv-1' }); log('V10 → aceito (código de serviço com outra caixa)') }
      catch (e) { log(`V10 mercadoria com código "srv-1" (serviço tem "SRV-1") → ${classify(e)}`) }
      const asMerch = await repo.updateMerchandise(5000, base() as any, P, INST)
      const tuOfService = await repo.getTradeUnits(5000, P, INST)
      log(`V10b PUT /merchandise/5000 (serviço) → ${asMerch ? 'EDITOU' : '404'}; GET trade-units → ${tuOfService ? 'VAZOU' : '404'}`)
    }
    // ---- V11: designação apontando nível NOVO adivinhado + designação de nível apagado
    {
      const id = await newProduct()
      try {
        await repo.saveTradeUnits(id, tu([{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor: 12 }], { taxableTradeLevel: 2 }) as any, P, INST)
        const v = await repo.getTradeUnits(id, P, INST)
        log(`V11 designação para o nível novo "adivinhado" (2) → aceita; taxable=${v?.taxableTradeLevel}`)
      } catch (e) { log(`V11 → ${classify(e)}`) }
    }
    // ---- V12: catálogo central — 8 criadores concorrentes (descrições DIFERENTES) e 8 com a MESMA descrição, SQL real da peça
    for (const scenario of ['diferentes', 'mesma']) {
      const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        const c = await pool.getConnection()
        const wrapped: any = {
          query: async (sql: string, params?: any[]) => {
            const r = await c.query(sql.replace(/setes_central\.tb_brand/g, `\`${P}\`.tb_brand`)
              .replace(/`setes_[a-z0-9_]+`\.tb_institution_has_brand/g, `\`${P}\`.tb_institution_has_brand`), params)
            await sleep(Math.random() * 15)    // latência de rede entre statements
            return r
          },
        }
        // (re-prova da correção) o protocolo de createAndLinkCatalogItem: trava NOMEADA do catálogo ANTES da transação, solta no finally
        const lockName = `${P}.tb_brand`
        let locked = false
        try {
          const [got] = await c.query<any[]>(`SELECT GET_LOCK(?, 10) AS ok`, [lockName])
          if (Number((got as any)[0]?.ok) !== 1) return 'sem trava (10 s)'
          locked = true
          await c.beginTransaction()
          const desc = scenario === 'mesma' ? 'MARCA CORRIDA' : `MARCA ${i}`
          const item = await ensureCatalogItem(wrapped, BRAND_CATALOG, { description: desc })
          await linkCatalogItem(wrapped, BRAND_CATALOG, P, INST, item.id)
          await c.commit()
          return item.reused ? 'ok (reusou)' : 'ok'
        } catch (e) {
          await c.rollback()
          return classify(e)
        } finally {
          if (locked) await c.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => undefined)
          c.release()
        }
      }))
      const tally = results.reduce((m: Record<string, number>, r) => { const k = r.split(' (')[0]; m[k] = (m[k] ?? 0) + 1; return m }, {})
      const [dups] = await pool.query<any[]>(`SELECT description, COUNT(*) n FROM \`${P}\`.tb_brand WHERE deleted = 'N' GROUP BY description HAVING n > 1`)
      log(`V12 criar marca na central ×8 (${scenario}) → ${JSON.stringify(tally)}; descrições duplicadas na cópia: ${JSON.stringify(dups)}`)
      log(`    detalhes: ${JSON.stringify(results.filter(r => r !== 'ok'))}`)
    }
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${P}\``).catch(() => undefined)
    conn.release()
    await pool.end()
    console.log(`\nschema descartável ${P} apagado`)
  }
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
