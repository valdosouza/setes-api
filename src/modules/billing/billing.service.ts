import { institutionZoneFor, withZoneWall } from '@shared/time-zone'
import { invoiceEmissionDateFor } from '@shared/invoice/emission-date'
import { invoiceSerieFor } from '@shared/invoice-series'
import { HttpError } from '@shared/errors/http-error'
import {
  findTaxRule, loadPieces, calculateItemTaxes, prorateWithResidue,
  calcMerchandiseValue, TaxRuleMatchCriteria, TaxRulePieces,
  ItemTaxCalcInput, icmsMissingCodeForCrt,
} from '@shared/tax-rule'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { liabilityFromExigibilidade } from '@shared/entity-tax/entity-tax.types'
import {
  resolveServiceTaxRule, getServiceTaxRuleById, checkServiceRule,
  serviceRuleProblemMessage, ServiceTaxRuleResolved,
} from '@shared/service-tax-rule'
import { getConfigContent } from '@shared/interface-config'
import { resolveTitleAutomationConfig } from '@shared/title-automation'
import { InstitutionPayload } from '@shared/types/express'
import { resolveMvaAliq, resolveFcpAliq } from '@modules/state-tax-rates/state-tax-rates.repository'
import pool from '@shared/db/connection'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { findOpenCashierIdTx } from '@shared/financial-settlement'
import {
  cancelInvoice, CancelInvoiceResult, waiveSubstitutedCancel, CancelWaiverResult, buildCancelPlan, CancelBlock, ReleasedTitle,
  readInvoiceLives, readInvoiceFiscal, fiscalEffectOf, FiscalEffect, findCurrentCancelWaiver, fiscalRecordKey,
} from '@shared/invoice'
import { assertSchema } from '@shared/db/schema'
import { previewServiceIbscbs } from '@shared/service-ibscbs-declaration'
import { previewIbscbsAssessmentRefusal } from '@shared/ibscbs-assessment'
import { findClassificationAt, ClassificationAt } from '@shared/ibscbs-classification'
import {
  loadRegularPlan, regularProblemOf, declareRegularItem, RegularPlan, RegularProblem, IbscbsRegularDeclared,
} from '@shared/ibscbs-regular'
import {
  loadSimplesDasPlan, declareSimplesItem, simplesRateMissingMessage, IbscbsSimplesDeclared,
} from '@shared/ibscbs-simples-das'
import { CancelBody, CancelWaiverBody } from './billing.dto'
import { resolveOrderParcels, MaterializedParcel as ResolvedParcel } from '@shared/order-installment'
import { hasServiceOrderCycle } from '@shared/service-order'
import { Queryable, assertOrderOpen } from '@shared/order'
import {
  parseCrt, adjustMva, resolveFinancialPolarity,
} from './billing.context'
import {
  getOrderStatus, getOrderBranch, listBillingItems, getItemRuleLinks,
  upsertItemRuleAuto, clearAutoRuleLink, findDeadRuleIds,
  getItemServiceRuleLinks, upsertItemServiceRuleAuto, clearAutoServiceRuleLink,
  getFreightAndExpenses,
  getEntityLocation, persistInvoice, ComputedItem,
  OrderBranchInfo,
  getGeneralObservations, getRuleObservationNotes, getNcmApproxRates,
  getPaymentTypeKinds,
  hasOrderBilling,
} from './billing.repository'
import {
  buildRegimeObservations, buildIssqnObservation, buildApproxTaxObservation,
  calcApproxTaxAliq, ObsRegimeItem,
} from './billing.observations'
import {
  buildReturnPlan, getSaleOrderInfo, getAnchor, ReturnPlan,
} from '@shared/order-return'
import {
  resolveCommissionAliq, getPostedItemCommissions, CommissionEntryInput,
} from '@shared/commission'
import {
  ValidationReport, ValidationIssue, InvoiceResult, BillingOrderItem,
} from './billing.interface'
import { ValidateBodyDto, InvoiceBodyDto } from './billing.dto'
import { merchandiseInvoiceTotalOf } from './billing.total'
import { invoiceContentIssues, loadInvoiceContent, noteTextIssue, pisCofinsCstOf } from './billing.content'
import { billingInputPrint, BillingInputChanged } from './billing.input-print'

/**
 * Orquestração do faturamento (W2 Onda 3, rodada R4):
 * - validateOrder: valida TUDO em lote (lista completa, nunca para na 1ª) e
 *   grava a regra achada por item (origin 'A'; 'M' nunca é sobrescrito).
 * - invoiceOrder: fatura consumindo as regras GRAVADAS (sem rebuscar — item
 *   sem linha = 422 REQUIRES_VALIDATION), calcula por item (@shared/tax-rule),
 *   grava impostos + nota + financeiro em UMA transação.
 */

const MERCHANDISE_KINDS = ['Sale', 'Purchase', 'Adjust']
/** IBS.E9.P5 (D-IB142): o IBS/CBS do Simples no DAS é o da RECEITA do emitente — só o item de VENDA; compra e ajuste (entradas) ficam de fora. */
const SIMPLES_KINDS: readonly string[] = ['Sale']
// IBS.E9.P4 (D-IB145): o IBS/CBS do REGIME REGULAR vale para venda, compra e ajuste — os mesmos tipos da classificação (MERCHANDISE_KINDS)

interface BillingContext {
  branch: OrderBranchInfo
  emitterCrt: string | null
  /** cAtivSN padrão do estabelecimento (IBS.E9.P5, D-IB139); null = 01. */
  emitterSimplesActivity: string | null
  /** opSimpNac do emitente (IBS.E9.P5): o MEI ('2') não entra no Simples no DAS. */
  emitterSimplesRegime: string | null
  emitterStateId: number | null
  recipientCityId: number | null
  recipientStateId: number | null
  recipientConsumer: 'S' | 'N'
  recipientSimples: 'S' | 'N'
  recipientContributor: boolean
  recipientByPassSt: 'S' | 'N'
  recipientIssRetido: boolean
  /** D-N20: exigibilidade do ISS do EMITENTE → tribISSQN do ramo de serviço (liabilityFromExigibilidade). */
  emitterIssExigibilidade: string | null
}

async function loadContext(
  schemaName: string, institutionId: number, branch: OrderBranchInfo
): Promise<{ ctx: BillingContext; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = []

  // Convenção confirmada (R4): tb_institution.id = tb_entity.id
  const emitterTax = await getEntityTax(schemaName, institutionId, institutionId)
  const emitterLoc = await getEntityLocation(institutionId)
  const crt = parseCrt(emitterTax?.taxRegime)

  if (!emitterTax) {
    issues.push({ scope: 'emitter', field: 'taxRegime',
      message: 'Emitente sem tributação configurada (aba Tributação do cadastro)' })
  } else if (crt === null) {
    issues.push({ scope: 'emitter', field: 'taxRegime',
      message: 'Regime tributário do emitente inválido — informe o regime (1/2/3)' })
  }
  if (!emitterLoc || !emitterLoc.stateId) {
    issues.push({ scope: 'emitter', field: 'address',
      message: 'Emitente sem endereço principal com UF' })
  }

  const recipientTax = await getEntityTax(schemaName, institutionId, branch.recipientEntityId)
  const recipientLoc = await getEntityLocation(branch.recipientEntityId)
  if (!recipientLoc || !recipientLoc.stateId) {
    issues.push({ scope: 'recipient', field: 'address',
      message: 'Destinatário sem endereço principal com UF' })
  }
  if (!recipientTax) {
    // sem a aba Tributação o match roda com defaults silenciosos
    // (não consumidor/não Simples/não contribuinte) — pode casar regra errada
    issues.push({ scope: 'recipient', field: 'taxRegime',
      message: 'Destinatário sem tributação configurada (aba Tributação do cadastro)' })
  }

  const ctx: BillingContext = {
    branch,
    emitterCrt: crt,
    emitterSimplesActivity: emitterTax?.simplesActivity ?? null,
    emitterSimplesRegime: emitterTax?.simplesRegime ?? null,
    emitterStateId: emitterLoc?.stateId ?? null,
    recipientCityId: recipientLoc?.cityId ?? null,
    recipientStateId: recipientLoc?.stateId ?? null,
    recipientConsumer: recipientTax?.consumer === 'S' ? 'S' : 'N',
    // Simples do DESTINATÁRIO no seletor da regra (T5) — regime 1 = optante
    recipientSimples: parseCrt(recipientTax?.taxRegime) === '1' ? 'S' : 'N',
    recipientContributor: recipientTax?.indIeDest === '1',
    recipientByPassSt: recipientTax?.byPassSt === 'S' ? 'S' : 'N',
    recipientIssRetido: recipientTax?.issRetido === 'S',
    emitterIssExigibilidade: emitterTax?.issExigibilidade ?? null,
  }
  return { ctx, issues }
}

function buildCriteria(
  item: BillingOrderItem, ctx: BillingContext, institutionId: number,
  adjustment: { cfopId: string } | null | undefined,
  manualRuleId: number | null
): TaxRuleMatchCriteria {
  const isAdjust = ctx.branch.branch === 'adjust'
  return {
    institutionId,
    productId: item.productId,
    productNcm: item.ncm,
    productOrigin: item.origin ?? '0',
    productSt: item.merchandiseSt,
    purpose: isAdjust ? '0' : (item.purpose ?? '0'),
    entityId: ctx.branch.recipientEntityId,
    customerIgnoreSt: ctx.recipientByPassSt,
    finalConsumer: ctx.recipientConsumer,
    simples: ctx.recipientSimples,
    // direção sempre do RAMO (fonte única — a do ajuste é gravada na
    // abertura pelo order-returns; parecer 2026-08-24)
    direction: ctx.branch.direction,
    destinationStateId: ctx.recipientStateId ?? 0,
    emitterStateId: ctx.emitterStateId ?? 0,
    cfopId: isAdjust ? adjustment?.cfopId ?? null : null,
    directRuleId: manualRuleId,
  }
}

