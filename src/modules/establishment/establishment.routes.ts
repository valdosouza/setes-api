import { Router } from 'express'
import * as controller from './establishment.controller'

/**
 * Rotas do módulo establishment — montadas em /api/establishment pelo
 * gateway (adminGuard): permite ao ADMIN do próprio institution ler/editar
 * um SUBCONJUNTO RESTRITO da cadeia fiscal do PRÓPRIO estabelecimento.
 * NUNCA aceita :id de rota — o institutionId vem sempre do token
 * (IDOR eliminado por construção). Espelho no app: apps/web/lib/app/
 * modules/establishment/.
 *
 * document/personType (CPF/CNPJ e o toggle F/J) são SOMENTE LEITURA no
 * PUT: o cadastro completo com troca de documento continua exclusivo do
 * Super via /api/institutions/:id.
 */
const router = Router()

/**
 * @swagger
 * /api/establishment:
 *   get:
 *     summary: Retorna os dados do PRÓPRIO estabelecimento (institutionId do token — nunca de :id)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: '{ ok: true, data: { nameCompany, nickTrade, document, personType, ie, im, taxRegime, simplesRegime, simplesAssessment, simplesTotalTaxAliquot, specialTaxRegime, cnae, addresses, phones, socials } }'
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *       500: { description: Erro interno }
 */
router.get('/', controller.get)

/**
 * @swagger
 * /api/establishment:
 *   put:
 *     summary: Atualiza o SUBCONJUNTO editável do próprio estabelecimento (document/personType são somente leitura — ignorados se enviados)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nameCompany, nickTrade, ie, im, addresses, phones, socials]
 *             properties:
 *               nameCompany: { type: string, example: 'Fulano de Tal Ltda' }
 *               nickTrade:   { type: string, nullable: true, example: 'Fulano' }
 *               ie:          { type: string, nullable: true }
 *               im:          { type: string, nullable: true }
 *               taxRegime:
 *                 type: string
 *                 nullable: true
 *                 description: >-
 *                   Regime tributário do estabelecimento (D39 — rótulo canônico
 *                   de TAX_REGIMES; grava em tb_entity_tax do próprio emitente,
 *                   preservando os demais campos). Omitido = não toca.
 *                   D42 — troca de GRUPO (Simples 1/2 × Normal 3) REMOVE das
 *                   regras de tributação o código do regime antigo (indo p/
 *                   Simples zera o CST; p/ Normal zera o CSOSN): as regras
 *                   ficam pendentes no /billing/validate até serem revisadas.
 *                 example: '1 - Simples Nacional'
 *               simplesRegime:     { type: string, nullable: true, enum: ['1', '2', '3'], description: 'opSimpNac do DPS — 1 não optante · 2 MEI · 3 ME/EPP' }
 *               simplesAssessment: { type: string, nullable: true, enum: ['1', '2', '3'], description: 'regApTribSN — obrigatório com simplesRegime 3 (Q-N36; 422 REQUIRED_FIELDS no estado resultante)' }
 *               simplesTotalTaxAliquot: { type: number, nullable: true, minimum: 0.01, maximum: 99.99, example: 6.00, description: 'pTotTribSN — % aproximado da alíquota efetiva do Simples (DAS); obrigatório com simplesRegime 3 (Q-N37); sair do regime 3 limpa' }
 *               specialTaxRegime:  { type: string, nullable: true, enum: ['0', '1', '2', '3', '4', '5', '6'] }
 *               cnae:              { type: string, nullable: true, pattern: '^\d{7}$' }
 *               addresses:
 *                 type: array
 *                 items: { type: object }
 *               phones:
 *                 type: array
 *                 items: { type: object }
 *               socials:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       200:
 *         description: >-
 *           { ok: true, data: EstablishmentDto + ibscbsAssessmentNotice }. D-IB105: ibscbsAssessmentNotice = { validFrom } (início da
 *           1ª opção FUTURA 2/3 de apuração do IBS/CBS) quando ESTE salvamento tirou o estabelecimento do Simples (simplesRegime gravado
 *           3/4 → outro); null = sem aviso. Aviso que NÃO bloqueia: o salvamento já gravou; o faturamento a partir dessa data será
 *           recusado até a opção ser excluída ou trocada (aba Regime IBS/CBS).
 *       400: { description: Validação falhou }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *       500: { description: Erro interno }
 */
router.put('/', controller.update)

// ---------------------------------------------------------------------------
// Sub-recurso EMISSOR FISCAL (Onda 3 NFS-e / NF-e — conceito A, migration 058):
// habilitação POR MODELO (SE · 55; 65 na onda do PDV) + certificado A1 ÚNICO do
// estabelecimento (D-N31; write-only, .pfx + senha → par PEM no cofre). adminGuard herdado do
// gateway; institution SEMPRE do token.
// ---------------------------------------------------------------------------

