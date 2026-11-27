import { HttpError } from '@shared/errors/http-error'
import { ItemTaxCalcResult } from '@shared/tax-rule'
import { ClassificationAt, RegularRefusal, regularVerdictOf } from '@shared/ibscbs-classification'
import { loadIbscbsAliqTable } from '@shared/ibscbs-rate'
import { merchandiseParcelsOf, SimplesItemParcels } from '@shared/ibscbs-simples-das/parcels'
import {
  IbscbsAliqLine, IbscbsCalculationError, IbscbsItemCalculated, IbscbsTax, IbscbsTaxValue,
  calcIbscbsGrossBase, calcIbscbsItem, ibscbsAliqAt, ibscbsTaxAssessmentOf,
} from '@shared/ibscbs-calculation'

/**
 * @shared/ibscbs-regular (setes-api:IBS.E9.P4; D-IB143, D-IB144, D-IB145): o IBS/CBS do REGIME REGULAR (CRT 3) que o faturamento
 * calcula por item e congela em `tb_order_item_ibscbs_tax` (uma linha por tributo) e `tb_order_item_ibscbs.base_value` (o `vBC`).
 * A conta é a do motor ratificado no IBS.E9.P1 (`@shared/ibscbs-calculation`); aqui só se decide QUANDO ela vale, se o item pode
 * ser calculado e se monta a entrada.
 *
 * QUANDO vale (A-IB143a), na data de emissão da nota: o CRT do emitente é `3` e o item é mercadoria (venda, compra ou ajuste —
 * D-IB145; quem chama decide o tipo). CRT 1 e 2 e MEI não passam por aqui: o Simples é do `@shared/ibscbs-simples-das`.
 * Em 2026 vale também (D-IB143): não há data de início nem piso.
 *
 * O que RECUSA (A-IB143e, A-IB143f, A-IB143j; sempre com todos os itens, nunca um valor inventado):
 *  - classificação sem presença no modelo 55 (rej. 1025), CST fora de 000/200 (D-IB144), com `gTribRegular` ou com a redução ainda
 *    desconhecida (`regularVerdictOf`);
 *  - sem alíquota vigente na data para algum dos três tributos (a CBS de 2027 em diante não está na tabela: RF-CAL-02).
 *
 * Por fora sempre (A-IB143b). A base `S` é a do motor (RF-BC-03): ICMS, PIS, COFINS, FCP e II do item já calculados entram nela, por
 * isso a declaração é feita DEPOIS de `calculateItemTaxes` (A-IB143g). ICMS diferido e ICMS-ST retido não saem da base (lacuna).
 */

export type RegularPlan =
  | { active: false }
  | {
      active: true
      /** A data de emissão da nota (o fato gerador das alíquotas). */
      emissionDate: string
      /** A tabela de alíquotas viva, lida UMA vez antes da transação. */
      aliqTable: IbscbsAliqLine[]
    }

export type ActiveRegularPlan = Extract<RegularPlan, { active: true }>

export interface RegularPlanInput {
  /** CRT do emitente ('1' | '2' | '3' | null). */
  crt: string | null
  emissionDate: string
}

/** Decide, UMA vez por nota, se o regular vale e lê a tabela de alíquotas (sem trava, ANTES da transação). Falha de leitura sobe. */
export async function loadRegularPlan(input: RegularPlanInput): Promise<RegularPlan> {
  if (input.crt !== '3') return { active: false }
  return { active: true, emissionDate: input.emissionDate, aliqTable: await loadIbscbsAliqTable() }
}

export type RegularProblemCode =
  | 'BILLING_IBSCBS_NOT_ALLOWED_IN_NFE'
  | 'BILLING_IBSCBS_CST_NOT_SUPPORTED'
  | 'BILLING_IBSCBS_REDUCTION_UNKNOWN'
  | 'BILLING_IBSCBS_RATE_NOT_FOUND'
  | 'IBSCBS_CLASSIFICATION_NOT_FOUND'

export interface RegularProblem {
  code: RegularProblemCode
  message: string
}

const TAX_LABEL: Readonly<Record<IbscbsTax, string>> = { IBS_UF: 'IBS da UF', IBS_MUN: 'IBS do município', CBS: 'CBS' }