/**
 * IBS.E9.P3 — a classificação de IBS/CBS do item de MERCADORIA, conferida no faturamento e na validação pela MESMA função.
 * D-IB134: regra sem a peça `ibscbs` não fatura, já em 2026 (não espera a data da obrigação). D-IB136: o código precisa existir
 * e estar vigente na data de emissão — só isso, para TODO CRT; o campo `applicable` (a marca "vale para a NF-e", modelo 55) é
 * ignorado aqui de propósito: IBS.E9.P4 (A-IB143j) o confere SÓ no regime regular (CRT 3), em `@shared/ibscbs-regular`, com a linha
 * vigente que este verificador guarda (`lineOf`). Uma consulta por código (as regras de um pedido são poucas).
 */
interface IbscbsItemProblem {
  code: 'BILLING_IBSCBS_CLASSIFICATION_REQUIRED' | 'IBSCBS_CLASSIFICATION_NOT_FOUND'
  message: string
}
function ibscbsItemChecker(emissionDate: string) {
  const vigentByCode = new Map<string, boolean>()
  // IBS.E9.P4: a linha vigente (modelo 55) de cada código já conferido — o regime regular a usa sem nova consulta
  const lineByCode = new Map<string, ClassificationAt | null>()
  const check = async (itemId: number, ruleId: number, pieces: TaxRulePieces): Promise<IbscbsItemProblem | null> => {
    const code = pieces.ibscbs?.classificationCode
    if (!code) {
      return { code: 'BILLING_IBSCBS_CLASSIFICATION_REQUIRED',
        message: `Item ${itemId}: regra de tributação ${ruleId} sem classificação de IBS/CBS (cClassTrib) — informe na regra` }
    }
    // gate adversarial: o código lido do banco é conferido no FORMATO antes de ir ao catálogo e ao registro do item
    // (linha gravada fora da API — número, espaços, dígitos não ASCII — nunca chega ao INSERT)
    let vigent = vigentByCode.get(code)
    if (vigent === undefined) {
      const line = typeof code === 'string' && /^[0-9]{6}$/.test(code) ? await findClassificationAt(pool, code, '55', emissionDate) : null
      lineByCode.set(code, line)
      vigent = line != null
      vigentByCode.set(code, vigent)
    }
    return vigent ? null : { code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
      message: `Item ${itemId}: cClassTrib ${code} da regra de tributação ${ruleId} não existe no catálogo ou não está vigente em ${emissionDate}` }
  }
  return Object.assign(check, { lineOf: (code: string): ClassificationAt | null => lineByCode.get(code) ?? null })
}

