/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA de correção — cadastro de produtos (mercadoria), onda 1 (2026-10-18, 2ª rodada).
//
// Alvo: `decimalField` (@shared/validation/decimal — "o que valida é o que grava") pelos DTOs REAIS que o usam: o fator do nível
// (DECIMAL(14,6)), a grade de preços COMPARTILHADA (`productPriceInputDto` — price_tag DECIMAL(13,6), aliq_kickback DECIMAL(10,2)) no
// DTO da mercadoria E no do serviço (regressão). Bordas provadas também no banco (schema descartável, roteiro do gate
// `probe-merchandise-r2.ts`: 9999999.999999 / 99.99 / -0 / 0.1+0.2 gravaram como conferidos; fator 99999999.999999 e 0.3 relidos do
// banco e regravados SEM diferença). Semântica fixada (todos devem PASSAR).
import { merchandiseDto, tradeUnitsDto } from '../modules/merchandise/merchandise.dto'
import { serviceDto } from '../modules/services/services.dto'

const factorOf = (factor: unknown) => tradeUnitsDto.safeParse({ levels: [{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor }] })
const normalizedFactor = (factor: number) => {
  const r = factorOf(factor)
  if (!r.success) throw new Error(`recusado: ${factor}`)
  return r.data.levels[1].factor
}
const price = (p: Record<string, unknown>) => merchandiseDto.safeParse({
  description: 'X', categoryId: 3, brandId: 1, baseUnit: { measureId: 1 }, prices: [{ priceListId: 1, ...p }],
})
const servicePrice = (p: Record<string, unknown>) => serviceDto.safeParse({ description: 'S', categoryId: 2, prices: [{ priceListId: 1, ...p }] })

describe('fator do nível — DECIMAL(14,6), > 0', () => {
  it('teto exato 99999999.999999 aceito e entregue IGUAL (o que o banco relê)', () => {
    expect(normalizedFactor(99999999.999999)).toBe(99999999.999999)
  })

  it.each([
    ['meia casa acima do teto', 99999999.9999995],
    ['acima do teto', 100000000],
    ['7ª casa', 1.0000001],
    ['abaixo da 6ª casa (arredondaria para 0 → CHECK)', 1e-7],
    ['ruído que normaliza para 0', 5e-10],
    ['zero', 0],
    ['-0', -0],
    ['negativo', -1],
    ['1e21', 1e21],
    ['Infinity (JSON 1e400)', Infinity],
    ['NaN', NaN],
    ['string numérica', '12.5'],
    ['null', null],
  ])('%s → 400', (_label, factor) => {
    expect(factorOf(factor).success).toBe(false)
  })

  it('ruído binário até 1e-9 é limpo: 0.1 + 0.2 → 0.3; 12.0000000004 → 12', () => {
    expect(normalizedFactor(0.1 + 0.2)).toBe(0.3)
    expect(normalizedFactor(12.0000000004)).toBe(12)
  })

  it('base com fator 1 + ruído (1.0000000004) continua base (a guarda D-PR15 compara o normalizado)', () => {
    const r = tradeUnitsDto.safeParse({ levels: [{ level: 1, measureId: 1, factor: 1.0000000004 }] })
    expect(r.success && r.data.levels[0].factor).toBe(1)
  })
})

describe('grade de preços — peça compartilhada mercadoria × serviço', () => {
  it.each([
    [9999999.999999, true], [9999999.9999995, false], [10000000, false], [0, true], [-0, true],
    [0.000001, true], [1e-7, false], [-0.01, false], [12.1234567, false],
  ])('priceTag %p → aceito %p (mercadoria)', (priceTag, ok) => {
    expect(price({ priceTag }).success).toBe(ok)
  })

  it.each([
    [100, true], [99.99, true], [0, true], [100.005, false], [99.995, false], [100.01, false], [-0.01, false], [0.1 + 0.2, true],
  ])('aliqKickback %p → aceito %p', (aliqKickback, ok) => {
    expect(price({ priceTag: 10, aliqKickback }).success).toBe(ok)
  })

  it('aliqKickback ausente fica AUSENTE (a coluna não é tocada) e null fica null', () => {
    const absent = price({ priceTag: 10 })
    const nul = price({ priceTag: 10, aliqKickback: null })
    expect(absent.success && 'aliqKickback' in absent.data.prices[0]).toBe(false)
    expect(nul.success && nul.data.prices[0].aliqKickback).toBeNull()
  })

  it('REGRESSÃO serviços: o que o app de serviços manda hoje segue aceito (0, null, inteiro, 2 casas)', () => {
    for (const priceTag of [0, null, 10, 10.5, 1234.56]) expect(servicePrice({ priceTag }).success).toBe(true)
    const r = servicePrice({ priceTag: 0.1 * 3 })   // 0.30000000000000004 — o double que um cálculo no app produz
    expect(r.success && r.data.prices[0].priceTag).toBe(0.3)
  })

  it('MUDANÇA de contrato em serviços (era aceito e o banco grampeava/arredondava em silêncio): 7ª casa e > 9.999.999,999999 → 400', () => {
    expect(servicePrice({ priceTag: 12.1234567 }).success).toBe(false)
    expect(servicePrice({ priceTag: 20000000 }).success).toBe(false)
  })
})
