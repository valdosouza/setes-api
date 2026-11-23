/// <reference types="jest" />
// NFE.E1.P1.T2 (D-NE215, D-NE27): o vNF do ramo de mercadoria é cunhado pela peça do núcleo `fiscal-api/merchandise-total`,
// com as parcelas somadas dos itens de mercadoria em centavos inteiros. Peça pura — sem banco.
import { merchandiseTotalsOf, merchandiseInvoiceTotalOf } from '../modules/billing/billing.total'
import { calcMerchandiseValue } from '../shared/tax-rule'
import type { ComputedItem } from '../modules/billing/billing.repository'

const D = '2026-11-23'
/** Um item calculado, só com o que a soma lê. */
function ci(over: {
  unit: number; qty: number; discount?: number; kind?: 'P' | 'M' | 'S'; freight?: number; expenses?: number
  valueSt?: number; fcpSt?: number; ipi?: number
}): ComputedItem {
  return {
    item: { id: 1, kind: 'Sale', productId: 1, quantity: over.qty, unitValue: over.unit, discountValue: over.discount ?? 0, productKind: over.kind ?? 'P' },
    merchandiseValue: calcMerchandiseValue(over.unit, over.qty, over.discount ?? 0),
    freightShare: over.freight ?? 0, expensesShare: over.expenses ?? 0,
    taxes: {
      icms: over.valueSt === undefined ? undefined : { base: 0, aliq: 0, value: 0, baseSt: 0, valueSt: over.valueSt },
      fcpSt: over.fcpSt === undefined ? undefined : { base: 0, value: over.fcpSt },
      ipi: over.ipi === undefined ? undefined : { base: 0, aliq: 0, value: over.ipi },
    },
  } as unknown as ComputedItem
}

describe('vNF do ramo de mercadoria pela fórmula oficial (RF-NFE-28, W16-10)', () => {
  it('nota real 3122 do cliente (CFOP 5101, CSOSN 101): vProd 4000,00 → vNF 4000,00', () => {
    expect(merchandiseInvoiceTotalOf([ci({ unit: 4000, qty: 1 })], D)).toBe(4000)
  })

  it('vProd 1000,00 − vDesc 50,00 + vFrete 30,00 + vOutro 12,50 → vNF 992,50', () => {
    const items = [ci({ unit: 100, qty: 10, discount: 50, freight: 30, expenses: 12.5 })]
    expect(merchandiseTotalsOf(items)).toMatchObject({ vProd: 100000, vDesc: 5000, vFrete: 3000, vOutro: 1250 })
    expect(merchandiseInvoiceTotalOf(items, D)).toBe(992.5)
  })

  it('soma ST, FCP-ST e IPI que o motor calculou: 200,00 + ST 36,00 + FCP-ST 4,00 + IPI 20,00 → 260,00', () => {
    const items = [ci({ unit: 100, qty: 2, valueSt: 36, fcpSt: 4, ipi: 20 })]
    expect(merchandiseTotalsOf(items)).toMatchObject({ vProd: 20000, vDesc: 0, vST: 3600, vFCPST: 400, vIPI: 2000 })
    expect(merchandiseInvoiceTotalOf(items, D)).toBe(260)
  })

  it('o que o faturamento não produz entra ZERO: seguro, desonerado, monofásico, II, IPI devolvido, vServ, PIS/COFINS-ST; veículo novo fora', () => {
    expect(merchandiseTotalsOf([ci({ unit: 10, qty: 1 })])).toEqual({
      vProd: 1000, vDesc: 0, vST: 0, vFCPST: 0, vFrete: 0, vOutro: 0, vIPI: 0, vSeg: 0, vICMSDesonDeducted: 0,
      vICMSMonoReten: 0, vII: 0, vIPIDevol: 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
    })
  })

  it('unitário com mais de 2 casas: vProd − vDesc é EXATAMENTE o valor líquido do item (10,006 − 0,002 → 10,00, como antes)', () => {
    const items = [ci({ unit: 10.006, qty: 1, discount: 0.002 })]
    expect(merchandiseTotalsOf(items)).toMatchObject({ vProd: 1001, vDesc: 1 })
    expect(merchandiseInvoiceTotalOf(items, D)).toBe(10)
    // varredura: em qualquer combinação o vNF sem frete/imposto = soma dos líquidos, e nenhuma parcela é negativa ou fracionária
    for (const unit of [0.333333, 1.005, 19.999999, 7.125, 1234.5678]) {
      for (const qty of [1, 3, 0.5, 2.3333]) {
        for (const discount of [0, 0.001, 0.005, 1]) {
          const one = [ci({ unit, qty, discount }), ci({ unit: unit * 2, qty, discount: 0 })]
          const t = merchandiseTotalsOf(one)
          expect(Number.isInteger(t.vProd) && Number.isInteger(t.vDesc) && t.vDesc >= 0).toBe(true)
          const net = one.reduce((s, i) => s + Math.round(i.merchandiseValue * 100), 0)
          if (one.every(i => i.merchandiseValue >= 0)) expect(merchandiseInvoiceTotalOf(one, D)).toBe(net / 100)
        }
      }
    }
  })

  it('nota conjugada: o item de serviço e a cota de frete dele NÃO entram (o serviço sai em NFS-e própria — vServ 0)', () => {
    const items = [ci({ unit: 100, qty: 1, freight: 6 }), ci({ unit: 500, qty: 1, kind: 'S', freight: 4 })]
    expect(merchandiseTotalsOf(items)).toMatchObject({ vProd: 10000, vFrete: 600, vServ: 0 })
    expect(merchandiseInvoiceTotalOf(items, D)).toBe(106)
  })

  it('nota só de serviço → null (não há ramo de mercadoria)', () => {
    expect(merchandiseInvoiceTotalOf([ci({ unit: 500, qty: 1, kind: 'S' })], D)).toBeNull()
    expect(merchandiseInvoiceTotalOf([], D)).toBeNull()
  })

  it('parcela negativa (ST negativa do CSOSN) → 422 BILLING_TOTAL_INVALID com o item, nunca 500 nem total errado', () => {
    try {
      merchandiseInvoiceTotalOf([ci({ unit: 100, qty: 1, valueSt: -3.5 })], D)
      throw new Error('devia recusar')
    } catch (err: any) {
      expect(err).toMatchObject({ statusCode: 422, code: 'BILLING_TOTAL_INVALID', fields: [{ field: 'item.1', message: expect.stringContaining('vST') }] })
    }
  })

  it('a recusa é POR ITEM: ST −1,20 de um item NÃO some atrás do +7,20 de outro (somadas dariam 6,00 e a nota sairia errada em silêncio)', () => {
    const a = ci({ unit: 100, qty: 1, valueSt: -1.2 })
    const b = ci({ unit: 100, qty: 1, valueSt: 7.2 })
    ;(b.item as any).id = 2
    expect(() => merchandiseInvoiceTotalOf([b, a], D))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'BILLING_TOTAL_INVALID', fields: [expect.objectContaining({ field: 'item.1' })] }))
    expect(merchandiseInvoiceTotalOf([b], D)).toBe(107.2)
  })

  it('data de emissão anterior à vigência da fórmula (01/07/2024) → 422 BILLING_TOTAL_INVALID', () => {
    expect(() => merchandiseInvoiceTotalOf([ci({ unit: 1, qty: 1 })], '2024-06-30'))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'BILLING_TOTAL_INVALID' }))
  })
})