export async function validateOrder(
  institution: InstitutionPayload, input: ValidateBodyDto
): Promise<ValidationReport> {
  const { schemaName, institutionId } = institution
  const issues: ValidationIssue[] = []

  const status = await getOrderStatus(schemaName, institutionId, input.orderId)
  if (status === null) throw new HttpError(404, `Ordem ${input.orderId} não encontrada`)
  // D3/D4 (gate 2026-09-29): 'C' (cancelado com nota fiscal) também NÃO fatura — predicado único
  assertOrderOpen(status, input.orderId)

  const branch = await getOrderBranch(schemaName, institutionId, input.orderId)
  if (!branch) {
    throw new HttpError(422, 'Ordem sem ramo (venda/compra/ajuste/serviço)',
      [{ field: 'orderId', message: 'Ramo da ordem não identificado' }], 'ORDER_NO_BRANCH')
  }
  if (branch.branch === 'service' && await hasServiceOrderCycle(schemaName, institutionId, input.orderId)) {
    // Q-A11: ordem de SERVIÇO (ciclo vivo) fatura pelo próprio módulo
    throw new HttpError(409, 'Ordem de serviço fatura pelo módulo de OS (POST /api/service-orders/:id/invoice)',
      undefined, 'SERVICE_ORDER_OWN_ENDPOINT')
  }
  if (branch.branch === 'adjust' && !input.adjustment) {
    issues.push({ scope: 'order', field: 'adjustment',
      message: 'Ordem de ajuste exige CFOP no faturamento' })
  }

  const { ctx, issues: ctxIssues } = await loadContext(schemaName, institutionId, branch)
  issues.push(...ctxIssues)

  const items = await listBillingItems(schemaName, institutionId, input.orderId)
  if (items.length === 0) {
    issues.push({ scope: 'order', field: 'items', message: 'Ordem sem itens vivos' })
  }

  // Devolução de mercadoria (rodada 2026-08-24): a ÂNCORA gravada na
  // abertura identifica a devolução (fonte única — nada viaja no payload);
  // mesmas regras do legado, em lote — origem faturada/mesmo cliente,
  // itens ⊆ origem, qtde ≤ saldo devolvível (acumulado), valor ≤ origem.
  if (branch.branch === 'adjust') {
    const anchor = await getAnchor(schemaName, institutionId, input.orderId, { includeDeleted: true })
    if (anchor && anchor.deleted === 'S') {
      // D-A31: âncora cancelada com a ordem viva = inconsistência (só por SQL) — nunca ajuste solto
      issues.push({ scope: 'order', field: 'adjustment',
        message: 'Devolução com âncora cancelada — ordem de ajuste inconsistente (cancele a devolução)' })
    } else if (anchor && branch.direction !== 'E') {
      issues.push({ scope: 'order', field: 'adjustment',
        message: 'Devolução de mercadoria exige ajuste de ENTRADA' })
    } else if (anchor) {
      // devolução de MERCADORIA — item de serviço fica fora do plano
      // (achado LOW do gate adversarial 2026-08-24)
      const { issues: retIssues, originLegacy } = await buildReturnPlan(
        schemaName, institutionId, anchor.orderIdOri,
        branch.recipientEntityId,
        items.filter(i => i.productKind !== 'S')
          .map(i => ({ id: i.id, kind: i.kind, productId: i.productId,
            quantity: i.quantity, unitValue: i.unitValue })),
        { refuseRepeatedLines: input.authorizeNfe === true })
      // D-NE113 + D-NE267: com a marcação de emitir a NF-e, devolução de venda do ERP Desktop é recusada (sem ela, segue)
      if (input.authorizeNfe === true && originLegacy) {
        issues.push({ scope: 'order', field: 'returnedOrderId', message: `A venda ${anchor.orderIdOri} foi feita no ERP Desktop — a NF-e de devolução pela web ainda não atende vendas do Desktop` })
      }
      issues.push(...retIssues.map(ri => ({
        scope: (ri.itemId !== undefined ? 'item' : 'order') as 'item' | 'order',
        itemId: ri.itemId, field: ri.field, message: ri.message,
      })))
    }
  }

  const links = await getItemRuleLinks(schemaName, institutionId, input.orderId)
  const manualByItem = new Map(
    links.filter(l => l.origin === 'M').map(l => [`${l.orderItemId}|${l.kind}`, l]))
  // Onda 3 (regra de serviço — D6/D12/D14): vínculo irmão por item; só
  // consultado quando a ordem tem serviço (ordens só-mercadoria não pagam).
  const hasService = items.some(i => i.productKind === 'S')
  const serviceLinks = hasService
    ? await getItemServiceRuleLinks(schemaName, institutionId, input.orderId) : []
  const serviceManualByItem = new Map(
    serviceLinks.filter(l => l.origin === 'M').map(l => [`${l.orderItemId}|${l.kind}`, l]))

  let rulesResolved = 0
  let rulesManual = 0

  // D42 — regra casada precisa do código do regime VIGENTE do emitente
  // (Simples = CSOSN, Normal = CST): a troca de regime no cadastro do
  // estabelecimento zera o código antigo e a regra fica pendente até a
  // revisão. Sem o check, o cálculo despacharia pelo código restante e a
  // nota sairia no regime errado em silêncio.
  const validatePiecesCache = new Map<number, TaxRulePieces>()
  /** item de mercadoria → regra de tributação que vale para ele neste validate (NFE.E1.P4.T4: PIS/COFINS da regra) */
  const ruleIdByItem = new Map<number, number>()
  const validatePiecesOf = async (ruleId: number): Promise<TaxRulePieces> => {
    let pieces = validatePiecesCache.get(ruleId)
    if (!pieces) {
      pieces = (await loadPieces(schemaName, ruleId)) ?? {}
      validatePiecesCache.set(ruleId, pieces)
    }
    return pieces
  }
  const ruleMissingCode = async (ruleId: number): Promise<'csosn' | 'cst' | null> =>
    icmsMissingCodeForCrt(await validatePiecesOf(ruleId), ctx.emitterCrt)
  // IBS.E9.P3: a mesma conferência do faturamento, na data que ele usaria — vira pendência da lista (a tela descobre aqui)
  let ibscbsProblemOf: ReturnType<typeof ibscbsItemChecker> | null = null
  let regularPlan: RegularPlan | null = null
  const pushIbscbsIssue = async (itemId: number, ruleId: number): Promise<void> => {
    let emissionDate: string | null = null
    if (!ibscbsProblemOf) {
      emissionDate = await invoiceEmissionDateFor(schemaName, institutionId)
      ibscbsProblemOf = ibscbsItemChecker(emissionDate)
    }
    const pieces = await validatePiecesOf(ruleId)
    const problem = await ibscbsProblemOf(itemId, ruleId, pieces)
    if (problem) {
      issues.push({ scope: 'item', itemId, field: 'ibscbsClassification', message: problem.message })
      return
    }
    // IBS.E9.P4: a mesma conferência do faturamento do REGIME REGULAR (CRT 3) — modelo 55, CST aceito, redução e alíquota vigente
    regularPlan ??= await loadRegularPlan({ crt: ctx.emitterCrt, emissionDate: emissionDate ?? await invoiceEmissionDateFor(schemaName, institutionId) })
    const code = pieces.ibscbs?.classificationCode
    if (regularPlan.active && code) {
      const regular = regularProblemOf(regularPlan, itemId, ruleId, code, ibscbsProblemOf.lineOf(code))
      if (regular) issues.push({ scope: 'item', itemId, field: 'ibscbsRegular', message: regular.message })
    }
  }
  const missingCodeMessage = (itemId: number, ruleId: number, code: 'csosn' | 'cst') =>
    `Item ${itemId}: regra de tributação ${ruleId} sem ${code === 'csosn'
      ? 'CSOSN (emitente no Simples Nacional)'
      : 'CST (emitente no Regime Normal)'} — revise as regras de tributação para o regime atual`

  for (const item of items) {
    if (item.productKind === 'S') {
      // Serviço: regra APONTADA pelo cadastro (D1) ou RegraDireta 'M' (D14);
      // sem regra / inativa / cidade ≠ tomador = pendência (D6/D12). Vínculo
      // 'A' só sobrevive quando a regra passa — sem link o /invoice devolve
      // 422 REQUIRES_VALIDATION (a "interrupção do faturamento").
      const svcManual = serviceManualByItem.get(`${item.id}|${item.kind}`)
      const rule = svcManual
        ? await getServiceTaxRuleById(schemaName, institutionId, svcManual.serviceTaxRuleId)
        : await resolveServiceTaxRule(schemaName, institutionId, item.productId)
      const problem = checkServiceRule(rule, ctx.recipientCityId)
      if (problem) {
        if (!svcManual) {
          await clearAutoServiceRuleLink(
            schemaName, institutionId, input.orderId, item.id, item.kind)
        }
        issues.push({ scope: 'item', itemId: item.id, field: 'serviceTaxRule',
          message: serviceRuleProblemMessage(item.id, problem, rule) })
        continue
      }
      if (svcManual) {
        rulesManual++
      } else {
        await upsertItemServiceRuleAuto(
          schemaName, institutionId, input.orderId, item.id, item.kind, rule!.id)
        rulesResolved++
      }
      continue
    }
    if (!MERCHANDISE_KINDS.includes(item.kind)) continue

    if (item.ncm === null || item.ncm === '') {
      issues.push({ scope: 'item', itemId: item.id, field: 'ncm',
        message: `Item ${item.id}: produto sem NCM no cadastro` })
    }

    const manual = manualByItem.get(`${item.id}|${item.kind}`)
    if (manual) {
      // RegraDireta — escolha do cliente: o vínculo 'M' é intocável, mas a
      // incoerência com o regime vira pendência do mesmo jeito (D42).
      const missing = await ruleMissingCode(manual.taxRuleId)
      ruleIdByItem.set(item.id, manual.taxRuleId)
      if (missing) {
        issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
          message: missingCodeMessage(item.id, manual.taxRuleId, missing) })
      }
      await pushIbscbsIssue(item.id, manual.taxRuleId)
      rulesManual++
      continue
    }

    if (ctx.recipientStateId === null || ctx.emitterStateId === null) continue

    const criteria = buildCriteria(item, ctx, institutionId, input.adjustment, null)
    const rule = await findTaxRule(schemaName, criteria)
    if (rule) {
      // D42: regra incompleta para o regime NÃO grava o link 'A' — sem
      // link o /invoice devolve 422 REQUIRES_VALIDATION (é a "interrupção
      // do faturamento" prometida no aviso do cadastro).
      const missing = await ruleMissingCode(rule.id)
      ruleIdByItem.set(item.id, rule.id)
      if (missing) {
        await clearAutoRuleLink(
          schemaName, institutionId, input.orderId, item.id, item.kind)
        issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
          message: missingCodeMessage(item.id, rule.id, missing) })
        await pushIbscbsIssue(item.id, rule.id)   // as duas pendências da regra saem na MESMA volta (gates do IBS.E9.P3)
        continue
      }
      await upsertItemRuleAuto(
        schemaName, institutionId, input.orderId, item.id, item.kind,
        rule.id, rule.cfopId)
      // o vínculo fica (a regra casa); a classificação que falta é pendência própria, com o 422 próprio no /invoice
      await pushIbscbsIssue(item.id, rule.id)
      rulesResolved++
    } else {
      // link 'A' de validação anterior NÃO sobrevive a um match que falhou
      // (senão o /invoice faturaria com a regra velha — issue e fatura
      // passando juntas). 'M' é intocável.
      await clearAutoRuleLink(
        schemaName, institutionId, input.orderId, item.id, item.kind)
      // conteúdo do alerta do legado (§3): produto + critérios do destinatário
      issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
        message: `Item ${item.id} (produto ${item.productId}): nenhuma regra de tributação encontrada — ` +
          `NCM ${item.ncm ?? '—'}, origem ${criteria.productOrigin}, ST ${criteria.productSt}, ` +
          `finalidade ${criteria.purpose}, sentido ${criteria.direction}, ` +
          `consumidor final ${criteria.finalConsumer}, Simples ${criteria.simples}, ` +
          `UF destino ${criteria.destinationStateId}` })
    }
  }

  // D-NE260 + D-NE267: com a marcação de emitir a NF-e (a opção da TELA do faturamento, como no ERP Desktop) e nota com
  // mercadoria, a conferência do conteúdo que a NF-e exige entra na lista — destinatário e itens, com o campo. Sem a marcação,
  // nenhuma leitura nova. (O texto da nota só existe no /invoice: é conferido lá.)
  if (input.authorizeNfe === true && items.some(i => i.productKind !== 'S')) {
    // NFE.E1.P4.T4: a regra de cada item (resolvida acima, com as peças já lidas) entrega o CST de PIS e de COFINS; item ainda sem
    // regra fica sem o campo (não conferido — a pendência dele é a da regra)
    const withRule = items.map(i => {
      const ruleId = ruleIdByItem.get(i.id)
      return ruleId === undefined ? i : { ...i, ...pisCofinsCstOf(validatePiecesCache.get(ruleId)) }
    })
    issues.push(...invoiceContentIssues(
      await loadInvoiceContent(schemaName, institutionId, branch.recipientEntityId, withRule)))
  }

  // Q-A8: condições de cobrança são pré-requisito do faturamento — a tela
  // descobre AQUI, não no 422 do invoice.
  if (!(await hasOrderBilling(schemaName, institutionId, input.orderId))) {
    issues.push({ scope: 'order', field: 'billing',
      message: 'Ordem sem condições de cobrança (forma de pagamento/prazo) — negocie antes de faturar' })
  }

  // IB-3 (D-IB76 = Q-IB76 (a)): a declaração IBS/CBS PREVISTA — mesma composição do faturamento, só-pergunta, na data que ele usaria;
  // antes da obrigação fica só no campo próprio (aviso); depois, a recusa vira issue de bloqueio com o mesmo texto do 422
  const serviceProductIds = items.filter(i => i.productKind === 'S').map(i => Number(i.productId))
  const ibscbs = await previewServiceIbscbs(pool, assertSchema(schemaName), institutionId, serviceProductIds)
  if (ibscbs?.refusal) issues.push({ scope: 'ibscbs', field: 'ibscbs', message: ibscbs.refusal.message })
  // D-IB99: a opção de apuração do IBS/CBS vale para TODA nota (mercadoria também) — a MESMA regra do `issueInvoice`, só-pergunta,
  // na data que o faturamento usaria; sem repetir a issue quando a prévia do serviço já a trouxe
  const regimeDate = ibscbs?.competenceDate ?? await invoiceEmissionDateFor(schemaName, institutionId)
  const regime = await previewIbscbsAssessmentRefusal(pool, assertSchema(schemaName), institutionId, regimeDate)
  if (regime && ibscbs?.refusal?.code !== regime.code) {
    issues.push({ scope: 'order', field: 'ibscbsAssessment', message: regime.message })
  }

  // IBS.E9.P5 (D-IB140): a mesma conferência do faturamento — o Simples no DAS de 2027 em diante sem o percentual do mês vira
  // pendência POR ITEM de mercadoria (a tela descobre aqui, não no 422); antes da data de início nada é lido além do CRT
  const simplesPlan = await loadSimplesDasPlan({
    institution, crt: ctx.emitterCrt, simplesRegime: ctx.emitterSimplesRegime, emissionDate: regimeDate,
    establishmentActivity: ctx.emitterSimplesActivity })
  if (simplesPlan.active && simplesPlan.rate === null) {
    for (const item of items) {
      if (item.productKind === 'S' || !SIMPLES_KINDS.includes(item.kind)) continue
      issues.push({ scope: 'item', itemId: item.id, field: 'ibscbsSimplesRate',
        message: simplesRateMissingMessage(item.id, simplesPlan.competence) })
    }
  }

  return { orderId: input.orderId, branch: branch.branch, issues, rulesResolved, rulesManual, ibscbs }
}