// F2a, etapa A3 (D-F4/D-F12/D-F112): as 5 rotas do EMISSOR fiscal (habilitação por modelo e A1) MORRERAM — o app fala com a
// nfse-api direto (`/v1/emitter/*`; A1 cifrado no fiscal_api — D-F16). A SÉRIE da nota por modelo é leitura só no ERP
// (`@shared/invoice-series`), sem tela até o 1º cliente de mercadoria.

// ---------------------------------------------------------------------------
// Sub-recurso OPÇÃO DE APURAÇÃO DO IBS/CBS do Simples (`regApIBSCBSSN` — D-IB99/D-IB100, prompt_fase_ibs_cbs.md §14):
// fato DATADO do estabelecimento (tabela da migration 077), escrito SÓ por aqui pela peça
// @shared/ibscbs-assessment. adminGuard herdado do gateway; institution SEMPRE do token; a data de início é a identidade.
// Lista curta de um único registro (sem paginação — como a habilitação do emissor).
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/establishment/ibscbs-assessments:
 *   get:
 *     summary: Opções de apuração do IBS/CBS do PRÓPRIO estabelecimento (histórico datado + a vigente hoje)
 *     description: >-
 *       Sem linha vale 1 (IBS e CBS pelo Simples — efeito legal de não optar, D-IB1). Só a opção 1 é SUPORTADA hoje: com 2/3
 *       vigente na competência o faturamento recusa a nota (422 IBSCBS_REGULAR_REGIME_UNSUPPORTED — D-IB99). Só linha FUTURA é
 *       editável (`editable`).
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: >-
 *           { ok: true, data: { today: 'AAAA-MM-DD', lastInvoice: 'AAAA-MM-DD' (null = nenhuma nota), firstStart: 'AAAA-MM-DD' (1º início aceito — D-IB101), simplesRegime (opSimpNac gravado), regularAllowed (2/3 admitidos — D-IB102), desktopEmission (tem sincronizador — a opção governa só as notas deste sistema, D-IB104), regularStart: '2027-01-01', supported: ['1'],
 *           current: { assessment, validFrom (null = sem linha), supported },
 *           items: [{ validFrom, assessment, supported, inEffect, editable }] } }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *   post:
 *     summary: Registra uma opção de apuração do IBS/CBS com início HOJE ou depois (2/3 só a partir de 01/01/2027)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [validFrom, assessment]
 *             properties:
 *               validFrom:  { type: string, format: date, example: '2027-01-01' }
 *               assessment:
 *                 type: string
 *                 enum: ['1', '2', '3']
 *                 description: 'regApIBSCBSSN (NT 009) — 1 IBS e CBS pelo SN · 2 CBS pelo SN e IBS pelo regime regular · 3 IBS e CBS pelo regime regular'
 *     responses:
 *       201: { description: '{ ok: true, data: (a mesma visão do GET, atualizada) }' }
 *       400: { description: 'Validação falhou (VALIDATION_FAILED) ou campo apertado pelo cliente vazio (REQUIRED_FIELDS)' }
 *       409: { description: 'IBSCBS_ASSESSMENT_DUPLICATE — já existe opção viva com essa data · IBSCBS_ASSESSMENT_INVOICED — início ≤ a última nota viva (D-IB101: a opção nunca muda o que uma nota já leu)' }
 *       422: { description: 'IBSCBS_ASSESSMENT_DATE_PAST (início antes de hoje) · IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY (2/3 antes de 01/01/2027) · IBSCBS_ASSESSMENT_NOT_SIMPLES (2/3 sem opSimpNac 3/4 gravado — D-IB102)' }
 */
router.get('/ibscbs-assessments', controller.listIbscbsAssessments)
router.post('/ibscbs-assessments', controller.createIbscbsAssessment)

/**
 * @swagger
 * /api/establishment/ibscbs-assessments/{validFrom}:
 *   put:
 *     summary: Troca a opção de uma linha FUTURA (a data é a identidade — mudar a data = excluir e registrar outra)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: validFrom, required: true, schema: { type: string, format: date } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assessment]
 *             properties:
 *               assessment: { type: string, enum: ['1', '2', '3'] }
 *     responses:
 *       200: { description: '{ ok: true, data: (a visão atualizada) }' }
 *       400: { description: 'Data/opção inválida (VALIDATION_FAILED)' }
 *       404: { description: IBSCBS_ASSESSMENT_NOT_FOUND }
 *       409: { description: 'IBSCBS_ASSESSMENT_IN_EFFECT — linha vigente ou passada é imutável · IBSCBS_ASSESSMENT_INVOICED — início ≤ a última nota viva (D-IB101)' }
 *       422: { description: 'IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY · IBSCBS_ASSESSMENT_NOT_SIMPLES (2/3 sem opSimpNac 3/4 gravado — D-IB102)' }
 *   delete:
 *     summary: Exclui (soft) uma linha FUTURA — o cancelamento da opção antes de ela valer
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: validFrom, required: true, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: '{ ok: true, data: (a visão atualizada) }' }
 *       400: { description: 'Data inválida (VALIDATION_FAILED)' }
 *       404: { description: IBSCBS_ASSESSMENT_NOT_FOUND }
 *       409: { description: 'IBSCBS_ASSESSMENT_IN_EFFECT — linha vigente ou passada é imutável · IBSCBS_ASSESSMENT_INVOICED — início ≤ a última nota viva (D-IB101)' }
 */