/** O mesmo texto no 422 do faturamento e na pendência do `/validate`. */
function refusalOf(reason: RegularRefusal, itemId: number, ruleId: number, line: ClassificationAt | null, code: string): RegularProblem {
  switch (reason) {
    case 'no-line':
      return { code: 'IBSCBS_CLASSIFICATION_NOT_FOUND',
        message: `Item ${itemId}: cClassTrib ${code} da regra de tributação ${ruleId} não existe no catálogo ou não está vigente na data da nota` }
    case 'not-allowed-in-nfe':
      return { code: 'BILLING_IBSCBS_NOT_ALLOWED_IN_NFE',
        message: `Item ${itemId}: cClassTrib ${code} da regra de tributação ${ruleId} não é permitido na NF-e modelo 55 (rej. 1025) — troque a classificação da regra` }
    case 'cst-unsupported':
      return { code: 'BILLING_IBSCBS_CST_NOT_SUPPORTED',
        message: `Item ${itemId}: cClassTrib ${code} (CST ${line?.cst}) ainda não é calculado no regime regular — só o CST 000 e o 200 sem grupo de tributação regular; troque a classificação da regra de tributação ${ruleId}` }
    case 'requires-regular':
      return { code: 'BILLING_IBSCBS_CST_NOT_SUPPORTED',
        message: `Item ${itemId}: cClassTrib ${code} exige o grupo de tributação regular (gTribRegular), que o faturamento ainda não calcula — troque a classificação da regra de tributação ${ruleId}` }
    case 'reduction-unknown':
      return { code: 'BILLING_IBSCBS_REDUCTION_UNKNOWN',
        message: `Item ${itemId}: a redução de alíquota do cClassTrib ${code} ainda não foi carregada no catálogo — recusado até a próxima carga (rotina do Super)` }
  }
}

/**
 * Pode calcular este item? Só diz o que se sabe SEM os impostos do item (serve ao `/validate`): o veredito do regular para a
 * classificação e a existência de alíquota vigente para os três tributos na data. `null` = sem problema.
 */
export function regularProblemOf(
  plan: ActiveRegularPlan, itemId: number, ruleId: number, code: string, line: ClassificationAt | null,
): RegularProblem | null {
  const verdict = regularVerdictOf(line)
  if (!verdict.accepted) return refusalOf(verdict.reason!, itemId, ruleId, line, code)
  for (const tax of ['IBS_UF', 'IBS_MUN', 'CBS'] as const) {
    if (ibscbsAliqAt(plan.aliqTable, tax, plan.emissionDate) === null) {
      return { code: 'BILLING_IBSCBS_RATE_NOT_FOUND',
        message: `Item ${itemId}: sem alíquota de ${TAX_LABEL[tax]} vigente em ${plan.emissionDate} — a alíquota ainda não foi fixada ou cadastrada; a nota do regime regular não pode ser calculada` }
    }
  }
  return null
}

/** O que o item declara no regime regular — as linhas de `tb_order_item_ibscbs_tax` e a base (reais com 2 casas; percentuais em texto de 4 casas). */
export interface IbscbsRegularDeclared {
  baseValue: number
  taxes: Array<{
    tax: 'U' | 'M' | 'C'
    nominalRate: string
    /** NULL = o código não leva `gRed` (redução zero). */
    reductionRate: string | null
    effectiveRate: string
    taxValue: number
  }>
}

/** Milionésimos de fração → percentual em texto de 4 casas, sem ponto flutuante (600000 → '60.0000'; 500 → '0.0500'). */
export function percentTextOf(ppm: number): string {
  return `${Math.floor(ppm / 10000)}.${String(ppm % 10000).padStart(4, '0')}`
}

const cents = (value: number | undefined): number => (value === undefined ? 0 : Math.round(value * 100))

/** Os componentes de `S` que os impostos já calculados do item trazem (RF-BC-03): ICMS, FCP, PIS, COFINS e II saem/entram na base. */
export function grossBaseComponentsOf(parcels: SimplesItemParcels, taxes: ItemTaxCalcResult) {
  const { vProd, vDesc, vFrete, vOutro } = merchandiseParcelsOf(parcels)
  return {
    vProd, vDesc, vFrete, vOutro,
    vICMS: cents(taxes.icms?.value),
    vFCP: cents(taxes.fcp?.value),
    vPIS: cents(taxes.pisCofins?.filter(p => p.kind === 'P').reduce((s, p) => s + p.value, 0)),
    vCOFINS: cents(taxes.pisCofins?.filter(p => p.kind === 'C').reduce((s, p) => s + p.value, 0)),
    vII: cents(taxes.ii?.iiValue),
  }
}

const SLOTS = [
  { tax: 'U', key: 'ibsUf' },
  { tax: 'M', key: 'ibsMun' },
  { tax: 'C', key: 'cbs' },
] as const

/**
 * A declaração de UM item (plano ativo, `regularProblemOf` sem problema): `vBC` = `S` (por fora), valor por tributo do motor.
 * Entrada que o motor recusa (ex.: `S` negativo) vira 422 com o item — nunca 500.
 */