/** D-NE220: os ids de item que aparecem mais de uma vez no pedido (em `kind` diferentes), em ordem crescente. */
export function duplicatedItemIds(items: ReadonlyArray<{ id: number }>): number[] {
  const seen = new Set<number>()
  const repeated = new Set<number>()
  for (const it of items) {
    const id = Number(it.id)
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  return [...repeated].sort((a, b) => a - b)
}

/** D-FAT1: quantas vezes o faturamento refaz leitura + cálculo quando o pedido muda antes da trava. */
export const BILLING_INPUT_ATTEMPTS = 3

/**
 * D-FAT1: fatura; se o pedido mudou entre a leitura e a trava (`BillingInputChanged`, da transação — nada foi gravado), refaz a
 * leitura e o cálculo inteiros. Depois de `BILLING_INPUT_ATTEMPTS` tentativas = 409 RESOURCE_BUSY (alguém está editando o pedido).
 */
export async function invoiceOrder(
  institution: InstitutionPayload, input: InvoiceBodyDto
): Promise<InvoiceResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await invoiceOrderOnce(institution, input)
    } catch (err) {
      if (!(err instanceof BillingInputChanged)) throw err
      if (attempt >= BILLING_INPUT_ATTEMPTS) {
        throw new HttpError(409, `Itens do pedido ${input.orderId} mudaram durante o faturamento — tente de novo`, undefined, 'RESOURCE_BUSY')
      }
    }
  }
}