router.put('/ibscbs-assessments/:validFrom', controller.changeIbscbsAssessment)
router.delete('/ibscbs-assessments/:validFrom', controller.removeIbscbsAssessment)

// ---------------------------------------------------------------------------
// Sub-recurso PERCENTUAL DO SIMPLES NO IBS/CBS (setes-api:IBS.E9.P5, D-IB138): o percentual efetivo (`pIBSSN`/`pCBSSN`) de cada
// mês, tabela da migration 084, escrita SÓ pela peça @shared/ibscbs-simples-rate. adminGuard herdado do gateway; institution
// SEMPRE do token; o mês 'AAAA-MM' é a identidade. Qualquer mês pode ser cadastrado, editado ou removido (A-IB138g).
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/establishment/simples-rates:
 *   get:
 *     summary: Percentuais do Simples no IBS/CBS do PRÓPRIO estabelecimento, do mês mais novo para o mais antigo
 *     description: >-
 *       Sem percentual cadastrado para o mês da nota, o faturamento do Simples no DAS RECUSA (422 BILLING_IBSCBS_SIMPLES_RATE_REQUIRED
 *       — D-IB140), desde a data de início (configuração `billing/ibscbs_simples_start`, nunca antes de 2027-01-01 — D-IB141).
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: "{ ok: true, data: [{ competence: 'AAAA-MM', ibsRate: '0.1000', cbsRate: '0.9000', ibsPpm, cbsPpm }] }" }
 *       401: { description: Não autenticado }
 *       403: { description: Restrito a administradores }
 *   post:
 *     summary: Cadastra o percentual de um mês
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [competence, ibsRate, cbsRate]
 *             properties:
 *               competence: { type: string, example: '2027-01', description: 'Mês AAAA-MM' }
 *               ibsRate:    { type: string, example: '0.1000', description: 'pIBSSN em % (0 a 100, até 4 casas); número também é aceito' }
 *               cbsRate:    { type: string, example: '0.9000', description: 'pCBSSN em % (0 a 100, até 4 casas); número também é aceito' }
 *     responses:
 *       201: { description: '{ ok: true, data: (a lista atualizada) }' }
 *       400: { description: 'VALIDATION_FAILED ou IBSCBS_SIMPLES_RATE_INVALID (mês fora de AAAA-MM, percentual fora de 0 a 100 ou com mais de 4 casas)' }
 *       409: { description: 'IBSCBS_SIMPLES_RATE_DUPLICATE — já existe percentual vivo para o mês' }
 */
router.get('/simples-rates', controller.listSimplesRatesHandler)
router.post('/simples-rates', controller.createSimplesRateHandler)

/**
 * @swagger
 * /api/establishment/simples-rates/{competence}:
 *   put:
 *     summary: Troca os percentuais de um mês já cadastrado (o mês é a identidade)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: competence, required: true, schema: { type: string, example: '2027-01' } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ibsRate, cbsRate]
 *             properties:
 *               ibsRate: { type: string, example: '0.1000' }
 *               cbsRate: { type: string, example: '0.9000' }
 *     responses:
 *       200: { description: '{ ok: true, data: (a lista atualizada) }' }
 *       400: { description: 'VALIDATION_FAILED ou IBSCBS_SIMPLES_RATE_INVALID' }
 *       404: { description: IBSCBS_SIMPLES_RATE_NOT_FOUND }
 *   delete:
 *     summary: Exclui (soft) o percentual de um mês; a nota já emitida não muda (o item guarda o percentual que usou)
 *     tags: [Establishment]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: competence, required: true, schema: { type: string, example: '2027-01' } }
 *     responses:
 *       200: { description: '{ ok: true, data: (a lista atualizada) }' }
 *       400: { description: IBSCBS_SIMPLES_RATE_INVALID (mês fora de AAAA-MM) }
 *       404: { description: IBSCBS_SIMPLES_RATE_NOT_FOUND }
 */
router.put('/simples-rates/:competence', controller.changeSimplesRateHandler)
router.delete('/simples-rates/:competence', controller.removeSimplesRateHandler)

export default router
