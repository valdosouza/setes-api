import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { TAX_RULE_ORIGINS, TAX_RULE_PURPOSES, countTaxRulesForProduct } from '@shared/tax-rule'
import { allocateProductId, assertIdentifierFree, identifierOrId, lockForIdentifierChange } from '@shared/product-id'
import { gtinIdentity } from '@shared/validation'
import { assertPriceListsAlive, listProductPrices, syncProductPrices } from '@shared/price'
import {
  BRAND_CATALOG, MEASURE_CATALOG, PACKAGE_CATALOG, CatalogItemRow, assertCatalogItemLinked, listLinkedCatalog,
} from '@shared/central-catalog'
import {
  MerchandiseListRow, MerchandiseFull, MerchandiseInput, MerchandiseLookupRow, BaseUnitRow,
  TradeUnitRow, TradeUnitsView, TradeUnitsInput, MerchandiseLinks,
} from './merchandise.interface'

/**
 * Repositório do cadastro de MERCADORIAS — tb_product com kind ∈ {P, M} (D-PR4) em TODO WHERE de leitura/escrita (este módulo nunca
 * enxerga nem toca serviço — espelho do "mercadoria invisível via /services"), especialização fiscal tb_merchandise e unidades de venda
 * tb_merchandise_trade_unit (migration 071 — D-PR15/D-PR16). Escopo (PADROES_BANCO §12): tudo aqui é tabela do GRUPO; hoje a chave do
 * grupo = a institution da sessão (D-PR24 regra 3: o escopo resolve num ponto só — `scope.institutionId` vindo do serviço).
 */

/**
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — D-BA2/D-BA3, Onda 2 §12): lista branca desta lista. O GTIN NÃO é critério (relação
 * 1:N com os níveis — a regra da casa só aceita 1:N como `shape:'set'` de lookup): ele entra no FILTRO RÁPIDO por igualdade exata.
 */
export const MERCHANDISE_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  { key: 'description', kind: 'text', labelKey: 'search.merchandise.description', expr: 'p.description' },
  { key: 'identifier', kind: 'text', labelKey: 'search.merchandise.identifier', expr: 'p.identifier' },
  { key: 'kind', kind: 'options', labelKey: 'search.merchandise.kind', expr: 'p.kind', options: ['P', 'M'] },
  { key: 'category', kind: 'lookup', labelKey: 'search.merchandise.category',
    expr: 'p.tb_category_id', lookup: '/api/merchandise/categories' },
  { key: 'brand', kind: 'lookup', labelKey: 'search.merchandise.brand', expr: 'm.tb_brand_id', lookup: '/api/merchandise/brands' },
  { key: 'ncm', kind: 'text', labelKey: 'search.merchandise.ncm', expr: 'm.ncm' },
  { key: 'cest', kind: 'text', labelKey: 'search.merchandise.cest', expr: 'm.cest' },
  { key: 'origin', kind: 'options', labelKey: 'search.merchandise.origin', expr: "COALESCE(m.source, '0')", options: TAX_RULE_ORIGINS },
  { key: 'purpose', kind: 'options', labelKey: 'search.merchandise.purpose', expr: 'm.kind_tributary', options: TAX_RULE_PURPOSES },
  { key: 'active', kind: 'bool', labelKey: 'search.merchandise.active', expr: "COALESCE(p.active, 'S')", boolValues: ['S', 'N'] },
]

const KIND_WHERE = "p.kind IN ('P', 'M')"

/** Lista PAGINADA (shared/list): página + COUNT com a MESMA where. Filtro rápido: descrição/código (contém) OU GTIN (exato). */
export async function listMerchandise(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<MerchandiseListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  // GTIN no filtro rápido pela IDENTIDADE GS1 (A-PR3 — 13 ou 14 dígitos acham o mesmo nível) e pelo `uq_mtu_live_gtin` (só vivos)
  const typed = query.filter ? query.filter.trim() : ''
  const gtinKey = /^\d{8,14}$/.test(typed) ? gtinIdentity(typed) : null
  const where =
    `FROM \`${schemaName}\`.tb_product p
     LEFT JOIN \`${schemaName}\`.tb_merchandise m
       ON m.id = p.id AND m.tb_institution_id = p.tb_institution_id
     LEFT JOIN \`${schemaName}\`.tb_category c
       ON c.id = p.tb_category_id AND c.tb_institution_id = p.tb_institution_id
     LEFT JOIN setes_central.tb_brand b ON b.id = m.tb_brand_id
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND ${KIND_WHERE}
       AND (? IS NULL OR p.description LIKE ? OR p.identifier LIKE ?
            OR EXISTS (SELECT 1 FROM \`${schemaName}\`.tb_merchandise_trade_unit tu
                        WHERE tu.tb_institution_id = p.tb_institution_id AND tu.tb_merchandise_id = p.id
                          AND tu.live_gtin = ?))${query.criteria.sql}`
  const params = [institutionId, like, like, like, gtinKey, ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.identifier, p.description, p.kind,
            p.tb_category_id AS categoryId,
            c.description    AS categoryDescription,
            m.tb_brand_id    AS brandId,
            b.description    AS brandDescription,
            m.ncm            AS ncm,
            COALESCE(p.active, 'S') AS active
     ${where}
     ORDER BY p.description, p.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows, total: Number(count[0].total) }
}