async function invoiceOrderOnce(
  institution: InstitutionPayload, input: InvoiceBodyDto
): Promise<InvoiceResult> {
  const { schemaName, institutionId } = institution

  const status = await getOrderStatus(schemaName, institutionId, input.orderId)
  if (status === null) throw new HttpError(404, `Ordem ${input.orderId} não encontrada`)
  assertOrderOpen(status, input.orderId)

  const branch = await getOrderBranch(schemaName, institutionId, input.orderId)
  if (!branch) {
    throw new HttpError(422, 'Ordem sem ramo identificado',
      [{ field: 'orderId', message: 'Ramo da ordem não identificado' }], 'ORDER_NO_BRANCH')
  }
  if (branch.branch === 'service' && await hasServiceOrderCycle(schemaName, institutionId, input.orderId)) {
    // Q-A11: ordem de SERVIÇO (ciclo vivo) fatura pelo próprio módulo
    throw new HttpError(409, 'Ordem de serviço fatura pelo módulo de OS (POST /api/service-orders/:id/invoice)',
      undefined, 'SERVICE_ORDER_OWN_ENDPOINT')
  }
  if (branch.branch === 'adjust' && !input.adjustment) {
    throw new HttpError(422, 'Ordem de ajuste exige CFOP',
      [{ field: 'adjustment', message: 'Informe o cfopId' }], 'ADJUST_PARAMS_REQUIRED')
  }

  const { ctx, issues: ctxIssues } = await loadContext(schemaName, institutionId, branch)
  if (ctxIssues.length > 0) {
    throw new HttpError(422, 'Pendências de cadastro impedem o faturamento',
      ctxIssues.map(i => ({ field: i.field ?? i.scope, message: i.message })),
      'REQUIRES_VALIDATION')
  }

  const items = await listBillingItems(schemaName, institutionId, input.orderId)
  if (items.length === 0) {
    throw new HttpError(422, 'Ordem sem itens — nada a faturar',
      [{ field: 'items', message: 'Inclua ao menos um item' }], 'ORDER_NO_ITEMS')
  }
  // D-NE220: o id do item é ÚNICO por pedido entre os `kind` — as tabelas de imposto por item e o nItem da NF-e usam só o id. A PK
  // de tb_order_item aceita o mesmo id com `kind` diferente (linhas do sincronizador), então a cerca é aqui: recusa, nunca imposto
  // de um item gravado por cima do outro. (Sem índice único: UNIQUE + upsert trocaria a linha errada — PADROES_BANCO §9, regra 10.)
  const repeatedIds = duplicatedItemIds(items)
  if (repeatedIds.length > 0) {
    throw new HttpError(422, 'Pedido com número de item repetido — corrija os itens antes de faturar',
      repeatedIds.map(id => ({ field: `item.${id}`, message: `O item ${id} aparece mais de uma vez no pedido` })),
      'ORDER_ITEM_ID_DUPLICATED')
  }

  const links = await getItemRuleLinks(schemaName, institutionId, input.orderId)
  const linkByItem = new Map(links.map(l => [`${l.orderItemId}|${l.kind}`, l]))

  const merchandiseItems = items.filter(
    i => i.productKind !== 'S' && MERCHANDISE_KINDS.includes(i.kind))

  // Onda 3 — serviço exige vínculo gravado pelo /validate (D6) e a regra é
  // REVALIDADA aqui (viva, ativa, cidade = tomador — D12): paridade com o
  // gate duro de NCM/regra da mercadoria.
  const serviceItems = items.filter(i => i.productKind === 'S')
  const serviceRuleByItem = new Map<string, ServiceTaxRuleResolved>()
  let serviceLinksRead: Awaited<ReturnType<typeof getItemServiceRuleLinks>> = []   // D-FAT1: entra na impressão do pedido
  if (serviceItems.length > 0) {
    const serviceLinks = await getItemServiceRuleLinks(schemaName, institutionId, input.orderId)
    serviceLinksRead = serviceLinks
    const serviceLinkByItem = new Map(serviceLinks.map(l => [`${l.orderItemId}|${l.kind}`, l]))
    const missingService = serviceItems.filter(i => !serviceLinkByItem.has(`${i.id}|${i.kind}`))
    if (missingService.length > 0) {
      throw new HttpError(422, 'Serviço sem regra de tributação vinculada — valide a ordem',
        missingService.map(i => ({ field: `item.${i.id}`, message: 'Sem regra de tributação de serviço vinculada' })),
        'REQUIRES_VALIDATION')
    }
    const ruleCache = new Map<number, ServiceTaxRuleResolved | null>()
    for (const item of serviceItems) {
      const link = serviceLinkByItem.get(`${item.id}|${item.kind}`)!
      if (!ruleCache.has(link.serviceTaxRuleId)) {
        ruleCache.set(link.serviceTaxRuleId,
          await getServiceTaxRuleById(schemaName, institutionId, link.serviceTaxRuleId))
      }
      const rule = ruleCache.get(link.serviceTaxRuleId)!
      const problem = checkServiceRule(rule, ctx.recipientCityId)
      if (problem) {
        throw new HttpError(422, 'Regra de tributação de serviço inválida — valide a ordem',
          [{ field: `item.${item.id}`, message: serviceRuleProblemMessage(item.id, problem, rule) }],
          'REQUIRES_VALIDATION')
      }
      serviceRuleByItem.set(`${item.id}|${item.kind}`, rule!)
    }
  }

  // R5-Q3 (evidência Fc_Valida_Itens_Nota): NCM ausente é gate DURO no
  // legado, revalidado no momento de faturar (o /validate pode ter rodado
  // antes do produto ser corrigido/trocado) — não é só aviso.
  const missingNcm = merchandiseItems.filter(i => !i.ncm || i.ncm.trim() === '')
  if (missingNcm.length > 0) {
    throw new HttpError(422, 'Produto sem NCM — não é possível faturar',
      missingNcm.map(i => ({ field: `item.${i.id}`, message: 'NCM ausente no cadastro do produto' })),
      'MISSING_NCM')
  }

  const missing = merchandiseItems.filter(i => !linkByItem.has(`${i.id}|${i.kind}`))
  if (missing.length > 0) {
    throw new HttpError(422, 'Itens sem regra de tributação resolvida — execute a validação',
      missing.map(i => ({ field: `item.${i.id}`, message: 'Sem regra vinculada' })),
      'REQUIRES_VALIDATION')
  }

  // "sem rebuscar" ≠ confiar cegamente na referência: a regra gravada
  // precisa estar VIVA (soft-delete em cascata zeraria as peças e a nota
  // sairia SEM imposto, silenciosamente — achado HIGH dos gates)
  const deadRules = await findDeadRuleIds(
    schemaName, links.map(l => l.taxRuleId).filter(id => id > 0))
  if (deadRules.length > 0) {
    throw new HttpError(422,
      'Regra de tributação vinculada foi excluída — execute a validação novamente',
      deadRules.map(id => ({ field: 'taxRule', message: `Regra ${id} não existe mais` })),
      'REQUIRES_VALIDATION')
  }

  // guarda de sanidade: item com valor líquido negativo corrompe nota E financeiro
  const negative = items.filter(
    i => calcMerchandiseValue(i.unitValue, i.quantity, i.discountValue) < 0)
  if (negative.length > 0) {
    throw new HttpError(422, 'Item com desconto maior que o valor da mercadoria',
      negative.map(i => ({ field: `item.${i.id}`, message: 'Valor líquido negativo' })),
      'NEGATIVE_ITEM_VALUE')
  }

  // Devolução de mercadoria: identificada pela ÂNCORA (fonte única) e
  // gate DURO revalidado no faturamento (mesmo padrão R5-Q3 — não confia
  // só no /validate anterior). Issues = 422.
  let returnPlan: ReturnPlan | null = null
  if (branch.branch === 'adjust') {
    const anchor = await getAnchor(schemaName, institutionId, input.orderId, { includeDeleted: true })
    if (anchor && anchor.deleted === 'S') {
      throw new HttpError(409,
        'Devolução com âncora cancelada — a ordem de ajuste ficou inconsistente; cancele a devolução',
        [{ field: 'adjustment', message: 'Âncora da devolução cancelada' }], 'RETURN_ANCHOR_INCONSISTENT')
    }
    if (anchor) {
      if (branch.direction !== 'E') {
        throw new HttpError(422, 'Devolução de mercadoria exige ajuste de ENTRADA',
          [{ field: 'adjustment', message: 'Sentido do ajuste deve ser E' }],
          'RETURN_REQUIRES_ENTRY')
      }
      const { issues: retIssues, plan, originLegacy } = await buildReturnPlan(
        schemaName, institutionId, anchor.orderIdOri,
        branch.recipientEntityId,
        items.filter(i => i.productKind !== 'S')
          .map(i => ({ id: i.id, kind: i.kind, productId: i.productId,
            quantity: i.quantity, unitValue: i.unitValue })),
        { refuseRepeatedLines: input.authorizeNfe === true })
      // D-NE113 + D-NE267: com a marcação de emitir a NF-e, devolução de venda do ERP Desktop é recusada — ANTES das issues do
      // plano (a causa é a origem, não o saldo). Sem a marcação, a devolução de venda do Desktop segue como sempre foi.
      if (input.authorizeNfe === true && originLegacy) {
        throw new HttpError(422, `A venda ${anchor.orderIdOri} foi feita no ERP Desktop — a NF-e de devolução pela web ainda não atende vendas do Desktop`,
          [{ field: 'returnedOrderId', message: 'Venda feita no ERP Desktop' }], 'RETURN_ORIGIN_LEGACY')
      }
      if (retIssues.length > 0 || !plan) {
        throw new HttpError(422, 'Devolução inválida contra o pedido original',
          retIssues.map(ri => ({
            field: ri.itemId !== undefined ? `item.${ri.itemId}` : ri.field,
            message: ri.message,
          })), 'RETURN_INVALID')
      }
      returnPlan = plan
    }
  }

  // D-NE260 + D-NE267: a conferência do conteúdo é REFEITA aqui com a marcação que ESTE pedido de faturamento traz (a marcação não
  // é gravada; o /validate anterior não vale como garantia — padrão R5-Q3). Pendência = 422, antes de qualquer gravação —
  // e DEPOIS da devolução: na venda do ERP Desktop a causa a dizer é a origem (`RETURN_ORIGIN_LEGACY`), não o cadastro.
  const piecesCache = new Map<number, TaxRulePieces>() // N itens, poucas regras (o laço do cálculo, abaixo, reaproveita)
  if (input.authorizeNfe === true && items.some(i => i.productKind !== 'S')) {
    // NFE.E1.P4.T4: o CST de PIS e de COFINS vem das peças da regra VINCULADA ao item (as mesmas que o cálculo vai usar)
    const withRule: Array<typeof items[number] & { pisCst?: string | null; cofinsCst?: string | null }> = []
    for (const i of items) {
      const link = i.productKind !== 'S' ? linkByItem.get(`${i.id}|${i.kind}`) : undefined
      if (!link) { withRule.push(i); continue }
      let pieces = piecesCache.get(link.taxRuleId)
      if (!pieces) {
        pieces = await loadPieces(schemaName, link.taxRuleId)
        piecesCache.set(link.taxRuleId, pieces)
      }
      withRule.push({ ...i, ...pisCofinsCstOf(pieces) })
    }
    const content = invoiceContentIssues(
      await loadInvoiceContent(schemaName, institutionId, branch.recipientEntityId, withRule))
    if (content.length > 0) {
      throw new HttpError(422, 'Dados que a NF-e exige estão incompletos — corrija o cadastro antes de faturar',
        content.map(i => ({ field: i.itemId !== undefined ? `item.${i.itemId}` : i.field ?? i.scope, message: i.message })),
        'REQUIRES_VALIDATION')
    }
  }

  // rateio T2 sobre TODOS os itens vivos (mercadoria líquida como base)
  const { freight, expenses } = await getFreightAndExpenses(schemaName, institutionId, input.orderId)
  const merchValues = items.map(i => calcMerchandiseValue(i.unitValue, i.quantity, i.discountValue))
  const freightShares = prorateWithResidue(merchValues, freight)
  const expensesShares = prorateWithResidue(merchValues, expenses)

  // P2.9 — alíquota do crédito SN (config única da institution, evidência
  // GRL_G_AQ_CRED_ICMS: o legado lê a MESMA config em venda/compra/ajuste,
  // não é campo da regra nem do produto).
  const creditAliqPct = Number(
    (await getConfigContent(institution, 'billing', 'sn_credit_aliq')) ?? '0')

  // Q-TZ1 + D-IB64/D-IB88: a data de emissão (= competência fiscal da declaração IBS/CBS = base dos vencimentos) pelo DONO ÚNICO.
  // IBS.E9.P3: lida ANTES do laço dos itens — a classificação de IBS/CBS de cada item é conferida nessa data.
  const baseDate = await invoiceEmissionDateFor(schemaName, institutionId)
  const ibscbsProblemOf = ibscbsItemChecker(baseDate)
  const ibscbsProblems: Array<{ itemId: number } & IbscbsItemProblem> = []
  // IBS.E9.P5 (D-IB138 a D-IB141): o Simples no DAS de 2027 em diante — decidido e com o percentual do mês lido ANTES do laço e da transação
  const simplesPlan = await loadSimplesDasPlan({
    institution, crt: ctx.emitterCrt, simplesRegime: ctx.emitterSimplesRegime, emissionDate: baseDate,
    establishmentActivity: ctx.emitterSimplesActivity })
  const simplesProblems: Array<{ itemId: number; message: string }> = []
  // IBS.E9.P4 (D-IB143 a D-IB145): o regime regular (CRT 3) calcula e grava os valores por tributo já em 2026 — plano e alíquotas lidos ANTES do laço e da transação
  const regularPlan = await loadRegularPlan({ crt: ctx.emitterCrt, emissionDate: baseDate })
  const regularProblems: Array<{ itemId: number } & RegularProblem> = []

  const computed: ComputedItem[] = []
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    const merchandiseValue = merchValues[idx]
    const isService = item.productKind === 'S'
    const link = linkByItem.get(`${item.id}|${item.kind}`)

    let pieces: TaxRulePieces = {}
    if (link) {
      const cached = piecesCache.get(link.taxRuleId)
      if (cached) {
        pieces = cached
      } else {
        pieces = await loadPieces(schemaName, link.taxRuleId)
        piecesCache.set(link.taxRuleId, pieces)
      }
    }
    // IBS.E9.P3 (D-IB134): mercadoria sem classificação de IBS/CBS vigente não fatura — junta todos os itens e recusa depois do laço
    // `ibscbsChecked`: só o código CONFERIDO vai ao registro do item — o mesmo predicado decide a recusa e a gravação.
    let ibscbsChecked: string | null = null
    if (link && !isService && MERCHANDISE_KINDS.includes(item.kind)) {
      const problem = await ibscbsProblemOf(item.id, link.taxRuleId, pieces)
      if (problem) ibscbsProblems.push({ itemId: item.id, ...problem })
      else ibscbsChecked = pieces.ibscbs!.classificationCode
    }
    // IBS.E9.P5: o item de mercadoria do Simples declara atividade, percentual e valores; sem o percentual do mês a nota não sai (D-IB140)
    let ibscbsSimples: IbscbsSimplesDeclared | null = null
    if (simplesPlan.active && link && !isService && SIMPLES_KINDS.includes(item.kind)) {
      if (simplesPlan.rate === null) {
        simplesProblems.push({ itemId: item.id, message: simplesRateMissingMessage(item.id, simplesPlan.competence) })
      } else {
        ibscbsSimples = declareSimplesItem({ ...simplesPlan, rate: simplesPlan.rate }, item.id, {
          unitValue: item.unitValue, quantity: item.quantity, merchandiseValue,
          freightShare: freightShares[idx], expensesShare: expensesShares[idx],
        }, item.simplesActivity)
      }
    }

    // MVA/FCP por UF×NCM: ST pela UF do DESTINATÁRIO; NR (alíquota interna
    // do emitente) pela UF do EMITENTE (P2.7/P3.1)
    let stAliq: number | null = null
    let mvaPct: number | null = null
    let fcpAliq: number | null = null
    let fcpStAliq: number | null = null
    if (!isService && item.ncm && pieces.icmsSt) {
      const mvaDest = await resolveMvaAliq(
        schemaName, institutionId, ctx.recipientStateId!, item.ncm)
      if (mvaDest) {
        stAliq = mvaDest.internalAliq
        if (input.useMvaOriginal) {
          mvaPct = mvaDest.mvaOriginal
        } else {
          const mvaEmit = await resolveMvaAliq(
            schemaName, institutionId, ctx.emitterStateId!, item.ncm)
          const interAliq = pieces.icms?.aliq ?? mvaEmit?.internalAliq ?? 0
          mvaPct = adjustMva(mvaDest.mvaOriginal, interAliq, mvaDest.internalAliq)
        }
      }
    }
    if (!isService && item.ncm) {
      const fcp = await resolveFcpAliq(
        schemaName, institutionId, ctx.recipientStateId!, item.ncm)
      if (fcp) { fcpAliq = fcp.aliq; fcpStAliq = fcp.aliq }
    }

    const calcInput: ItemTaxCalcInput = {
      merchandiseValue,
      freight: freightShares[idx],
      insurance: 0,
      other: expensesShares[idx],
      kind: item.productKind,
      icms: pieces.icms ? {
        cst: pieces.icms.cstNr ?? '',
        csosn: pieces.icms.csosn ?? null,
        aliq: pieces.icms.aliq ?? 0,
        aliqReduction: pieces.icms.aliqReduction ?? 0,
        baseReduction: pieces.icms.baseReduction ?? 0,
        deferredAliqPct: pieces.icms.deferredAliq ?? 0,
        destinationIsResale: ctx.recipientConsumer === 'N',
        destinationIsContributor: ctx.recipientContributor,
        purpose: item.purpose ?? '0',
        stAliq, mvaPct,
        stBaseReduction: pieces.icmsSt?.propagateBaseReduction === 'S'
          ? (pieces.icms.baseReduction ?? 0) : 0,
        creditAliqPct,
      } : undefined,
      fcp: (fcpAliq || fcpStAliq) ? { aliqFcp: fcpAliq, aliqFcpSt: fcpStAliq } : undefined,
      ipi: pieces.ipi ? { cst: pieces.ipi.cst, aliq: pieces.ipi.aliq ?? 0 } : undefined,
      pisCofins: pieces.pisCofins?.map(pc => ({
        kind: pc.kind, cst: pc.cst, aliq: pc.aliq ?? 0,
        quantity: item.quantity, unitAliqValue: item.unitValue,
      })),
      issqn: isService ? {
        aliqPct: serviceRuleByItem.get(`${item.id}|${item.kind}`)!.aliq, // D13: alíquota da REGRA
        deductionValue: item.discountValue,
        withheld: ctx.recipientIssRetido,
      } : undefined,
    }
    const serviceRule = isService ? serviceRuleByItem.get(`${item.id}|${item.kind}`) ?? null : null

    const taxes = calculateItemTaxes(calcInput)
    // IBS.E9.P4: o item de mercadoria do regime regular declara a base e os valores por tributo — DEPOIS dos impostos do item (ICMS, PIS,
    // COFINS, FCP e II saem da base, A-IB143g); recusa junta todos os itens e sai depois do laço
    let ibscbsRegular: IbscbsRegularDeclared | null = null
    if (regularPlan.active && link && ibscbsChecked !== null) {
      const line = ibscbsProblemOf.lineOf(ibscbsChecked)
      const problem = regularProblemOf(regularPlan, item.id, link.taxRuleId, ibscbsChecked, line)
      if (problem) regularProblems.push({ itemId: item.id, ...problem })
      else {
        ibscbsRegular = declareRegularItem(regularPlan, item.id, line!, {
          unitValue: item.unitValue, quantity: item.quantity, merchandiseValue,
          freightShare: freightShares[idx], expensesShare: expensesShares[idx],
        }, taxes)
      }
    }

    computed.push({
      item,
      link: link ?? {
        orderItemId: item.id, kind: item.kind, taxRuleId: 0,
        cfopId: null, setFinancial: 'S', origin: 'A',
      },
      taxes,
      merchandiseValue,
      freightShare: freightShares[idx],
      expensesShare: expensesShares[idx],
      ipiCst: pieces.ipi?.cst ?? null,
      pisCst: pieces.pisCofins?.find(p => p.kind === 'P')?.cst ?? null,
      cofinsCst: pieces.pisCofins?.find(p => p.kind === 'C')?.cst ?? null,
      ibscbsClassificationCode: ibscbsChecked,
      ibscbsSimples,
      ibscbsRegular,
      icmsExtras: {
        cst: pieces.icms?.cstNr ?? pieces.icms?.csosn ?? null,
        origin: item.origin,
        modBc: pieces.icms?.modBc ?? null,
        modBcSt: pieces.icmsSt?.modBcSt ?? null,
        dischargeId: pieces.icms?.dischargeId ?? null,
        baseReduction: pieces.icms?.baseReduction ?? 0,
        aliqReduction: pieces.icms?.aliqReduction ?? 0,
        stBaseReduction: pieces.icmsSt?.propagateBaseReduction === 'S'
          ? (pieces.icms?.baseReduction ?? 0) : 0,
        mvaPct,
        stAliq,
      },
      issqnExtras: serviceRule
        ? {
            serviceListId: serviceRule.serviceListId, municipalCode: serviceRule.municipalCode,
            nationalCode: serviceRule.nationalCode, cityId: serviceRule.cityId, aliq: serviceRule.aliq,
          }
        : null,
    })
  }

  if (ibscbsProblems.length > 0) {
    // um 422 só, com todos os itens; o código é o do primeiro problema (regra sem a peça × código fora de vigência)
    throw new HttpError(422, 'Mercadoria sem classificação de IBS/CBS válida — revise as regras de tributação',
      ibscbsProblems.map(p => ({ field: `item.${p.itemId}`, message: p.message })), ibscbsProblems[0].code)
  }
  if (regularProblems.length > 0) {
    // um 422 só, com todos os itens (D-IB144, A-IB143f); o código é o do primeiro problema
    throw new HttpError(422, 'IBS/CBS do regime regular não pode ser calculado — revise as regras de tributação e as alíquotas',
      regularProblems.map(p => ({ field: `item.${p.itemId}`, message: p.message })), regularProblems[0].code)
  }
  if (simplesProblems.length > 0) {
    // um 422 só, com todos os itens (D-IB140): falta o percentual de IBS/CBS do Simples do mês da nota
    throw new HttpError(422, 'Falta o percentual de IBS/CBS do Simples do mês da nota — cadastre o percentual do mês',
      simplesProblems.map(p => ({ field: `item.${p.itemId}`, message: p.message })), 'BILLING_IBSCBS_SIMPLES_RATE_REQUIRED')
  }

  // total da nota = mercadorias + frete + despesas + ST + IPI (itens com financeiro)
  const totalValue = round2(
    computed.reduce((sum, ci) => sum + ci.merchandiseValue + ci.freightShare
      + ci.expensesShare + (ci.taxes.icms?.valueSt ?? 0) + (ci.taxes.ipi?.value ?? 0), 0))

  // financeiro (decisão 25 — materialização única): installment elaborado
  // vence; senão o PRAZO gera as parcelas
  const financialBase = round2(computed
    .filter(ci => ci.link.setFinancial !== 'N')
    .reduce((sum, ci) => sum + ci.merchandiseValue + ci.freightShare
      + ci.expensesShare + (ci.taxes.icms?.valueSt ?? 0) + (ci.taxes.ipi?.value ?? 0), 0))

  // Parcelas do pedido — COMPOSIÇÃO única (@shared/order-installment,
  // prompt_negociacao_pedido.md D7, 2026-09-06): elaborado é validado contra
  // a base do PEDIDO (itens + frete — ValidaParcelamento do legado) e a
  // diferença até a base da NOTA (ST/IPI/despesas) entra na 1ª parcela; sem
  // elaborado, o prazo do billing gera sobre a base da NOTA. ORDER_NO_BILLING
  // e INVALID_DEADLINE nascem lá. A mesma função alimenta o preview da tela.
  // Gate socrático 2026-09-06 (TOCTOU): a resolução roda DENTRO da transação
  // do faturamento, depois do FOR UPDATE em tb_order — um PUT da negociação
  // concorrente não pode mais deixar tb_financial nascendo de uma grade que
  // já não existe; o retry em deadlock re-resolve junto com a transação.
  // (a data de emissão — `baseDate` — já foi lida antes do laço dos itens: IBS.E9.P3)
  // D-NE215/D-NE27: o vNF do ramo de mercadoria pela fórmula oficial (peça do núcleo), datada pela emissão. NÃO muda o total da
  // nota nem a base do financeiro (acima) — esses seguem como eram.
  const merchandiseTotalValue = merchandiseInvoiceTotalOf(computed, baseDate)
  const resolveParcels = async (db: Queryable): Promise<ResolvedParcel[]> => {
    const resolved = await resolveOrderParcels(db, schemaName, institutionId, input.orderId,
      { noteBase: financialBase, baseDate })
    const parcels = resolved.parcels

    // Cheque (D8/D9 — prompt_cheque_rastreabilidade.md): parcela cuja forma
    // resolve para kind='Q' EXIGE cheques no payload cuja soma bata com o
    // valor da parcela; formas de qualquer outro kind não usam este bloco
    // (dados de cheque enviados por engano são ignorados, nunca aceitos).
    if (parcels.length > 0) {
      const typeIds = [...new Set(parcels.map(p => p.paymentTypeId))]
      const kindByType = await getPaymentTypeKinds(typeIds, db)
      for (const p of parcels) {
        if (kindByType.get(p.paymentTypeId) !== 'Q') continue
        const entry = input.checks?.find(c => c.parcel === p.parcel)
        if (!entry || entry.items.length === 0) {
          throw new HttpError(422, `Parcela ${p.parcel} é cheque — informe ao menos um cheque`,
            [{ field: `checks.${p.parcel}`, message: 'Obrigatório' }], 'CHECK_REQUIRED')
        }
        const sum = round2(entry.items.reduce((s, c) => s + c.value, 0))
        if (sum !== p.amount) {
          throw new HttpError(422, 'Soma dos cheques não confere com o valor da parcela',
            [{ field: `checks.${p.parcel}`, expected: p.amount, // Q-N3: a tela corrige sem parse
              message: `Soma dos cheques ${sum} difere do valor da parcela ${p.amount}` }],
            'CHECK_SUM_MISMATCH')
        }
      }
    }
    return parcels
  }

  // model por PRESENÇA de itens (natureza = ramo, D1–D11): mercadoria
  // presente → 55 (o ramo service da conjugada autoriza como NFS-e depois);
  // só serviço → SE (interna, como no Software House)
  const hasMerchandise = computed.some(ci => ci.item.productKind !== 'S')
  const model = hasMerchandise ? '55' : 'SE'
  // D-E2 (Onda 3) + D-F112 (F2a): a série da nota por modelo é leitura só no ERP (`@shared/invoice-series`); sem linha = '1'
  const serie = await invoiceSerieFor(pool, institution.schemaName, institution.institutionId, model)

  // R5-Q1 atualizada pelo parecer 2026-08-24: a direção do ajuste vem do
  // RAMO (gravada na abertura pelo order-returns) — fonte única, o
  // payload não a carrega mais.
  const polarity = resolveFinancialPolarity(branch.branch,
    branch.branch === 'adjust' ? branch.direction : undefined)

  // Motor de observações fiscais (T6/P11) — construído com os itens JÁ
  // calculados; persistido na MESMA transação (padrão do financeiro).
  const ruleIds = [...new Set(computed.map(ci => ci.link.taxRuleId).filter(id => id > 0))]
  const ruleNotes = await getRuleObservationNotes(schemaName, ruleIds)
  const generalNotes = await getGeneralObservations(schemaName, institutionId)

  const regimeItems: ObsRegimeItem[] = computed
    .filter(ci => ci.item.productKind !== 'S')
    .map(ci => ({
      cst: ci.icmsExtras.cst,
      baseSt: ci.taxes.icms?.baseSt ?? null,
      valueSt: ci.taxes.icms?.valueSt ?? null,
      baseReduction: ci.icmsExtras.baseReduction ?? null,
      creditAliq: ci.taxes.icms?.creditAliq ?? null,
      creditValue: ci.taxes.icms?.creditValue ?? null,
      observationNote: ci.link.taxRuleId > 0 ? (ruleNotes.get(ci.link.taxRuleId) ?? null) : null,
    }))
  const regimeTexts = buildRegimeObservations(regimeItems, creditAliqPct)

  const totalWithheldIssqn = round2(computed.reduce(
    (sum, ci) => sum + (ci.taxes.issqn?.withheldValue ?? 0), 0))
  const issqnText = buildIssqnObservation(totalWithheldIssqn)

  // Imposto aproximado (Lei 12.741/2012): percentual PERSISTIDO por item
  // sempre (mesmo padrão do ITF_IMP_APROX do legado — não depende da
  // config); a OBSERVAÇÃO agregada na nota é que é gated por config + só
  // ordem de venda ("natureza contém VENDA" do legado).
  const merchNcmCodes = computed
    .filter(ci => ci.item.productKind !== 'S' && ci.item.ncm)
    .map(ci => ci.item.ncm!)
  const ncmRates = await getNcmApproxRates(merchNcmCodes)
  const approxTaxByItem = new Map<string, number>()
  for (const ci of computed) {
    if (ci.item.productKind === 'S' || !ci.item.ncm) continue
    const rate = ncmRates.get(ci.item.ncm) ?? null
    approxTaxByItem.set(`${ci.item.id}|${ci.item.kind}`,
      calcApproxTaxAliq(ci.item.origin !== '0', rate))
  }

  const approxTaxEnabled = (await getConfigContent(
    institution, 'billing', 'approx_tax_enabled')) === 'S'
  let approxTaxText: string | null = null
  if (approxTaxEnabled && branch.branch === 'sale') {
    const approxItems = computed.filter(ci => ci.item.ncm).map((ci) => {
      const rate = ncmRates.get(ci.item.ncm!) ?? { aliqNac: 0, aliqImp: 0, aliqEst: 0, aliqMun: 0 }
      return {
        merchandiseValue: ci.merchandiseValue,
        aliqNac: ci.item.origin !== '0' ? rate.aliqImp : rate.aliqNac,
        aliqEst: rate.aliqEst, aliqMun: rate.aliqMun,
      }
    })
    approxTaxText = buildApproxTaxObservation(approxItems)
  }

  const noteText = [...generalNotes, ...regimeTexts, issqnText, approxTaxText]
    .filter((t): t is string => !!t).join('\n')
  // D-NE49 + D-NE267: com a marcação, o texto da nota acima do tamanho da NF-e é recusado com o campo — nunca truncado
  if (input.authorizeNfe === true && hasMerchandise) {
    const tooLong = noteTextIssue(noteText)
    if (tooLong) {
      throw new HttpError(422, 'Dados que a NF-e exige estão incompletos — corrija antes de faturar',
        [{ field: tooLong.field ?? 'note', message: tooLong.message }], 'REQUIRES_VALIDATION')
    }
  }

  // LOW-9 (seed 58): como o xDescServ do DPS é montado — 'I' itens · 'O' observação
  // da nota · 'A' ambos. Lido ANTES da transação (mesma regra da config acima).
  const dpsFormatRaw = await getConfigContent(institution, 'billing', 'dps_description_format')
  const dpsDescriptionFormat: 'I' | 'O' | 'A' = dpsFormatRaw === 'O' || dpsFormatRaw === 'A' ? dpsFormatRaw : 'I'

  // ── Comissão por item (Q1/Q2 da rodada 2026-08-24) ──────────────────────
  // Venda: lançamento POSITIVO por item (kind 'F' — faturamento; o modo
  // 'R' fica para a peça completa, Q5). Base = valor líquido do item
  // (qtde × unit − desconto), sem frete/ST/IPI. Alíquota resolvida na hora
  // (vendedor ou produto — semântica do VEN_PROPORCAO); aliq 0 = sem linha.
  const commissions: CommissionEntryInput[] = []
  if (branch.branch === 'sale') {
    const sale = await getSaleOrderInfo(schemaName, institutionId, input.orderId)
    if (sale) {
      // cache por produto×lista — sem ele a nota de N itens relê o mesmo
      // vendedor N vezes (R6 do gate socrático)
      const aliqCache = new Map<string, number>()
      for (const ci of computed) {
        if (ci.merchandiseValue <= 0) continue
        const cacheKey = `${ci.item.productId}|${ci.item.priceListId ?? ''}`
        let aliq = aliqCache.get(cacheKey)
        if (aliq === undefined) {
          aliq = await resolveCommissionAliq(
            schemaName, institutionId, sale.salesmanId, ci.item.productId, ci.item.priceListId)
          aliqCache.set(cacheKey, aliq)
        }
        if (aliq <= 0) continue
        commissions.push({
          kind: 'F', orderId: input.orderId,
          orderItemId: ci.item.id, orderItemKind: ci.item.kind,
          customerId: sale.customerId, salesmanId: sale.salesmanId,
          baseValue: ci.merchandiseValue, aliq,
          value: round2(ci.merchandiseValue * aliq / 100),
        })
      }
    }
  }
  // Devolução: lançamento NEGATIVO por item devolvido, para o vendedor
  // DERIVADO do pedido original (D3). Alíquota = a do lançamento positivo
  // da venda quando existe (espelho fiel do que foi comissionado); venda
  // anterior à peça = resolve pela fonte atual. Corrige o achado literal
  // do legado (estorno da comissão INTEIRA em devolução parcial — Q2).
  if (returnPlan) {
    const posted = await getPostedItemCommissions(
      schemaName, institutionId, returnPlan.orderIdOri)
    const postedByItem = new Map(posted.map(p => [`${p.orderItemId}|${p.orderItemKind}`, p]))
    const computedByItem = new Map(computed.map(ci => [`${ci.item.id}|${ci.item.kind}`, ci]))
    for (const link of returnPlan.links) {
      const ci = computedByItem.get(`${link.itemId}|${link.itemKind}`)
      if (!ci || ci.merchandiseValue <= 0) continue
      const postedEntry = postedByItem.get(`${link.itemIdOri}|${link.kindOri}`)
      const aliq = postedEntry
        ? postedEntry.aliq
        : await resolveCommissionAliq(
            schemaName, institutionId, returnPlan.salesmanId, link.productId, link.priceListIdOri)
      if (aliq <= 0) continue
      commissions.push({
        kind: 'F', orderId: input.orderId,
        orderItemId: link.itemId, orderItemKind: link.itemKind,
        customerId: returnPlan.customerId, salesmanId: returnPlan.salesmanId,
        baseValue: ci.merchandiseValue, aliq,
        value: -round2(ci.merchandiseValue * aliq / 100),
      })
    }
  }

  // D18 (regra de recebimento) / D9 (boleto): a política dos automatismos do
  // título (baixa por contrato + boleto automático) é resolvida pela
  // composição, SEMPRE fora da transação — ler config lá dentro pede uma 2ª
  // conexão do pool com a 1ª presa segurando locks (gate adversarial, Onda 1).
  const automationConfig = await resolveTitleAutomationConfig(
    schemaName, institutionId, institution.userId)

  return persistInvoice(schemaName, institutionId, {
    orderId: input.orderId,
    automationConfig,
    recipientEntityId: branch.recipientEntityId,
    model, serie,
    items: computed,
    totalValue,
    merchandiseTotalValue,
    inputPrint: billingInputPrint({ items, links, serviceLinks: serviceLinksRead, freight, expenses }),
    resolveParcels,
    checks: input.checks ?? [],
    financialKind: polarity.kind,
    financialOperation: polarity.operation,
    noteText,
    approxTaxByItem,
    userId: institution.userId,
    commissions,
    returnPlan,
    serviceLiability: liabilityFromExigibilidade(ctx.emitterIssExigibilidade),
    dpsDescriptionFormat,
    dtEmission: baseDate,   // D-IB64: a data calculada UMA vez (a mesma dos vencimentos)
  })
}

