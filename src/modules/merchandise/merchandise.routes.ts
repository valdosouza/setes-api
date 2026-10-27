import { Router } from 'express'
import * as controller from './merchandise.controller'
import { requirePrivilege } from '@shared/auth/require-privilege'
import { PRIVILEGE_CATALOGAR } from '@shared/auth/privileges'

/**
 * Rotas do módulo merchandise — /api/merchandise (espelha /home/merchandise no app; rótulo da tela "Produtos" — D-PR3). Cadastro de
 * MERCADORIA do cliente (tb_product kind P/M + tb_merchandise + unidades de venda tb_merchandise_trade_unit); gate técnico = flag
 * 'merchandise'. Liberação comercial só para cliente SEM legado (D3 do serviço / D-PR14 — item 7 do roteiro de implantação web).
 * Sub-rota B "Unidades e GTIN" em /:id/trade-units; painel de vínculos em /:id/links (D-PR25). Rotas fixas ANTES de /:id.
 */
const router = Router()

/** D-PR33: criar no catálogo CENTRAL (compartilhado entre clientes; o 1º criador fixa a descrição) exige o ato CATALOGAR na
 *  interface `merchandise` — admin passa (D32); a interface tem de estar contratada para todos (D-F37). */
const catalogar = requirePrivilege('merchandise', PRIVILEGE_CATALOGAR)

/**
 * @swagger
 * /api/merchandise:
 *   get:
 *     summary: Lista paginada de mercadorias (tb_product kind P/M) da institution
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Contém em descrição e código; igualdade exata no GTIN de qualquer nível vivo
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID'
 *     responses:
 *       200: { description: "{ ok, data, page, pageSize, total }" }
 *       401: { description: Sem JWT }
 *       403: { description: Flag desabilitada }
 *       500: { description: Erro interno }
 *   post:
 *     summary: Cria a mercadoria (produto + fatos fiscais + unidade-base + grade de preços) numa transação
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, categoryId, brandId, baseUnit]
 *             properties:
 *               identifier: { type: string, description: "Código (≤ 50); em branco = o próprio id. Único entre os produtos vivos (D-PR7)" }
 *               description: { type: string }
 *               kind: { type: string, enum: [P, M], description: "P acabado · M matéria-prima (D-PR4)" }
 *               categoryId: { type: integer, description: "Categoria de PRODUTO (kind P)" }
 *               financialPlansId: { type: integer, nullable: true }
 *               brandId: { type: integer, description: "Marca vinculada à institution (D-PR5)" }
 *               active: { type: string, enum: [S, N] }
 *               note: { type: string, nullable: true }
 *               ncm: { type: string, nullable: true, description: "8 dígitos (D36); sem NCM o faturamento barra" }
 *               cest: { type: string, nullable: true, description: "7 dígitos; a ST é DERIVADA da presença do CEST" }
 *               origin: { type: string, description: "0–8 (tabela A do CST)" }
 *               purpose: { type: string, description: "0–7 (finalidade)" }
 *               baseUnit: { type: object, description: "Nível 1, fator 1: { measureId, packageId?, gtin? } — GTIN 8/12/13/14 com DV GS1" }
 *               prices: { type: array, items: { type: object }, description: "[{ priceListId, priceTag (null = remove), aliqKickback? }]" }
 *     responses:
 *       201: { description: "{ ok, data: { id } }" }
 *       400: { description: "Payload inválido ou referência inexistente (fields[])" }
 *       409: { description: "PRODUCT_IDENTIFIER_TAKEN / GTIN_TAKEN (fields[1] = id do outro produto) / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *       422: { description: CATALOG_ITEM_NOT_LINKED }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @swagger
 * /api/merchandise/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de mercadorias (sem expressão SQL)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind, labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/merchandise/categories:
 *   get:
 *     summary: Lookup das categorias de PRODUTO vivas (kind P) da institution
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, name }] }" }
 */
router.get('/categories', controller.categoriesLookup)

/**
 * @swagger
 * /api/merchandise/financial-plans:
 *   get:
 *     summary: Lookup dos planos financeiros vivos da institution
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, name }] }" }
 */
router.get('/financial-plans', controller.financialPlansLookup)

/**
 * @swagger
 * /api/merchandise/price-lists:
 *   get:
 *     summary: Tabelas de preço vivas (grade do produto novo)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description }] }" }
 */
router.get('/price-lists', controller.priceListsLookup)

/**
 * @swagger
 * /api/merchandise/brands:
 *   get:
 *     summary: Lookup das marcas VINCULADAS e ativas da institution (catálogo central — D-PR5)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, abbreviation, name }] }" }
 *   post:
 *     summary: Cria a marca na hora (dedupe pela descrição na central + vínculo com a institution)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string }
 *     responses:
 *       201: { description: "{ ok, data: { id, reused } } — reused = já existia na central" }
 *       409: { description: "RESOURCE_BUSY — outro criador segura o catálogo central (trava nomeada) por mais de 10 s; tente de novo / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *       403: { description: "PRIVILEGE_REQUIRED — falta o ato CATALOGAR na interface merchandise (D-PR33) / INTERFACE_NOT_ALLOWED" }
 */
router.get('/brands', controller.brandsLookup)
router.post('/brands', catalogar, controller.createBrand)

