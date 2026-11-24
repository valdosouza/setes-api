import { HttpError } from '@shared/errors/http-error'
import pool from '@shared/db/connection'
import { getConfigContent } from '@shared/interface-config'
import { InstitutionPayload } from '@shared/types/express'
import { merchandiseParcelsOf, SimplesItemParcels } from './parcels'
import { ibscbsAssessmentAt, isIsoDate } from '@shared/ibscbs-assessment'
import { SimplesRate, simplesCompetenceOf, simplesRateAt } from '@shared/ibscbs-simples-rate'
import { resolveSimplesActivity } from '@shared/ibscbs-simples-activity'
import {
  IbscbsCalculationError, calcIbscbsSimplesBase, calcIbscbsSimplesItem, ibscbsTaxAssessmentOf,
} from '@shared/ibscbs-calculation'

/**
 * @shared/ibscbs-simples-das (setes-api:IBS.E9.P5; D-IB138 a D-IB141): o IBS/CBS do SIMPLES NO DAS que o faturamento declara por
 * item a partir de 2027 — a atividade (`cAtivSN`), o percentual do mês (`pIBSSN`/`pCBSSN`) e a base e os valores (`vIBSSN`/`vCBSSN`),
 * congelados em `tb_order_item_ibscbs_simples`. A conta é a do motor ratificado no IBS.E9.P1 (`@shared/ibscbs-calculation`); aqui
 * só se decide QUANDO ela vale e se monta a entrada.
 *
 * QUANDO vale (A-IB138c) — as quatro juntas, na data de emissão da nota:
 *   1. a data é ≥ a data de início: o piso 2027-01-01 no código; a configuração `billing`/`ibscbs_simples_start` só pode ADIAR
 *      (valor anterior ao piso é ignorado — A-IB141a: "em 2026 nada muda" não depende de cadastro);
 *   2. o CRT do emitente é 1 e ele NÃO é MEI (`simplesRegime` ≠ '2'): CRT 2 com sublimite e MEI não gravam — a NT tem conflito e
 *      lacuna, fica para a nfe-api;
 *   3. a opção de apuração do IBS/CBS é a 1, Simples no DAS (as opções 2 e 3 o faturamento já recusa — D-IB99);
 *   4. o item é de VENDA de mercadoria (D-IB142: compra e ajuste, que são entradas, ficam de fora; a decisão é de quem chama).
 * Antes do piso nada é lido além do CRT: nenhuma consulta nova em nota de 2026.
 */

/** O piso da data de início (RF-CAL-04: a obrigação do Simples começa em 01/01/2027). */
export const IBSCBS_SIMPLES_START_FLOOR = '2027-01-01'

/** A data de início efetiva: a configurada quando é data real e ≥ o piso; senão o piso (a configuração só adia). */
export function simplesStartOf(configured: string | null | undefined): string {
  const text = (configured ?? '').trim()
  const value = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) ? text.slice(0, 10) : text   // o ISO com hora ('2027-02-01T00:00:00Z') vale pelo dia
  return isIsoDate(value) && value > IBSCBS_SIMPLES_START_FLOOR ? value : IBSCBS_SIMPLES_START_FLOOR
}

export type SimplesDasPlan =
  | { active: false }
  | {
      active: true
      /** O mês do percentual: o da data de emissão (A-IB138a). */
      competence: string
      /** `null` = sem percentual cadastrado para o mês: o faturamento recusa (D-IB140). */
      rate: SimplesRate | null
      /** A atividade padrão do estabelecimento (null = 01). */
      establishmentActivity: string | null
    }

export interface SimplesDasPlanInput {
  institution: InstitutionPayload
  /** CRT do emitente ('1' | '2' | '3' | null). */
  crt: string | null
  /** opSimpNac gravado no emitente ('1' não optante · '2' MEI · '3' ME/EPP · null): o MEI é CRT 1 e NÃO entra (A-IB138c, RF-SN-16). */
  simplesRegime: string | null
  /** A data de emissão da nota (`invoiceEmissionDateFor`). */
  emissionDate: string
  establishmentActivity: string | null
}