/**
 * Cancelamento da nota (prompt_cancelamento_nota.md, Onda 1 — nota NÃO
 * transmitida): a composição @shared/invoice.cancelInvoice faz tudo dentro
 * de UMA transação; deadlock reexecuta do zero (D-G4).
 */
export async function cancelOrderInvoice(
  institution: InstitutionPayload, input: CancelBody
): Promise<CancelInvoiceResult> {
  // F2a, etapa A3 (D-F4/D-F28/D-F29): o setes-api NUNCA fala com o fisco — a reconferência (Q-ADV1b) é pedida pelo APP à nfse-api
  // (`/v1/nfse/invoices/{id}/reconfirm`) e o plano EXIGE a prova LIDA no `fiscal_api` (veredito do núcleo — D-F109)
  const { schemaName, institutionId, userId } = institution
  return withDeadlockRetry('cancelamento da nota', { institutionId, orderId: input.orderId }, 3,
    async () => {
      const conn = await pool.getConnection()
      let broken = false
      try {
        await conn.beginTransaction()
        const result = await cancelInvoice(conn, schemaName, institutionId, userId, input)
        await conn.commit()
        return result
      } catch (err: any) {
        // F2AR4-ADV-04: a conexão pode ter MORRIDO (ECONNRESET/KILL — o 503 da voz na D-F130); o rollback que rejeita não substitui o
        // erro original e a conexão quebrada é DESCARTADA (nunca volta ao pool)
        try { await conn.rollback() } catch { broken = true }
        // lock wait → 409 RESOURCE_BUSY é TRANSVERSAL (Q-A3: @shared/db/contention
        // no handleError); aqui só propaga — deadlock reexecuta pelo retry.
        throw err
      } finally {
        if (broken) conn.destroy()
        else conn.release()
      }
    })
}