/**
 * @swagger
 * /api/merchandise/measures:
 *   get:
 *     summary: Lookup das unidades de medida VINCULADAS e ativas (catálogo central — D-PR28)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, abbreviation, name }] }" }
 *   post:
 *     summary: Cria a unidade na hora (dedupe pela ABREVIAÇÃO — é o uCom/uTrib da NF-e) + vínculo
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, abbreviation]
 *             properties:
 *               description: { type: string }
 *               abbreviation: { type: string, description: "1 a 5 caracteres" }
 *     responses:
 *       201: { description: "{ ok, data: { id, reused } }" }
 *       409: { description: "RESOURCE_BUSY — outro criador segura o catálogo central (trava nomeada) por mais de 10 s; tente de novo / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *       403: { description: "PRIVILEGE_REQUIRED — falta o ato CATALOGAR na interface merchandise (D-PR33) / INTERFACE_NOT_ALLOWED" }
 */
router.get('/measures', controller.measuresLookup)
router.post('/measures', catalogar, controller.createMeasure)

/**
 * @swagger
 * /api/merchandise/packages:
 *   get:
 *     summary: Lookup das embalagens VINCULADAS e ativas (catálogo central — D-PR28)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ ok, data: [{ id, description, abbreviation, name }] }" }
 *   post:
 *     summary: Cria a embalagem na hora (dedupe pela descrição) + vínculo
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string }
 *               abbreviation: { type: string, nullable: true, description: "até 3 caracteres" }
 *     responses:
 *       201: { description: "{ ok, data: { id, reused } }" }
 *       409: { description: "RESOURCE_BUSY — outro criador segura o catálogo central (trava nomeada) por mais de 10 s; tente de novo / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *       403: { description: "PRIVILEGE_REQUIRED — falta o ato CATALOGAR na interface merchandise (D-PR33) / INTERFACE_NOT_ALLOWED" }
 */
router.get('/packages', controller.packagesLookup)
router.post('/packages', catalogar, controller.createPackage)

/**
 * @swagger
 * /api/merchandise/{id}:
 *   get:
 *     summary: Ficha da mercadoria (catálogo + fiscal + unidade-base + designações + grade de preços)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data } — st é DERIVADO do CEST; baseUnit null = produto sem nível base (veio do legado)" }
 *       404: { description: Não encontrado (ou é serviço) }
 *   put:
 *     summary: Atualiza a mercadoria (mesmo corpo do POST; publicado/promoção/destaque não são tocados — D-PR27)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 *       409: { description: "PRODUCT_IDENTIFIER_TAKEN / GTIN_TAKEN (fields[1] = id do dono) / TRADE_UNIT_BASE_LOCKED (trocar a unidade-base com outro nível vivo — D-PR40 — ou com preço gravado na grade / item em pedido aberto — D-PR42) / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *   delete:
 *     summary: Soft delete (D-PR11) — os níveis saem junto (o GTIN volta a ficar livre); preços ficam como história
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok }" }
 *       404: { description: Não encontrado }
 *       409: { description: "CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 */
router.get('/:id', controller.getOne)
router.put('/:id', controller.update)
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/merchandise/{id}/trade-units:
 *   get:
 *     summary: Unidades de venda do produto (níveis vivos) + designações tributável e de venda padrão (D-PR15/D-PR16)
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: { levels: [{ level, measureId, measureAbbreviation, packageId, factor, gtin }], taxableTradeLevel, defaultSaleTradeLevel } }" }
 *       404: { description: Não encontrado }
 *   put:
 *     summary: Grava a grade inteira de níveis + as designações numa transação (presença = sincroniza)
 *     description: "Nível sem número = NOVO (a API numera; número nunca é reaproveitado). O nível 1 (base, fator 1) não sai da grade. Nível ausente = soft delete, salvo se designado (D-PR30)."
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [levels]
 *             properties:
 *               levels: { type: array, items: { type: object }, description: "[{ level?, measureId, packageId?, factor, gtin? }]" }
 *               taxableTradeLevel: { type: integer, nullable: true, description: "AUSENTE = mantém a gravada (A-PR2); null = a própria unidade vendida" }
 *               defaultSaleTradeLevel: { type: integer, nullable: true, description: "AUSENTE = mantém a gravada (A-PR2); null = a unidade-base" }
 *     responses:
 *       200: { description: "{ ok }" }
 *       409: { description: "TRADE_UNIT_BASE_REQUIRED / TRADE_UNIT_DUPLICATE (D-PR31) / TRADE_UNIT_DESIGNATED (D-PR30) / GTIN_TAKEN (D-PR19) / MERCHANDISE_FACTS_MISSING (produto sem ficha fiscal — salve a ficha antes) / TRADE_UNIT_BASE_LOCKED (D-PR40; D-PR42: preço gravado ou item em pedido aberto) / CATALOG_LEGACY_OWNED (transição do legado, source_kind L — só consulta, D-PR32/D-PR47)" }
 *       422: { description: "TRADE_UNIT_NOT_FOUND / CATALOG_ITEM_NOT_LINKED" }
 */
router.get('/:id/trade-units', controller.getTradeUnits)
router.put('/:id/trade-units', controller.putTradeUnits)

/**
 * @swagger
 * /api/merchandise/{id}/links:
 *   get:
 *     summary: Contagens do painel de vínculos da ficha (D-PR25) — cada dono conta o seu
 *     tags: [merchandise]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ ok, data: { tradeUnits, taxRules } }" }
 *       404: { description: Não encontrado }
 */
router.get('/:id/links', controller.links)

export default router