/**
 * Decide, UMA vez por nota, se o Simples no DAS vale e lê o percentual do mês (sem trava, ANTES da transação — A-IB138f). Falha
 * de leitura sobe: nunca vira "não vale" em silêncio.
 */
export async function loadSimplesDasPlan(input: SimplesDasPlanInput): Promise<SimplesDasPlan> {
  const { institution, crt, simplesRegime, emissionDate, establishmentActivity } = input
  if (crt !== '1') return { active: false }
  if (simplesRegime === '2') return { active: false }   // MEI: a NT não tem fonte (RF-SN-16, grau N) — nada lido, nada recusado
  if (emissionDate < IBSCBS_SIMPLES_START_FLOOR) return { active: false }   // 2026: nada lido, nada muda (D-IB141)
  const start = simplesStartOf(await getConfigContent(institution, 'billing', 'ibscbs_simples_start'))
  if (emissionDate < start) return { active: false }
  const { schemaName, institutionId } = institution
  const { assessment } = await ibscbsAssessmentAt(pool, schemaName, institutionId, emissionDate, { lock: false })
  if (assessment !== '1') return { active: false }
  const competence = simplesCompetenceOf(emissionDate)
  const rate = await simplesRateAt(pool, schemaName, institutionId, competence)
  return { active: true, competence, rate, establishmentActivity }
}

/** O que o item do Simples declara — a linha de `tb_order_item_ibscbs_simples` (valores em reais com 2 casas). */
export interface IbscbsSimplesDeclared {
  activityCode: string
  competence:   string
  /** Percentuais usados, texto de 4 casas ('0.1000') — congelados no item. */
  ibsRate:      string
  cbsRate:      string
  baseValue:    number
  ibsValue:     number
  cbsValue:     number
}

export { merchandiseParcelsOf }
export type { SimplesItemParcels }

/**
 * A declaração de UM item (plano ativo e com percentual): base = `vProd + vFrete + vOutro − vDesc` (motor do IBS.E9.P1, A-IB138e),
 * valor = base × percentual efetivo, meio para cima, em milionésimos. Entrada que o motor recusa vira 422 com o item — nunca 500.
 */
export function declareSimplesItem(
  plan: Extract<SimplesDasPlan, { active: true }> & { rate: SimplesRate },
  itemId: number, parcels: SimplesItemParcels, merchandiseActivity: string | null,
): IbscbsSimplesDeclared {
  const activityCode = resolveSimplesActivity(merchandiseActivity, plan.establishmentActivity)
  try {
    const { vProd, vDesc, vFrete, vOutro } = merchandiseParcelsOf(parcels)
    const baseCents = calcIbscbsSimplesBase({ vProd, vFrete, vOutro, vDesc })
    const result = calcIbscbsSimplesItem({
      baseCents, assessment: ibscbsTaxAssessmentOf('1'),
      simplesAliqs: { ibs: plan.rate.ibsPpm, cbs: plan.rate.cbsPpm },
    })
    if (result.status !== 'calculated') {
      throw new IbscbsCalculationError('INVALID_INPUT', `percentual do Simples ausente (${result.tax})`)
    }
    return {
      activityCode, competence: plan.competence, ibsRate: plan.rate.ibsRate, cbsRate: plan.rate.cbsRate,
      baseValue: result.baseCents / 100, ibsValue: result.ibsCents / 100, cbsValue: result.cbsCents / 100,
    }
  } catch (err) {
    if (err instanceof IbscbsCalculationError) {
      throw new HttpError(422, 'IBS/CBS do Simples inválido pela conta oficial — confira os valores dos itens',
        [{ field: `item.${itemId}`, message: `Item ${itemId}: ${err.message}` }], 'BILLING_TOTAL_INVALID')
    }
    throw err
  }
}

/** A mensagem da recusa por mês sem percentual (D-IB140) — a mesma no 422 do faturamento e na pendência do /validate. */
export function simplesRateMissingMessage(itemId: number, competence: string): string {
  return `Item ${itemId}: sem o percentual de IBS/CBS do Simples do mês ${competence} — cadastre o percentual do mês no estabelecimento`
}