/**
 * D-F67/D-F72/D-F73/D-F74 (Rodada 13 das APIs fiscais): "manter a nota" — a NFS-e foi cancelada por SUBSTITUIÇÃO no
 * fisco (e105102) e o humano decide NÃO cancelar a nota no ERP. A peça `@shared/invoice.waiveSubstitutedCancel` faz
 * tudo em UMA transação; deadlock reexecuta do zero. Privilégio CANCELAR do ramo (rota).
 */
export async function waiveOrderInvoiceCancel(
  institution: InstitutionPayload, input: CancelWaiverBody
): Promise<CancelWaiverResult> {
  const { schemaName, institutionId, userId } = institution
  const result = await withDeadlockRetry('manter a nota substituída', { institutionId, orderId: input.orderId }, 3,
    async () => {
      const conn = await pool.getConnection()
      let broken = false
      try {
        await conn.beginTransaction()
        const out = await waiveSubstitutedCancel(conn, schemaName, institutionId, userId, input)
        await conn.commit()
        return out
      } catch (err: any) {
        try { await conn.rollback() } catch { broken = true }     // F2AR4-ADV-04 (ver cancelOrderInvoice)
        throw err
      } finally {
        if (broken) conn.destroy()
        else conn.release()
      }
    })
  // Q-TZ1: o instante sai na hora do ESTABELECIMENTO (banco em UTC)
  return withZoneWall(result, ['createdAt'] as const, await institutionZoneFor(schemaName, institutionId))
}