export async function getMerchandise(
  id: number, schemaName: string, institutionId: number
): Promise<MerchandiseFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.identifier, p.description, p.kind,
            p.tb_category_id        AS categoryId,
            c.description           AS categoryDescription,
            p.tb_financial_plans_id AS financialPlansId,
            f.description           AS financialPlansDescription,
            COALESCE(p.active, 'S') AS active,
            CAST(p.note AS CHAR)    AS note,
            m.tb_brand_id           AS brandId,
            b.description           AS brandDescription,
            m.ncm                   AS ncm,
            m.cest                  AS cest,
            COALESCE(m.source, '0') AS origin,
            COALESCE(m.kind_tributary, '1') AS purpose,
            m.taxable_trade_level      AS taxableTradeLevel,
            m.default_sale_trade_level AS defaultSaleTradeLevel,
            CASE WHEN m.manuf_sign_ind_scale COLLATE utf8mb4_bin IN ('S', 'N') THEN m.manuf_sign_ind_scale END AS scaleRelevance,
            mfc.cnpj                AS manufacturerCnpj,
            tu.tb_measure_id AS buMeasureId,
            ms.abbreviation  AS buMeasureAbbreviation,
            ms.description   AS buMeasureDescription,
            tu.tb_package_id AS buPackageId,
            pk.description   AS buPackageDescription,
            tu.gtin          AS buGtin
     FROM \`${schemaName}\`.tb_product p
     LEFT JOIN \`${schemaName}\`.tb_merchandise m
       ON m.id = p.id AND m.tb_institution_id = p.tb_institution_id
     LEFT JOIN setes_central.tb_brand b ON b.id = m.tb_brand_id
     LEFT JOIN \`${schemaName}\`.tb_merchandise_factory mfc
       ON mfc.tb_institution_id = m.tb_institution_id AND mfc.tb_merchandise_id = m.id AND mfc.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_merchandise_trade_unit tu
       ON tu.tb_institution_id = p.tb_institution_id AND tu.tb_merchandise_id = p.id AND tu.level = 1 AND tu.deleted = 'N'
     LEFT JOIN setes_central.tb_measure ms ON ms.id = tu.tb_measure_id
     LEFT JOIN setes_central.tb_package pk ON pk.id = tu.tb_package_id
     LEFT JOIN \`${schemaName}\`.tb_category c
       ON c.id = p.tb_category_id AND c.tb_institution_id = p.tb_institution_id
     LEFT JOIN \`${schemaName}\`.tb_financial_plans f
       ON f.id = p.tb_financial_plans_id AND f.tb_institution_id = p.tb_institution_id
     WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N' AND ${KIND_WHERE}`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const {
    buMeasureId, buMeasureAbbreviation, buMeasureDescription, buPackageId, buPackageDescription, buGtin, ...base
  } = rows[0]
  const baseUnit: BaseUnitRow | null = buMeasureId == null ? null : {
    measureId: Number(buMeasureId), measureAbbreviation: buMeasureAbbreviation ?? null,
    measureDescription: buMeasureDescription ?? null, packageId: buPackageId == null ? null : Number(buPackageId),
    packageDescription: buPackageDescription ?? null, gtin: buGtin ?? null,
  }
  const prices = await listProductPrices(schemaName, institutionId, id)
  return { ...base, st: base.cest != null && base.cest !== '', baseUnit, prices }
}

/** O que a ficha já tem gravado — a conferência de referência roda só no que NASCE ou MUDA (A-PR1; ADV-10 do gate da onda 1). */
interface StoredRefs {
  categoryId:       number | null
  financialPlansId: number | null
  brandId:          number | null
  measureId:        number | null
  packageId:        number | null
}

/** FKs do form validadas DENTRO da transação — 400/422 com fields[]. `stored` null = produto novo (confere tudo). */
async function assertRefs(
  conn: PoolConnection, input: MerchandiseInput, schemaName: string, institutionId: number, stored: StoredRefs | null
): Promise<void> {
  const changed = <T>(value: T, before: T | null | undefined) => stored == null || value !== before
  if (changed(input.categoryId, stored?.categoryId)) {
    const [cat] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_category WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' AND kind = 'P'`,
      [input.categoryId, institutionId])
    if (cat.length === 0) {
      throw new HttpError(400, 'Categoria inexistente', [{ field: 'categoryId', message: 'Categoria de produto não encontrada' }])
    }
  }
  if (input.financialPlansId != null && changed(input.financialPlansId, stored?.financialPlansId)) {
    const [fp] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_financial_plans WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.financialPlansId, institutionId])
    if (fp.length === 0) {
      throw new HttpError(400, 'Plano financeiro inexistente',
        [{ field: 'financialPlansId', message: 'Plano financeiro não encontrado' }])
    }
  }
  if (changed(input.brandId, stored?.brandId)) {
    await assertCatalogItemLinked(conn, BRAND_CATALOG, schemaName, institutionId, input.brandId, 'brandId')
  }
  if (changed(input.baseUnit.measureId, stored?.measureId)) {
    await assertCatalogItemLinked(conn, MEASURE_CATALOG, schemaName, institutionId, input.baseUnit.measureId, 'baseUnit.measureId')
  }
  const packageId = input.baseUnit.packageId ?? null
  if (packageId != null && changed(packageId, stored?.packageId)) {
    await assertCatalogItemLinked(conn, PACKAGE_CATALOG, schemaName, institutionId, packageId, 'baseUnit.packageId')
  }
  await assertPriceListsAlive(conn, schemaName, institutionId, input.prices ?? [])
}

