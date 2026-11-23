/**
 * Totais da nota = soma EXATA dos itens (RF-BC-09: W35-10 em diante, sem tolerância; RF-SN-19 no Simples).
 * Quais itens entram (CST que leva o grupo) é de quem chama: aqui só se soma o que foi calculado. Cada item é conferido
 * antes de somar — item não calculado, conta que não fechou, campo que não é centavo ou `vIBS` diferente de UF +
 * município é erro.
 */
import { assertCents } from './arith'
import {
  IbscbsCalculationError, IbscbsItemCalculated, IbscbsSimplesItemCalculated, IbscbsSimplesTotals, IbscbsTotals,
} from './types'

function assertCalculated(item: unknown, name: string): void {
  if (item === null || typeof item !== 'object' || (item as { status?: unknown }).status !== 'calculated') {
    throw new IbscbsCalculationError('INVALID_INPUT', `${name}: só entra item calculado (status "calculated")`)
  }
}

export function ibscbsTotals(items: readonly IbscbsItemCalculated[]): IbscbsTotals {
  if (!Array.isArray(items)) throw new IbscbsCalculationError('INVALID_INPUT', 'items: esperada uma lista')
  const totals: IbscbsTotals = {
    baseCents: 0,
    ibsUfDeferredCents: 0, ibsUfCents: 0,
    ibsMunDeferredCents: 0, ibsMunCents: 0,
    ibsCents: 0,
    cbsDeferredCents: 0, cbsCents: 0,
  }
  items.forEach((item, i) => {
    const name = `items[${i}]`
    assertCalculated(item, name)
    for (const key of ['ibsUf', 'ibsMun', 'cbs'] as const) {
      if (item[key] === null || typeof item[key] !== 'object') {
        throw new IbscbsCalculationError('INVALID_INPUT', `${name}.${key}: esperado o valor do tributo`)
      }
    }
    if (item.closes !== true) {
      throw new IbscbsCalculationError('INVALID_INPUT', `${name}: a conta por dentro deste item não fechou`)
    }
    const ibs = assertCents(item.ibsCents, `${name}.ibsCents`)
    const uf = assertCents(item.ibsUf.valueCents, `${name}.ibsUf.valueCents`)
    const mun = assertCents(item.ibsMun.valueCents, `${name}.ibsMun.valueCents`)
    if (ibs !== uf + mun) {
      throw new IbscbsCalculationError('INVALID_INPUT', `${name}: vIBS (${ibs}) difere de IBS UF + IBS Mun (${uf + mun})`)
    }
    totals.baseCents += assertCents(item.baseCents, `${name}.baseCents`)
    totals.ibsUfDeferredCents += assertCents(item.ibsUf.deferredCents, `${name}.ibsUf.deferredCents`)
    totals.ibsUfCents += uf
    totals.ibsMunDeferredCents += assertCents(item.ibsMun.deferredCents, `${name}.ibsMun.deferredCents`)
    totals.ibsMunCents += mun
    totals.ibsCents += ibs
    totals.cbsDeferredCents += assertCents(item.cbs.deferredCents, `${name}.cbs.deferredCents`)
    totals.cbsCents += assertCents(item.cbs.valueCents, `${name}.cbs.valueCents`)
    for (const [key, value] of Object.entries(totals)) assertCents(value, `total ${key}`)
  })
  return totals
}

export function ibscbsSimplesTotals(items: readonly IbscbsSimplesItemCalculated[]): IbscbsSimplesTotals {
  if (!Array.isArray(items)) throw new IbscbsCalculationError('INVALID_INPUT', 'items: esperada uma lista')
  const totals: IbscbsSimplesTotals = { baseCents: 0, ibsCents: 0, cbsCents: 0 }
  items.forEach((item, i) => {
    const name = `items[${i}]`
    assertCalculated(item, name)
    totals.baseCents += assertCents(item.baseCents, `${name}.baseCents`)
    totals.ibsCents += assertCents(item.ibsCents, `${name}.ibsCents`)
    totals.cbsCents += assertCents(item.cbsCents, `${name}.cbsCents`)
    for (const [key, value] of Object.entries(totals)) assertCents(value, `total ${key}`)
  })
  return totals
}