/** O plano de cancelamento para a TELA (D-F29/D-F115): o mesmo cálculo do POST — uma política só. */
export interface CancelPlanView {
  orderId:       number
  invoiceNumber: string | null
  cancellable:   boolean
  blocks:        CancelBlock[]
  /** D3/D4: com registro fiscal a nota FICA (evento C) e o pedido vira 'C'; sem, a nota some e o pedido volta a aberto. */
  fiscalRecord:  boolean
  effects: {
    bankSlipsToCancel: number[]
    releasedTitles:    ReleasedTitle[]
    checksToReverse:   { checkId: number; number: string }[]
    commissionsToCompensate: number
    /** D16: o cancelamento grava linha de caixa — exige caixa aberto do operador. */
    touchesCash:       boolean
    /** D16 do OPERADOR que consulta (F2A3-SOC-12): caixa aberto quando `touchesCash`; null quando o cancelamento não toca o caixa. */
    cashierOpen:       boolean | null
  }
}

/**
 * GET /api/billing/:orderId/cancel-plan — CONSULTIVO (D-F29/D-F115): o app consulta antes de pedir o cancelamento no fisco; mudou no
 * meio = o POST recusa com o plano novo. Roda o MESMO `buildCancelPlan` do POST (uma política só — assunção A-F115, §22.11) numa
 * transação que SEMPRE desfaz: nada é gravado; as travas do plano duram só a leitura (lock wait → 409 RESOURCE_BUSY).
 */
export async function getOrderCancelPlan(institution: InstitutionPayload, orderId: number): Promise<CancelPlanView> {
  const { schemaName, institutionId, userId } = institution
  const s = assertSchema(schemaName)
  return withDeadlockRetry('plano de cancelamento (consulta)', { institutionId, orderId }, 3, async () => {
    const conn = await pool.getConnection()
    // D-F131 (= Q-F139 (a)): quem só CONSULTA espera trava por pouco tempo — `innodb_lock_wait_timeout` curto na SESSÃO, devolvido ao
    // valor que a conexão TINHA (molde da D-F41 — `runShortCommand` do núcleo); estourou = 1205 → 409 RESOURCE_BUSY em segundos, nunca 50 s
    // segurando a nota que a nfse-api trava como 1º comando. Devolução que falha = conexão DESCARTADA (nunca volta ao pool encurtada).
    // F2AR4-ADV-03: a espera de METADADOS (LOCK TABLES, ALTER, dump com --lock-tables) NÃO obedece o innodb_lock_wait_timeout — o
    // `lock_wait_timeout` (86400 s no servidor) é encurtado e devolvido junto; estoura com o MESMO 1205 → 409.
    let shortened = false
    let restored = false
    try {
      await conn.query('SET @setes_plan_prev_lw = @@session.innodb_lock_wait_timeout, @setes_plan_prev_mdl = @@session.lock_wait_timeout')
      shortened = true
      await conn.query('SET SESSION innodb_lock_wait_timeout = ?, lock_wait_timeout = ?', [CANCEL_PLAN_LOCK_WAIT_SECONDS, CANCEL_PLAN_LOCK_WAIT_SECONDS])
      await conn.beginTransaction()
      const plan = await buildCancelPlan(conn, s, institutionId, orderId)
      // F2A3-SOC-12 (gate socrático da A3): o consultivo diz o que o POST diria — com linha de caixa (D16) e sem caixa aberto do
      // operador o POST recusa (NO_OPEN_CASHIER); `cancellable` não pode mandar o app ao fisco para depois parar no caixa
      const cashierOpen = plan.touchesCash ? (await findOpenCashierIdTx(conn, s, institutionId, userId)) != null : null
      return {
        orderId, invoiceNumber: plan.invoice.number, cancellable: plan.blocks.length === 0 && cashierOpen !== false, blocks: plan.blocks,
        fiscalRecord: plan.fiscalRecord,
        effects: {
          bankSlipsToCancel: plan.bankSlipsToCancel, releasedTitles: plan.releasedTitles,
          checksToReverse: plan.checksToReverse.map(c => ({ checkId: c.checkId, number: c.number })),
          commissionsToCompensate: plan.commissionEntries.length, touchesCash: plan.touchesCash, cashierOpen,
        },
      }
    } finally {
      await conn.rollback().catch(() => undefined)     // consultivo: nada fica, nem trava
      if (shortened) {
        try {
          await conn.query('SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw, lock_wait_timeout = @setes_plan_prev_mdl')
          restored = true
        } catch { /* descartada abaixo */ }
      }
      if (!shortened || restored) conn.release()
      else conn.destroy()
    }
  })
}

/** D-F131: quanto o plano CONSULTIVO espera uma linha travada antes de desistir com 409 (o mesmo número do comando curto — D-F41). */
export const CANCEL_PLAN_LOCK_WAIT_SECONDS = 3

/** O EFEITO da voz do fisco na nota (D-F79/D-F114/D-F115) — a tela "No fisco" compõe com a nfse-api (fisco). */
export interface FiscalEffectView {
  orderId:          number
  lifeEvent:        number | null
  invoiceCancelled: boolean
  effect:           FiscalEffect
  /** D-F81: a decisão "manter a nota" VIGENTE (nota viva) da chave da vigente — ou null. */
  cancelWaiver:     { accessKey: string; reason: string; userId: number; createdAt: string | null } | null
}

/**
 * GET /api/billing/:orderId/fiscal-effect — leitura CONSULTIVA (sem trava): vida pela view de política, voz da vida pela porta
 * `@shared/fiscal-voice`, dispensa pelo ERP. Nota inexistente → 404; nota soft-deletada (pendente cancelada) → efeito 'none'.
 */
export async function getOrderFiscalEffect(institution: InstitutionPayload, orderId: number): Promise<FiscalEffectView> {
  const { schemaName, institutionId } = institution
  const s = assertSchema(schemaName)
  const life = (await readInvoiceLives(pool, s, institutionId, [orderId])).get(orderId)
  if (!life) throw new HttpError(404, `Nota do pedido ${orderId} não encontrada`, undefined, 'INVOICE_NOT_FOUND')
  const invoiceCancelled = life.lastKind === 'C'
  if (life.invoiceDeleted) return { orderId, lifeEvent: life.lifeEvent, invoiceCancelled, effect: 'none', cancelWaiver: null }
  const { current } = await readInvoiceFiscal(pool, institutionId, orderId, life.lifeEvent)
  // a dispensa é da chave do documento REGISTRADO em produção (D-F80) — a chave só depois do fato do registro (F2A3-SOC-08)
  const key = fiscalRecordKey(current)
  const waiver = key ? await findCurrentCancelWaiver(pool, s, institutionId, orderId, key) : null
  const zone = await institutionZoneFor(schemaName, institutionId)
  return {
    orderId, lifeEvent: life.lifeEvent, invoiceCancelled,
    effect: fiscalEffectOf(current, life.lastKind, !!waiver),
    cancelWaiver: waiver ? withZoneWall(waiver, ['createdAt'] as const, zone) : null,   // Q-TZ1: hora do ESTABELECIMENTO
  }
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
