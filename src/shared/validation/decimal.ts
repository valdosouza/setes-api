import { z } from 'zod'

/**
 * Número que vai para uma coluna DECIMAL(p, s) — "o que valida é o que grava" (setes-api/02-VALIDACAO.md; Q-A27 da peça `@shared/money`;
 * gate adversarial da onda 1 de produtos, ADV-03/ADV-04, 2026-10-18). O servidor roda SEM modo estrito: valor acima da faixa da coluna é
 * GRAMPEADO em silêncio e casa decimal a mais é ARREDONDADA. Então o DTO:
 *   · recusa o valor com mais de `scale` casas (ruído binário de até 1e-9 é limpo — `0.1 + 0.2` vira 0.3; `12.0000001` é recusado, senão
 *     o JS e o banco discordam sobre "o mesmo valor");
 *   · recusa o que passa do teto da coluna;
 *   · entrega o valor JÁ normalizado (o que segue para o INSERT é o que foi conferido).
 */
export function roundScale(n: number, scale: number): number {
  const f = 10 ** scale
  return Math.round(Number((n * f).toPrecision(15))) / f
}

export function decimalField(opts: { scale: number; max: number; min?: number; positive?: boolean }) {
  const { scale, max, min = 0, positive = false } = opts
  return z.number()
    .refine(v => Number.isFinite(v) && Math.abs(v) <= max * 10, { message: `Valor fora da faixa (o máximo é ${max})` })
    // tolerância = ruído binário: 1e-9 ou alguns ULP do próprio valor (acima de 2^23 o ULP passa de 1e-9 — ADV2-08)
    .refine(v => Math.abs(roundScale(v, scale) - v) <= Math.max(1e-9, Math.abs(v) * Number.EPSILON * 4),
      { message: `No máximo ${scale} casas decimais` })
    .transform(v => roundScale(v, scale))
    .refine(v => v <= max, { message: `O valor máximo é ${max}` })
    .refine(v => (positive ? v > 0 : v >= min), { message: positive ? 'O valor deve ser maior que zero' : `O valor mínimo é ${min}` })
}