export function declareRegularItem(
  plan: ActiveRegularPlan, itemId: number, line: ClassificationAt, parcels: SimplesItemParcels, taxes: ItemTaxCalcResult,
): IbscbsRegularDeclared {
  try {
    const grossBaseCents = calcIbscbsGrossBase(grossBaseComponentsOf(parcels, taxes))
    const ibsRed = line.ibsReductionPpm as number
    const cbsRed = line.cbsReductionPpm as number
    const result = calcIbscbsItem({
      grossBaseCents, mode: 'outside', assessment: ibscbsTaxAssessmentOf('not-simples'),
      aliqs: {
        ibsUf: ibscbsAliqAt(plan.aliqTable, 'IBS_UF', plan.emissionDate),
        ibsMun: ibscbsAliqAt(plan.aliqTable, 'IBS_MUN', plan.emissionDate),
        cbs: ibscbsAliqAt(plan.aliqTable, 'CBS', plan.emissionDate),
      },
      reductions: { ibsUf: ibsRed, ibsMun: ibsRed, cbs: cbsRed },
    })
    if (result.status !== 'calculated') {
      throw new IbscbsCalculationError('INVALID_INPUT', `alíquota de ${result.tax} ausente`)
    }
    return declaredOf(result)
  } catch (err) {
    if (err instanceof IbscbsCalculationError) {
      throw new HttpError(422, 'IBS/CBS do regime regular inválido pela conta oficial — confira os valores dos itens',
        [{ field: `item.${itemId}`, message: `Item ${itemId}: ${err.message}` }], 'BILLING_TOTAL_INVALID')
    }
    throw err
  }
}

function declaredOf(result: IbscbsItemCalculated): IbscbsRegularDeclared {
  return {
    baseValue: result.baseCents / 100,
    taxes: SLOTS.map(({ tax, key }) => {
      const v: IbscbsTaxValue = result[key]
      return {
        tax,
        nominalRate: percentTextOf(v.aliqPpm),
        reductionRate: v.reductionPpm > 0 ? percentTextOf(v.reductionPpm) : null,
        effectiveRate: percentTextOf(v.effectiveAliqPpm),
        taxValue: v.valueCents / 100,
      }
    }),
  }
}

/**
 * Depois das migrations: em cada schema de cliente vivo, as guardas da 085 existem pelo NOME (`tax` U/M/C, faixas e
 * efetiva ≤ nominal). Faltando, o setes-api NÃO sobe: sem elas, SQL direto gravaria um tributo ou uma alíquota que o código leria
 * como outra.
 */
export const REGULAR_EXPECTED_CHECKS: ReadonlyArray<readonly [table: string, name: string]> = Object.freeze([
  ['tb_order_item_ibscbs_tax', 'ck_order_item_ibscbs_tax_tax'],
  ['tb_order_item_ibscbs_tax', 'ck_order_item_ibscbs_tax_range'],
  ['tb_order_item_ibscbs_tax', 'ck_order_item_ibscbs_tax_effective'],
])

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

export async function regularMissingChecks(q: Queryable, schemaName: string): Promise<string[]> {
  const [rows] = await q.query(
    `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`, [schemaName])
  const present = new Set((rows as any[]).map(r => `${r.t}.${r.n}`))
  return REGULAR_EXPECTED_CHECKS.filter(([t, n]) => !present.has(`${t}.${n}`)).map(([t, n]) => `${t}.${n}`)
}

/** A coluna `base_value` de `tb_order_item_ibscbs` (085) existe no schema? */
export async function regularBaseColumnPresent(q: Queryable, schemaName: string): Promise<boolean> {
  const [rows] = await q.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_order_item_ibscbs' AND COLUMN_NAME = 'base_value'`, [schemaName])
  return (rows as any[]).length > 0
}

export async function assertIbscbsRegularChecks(q: Queryable): Promise<string> {
  const [schemas] = await q.query(
    "SELECT DISTINCT schema_name AS s FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N' AND schema_name IS NOT NULL")
  const bad: string[] = []
  for (const { s } of schemas as any[]) {
    const missing = await regularMissingChecks(q, String(s))
    if (!(await regularBaseColumnPresent(q, String(s)))) missing.push('tb_order_item_ibscbs.base_value (coluna)')
    if (missing.length) bad.push(`${s}: ${missing.join(', ')} ausente(s)`)
  }
  if (bad.length) {
    throw new Error(`IBS.E9.P4: guardas do IBS/CBS do regime regular ausentes — ${bad.join(' | ')} — confira a migration 085`)
  }
  return `${REGULAR_EXPECTED_CHECKS.length} CHECK(s) em ${(schemas as any[]).length} schema(s)`
}