/** Dono VIVO do GTIN pela identidade GS1 (`live_gtin` = forma de 14 dígitos — A-PR3; o UNIQUE `uq_mtu_live_gtin` serve a busca). */
async function gtinOwner(
  conn: PoolConnection, schemaName: string, institutionId: number, gtin: string, exceptMerchandiseId: number | null, locking: boolean
): Promise<number | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT tb_merchandise_id AS id FROM \`${schemaName}\`.tb_merchandise_trade_unit
      WHERE tb_institution_id = ? AND live_gtin = ?${exceptMerchandiseId != null ? ' AND tb_merchandise_id <> ?' : ''}
      ORDER BY tb_merchandise_id LIMIT 1${locking ? ' LOCK IN SHARE MODE' : ''}`,
    exceptMerchandiseId != null
      ? [institutionId, gtinIdentity(gtin), exceptMerchandiseId]
      : [institutionId, gtinIdentity(gtin)])
  return rows[0] ? Number(rows[0].id) : null
}

function gtinTaken(gtin: string, other: number, field: string): HttpError {
  return new HttpError(409, `O GTIN ${gtin} já é do produto ${other}`,
    [{ field, message: `GTIN já usado pelo produto ${other}` }, { field: 'id', message: String(other) }], ErrorCodes.GTIN_TAKEN)
}

/** D-PR19: o GTIN não pode estar VIVO em OUTRO produto — 409 com o id do outro. Leitura do retrato: a corrida cai no UNIQUE da 071. */
async function assertGtinFree(
  conn: PoolConnection, schemaName: string, institutionId: number, gtin: string, merchandiseId: number, field: string
): Promise<void> {
  const other = await gtinOwner(conn, schemaName, institutionId, gtin, merchandiseId, false)
  if (other != null) throw gtinTaken(gtin, other, field)
}

interface TradeUnitWriteContext {
  schemaName:    string
  institutionId: number
  merchandiseId: number
  gtin:          string | null
  gtinField:     string
  factorField:   string
}

/**
 * O UNIQUE da 071 que estourar vira o 409 tipado — e só estoura porque a gravação é INSERT puro (linha nova) ou UPDATE pela PK (linha
 * minha). ⚠️ CONHECIMENTO NEGATIVO (gates da onda 1, 2026-10-18 — ADV-01/ADV-02 provados em schema descartável): `INSERT … ON DUPLICATE
 * KEY UPDATE` numa tabela com UNIQUE além da PK NÃO lança ER_DUP_ENTRY na colisão secundária — ele ATUALIZA a linha que colidiu (o nível
 * de OUTRO produto ganhava a unidade/fator deste; o nível novo sumia com 200/201). Upsert só em tabela cujo único UNIQUE é a PK.
 * A corrida do GTIN: o outro escritor já COMMITOU (a colisão espera a trava dele) — a leitura TRAVANTE enxerga o dono acima do retrato.
 */
async function mapTradeUnitDup(conn: PoolConnection, err: any, ctx: TradeUnitWriteContext): Promise<never> {
  const msg = String(err?.sqlMessage ?? err?.message ?? '')
  if (err?.code === 'ER_DUP_ENTRY' && msg.includes('uq_mtu_live_gtin')) {
    const owner = ctx.gtin == null ? null : await gtinOwner(conn, ctx.schemaName, ctx.institutionId, ctx.gtin, null, true)
    if (owner != null && owner !== ctx.merchandiseId) throw gtinTaken(ctx.gtin!, owner, ctx.gtinField)
    throw new HttpError(409, 'GTIN repetido na grade', [{ field: ctx.gtinField, message: 'GTIN repetido na grade' }], ErrorCodes.GTIN_TAKEN)
  }
  if (err?.code === 'ER_DUP_ENTRY' && msg.includes('uq_mtu_live_unit_factor')) {
    throw new HttpError(409, 'Dois níveis com a mesma unidade e o mesmo fator',
      [{ field: ctx.factorField, message: 'Unidade e fator repetidos' }], ErrorCodes.TRADE_UNIT_DUPLICATE)
  }
  throw err
}

interface StoredBaseUnit { measureId: number; packageId: number | null; gtin: string | null; live: boolean }

function baseLocked(field: string): HttpError {
  return new HttpError(409, 'A unidade-base não muda enquanto houver outro nível vivo — os fatores são em unidades-base; remova ou ajuste os níveis antes',
    [{ field, message: 'Remova os outros níveis antes de trocar a unidade-base' }], ErrorCodes.TRADE_UNIT_BASE_LOCKED)
}

/**
 * D-PR42 (= Q-PR42' (a), Rodada 6): além dos níveis, o que MEDE na unidade-base — o PREÇO vivo da grade ("R$ 0,50 por UN") e o item de
 * pedido ABERTO (status 'A' — o predicado "aberto" da peça `@shared/order`, `assertOrderOpen`; o faturado guarda o congelado da NE-6).
 * Trocar a base com qualquer um deles mudaria o SENTIDO do número sem ninguém decidir. Conta o PREÇO GRAVADO de tabela VIVA (o da
 * própria requisição não — ele já está na base nova; trocar a base de produto com preço = tirar os preços, salvar, trocar a base). Leitura consistente depois da trava do produto (o preço só é escrito sob ela — `@shared/price` pela ficha); o item de pedido NÃO
 * trava o produto: um item que nasce no mesmo instante escapa (limite registrado na Rodada 6).
 */
