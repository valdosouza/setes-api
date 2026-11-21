import { z } from 'zod'
import { TAX_RULE_ORIGINS, TAX_RULE_PURPOSES } from '@shared/tax-rule'
import { decimalField, isCest, isGtin, isNcm, isValidCnpj } from '@shared/validation'
import { productPriceInputDto } from '@shared/price'

/**
 * DTO (Zod) do módulo merchandise. Tamanhos espelham o DDL (tb_product identifier 50 / description 100; tb_merchandise ncm 8 / cest 7;
 * tb_merchandise_trade_unit gtin 14). Formas pela peça `@shared/validation` (NCM 8, CEST 7, GTIN 8/12/13/14 + DV GS1) — sem tirar
 * separador (cerca D-CJ12): o app manda só dígitos.
 */

const sn = z.enum(['S', 'N'])

const gtinField = z.string().refine(isGtin, { message: 'GTIN inválido (8, 12, 13 ou 14 dígitos com o dígito verificador GS1)' })

const baseUnitDto = z.object({
  measureId: z.number().int().positive(),
  packageId: z.number().int().positive().nullable().optional(),
  gtin:      gtinField.nullable().optional(),
})

/**
 * FABRICANTE da mercadoria (D-PR10, D-PR60…D-PR65, A-PR6 — Rodada 9; passo PROD.E9.P1; RF-NFE-32/33). `scaleRelevance` = o indEscala
 * (`tb_merchandise.manuf_sign_ind_scale`): 'S' relevante, 'N' não relevante, null = não informado (três estados — D-SY5).
 * `manufacturerCnpj` = o CNPJFab (`tb_merchandise_factory`): canônico pela FederalId — 14 posições `[0-9A-Z]{12}[0-9]{2}` com o DV módulo 11
 * (ASCII − 48); o ALFANUMÉRICO é aceito (D-PR64). Forma não canônica (máscara, minúscula, espaço) é RECUSADA, nunca limpa (cerca D-CJ12).
 * Coerência: 'N' exige o CNPJ (rej. 879); CNPJ só com 'N' (D-PR62 — nunca zerar em silêncio); as duas chaves andam JUNTAS (A-PR6).
 */
const manufacturerCnpjField = z.string().refine(v => isValidCnpj(v), {
  message: 'CNPJ do fabricante inválido (14 posições sem máscara, letras maiúsculas e dígito verificador)',
})

const merchandiseShape = z.object({
  identifier:       z.string().max(50).nullable().optional(),
  description:      z.string().min(1).max(100),
  kind:             z.enum(['P', 'M']).optional().default('P'),
  categoryId:       z.number().int().positive(),
  financialPlansId: z.number().int().positive().nullable().optional(),
  brandId:          z.number().int().positive(),
  active:           sn.optional().default('S'),
  note:             z.string().max(4000).nullable().optional(),
  ncm:              z.string().refine(isNcm, { message: 'O NCM deve ter 8 dígitos' }).nullable().optional(),
  cest:             z.string().refine(isCest, { message: 'O CEST deve ter 7 dígitos' }).nullable().optional(),
  origin:           z.enum(TAX_RULE_ORIGINS).optional().default('0'),
  purpose:          z.enum(TAX_RULE_PURPOSES).optional().default('1'),
  // AUSENTES = o PUT não mexe no gravado; o POST grava "não informado" (A-PR6). Presentes = as duas juntas.
  scaleRelevance:   sn.nullable().optional(),
  manufacturerCnpj: manufacturerCnpjField.nullable().optional(),
  baseUnit:         baseUnitDto,
  prices:           z.array(productPriceInputDto).optional().default([])
                     .refine(arr => new Set(arr.map(p => p.priceListId)).size === arr.length,
                       { message: 'Tabela de preço duplicada na grade' }),
})

export const merchandiseDto = merchandiseShape.superRefine((v, ctx) => {
  const hasScale = v.scaleRelevance !== undefined, hasCnpj = v.manufacturerCnpj !== undefined
  if (hasScale !== hasCnpj) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: [hasScale ? 'manufacturerCnpj' : 'scaleRelevance'],
      message: 'scaleRelevance e manufacturerCnpj andam juntos (A-PR6)',
    })
    return
  }
  if (v.scaleRelevance === 'N' && v.manufacturerCnpj == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['manufacturerCnpj'],
      message: 'Produzido em escala NÃO relevante exige o CNPJ do fabricante (rejeição 879 da NF-e)',
    })
  }
  if (v.scaleRelevance !== 'N' && v.manufacturerCnpj != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['manufacturerCnpj'],
      message: 'O CNPJ do fabricante só vale para produto em escala NÃO relevante — limpe o campo (D-PR62)',
    })
  }
})

export type MerchandiseDto = z.infer<typeof merchandiseDto>

const tradeUnitDto = z.object({
  level:     z.number().int().min(1).nullable().optional(),   // null/ausente = nível NOVO (ADV2-02 — o serializador manda a chave)
  measureId: z.number().int().positive(),
  packageId: z.number().int().positive().nullable().optional(),
  // DECIMAL(14,6): até 6 casas e > 0 DEPOIS de normalizado (ADV-03 — 0,0000004 virava 0 no banco → CHECK → 500; 12,0000001 virava 12)
  factor:    decimalField({ scale: 6, max: 99999999.999999, positive: true }),
  gtin:      gtinField.nullable().optional(),
})

export const tradeUnitsDto = z.object({
  levels:                z.array(tradeUnitDto).min(1).max(50)
                           .refine(arr => {
                             const numbered = arr.filter(l => l.level != null).map(l => l.level)
                             return new Set(numbered).size === numbered.length
                           }, { message: 'Nível repetido na grade' }),
  // AUSENTE = não mexe na designação gravada; null = volta ao padrão (tributável = a vendida; venda = a base). Molde do `aliqKickback`
  // (D-PR9) — a designação nunca muda em silêncio (o espírito da D-PR30: a NF-e não muda sem alguém decidir) — A-PR2, a confirmar.
  taxableTradeLevel:     z.number().int().min(1).nullable().optional(),
  defaultSaleTradeLevel: z.number().int().min(1).nullable().optional(),
})

export type TradeUnitsDto = z.infer<typeof tradeUnitsDto>

export const catalogItemDto = z.object({
  description:  z.string().trim().min(1).max(100),
  abbreviation: z.string().trim().min(1).max(5).nullable().optional(),
})

/** Unidade de medida: a ABREVIAÇÃO é a chave (uCom/uTrib — 1 a 5 caracteres na coluna central). */
export const measureItemDto = catalogItemDto.extend({ abbreviation: z.string().trim().min(1).max(5) })

/** Embalagem: abreviação da central tem 3 caracteres. */
export const packageItemDto = catalogItemDto.extend({ abbreviation: z.string().trim().min(1).max(3).nullable().optional() })

/** Catálogo de campos da interface merchandise × caminho no payload deste DTO (obrigatoriedade apertada pelo cliente). */
export const MERCHANDISE_FIELD_PATHS: Readonly<Record<string, string>> = {
  tb_category_id:        'categoryId',
  tb_financial_plans_id: 'financialPlansId',
  tb_brand_id:           'brandId',
  source:                'origin',
  kind_tributary:        'purpose',
  tb_measure_id:         'baseUnit.measureId',
  tb_package_id:         'baseUnit.packageId',
  gtin:                  'baseUnit.gtin',
}
