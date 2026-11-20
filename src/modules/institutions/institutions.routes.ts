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
 *       200: { description: 'Envelope paginado { ok, data, page, pageSize, total } — data lista { id, nickTrade, nameCompany, schemaName, active, sourceKind (W|L|P — D-PR47) }' }
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
 *     description: "Além da cadeia: schemaName, active, sourceKind (W nativo web · L transição do desktop legado · P PDV — D-PR47) e transitionEndedAt (instante do ato encerrar a transição, ou null — D-PR48), transitionEndedBy (id do usuário que executou o ato, ou null), transitionEndedByName (nome de exibição desse usuário, ou null — D-PR57) e transitionEndReason (o motivo, ou null — D-PR53; nascem juntos)."
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
 *                 enum: [W, L, P]
 *                 description: 'ORIGEM DOS CADASTROS (D-PR47): W nativo web · L transição do desktop legado (catálogo de base do legado, web só consulta) · P PDV (catálogo da web). Declarado pelo Super — SEM default; imutável depois (só o ato encerrar a transição muda L → W/P).'
 *               admin:
 *                 type: object
 *                 required: [nameCompany, nickTrade, email, password]
 *                 properties:
 *                   nameCompany: { type: string, example: 'Fulano de Tal' }
 *                   nickTrade:   { type: string, example: 'Fulano' }
 *                   email:       { type: string, format: email, description: 'Login do admin — ÚNICO no grupo 2' }
 *                   password:    { type: string, minLength: 5, description: 'Texto puro; o hash MD5 é aplicado no service' }
 *     responses:
 *       201: { description: '{ ok, data: { id, schemaName, active, adminUserId } }' }
 *       400: { description: 'Validação — inclusive sourceKind ausente/fora de W,L,P (fields[sourceKind])' }
 *       409: { description: 'schemaName em uso, CPF/CNPJ duplicado ou e-mail já usado como login' }
 *       500: { description: 'Provisionamento ou admin falhou — institution permanece INATIVA' }
 */
router.post('/', controller.create)

/**
 * @swagger
 * /api/institutions/{id}:
 *   put:
 *     summary: Atualiza a cadeia do estabelecimento (schema_name e sourceKind são imutáveis)
 *     description: "`sourceKind` no corpo é só CONFERÊNCIA: igual ao gravado passa; diferente = 409 SOURCE_KIND_IMMUTABLE (a origem dos cadastros só muda pelo ato encerrar a transição — D-PR47/D-PR48)."
 *     tags: [Institutions]
 *     responses:
 *       200: { description: '{ ok }' }
 *       404: { description: Estabelecimento não encontrado }
 *       409: { description: 'SOURCE_KIND_IMMUTABLE — sourceKind diferente do gravado; CPF/CNPJ duplicado' }
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

/**
 * @swagger
 * /api/institutions/{id}/end-legacy-transition:
 *   post:
 *     summary: "ENCERRA a transição do desktop legado (D-PR48/D-PR49) — ato ÚNICO e IRREVERSÍVEL do Super: L → W (sem PDV) ou L → P (com PDV)"
 *     description: >
 *       Só para estabelecimento com origem dos cadastros L. Numa transação: grava `transitionEndedAt`, o autor (usuário do token) e o
 *       motivo (aparado) no MESMO comando que muda `sourceKind` para o destino (D-PR53 — o GET /:id devolve autor e motivo),
 *       cria as categorias padrão que faltarem ("Produtos"/"Serviços") e, no destino W, inativa a chave do sincronizador em definitivo
 *       (nunca reativa); no destino P a chave fica — é a dos PDVs, que passam a receber o catálogo da web (grupo do sync / frente
 *       tb_terminal). A partir daí a web é a dona do catálogo de base (D-PR47/D-PR52). Motivo e autor também vão ao log.
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
 *             required: [destination, reason]
 *             properties:
 *               destination: { type: string, enum: [W, P] }
 *               reason:      { type: string, minLength: 5, maxLength: 255 }
 *     responses:
 *       200:
 *         description: "{ ok: true, data: { sourceKind, transitionEndedAt, defaultCategories: { P, S }, syncKeysInactivated } }"
 *       400:
 *         description: destino fora de W/P ou motivo ausente/curto
 *       404:
 *         description: Estabelecimento não encontrado
 *       409:
 *         description: "LEGACY_TRANSITION_NOT_APPLICABLE — a origem não é L (inclusive transição já encerrada: o ato é único; fields[transitionEndedAt] traz o instante) / LEGACY_TRANSITION_DESTINATION_PENDING — destino P indisponível até o setes-sync honrar o fato (barreira interina A-PR5/Q-PR62; roteiro: parar o servidor desktop ANTES do ato)"
 */
router.post('/:id/end-legacy-transition', controller.endTransition)

export default router
