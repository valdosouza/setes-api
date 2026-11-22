import { Router } from 'express'
import * as controller from './services.controller'
import { requirePrivilege } from '@shared/auth/require-privilege'
import { PRIVILEGE_ALTERAR } from '@shared/auth/privileges'

/**
 * D-PR45 (Rodada 7 do cadastro de produtos, Valdo 2026-10-20 — fecha a Q-PR52): o ENQUADRAMENTO FISCAL do serviço tem rota
 * PRÓPRIA, montada no gateway ANTES do roteador do cadastro (`router.use('/services', servicesFiscalRoutes)` e só depois
 * `router.use('/services', servicesRoutes)`): o vínculo com a regra de ISS (`tb_service.tb_service_tax_rule_id`) e
 * a presunção IBS/CBS (`tb_service.nbs` + `tb_service_ibscbs`) são fatos que o LEGADO não produz — a web é a única escritora deles, em
 * qualquer modo do estabelecimento (W/D). O `PUT /api/services/:id` (dados do cadastro) não tem guarda desde a D-PR77.
 * Princípio: o dono do CADASTRO é quem o alimenta; o dono do ENQUADRAMENTO FISCAL é a web — cada fato com o seu escritor.
 *
 * Privilégio: ALTERAR (2) na interface `services` (D-PR45) — admin passa, super passa; a interface tem de estar contratada (D-F37).
 * Só PUT vive aqui: qualquer outro método nessas URLs cai no roteador do cadastro (404).
 */
const router = Router()
const alterar = requirePrivilege('services', PRIVILEGE_ALTERAR)

/**
 * @swagger
 * /api/services/{id}/tax-rule:
 *   put:
 *     summary: Vincula o serviço à regra de ISS (D-PR45 — fora da guarda do dono do catálogo; a web é a única escritora deste fato)
 *     description: Corpo `{ serviceTaxRuleId }` — `null` = sem regra. Vale em qualquer modo do estabelecimento (W/D), inclusive
 *       quando o cadastro do serviço vem do sistema legado (origem D). Privilégio ALTERAR na interface services.
 *     tags: [services]
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
 *             required: [serviceTaxRuleId]
 *             properties:
 *               serviceTaxRuleId: { type: integer, nullable: true }
 *     responses:
 *       200: { description: "{ ok }" }
 *       400: { description: "Validação; regra inexistente (fields[serviceTaxRuleId]); campo obrigatório do cliente (REQUIRED_FIELDS)" }
 *       403: { description: "PRIVILEGE_REQUIRED — falta ALTERAR em services / INTERFACE_NOT_ALLOWED" }
 *       404: { description: Serviço não encontrado }
 */
router.put('/:id/tax-rule', alterar, controller.updateTaxRule)

/**
 * @swagger
 * /api/services/{id}/ibscbs:
 *   put:
 *     summary: Grava a presunção IBS/CBS do serviço — NBS e/ou par cClassTrib × cIndOp (D-PR45 — fora da guarda do dono do catálogo)
 *     description: Mesma semântica do PUT do cadastro (ausente = não mexe · null = remove · valor = grava), mas pelo menos um dos dois
 *       campos tem de vir. Catálogo central conferido só no que MUDOU (D-IB30). Vale em qualquer modo do estabelecimento (W/D).
 *     tags: [services]
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
 *             properties:
 *               nbs: { type: string, nullable: true, description: "9 dígitos" }
 *               ibscbs:
 *                 type: object
 *                 nullable: true
 *                 properties:
 *                   classificationCode: { type: string, description: "cClassTrib, 6 dígitos" }
 *                   placeIndicatorCode: { type: string, description: "cIndOp, 6 dígitos" }
 *     responses:
 *       200: { description: "{ ok }" }
 *       400: { description: "Validação (corpo sem nbs e sem ibscbs = nada a gravar); campo obrigatório do cliente (REQUIRED_FIELDS)" }
 *       403: { description: "PRIVILEGE_REQUIRED — falta ALTERAR em services / INTERFACE_NOT_ALLOWED" }
 *       404: { description: Serviço não encontrado }
 *       422: { description: "Classificação IBS/CBS inválida (IBSCBS_* em code; campo em fields[])" }
 */
router.put('/:id/ibscbs', alterar, controller.updateIbscbs)

export default router
