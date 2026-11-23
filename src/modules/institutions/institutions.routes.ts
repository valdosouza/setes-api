import { Router } from 'express'
import * as controller from './institutions.controller'

/**
 * Rotas do módulo institutions — montadas em /api/institutions pelo gateway.
 * Espelho no app: apps/web/lib/app/modules/institutions/institutions_module.dart
 *
 * Cadastro de Estabelecimento com cadeia de entidade fiscal (skill
 * cadastro-entidade-fiscal.md). O POST absorveu o onboarding: cria a cadeia,
 * provisiona o schema do cliente e ativa a institution.
 */
const router = Router()

/**
 * @swagger
 * /api/institutions:
 *   get:
 *     summary: Lista estabelecimentos
 *     tags: [Institutions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema: { type: string }
 *         description: Filtra por nome fantasia, razão social ou schema
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, enum: [10, 25, 50, 100], default: 25 }
 *         description: Itens por página (omitido = config page_size do usuário; teto 200)
 *       - in: query
 *         name: criteria
 *         schema: { type: string }
 *         description: 'Pesquisa avançada (D-BA1) — JSON { chave: valor } com as chaves de GET /search-criteria; texto = contém, faixa = { from, to }, lookup = id, options = [valores], bool = true|false. Soma em E com filter. Desconhecida/malformada = 400 SEARCH_CRITERIA_INVALID; valor inválido = 422 SEARCH_CRITERION_INVALID com fields[]'
 *     responses:
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, nickTrade, nameCompany, schemaName, active, sourceKind (W|D — D-PR47/D-OI10) }' }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito à equipe Setes }
 *       500: { description: Erro interno }
 */
router.get('/', controller.list)

/**
 * @swagger
 * /api/institutions/search-criteria:
 *   get:
 *     summary: Critérios da pesquisa avançada da lista de instituições (Super)
 *     description: >
 *       Pesquisa avançada (prompt_pesquisa_avancada.md, D-BA2, Onda 2 §12) — lista branca
 *       declarada no módulo, sem expressão SQL.
 *     tags: [Institutions]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: 'Envelope { ok, data } — lista { key, kind (text|number|money|date|lookup|options|bool|federalId — prefixo da inscrição federal, D-CJ9), labelKey, lookup?, options? }' }
 *       401: { description: Não autenticado }
 *       500: { description: Erro interno }
 */
router.get('/search-criteria', controller.searchCriteria)

/**
 * @swagger
 * /api/institutions/fiscal-exists:
 *   get:
 *     summary: CPF/CNPJ já cadastrado? (verificação antecipada ao sair do campo — decisão 21 Fase 2)
 *     tags: [Institutions]
 *     parameters:
 *       - in: query
 *         name: cpf
 *         schema: { type: string }
 *         description: CPF com 11 dígitos, com ou sem máscara (informe cpf OU cnpj) — canonicalizado pela peça (D-CJ3)
 *       - in: query
 *         name: cnpj
 *         schema: { type: string }
 *         description: CNPJ (12 letras/números + 2 DV — alfanumérico desde 07/2026), com ou sem máscara — canonicalizado pela peça (D-CJ3)
 *       - in: query
 *         name: ignoreId
 *         schema: { type: integer }
 *         description: Entity em edição (ignorada na checagem)
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { exists: boolean } }'
 *       400:
 *         description: Parâmetros inválidos ou dígito verificador não confere
 */
router.get('/fiscal-exists', controller.fiscalExists)

/**
 * @swagger
 * /api/institutions/{id}:
 *   get:
 *     summary: Retorna o estabelecimento COMPLETO (entity + fiscal + endereços/fones/redes + institution)
 *     description: "Além da cadeia: schemaName, active, sourceKind (W a web é dona do catálogo · D o ERP Desktop é dono — D-PR47/D-OI10) e transitionEndedAt (instante da troca D → W, ou null — D-PR73), transitionEndedBy (id de quem fez a troca, ou null), transitionEndedByName (nome de exibição desse usuário, ou null — D-PR57) e transitionEndReason (só em linha do ato antigo, anterior à 081; null na troca — D-PR75)."
 *     tags: [Institutions]
 *     responses:
 *       200: { description: '{ ok, data: { …cadeia, schemaName, active, sourceKind, transitionEndedAt, transitionEndedBy, transitionEndedByName, transitionEndReason } }' }
 *       404: { description: Estabelecimento não encontrado }
 */
router.get('/:id', controller.getById)

