import { Router } from 'express'
import * as channel from './bank-accounts.channel.controller'
import { adminGuard } from '@gateway/admin.guard'

/**
 * Rotas do CANAL API da conta bancária (Onda 2 do Banco Inter — D-I3/D-I4) — montadas em /api/bank-accounts ANTES do roteador
 * guardado do cadastro (`router.use('/bank-accounts', bankAccountsChannelRoutes)` e só depois
 * `router.use('/bank-accounts', catalogOwnerGuard, bankAccountsRoutes)`). O canal (`tb_bank_account_channel`, segredos, token do webhook)
 * é fato que o LEGADO não produz — a web é a única escritora, em qualquer modo do estabelecimento (W/L/P); o CADASTRO da conta
 * (`tb_bank_account`) é o que o legado envia e, em L, fica só consulta (D-PR51, Rodada 7 de produtos — mesmo princípio da D-PR45:
 * cada fato com o seu escritor). Só os caminhos `/:id/channel…` vivem aqui; o resto cai no roteador guardado.
 */
const router = Router()

/**
 * @swagger
 * /api/bank-accounts/{id}/channel:
 *   get:
 *     tags: [BankAccounts]
 *     summary: Canal API da conta (Onda 2 — D-I3/D-I4) — configuração + PRESENÇA/validade dos segredos
 *     description: |
 *       "Esta conta corrente fala com o seu banco por API." 1 canal por conta
 *       (`tb_bank_account_channel`). Devolve `channel` (environment S/P, clientId,
 *       active, inboundToken), `secrets` (certificate/privateKey/clientSecret =
 *       presença; `certificateInfo` com validade lida do arquivo), `bankNumber`,
 *       `adapterSupported` (derivado do banco da conta) e `webhookPath`. Nunca
 *       devolve conteúdo de segredo.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { channel, secrets, bankNumber, adapterSupported, webhookPath } }' }
 *       404: { description: Conta não encontrada }
 *   put:
 *     tags: [BankAccounts]
 *     summary: Cria/altera o canal API da conta (admin)
 *     description: Banco sem adaptador → 422 BANK_CHANNEL_NO_ADAPTER. O `inboundToken` nasce uma vez (rotação é ato próprio).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [environment]
 *             properties:
 *               environment: { type: string, enum: [S, P] }
 *               clientId: { type: string, nullable: true, maxLength: 100 }
 *               active: { type: string, enum: [S, N], default: S }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (mesma forma do GET)' }
 *       403: { description: Só admin }
 *       422: { description: Banco sem adaptador }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Desativa (soft delete) o canal da conta (admin) — segredos ficam no cofre
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 */
router.get('/:id/channel', channel.getChannel)
router.put('/:id/channel', adminGuard, channel.putChannel)
router.delete('/:id/channel', adminGuard, channel.deleteChannel)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/secrets:
 *   put:
 *     tags: [BankAccounts]
 *     summary: Envia os segredos do canal — WRITE-ONLY (admin)
 *     description: |
 *       D-I3: certificado mTLS (PEM), chave privada (PEM) e client_secret vão para
 *       `SECRETS_PATH/<schema>/bank-account/<id>/<S|P>/…`, NUNCA para o banco de
 *       dados nem para o repositório. Cada campo é opcional (o que vier é gravado).
 *       A resposta só traz presença e validade — jamais o conteúdo.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               certificatePem: { type: string }
 *               privateKeyPem: { type: string }
 *               clientSecret: { type: string }
 *     responses:
 *       200: { description: 'Envelope { ok, data } (forma do GET /channel)' }
 *       400: { description: PEM inválido }
 *       409: { description: Canal ainda não configurado }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Apaga os segredos do canal no cofre (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 */
router.put('/:id/channel/secrets', adminGuard, channel.putSecrets)
router.delete('/:id/channel/secrets', adminGuard, channel.deleteSecrets)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/rotate-token:
 *   post:
 *     tags: [BankAccounts]
 *     summary: Gera novo token de entrada do webhook (admin) — a URL cadastrada no banco muda
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data } (forma do GET /channel)' }
 * /api/bank-accounts/{id}/channel/test:
 *   post:
 *     tags: [BankAccounts]
 *     summary: Prova de vida do canal — autentica no banco (token + mTLS) e lê o webhook cadastrado
 *     description: Não escreve nada no banco. Erros legíveis — BANK_CHANNEL_SECRET_MISSING, BANK_CHANNEL_CERT_EXPIRED, BANK_AUTH_FAILED, BANK_UNAVAILABLE.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { ok, webhook, environment } }' }
 *       409: { description: Canal/segredo/certificado/autenticação }
 *       503: { description: Banco indisponível }
 */
router.post('/:id/channel/rotate-token', adminGuard, channel.rotateToken)
router.post('/:id/channel/test', adminGuard, channel.test)   // gasta cota do banco: só admin (LOW-3 do gate, assunção Q-I7)

/**
 * @swagger
 * /api/bank-accounts/{id}/channel/webhook:
 *   get:
 *     tags: [BankAccounts]
 *     summary: Webhook cadastrado NO BANCO (estado remoto — nunca flag local)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok, data: { url, createdAt, updatedAt } | null }' }
 *   put:
 *     tags: [BankAccounts]
 *     summary: Cadastra/altera o webhook no banco (admin; Onda 4 — exige URL https pública)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [url], properties: { url: { type: string, format: uri } } }
 *     responses:
 *       200: { description: 'Envelope { ok, data }' }
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Remove o webhook no banco (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: integer } }]
 *     responses:
 *       200: { description: 'Envelope { ok }' }
 */
router.get('/:id/channel/webhook', channel.getWebhook)
router.put('/:id/channel/webhook', adminGuard, channel.putWebhook)
router.delete('/:id/channel/webhook', adminGuard, channel.deleteWebhook)

export default router
