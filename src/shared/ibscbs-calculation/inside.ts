/**
 * Conta "por dentro" (RF-PRC-02 a 04): o preço já contém o IBS e a CBS; acha `vBC`, IBS da UF, IBS do município e CBS em
 * centavos, com `vBC + IBS UF + IBS Mun + CBS = S` e cada tributo a no máximo 0,01 do exato (a tolerância da NT).
 *
 * PORTE LITERAL de `Fc_ContaPorDentro` do ERP Desktop (`Funcao\Un_RegraContaPorDentro.pas`), que é igual à referência
 * neutra (`conta_por_dentro_componentes`): mesma janela, mesma ordem de busca (dv crescente; ajustes 0, +1, −1) e mesmo
 * desempate (menor erro; menos centavos ajustados; menor |dv|; o primeiro achado). Não reordene os laços: muda o resultado.
 */
import { MAX_CENTS, PPM_SCALE_BIG, assertCents, assertPpm, roundHalfUpDiv } from './arith'
import { IbscbsCalculationError, IbscbsInsideResult } from './types'

/** Centavos de busca em torno do `vBC` exato. */
const WINDOW = 6
/** Ordem de busca do ajuste de cada componente. */
const STEPS = [0, 1, -1] as const

/** Teto do `S` (o do ERP Desktop): 40 bilhões de reais, em centavos. */
export const IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS = MAX_CENTS

const ZERO = BigInt(0)

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value
}

export function calcIbscbsInside(grossBase: number, ibsUf: number, ibsMun: number, cbs: number): IbscbsInsideResult {
  const grossBaseCents = assertCents(grossBase, 'grossBaseCents')
  const ibsUfPpm = assertPpm(ibsUf, 'ibsUfPpm')
  const ibsMunPpm = assertPpm(ibsMun, 'ibsMunPpm')
  const cbsPpm = assertPpm(cbs, 'cbsPpm')
  if (grossBaseCents > IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS) {
    throw new IbscbsCalculationError('GROSS_BASE_ABOVE_LIMIT', 'conta por dentro: valor acima do limite do cálculo')
  }

  const aliq = [BigInt(ibsUfPpm), BigInt(ibsMunPpm), BigInt(cbsPpm)]
  const total = aliq[0] + aliq[1] + aliq[2]
  // Sem base positiva ou sem alíquota não há o que dividir: vBC = S e os componentes zerados.
  if (grossBaseCents === 0 || total === ZERO) {
    return { baseCents: grossBaseCents, ibsUfCents: 0, ibsMunCents: 0, cbsCents: 0, adjustedCents: 0, closes: true }
  }

  const s = BigInt(grossBaseCents)
  const center = roundHalfUpDiv(s * PPM_SCALE_BIG, PPM_SCALE_BIG + total)

  let found = false
  let bestError = ZERO
  let bestAdjusted = 0
  let bestDv = 0
  let bestBase = ZERO
  let bestVal: [bigint, bigint, bigint] = [ZERO, ZERO, ZERO]

  for (let dv = -WINDOW; dv <= WINDOW; dv++) {
    const vbc = center + BigInt(dv)
    if (vbc < ZERO) continue
    const base = [
      roundHalfUpDiv(vbc * aliq[0], PPM_SCALE_BIG),
      roundHalfUpDiv(vbc * aliq[1], PPM_SCALE_BIG),
      roundHalfUpDiv(vbc * aliq[2], PPM_SCALE_BIG),
    ]
    for (const d0 of STEPS) {
      for (const d1 of STEPS) {
        for (const d2 of STEPS) {
          const d = [d0, d1, d2]
          const val: [bigint, bigint, bigint] = [ZERO, ZERO, ZERO]
          let valid = true
          let adjusted = 0
          for (let i = 0; i < 3; i++) {
            // Componente sem alíquota fica em zero.
            if (aliq[i] === ZERO && d[i] !== 0) { valid = false; break }
            val[i] = base[i] + BigInt(d[i])
            // Tolerância da NT: no máximo 0,01 (1 centavo = 10^6 nesta escala) do exato.
            if (val[i] < ZERO || abs(val[i] * PPM_SCALE_BIG - vbc * aliq[i]) > PPM_SCALE_BIG) { valid = false; break }
            adjusted += Math.abs(d[i])
          }
          if (!valid) continue
          const error = abs(vbc + val[0] + val[1] + val[2] - s)
          if (
            !found || error < bestError ||
            (error === bestError && (adjusted < bestAdjusted || (adjusted === bestAdjusted && Math.abs(dv) < bestDv)))
          ) {
            found = true
            bestError = error
            bestAdjusted = adjusted
            bestDv = Math.abs(dv)
            bestBase = vbc
            bestVal = val
          }
        }
      }
    }
  }

  if (found) {
    return {
      baseCents: Number(bestBase),
      ibsUfCents: Number(bestVal[0]),
      ibsMunCents: Number(bestVal[1]),
      cbsCents: Number(bestVal[2]),
      adjustedCents: bestAdjusted,
      closes: bestError === ZERO,
    }
  }

  // Nunca deveria chegar aqui (o ajuste 0 em todos os componentes é sempre válido no centro); se chegar, devolve o
  // centro sem ajuste e diz que não fechou.
  const v = aliq.map(a => roundHalfUpDiv(center * a, PPM_SCALE_BIG))
  return {
    baseCents: Number(center),
    ibsUfCents: Number(v[0]),
    ibsMunCents: Number(v[1]),
    cbsCents: Number(v[2]),
    adjustedCents: 0,
    closes: center + v[0] + v[1] + v[2] === s,
  }
}