/**
 * @swagger
 * /api/institutions:
 *   post:
 *     summary: Cria estabelecimento (cadeia em transação única) + provisiona o schema + contrata as telas estruturais + cria o admin inicial; active='S' só se tudo passar
 *     tags: [Institutions]
 *     description: >
 *       Onboarding completo (A2, 2026-08-15). Além da cadeia fiscal e do
 *       provisionamento do schema, concede o contrato das telas ESTRUTURAIS
 *       (Usuários, Módulos de Menu, Configurações das Interfaces — sem elas o
 *       menu do cliente nasce vazio) e cria o PRIMEIRO ADMIN, com vínculo
 *       kind='admin'. O bloco `admin` é OBRIGATÓRIO: cliente nunca existe sem
 *       dono. Qualquer falha pós-commit deixa a institution active='N'.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entity, personType, schemaName, admin, sourceKind]
 *             properties:
 *               schemaName: { type: string, example: setes_alpha, description: 'Padrão setes_<nome>; IMUTÁVEL depois' }
 *               sourceKind:
 *                 type: string
 *                 enum: [W, D]
 *                 description: 'ORIGEM DOS CADASTROS (D-PR47/D-OI10): W a web é dona do catálogo · D o ERP Desktop é dono (não é trava — D-PR77: o app orienta o usuário). Declarado pelo Super — SEM default; depois só a troca D → W no PUT, com a chave do sincronizador bloqueada (D-PR73/D-PR76).'
 *               admin:
 *                 type: object
 *                 required: [nameCompany, nickTrade, email, password]
 *                 properties:
 *                   nameCompany: { type: string, example: 'Fulano de Tal' }
 *                   nickTrade:   { type: string, example: 'Fulano' }
 *                   email:       { type: string, format: email, description: 'Login do admin — ÚNICO no grupo 2' }
 *                   password:    { type: string, minLength: 8, maxLength: 100, description: 'Texto puro (hash no service). Política D-EA5: mínimo 8, nunca só espaços, fora da lista de senhas comuns, sem o trecho antes do @ do e-mail (4+ letras)' }
 *     responses:
 *       201: { description: '{ ok, data: { id, schemaName, active, adminUserId } }' }
 *       400: { description: 'Validação — inclusive sourceKind ausente/fora de W,D (fields[sourceKind])' }
 *       409: { description: 'schemaName em uso, CPF/CNPJ duplicado ou e-mail já usado como login' }
 *       500: { description: 'Provisionamento ou admin falhou — institution permanece INATIVA' }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/institutions/{id}:
 *   put:
 *     summary: Atualiza a cadeia do estabelecimento (schema_name imutável; sourceKind só troca de D para W)
 *     description: >
 *       `sourceKind` no corpo: igual ao gravado passa; **D → W é a troca da origem dos cadastros** (D-PR73/D-PR76 — virar Web): só com a
 *       chave do sincronizador BLOQUEADA, grava quem trocou e quando (`transitionEndedBy`/`transitionEndedAt`, sem motivo — D-PR75) e cria
 *       as categorias padrão que faltarem; a partir daí a web é a dona do catálogo de base. W → D nunca (D-OI10).
 *     tags: [Institutions]
 *     responses:
 *       200: { description: '{ ok }' }
 *       404: { description: Estabelecimento não encontrado }
 *       409: { description: 'SOURCE_KIND_IMMUTABLE — W → D (nunca volta); SOURCE_KIND_SYNC_KEY_ACTIVE — D → W com a chave do sincronizador ativa ou bloqueada há menos de 5 min (o cache do setes-sync — D-PR78; fields[sourceKind] traz o tempo que falta); CPF/CNPJ duplicado' }
 */
router.put('/:id', controller.update)

/**
 * @swagger
 * /api/institutions/{id}:
 *   delete:
 *     summary: Exclui logicamente o estabelecimento (deleted='S' — a cadeia entity permanece)
 *     tags: [Institutions]
 */
router.delete('/:id', controller.remove)

/**
 * @swagger
 * /api/institutions/{id}/sync-api-key:
 *   get:
 *     summary: Chave de sincronização do estabelecimento (tb_sync_api_key — X-Api-Key do Sincronizador)
 *     tags: [Institutions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { apiKey, establishmentCode, active } | null }'
 *       404:
 *         description: Estabelecimento não encontrado
 */
router.get('/:id/sync-api-key', controller.getSyncKey)

/**
 * @swagger
 * /api/institutions/{id}/sync-api-key:
 *   post:
 *     summary: Gera a chave de sincronização (só quando não existe — 409 se já houver; troca é intervenção manual)
 *     tags: [Institutions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       201:
 *         description: '{ ok: true, data: { apiKey, establishmentCode, active } }'
 *       404:
 *         description: Estabelecimento não encontrado
 *       409:
 *         description: Chave já existe
 */
router.post('/:id/sync-api-key', controller.createSyncKey)

/**
 * @swagger
 * /api/institutions/{id}/sync-api-key/active:
 *   put:
 *     summary: "Pausa/retoma o sincronizador do estabelecimento (D-PR43 + D-PR48 item 1): N = o setes-sync recusa a chave (pausa de emergência), S = retoma a MESMA chave"
 *     description: >
 *       Só PAUSA, reversível. NÃO muda o dono do catálogo (é o fato `sourceKind` — D-PR47), não cria categoria, não confere linhas.
 *       Repetir o estado atual não muda nada. Em W (nativo web, ou transição encerrada para W) não há o que retomar: 409
 *       SYNC_KEY_NOT_FOR_SOURCE. O setes-sync guarda a chave válida em cache por até 5 min (D-SY13: o sincronizador fica INATIVO até
 *       "Ativar sincronia").
 *     tags: [Institutions]
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
 *             required: [active]
 *             properties:
 *               active: { type: string, enum: [S, N] }
 *     responses:
 *       200:
 *         description: "{ ok: true, data: { apiKey, establishmentCode, active } }"
 *       400:
 *         description: active fora de S/N
 *       404:
 *         description: "Estabelecimento não encontrado ou sem chave gerada (SYNC_KEY_MISSING)"
 *       409:
 *         description: "SYNC_KEY_NOT_FOR_SOURCE — retomar em estabelecimento W (sem sincronizador por construção)"
 */
router.put('/:id/sync-api-key/active', controller.setSyncKeyActive)

export default router