async function assertBaseUnitFree(
  conn: PoolConnection, schemaName: string, institutionId: number, merchandiseId: number, field: string
): Promise<void> {
  // só o preço de tabela VIVA — o que a grade da ficha mostra (`listProductPrices`); preço de tabela excluída não aparece e não trava
  const [price] = await conn.query<any[]>(
    `SELECT pr.tb_price_list_id AS listId FROM \`${schemaName}\`.tb_price pr
       INNER JOIN \`${schemaName}\`.tb_price_list l
          ON l.id = pr.tb_price_list_id AND l.tb_institution_id = pr.tb_institution_id AND l.deleted = 'N'
      WHERE pr.tb_institution_id = ? AND pr.tb_product_id = ? AND pr.deleted = 'N' LIMIT 1`,
    [institutionId, merchandiseId])
  if ((price as any[]).length > 0) {
    throw new HttpError(409, 'A unidade-base não muda: o produto tem preço na grade, medido nela — remova os preços antes ou cadastre outro produto',
      [{ field, message: 'Produto com preço na unidade-base atual' }], ErrorCodes.TRADE_UNIT_BASE_LOCKED)
  }
  const [order] = await conn.query<any[]>(
    `SELECT i.tb_order_id AS orderId FROM \`${schemaName}\`.tb_order_item i
       INNER JOIN \`${schemaName}\`.tb_order o
          ON o.id = i.tb_order_id AND o.tb_institution_id = i.tb_institution_id AND o.terminal = i.terminal
      WHERE i.tb_institution_id = ? AND i.tb_product_id = ? AND i.deleted = 'N' AND o.deleted = 'N' AND o.status = 'A'
      ORDER BY i.tb_order_id LIMIT 1`,
    [institutionId, merchandiseId])
  if ((order as any[]).length > 0) {
    const orderId = Number((order as any[])[0].orderId)
    throw new HttpError(409, `A unidade-base não muda: o produto está no pedido aberto ${orderId}, medido nela — fature ou retire o item antes`,
      [{ field, message: `Produto no pedido aberto ${orderId}` }], ErrorCodes.TRADE_UNIT_BASE_LOCKED)
  }
}

/**
 * Nível base (1, fator 1). `current` null = a linha NÃO existe → INSERT puro; existe → UPDATE pela PK (só se algo mudou). O GTIN é
 * conferido só quando nasce ou muda de identidade (A-PR1/A-PR3).
 */
async function writeBaseUnit(
  conn: PoolConnection, schemaName: string, institutionId: number, merchandiseId: number, input: MerchandiseInput,
  current: StoredBaseUnit | null
): Promise<void> {
  const gtin = input.baseUnit.gtin ?? null
  const packageId = input.baseUnit.packageId ?? null
  const storedGtin = current?.live ? current.gtin : null
  if (gtin != null && (storedGtin == null || gtinIdentity(gtin) !== gtinIdentity(storedGtin))) {
    await assertGtinFree(conn, schemaName, institutionId, gtin, merchandiseId, 'baseUnit.gtin')
  }
  const ctx: TradeUnitWriteContext = {
    schemaName, institutionId, merchandiseId, gtin, gtinField: 'baseUnit.gtin', factorField: 'baseUnit.measureId',
  }
  try {
    if (current == null) {
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_merchandise_trade_unit
           (tb_institution_id, tb_merchandise_id, level, tb_measure_id, tb_package_id, factor, gtin, created_at, updated_at, deleted)
         VALUES (?, ?, 1, ?, ?, 1, ?, NOW(), NOW(), 'N')`,
        [institutionId, merchandiseId, input.baseUnit.measureId, packageId, gtin])
    } else if (!current.live || current.measureId !== input.baseUnit.measureId || current.packageId !== packageId
               || current.gtin !== gtin) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_merchandise_trade_unit
            SET tb_measure_id = ?, tb_package_id = ?, factor = 1, gtin = ?, deleted = 'N', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = 1`,
        [input.baseUnit.measureId, packageId, gtin, institutionId, merchandiseId])
    }
  } catch (err) {
    await mapTradeUnitDup(conn, err, ctx)
  }
}

/** Especialização fiscal do bem (D-PR22 — do grupo). Só as colunas que a web mantém; as do legado ficam intactas. A PK é o único UNIQUE
 *  de `tb_merchandise` — o upsert aqui é seguro (ver o conhecimento negativo em `mapTradeUnitDup`). */
async function upsertMerchandiseFacts(
  conn: PoolConnection, schemaName: string, institutionId: number, id: number, input: MerchandiseInput
): Promise<void> {
  // indEscala (A-PR6): a LINHA que nasce leva sempre o valor do corpo, e AUSENTE nasce NULL ("não informado" — nunca o DEFAULT 'S' do
  // baseline, que inventava "relevante" — D-SY5), inclusive quando um PUT cria a tb_merchandise que faltava. Na linha que JÁ existe, a
  // coluna só entra no UPDATE quando a chave veio: ausente = o gravado (do sync, inclusive) não muda — a tela que ainda não manda o campo
  // não o apaga.
  const touchScale = input.scaleRelevance !== undefined
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_merchandise
       (id, tb_institution_id, ncm, cest, kind_tributary, source, tb_brand_id, manuf_sign_ind_scale, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE ncm = VALUES(ncm), cest = VALUES(cest), kind_tributary = VALUES(kind_tributary),
                             source = VALUES(source), tb_brand_id = VALUES(tb_brand_id),${
                               touchScale ? ' manuf_sign_ind_scale = VALUES(manuf_sign_ind_scale),' : ''} deleted = 'N', updated_at = NOW()`,
    [id, institutionId, input.ncm ?? null, input.cest ?? null, input.purpose, input.origin, input.brandId, input.scaleRelevance ?? null])
}

/**
 * FABRICANTE (D-PR65 — `tb_merchandise_factory`, especialização 1:1 opcional; A-PR6). Chave AUSENTE = não toca (o DTO garante que, na
 * criação, ausente só vem com o indEscala também ausente — não há fabricante a gravar). CNPJ = upsert pela PK (o ÚNICO UNIQUE da tabela —
 * PADROES §9 regra 10): troca o CNPJ na mesma linha e, se a linha estava morta, revive com o CNPJ NOVO (nunca herda o velho). null = soft
 * delete da linha viva (PADROES §3.1 — nunca DELETE). Roda DEPOIS do upsert de `tb_merchandise` (FK `fk_mf_merchandise`).
 */
async function writeManufacturer(
  conn: PoolConnection, schemaName: string, institutionId: number, id: number, input: MerchandiseInput, isNew: boolean
): Promise<void> {
  if (input.manufacturerCnpj === undefined) return
  if (input.manufacturerCnpj === null) {
    // Mercadoria que acabou de nascer não tem fabricante a limpar — e o UPDATE sem linha viraria trava de intervalo (PADROES §9 regra 12;
    // gate adversarial do delta, LOW-3).
    if (isNew) return
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_merchandise_factory SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND deleted = 'N'`,
      [institutionId, id])
    return
  }
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_merchandise_factory
       (tb_institution_id, tb_merchandise_id, cnpj, created_at, updated_at, deleted)
     VALUES (?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE cnpj = VALUES(cnpj), deleted = 'N', updated_at = NOW()`,
    [institutionId, id, input.manufacturerCnpj])
}

export async function insertMerchandise(
  input: MerchandiseInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // 1º statement da transação: trava da institution + MAX (D-PR2 — protocolo único da peça; nada lido antes).
    const id = await allocateProductId(conn, schemaName, institutionId)
    await assertRefs(conn, input, schemaName, institutionId, null)
    const identifier = identifierOrId(input.identifier, id)
    await assertIdentifierFree(conn, schemaName, institutionId, identifier, null, { automatic: identifier !== (input.identifier ?? '').trim() })

    // D-PR27/D-PR29: publicado/promoção/destaque nascem 'N' (flags de e-commerce — fora da ficha da onda 1).
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_product
         (id, identifier, tb_institution_id, description, kind, tb_category_id, tb_financial_plans_id,
          promotion, highlights, published, active, note, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'N', 'N', 'N', ?, ?, NOW(), NOW(), 'N')`,
      [id, identifier, institutionId, input.description, input.kind, input.categoryId, input.financialPlansId ?? null,
       input.active ?? 'S', input.note ?? null])
    await upsertMerchandiseFacts(conn, schemaName, institutionId, id, input)
    await writeManufacturer(conn, schemaName, institutionId, id, input, true)
    await writeBaseUnit(conn, schemaName, institutionId, id, input, null)
    await syncProductPrices(conn, schemaName, institutionId, id, input.prices ?? [])

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateMerchandise(
  id: number, input: MerchandiseInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Trava da PRÓPRIA linha — leitura travante, não abre o snapshot; kind P/M: nunca edita serviço. Depois a ficha fiscal, NUMA
    // leitura PRÓPRIA (PADROES §9 regra 9: nunca LEFT JOIN travante — a 1:1 ausente deixaria trava de intervalo), na ordem do escritor
    // (produto → tb_merchandise → níveis).
    const [rows] = await conn.query<any[]>(
      `SELECT p.identifier, p.tb_category_id AS categoryId, p.tb_financial_plans_id AS financialPlansId
         FROM \`${schemaName}\`.tb_product p
        WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N' AND p.kind IN ('P', 'M') FOR UPDATE`,
      [id, institutionId])
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    const [mf] = await conn.query<any[]>(
      `SELECT tb_brand_id AS brandId FROM \`${schemaName}\`.tb_merchandise WHERE id = ? AND tb_institution_id = ? FOR UPDATE`,
      [id, institutionId])
    const identifier = identifierOrId(input.identifier, id)
    if (identifier !== rows[0].identifier) {
      // A-PR1: a unicidade só roda quando o código MUDA — e com o lock da institution ANTES da 1ª leitura consistente.
      await lockForIdentifierChange(conn, institutionId)
      await assertIdentifierFree(conn, schemaName, institutionId, identifier, id,
        { automatic: identifier !== (input.identifier ?? '').trim() })
    }
    // TODOS os níveis do produto numa leitura travante (a mesma forma do saveTradeUnits): a base E a presença de outros níveis vivos
    const [lv] = await conn.query<any[]>(
      `SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, gtin, deleted
         FROM \`${schemaName}\`.tb_merchandise_trade_unit
        WHERE tb_institution_id = ? AND tb_merchandise_id = ? FOR UPDATE`,
      [institutionId, id])
    const bu = (lv as any[]).filter(r => Number(r.level) === 1)
    const current: StoredBaseUnit | null = bu[0] ? {
      measureId: Number(bu[0].measureId), packageId: bu[0].packageId == null ? null : Number(bu[0].packageId),
      gtin: bu[0].gtin ?? null, live: bu[0].deleted === 'N',
    } : null
    // D-PR40: o fator dos outros níveis é em unidades-BASE — trocar a unidade da base com outro nível vivo mudaria em silêncio o que
    // "CX × 12" significa (e o qTrib da NF-e); D-PR42: o mesmo vale para o preço vivo e o item de pedido aberto (assertBaseUnitFree)
    const otherLive = (lv as any[]).some(r => Number(r.level) !== 1 && r.deleted === 'N')
    // ADV3-01 (gate adversarial do delta): compara com a unidade GRAVADA no nível 1 — viva OU excluída (a ficha revive a base); sem linha
    // de base e com nível vivo o estado é inconsistente (nenhum escritor da API o produz) — falha fechado, nunca "adota" uma base nova
    if (otherLive && current == null) {
      throw new HttpError(409, 'O produto tem níveis sem unidade-base — corrija os níveis antes de salvar a ficha',
        [{ field: 'baseUnit.measureId', message: 'Níveis sem unidade-base' }], ErrorCodes.TRADE_UNIT_BASE_LOCKED)
    }
    if (current != null && current.measureId !== input.baseUnit.measureId) {
      if (otherLive) throw baseLocked('baseUnit.measureId')
      await assertBaseUnitFree(conn, schemaName, institutionId, id, 'baseUnit.measureId')
    }
    const num = (v: unknown) => (v == null ? null : Number(v))
    await assertRefs(conn, input, schemaName, institutionId, {
      categoryId: num(rows[0].categoryId), financialPlansId: num(rows[0].financialPlansId), brandId: num(mf[0]?.brandId),
      measureId: current?.live ? current.measureId : null, packageId: current?.live ? current.packageId : null,
    })

    // publicado/promoção/destaque NÃO são tocados (D-PR27 — nascem com o consumidor).
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_product
          SET identifier = ?, description = ?, kind = ?, tb_category_id = ?, tb_financial_plans_id = ?,
              active = ?, note = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND kind IN ('P', 'M')`,
      [identifier, input.description, input.kind, input.categoryId, input.financialPlansId ?? null,
       input.active ?? 'S', input.note ?? null, id, institutionId])
    await upsertMerchandiseFacts(conn, schemaName, institutionId, id, input)
    await writeManufacturer(conn, schemaName, institutionId, id, input, false)
    await writeBaseUnit(conn, schemaName, institutionId, id, input, current)
    await syncProductPrices(conn, schemaName, institutionId, id, input.prices ?? [])

    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Soft delete livre (D-PR11): o item já vendido segue pelo id e pelos snapshots. Os NÍVEIS do produto são soft-deletados junto — o
 * GTIN volta a ficar livre para outro produto (D-PR19 vale entre níveis VIVOS); os preços ficam como história (molde do serviço).
 */
export async function softDeleteMerchandise(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_product SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' AND kind IN ('P', 'M')`,
      [id, institutionId])
    if (result.affectedRows === 0) {
      await conn.rollback()
      return false
    }
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_merchandise_trade_unit SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND deleted = 'N'`,
      [institutionId, id])
    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------
// Sub-rota "Unidades e GTIN" (vinculada B — §12.1; D-PR15/D-PR16/D-PR19/D-PR30/D-PR31)
// ---------------------------------------------------------------------

async function merchandiseExists(
  executor: Pick<PoolConnection, 'query'>, id: number, schemaName: string, institutionId: number, lock = false
): Promise<boolean> {
  const [rows] = await executor.query<any[]>(
    `SELECT p.id FROM \`${schemaName}\`.tb_product p
      WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N' AND ${KIND_WHERE}${lock ? ' FOR UPDATE' : ''}`,
    [id, institutionId])
  return rows.length > 0
}

export async function getTradeUnits(
  id: number, schemaName: string, institutionId: number
): Promise<TradeUnitsView | null> {
  assertSchemaName(schemaName)
  if (!(await merchandiseExists(pool as any, id, schemaName, institutionId))) return null
  const [levels] = await pool.query<any[]>(
    `SELECT tu.level, tu.tb_measure_id AS measureId, ms.abbreviation AS measureAbbreviation, ms.description AS measureDescription,
            tu.tb_package_id AS packageId, pk.description AS packageDescription, tu.factor, tu.gtin
       FROM \`${schemaName}\`.tb_merchandise_trade_unit tu
       LEFT JOIN setes_central.tb_measure ms ON ms.id = tu.tb_measure_id
       LEFT JOIN setes_central.tb_package pk ON pk.id = tu.tb_package_id
      WHERE tu.tb_institution_id = ? AND tu.tb_merchandise_id = ? AND tu.deleted = 'N'
      ORDER BY tu.level`,
    [institutionId, id])
  const [m] = await pool.query<any[]>(
    `SELECT taxable_trade_level AS t, default_sale_trade_level AS d FROM \`${schemaName}\`.tb_merchandise
      WHERE id = ? AND tb_institution_id = ?`,
    [id, institutionId])
  return {
    levels: (levels as any[]).map(l => ({ ...l, factor: Number(l.factor) })) as TradeUnitRow[],
    taxableTradeLevel: m[0]?.t ?? null,
    defaultSaleTradeLevel: m[0]?.d ?? null,
  }
}

export async function saveTradeUnits(
  id: number, input: TradeUnitsInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (!(await merchandiseExists(conn, id, schemaName, institutionId, true))) {
      await conn.rollback()
      return false
    }
    // A ficha fiscal (tb_merchandise) é a dona das designações e o alvo da FK dos níveis: produto vindo do legado sem ela → 409 legível
    const [facts] = await conn.query<any[]>(
      `SELECT taxable_trade_level AS t, default_sale_trade_level AS d FROM \`${schemaName}\`.tb_merchandise
        WHERE id = ? AND tb_institution_id = ? FOR UPDATE`,
      [id, institutionId])
    if (!facts[0]) {
      throw new HttpError(409, 'Salve a ficha do produto antes das unidades de venda',
        [{ field: 'id', message: 'Produto sem ficha fiscal — salve a ficha primeiro' }], ErrorCodes.MERCHANDISE_FACTS_MISSING)
    }
    const [existing] = await conn.query<any[]>(
      `SELECT level, tb_measure_id AS measureId, tb_package_id AS packageId, factor, gtin, deleted
         FROM \`${schemaName}\`.tb_merchandise_trade_unit
        WHERE tb_institution_id = ? AND tb_merchandise_id = ? FOR UPDATE`,
      [institutionId, id])
    type Stored = { level: number; measureId: number; packageId: number | null; factor: number; gtin: string | null; deleted: string }
    const all: Stored[] = (existing as any[]).map(r => ({
      level: Number(r.level), measureId: Number(r.measureId), packageId: r.packageId == null ? null : Number(r.packageId),
      factor: Number(r.factor), gtin: r.gtin ?? null, deleted: r.deleted,
    }))
    const live = new Map(all.filter(r => r.deleted === 'N').map(r => [r.level, r]))
    let next = all.reduce((mx, r) => Math.max(mx, r.level), 0) + 1
    if (!live.has(1)) {
      // a base só nasce/renasce pela FICHA (o nível 1 da sub-rota precisa estar vivo) — ADV2-04: a saída é dita, não um 422 sem rumo
      throw new HttpError(409, 'Produto sem unidade-base — salve a ficha do produto (aba Principal) para criá-la',
        [{ field: 'levels', message: 'Salve a ficha do produto para criar a unidade-base' }], ErrorCodes.TRADE_UNIT_BASE_REQUIRED)
    }

    // numera os níveis NOVOS (nunca reaproveita número — um nível excluído não volta com outro significado)
    const final = input.levels.map((l, i) => {
      if (l.level != null && !live.has(l.level)) {
        throw new HttpError(422, `Nível ${l.level} não existe no produto`,
          [{ field: `levels.${i}.level`, message: 'Nível inexistente — nível novo vai sem número' }], ErrorCodes.TRADE_UNIT_NOT_FOUND)
      }
      return { ...l, packageId: l.packageId ?? null, gtin: l.gtin ?? null, level: l.level ?? (next++), index: i, isNew: l.level == null }
    })

    // D-PR15: a base (nível 1, fator 1) nunca sai da grade
    const base = final.find(l => l.level === 1)
    if (!base || base.factor !== 1) {
      throw new HttpError(409, 'A unidade-base (nível 1, fator 1) é obrigatória',
        [{ field: base ? `levels.${base.index}.factor` : 'levels', message: 'A unidade-base fica na grade com fator 1' }],
        ErrorCodes.TRADE_UNIT_BASE_REQUIRED)
    }
    // D-PR40: trocar a unidade da base com outro nível EXISTENTE mantido = 409 (nível novo da mesma grade já nasce na base nova);
    // D-PR42: e com preço vivo ou item de pedido aberto
    if (base.measureId !== live.get(1)!.measureId) {
      if (final.some(l => l.level !== 1 && !l.isNew)) throw baseLocked(`levels.${base.index}.measureId`)
      await assertBaseUnitFree(conn, schemaName, institutionId, id, `levels.${base.index}.measureId`)
    }
    // D-PR31: (unidade, fator) único entre os níveis vivos do produto — o fator chega NORMALIZADO pelo DTO (6 casas, o mesmo do banco)
    const seenUnit = new Set<string>()
    for (const l of final) {
      const key = `${l.measureId}|${l.factor}`
      if (seenUnit.has(key)) {
        throw new HttpError(409, 'Dois níveis com a mesma unidade e o mesmo fator',
          [{ field: `levels.${l.index}.factor`, message: 'Unidade e fator repetidos' }], ErrorCodes.TRADE_UNIT_DUPLICATE)
      }
      seenUnit.add(key)
    }
    // D-PR19: GTIN repetido dentro da própria grade — pela identidade GS1 (A-PR3)
    const seenGtin = new Set<string>()
    for (const l of final) {
      if (l.gtin == null) continue
      if (seenGtin.has(gtinIdentity(l.gtin))) {
        throw new HttpError(409, `GTIN ${l.gtin} repetido na grade`,
          [{ field: `levels.${l.index}.gtin`, message: 'GTIN repetido na grade' }], ErrorCodes.GTIN_TAKEN)
      }
      seenGtin.add(gtinIdentity(l.gtin))
    }
    // D-PR16/D-PR30: a designação aponta um nível da grade FINAL — removê-lo sem trocar a designação é recusado. AUSENTE = a gravada
    // (A-PR2 — a designação nunca muda em silêncio)
    const taxable = input.taxableTradeLevel !== undefined ? input.taxableTradeLevel : (facts[0].t == null ? null : Number(facts[0].t))
    const defaultSale = input.defaultSaleTradeLevel !== undefined
      ? input.defaultSaleTradeLevel : (facts[0].d == null ? null : Number(facts[0].d))
    const kept = new Set(final.map(l => l.level))
    for (const [field, value, label] of [
      ['taxableTradeLevel', taxable, 'tributável'],
      ['defaultSaleTradeLevel', defaultSale, 'de venda padrão'],
    ] as const) {
      if (value != null && !kept.has(value)) {
        if (!live.has(value)) {
          // designação para nível que não está vivo (nunca existiu, ou excluído) — ADV2-05: não é "remoção", é nível inexistente
          throw new HttpError(422, `O nível ${value} não existe na grade`,
            [{ field, message: `Nível ${value} inexistente` }], ErrorCodes.TRADE_UNIT_NOT_FOUND)
        }
        throw new HttpError(409, `O nível ${value} é a unidade ${label} — troque a designação antes de removê-lo`,
          [{ field, message: `Nível ${value} fora da grade` }], ErrorCodes.TRADE_UNIT_DESIGNATED)
      }
    }
    // referências centrais vinculadas + GTIN livre nos OUTROS produtos — só o que NASCE ou MUDA (A-PR1)
    const changedRows = final.filter(l => {
      if (l.isNew) return false
      const cur = live.get(l.level)!
      return cur.measureId !== l.measureId || cur.packageId !== l.packageId || cur.factor !== l.factor || cur.gtin !== l.gtin
    })
    for (const l of final) {
      const cur = l.isNew ? null : live.get(l.level)!
      if (cur == null || cur.measureId !== l.measureId) {
        await assertCatalogItemLinked(conn, MEASURE_CATALOG, schemaName, institutionId, l.measureId, `levels.${l.index}.measureId`)
      }
      if (l.packageId != null && (cur == null || cur.packageId !== l.packageId)) {
        await assertCatalogItemLinked(conn, PACKAGE_CATALOG, schemaName, institutionId, l.packageId, `levels.${l.index}.packageId`)
      }
      if (l.gtin != null && (cur?.gtin == null || gtinIdentity(cur.gtin) !== gtinIdentity(l.gtin))) {
        await assertGtinFree(conn, schemaName, institutionId, l.gtin, id, `levels.${l.index}.gtin`)
      }
    }

    // gravação em DUAS FASES (nunca upsert — conhecimento negativo em `mapTradeUnitDup`):
    //   (1) soft delete dos que saíram; (2) os que MUDAM são estacionados (deleted = 'S' tira GTIN e (unidade, fator) dos UNIQUE) —
    //   troca de GTIN ou de (unidade, fator) entre níveis do mesmo produto sem colisão transitória; (3) UPDATE pela PK de cada um que
    //   muda + INSERT puro de cada nível novo — a colisão que sobrar é de OUTRO produto (corrida) e vira o 409 tipado; (4) designações.
    const removed = [...live.keys()].filter(level => !kept.has(level))
    if (removed.length) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_merchandise_trade_unit SET deleted = 'S', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level IN (?)`,
        [institutionId, id, removed])
    }
    if (changedRows.length) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_merchandise_trade_unit SET deleted = 'S'
          WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level IN (?)`,
        [institutionId, id, changedRows.map(l => l.level)])
    }
    for (const l of [...changedRows, ...final.filter(f => f.isNew)]) {
      const ctx: TradeUnitWriteContext = {
        schemaName, institutionId, merchandiseId: id, gtin: l.gtin,
        gtinField: `levels.${l.index}.gtin`, factorField: `levels.${l.index}.factor`,
      }
      try {
        if (l.isNew) {
          await conn.query(
            `INSERT INTO \`${schemaName}\`.tb_merchandise_trade_unit
               (tb_institution_id, tb_merchandise_id, level, tb_measure_id, tb_package_id, factor, gtin, created_at, updated_at, deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
            [institutionId, id, l.level, l.measureId, l.packageId, l.factor, l.gtin])
        } else {
          await conn.query(
            `UPDATE \`${schemaName}\`.tb_merchandise_trade_unit
                SET tb_measure_id = ?, tb_package_id = ?, factor = ?, gtin = ?, deleted = 'N', updated_at = NOW()
              WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND level = ?`,
            [l.measureId, l.packageId, l.factor, l.gtin, institutionId, id, l.level])
        }
      } catch (err) {
        await mapTradeUnitDup(conn, err, ctx)
      }
    }
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_merchandise SET taxable_trade_level = ?, default_sale_trade_level = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [taxable, defaultSale, id, institutionId])

    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Contagens do painel de vínculos (D-PR25 §10.5 item 4) — cada dono conta o seu; null = produto inexistente. */
export async function getLinks(
  id: number, schemaName: string, institutionId: number
): Promise<MerchandiseLinks | null> {
  assertSchemaName(schemaName)
  if (!(await merchandiseExists(pool as any, id, schemaName, institutionId))) return null
  const [tu] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${schemaName}\`.tb_merchandise_trade_unit
      WHERE tb_institution_id = ? AND tb_merchandise_id = ? AND deleted = 'N'`,
    [institutionId, id])
  return { tradeUnits: Number(tu[0].n), taxRules: await countTaxRulesForProduct(schemaName, institutionId, id) }
}

// ---------------------------------------------------------------------
// Listas de apoio do form (LIMIT 100, escapeLike) — o app fala SÓ com /api/merchandise
// ---------------------------------------------------------------------

/** Categorias de PRODUTO (kind 'P' — a árvore é P/S; serviço tem as dele). */
export async function listCategoriesLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<MerchandiseLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description, description AS name FROM \`${schemaName}\`.tb_category
      WHERE tb_institution_id = ? AND deleted = 'N' AND kind = 'P' AND (? IS NULL OR description LIKE ?)
      ORDER BY description LIMIT 100`,
    [institutionId, like, like])
  return rows
}

export async function listFinancialPlansLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<MerchandiseLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description, description AS name FROM \`${schemaName}\`.tb_financial_plans
      WHERE tb_institution_id = ? AND deleted = 'N' AND (? IS NULL OR description LIKE ?)
      ORDER BY description LIMIT 100`,
    [institutionId, like, like])
  return rows
}

export async function listPriceListsLookup(schemaName: string, institutionId: number): Promise<MerchandiseLookupRow[]> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id, description FROM \`${schemaName}\`.tb_price_list
      WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY description, id LIMIT 100`,
    [institutionId])
  return rows
}

export const listBrandsLookup = (filter: string, schemaName: string, institutionId: number): Promise<CatalogItemRow[]> =>
  listLinkedCatalog(BRAND_CATALOG, schemaName, institutionId, filter)
export const listMeasuresLookup = (filter: string, schemaName: string, institutionId: number): Promise<CatalogItemRow[]> =>
  listLinkedCatalog(MEASURE_CATALOG, schemaName, institutionId, filter)
export const listPackagesLookup = (filter: string, schemaName: string, institutionId: number): Promise<CatalogItemRow[]> =>
  listLinkedCatalog(PACKAGE_CATALOG, schemaName, institutionId, filter)
