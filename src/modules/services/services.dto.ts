import { z } from 'zod'
import { productPriceInputDto } from '@shared/price'

/**
 * DTO (Zod) do módulo services. Tamanhos espelham o DDL da tb_product
 * (identifier 50, description 100). prices[]: priceTag null = remover o
 * preço da tabela; priceListId duplicado é rejeitado.
 */

const sn = z.enum(['S', 'N'])

/** Fase IBS/CBS (D-IB6): códigos oficiais só com dígitos — a peça confere o catálogo. */
const ibscbsDto = z.object({
  classificationCode: z.string().regex(/^\d{6}$/, 'cClassTrib tem 6 dígitos'),
  placeIndicatorCode: z.string().regex(/^\d{6}$/, 'cIndOp tem 6 dígitos'),
})

export const serviceDto = z.object({
  identifier:       z.string().max(50).nullable().optional(),
  serviceTaxRuleId: z.number().int().positive().nullable().optional(),
  description:      z.string().min(1).max(100),
  categoryId:       z.number().int().positive(),
  financialPlansId: z.number().int().positive().nullable().optional(),
  promotion:        sn.optional().default('N'),
  highlights:       sn.optional().default('N'),
  published:        sn.optional().default('N'),
  active:           sn.optional().default('S'),
  note:             z.string().max(4000).nullable().optional(),
  // ausente = não mexe · null = remove (o app antigo que não manda o campo não apaga nada)
  nbs:              z.string().regex(/^\d{9}$/, 'NBS tem 9 dígitos (sem pontos)').nullable().optional(),
  ibscbs:           ibscbsDto.nullable().optional(),
  prices:           z.array(productPriceInputDto).optional().default([])
                     .refine(arr => {
                       const ids = arr.map(p => p.priceListId)
                       return new Set(ids).size === ids.length
                     }, { message: 'Tabela de preço duplicada na grade' }),
})

export type ServiceDto = z.infer<typeof serviceDto>

/**
 * D-PR45 (Rodada 7 de produtos): rotas PRÓPRIAS do enquadramento fiscal do serviço — fora da guarda do dono do catálogo (o legado
 * não produz esses fatos; a web é a única escritora deles).
 *  - `PUT /api/services/:id/tax-rule` — o vínculo com a regra de ISS: `null` = sem regra.
 *  - `PUT /api/services/:id/ibscbs` — a presunção IBS/CBS: a MESMA semântica do PUT do cadastro (ausente = não mexe · null = remove ·
 *    valor = grava), mas pelo menos um dos dois campos tem de vir (um corpo vazio não é um ato).
 */
export const serviceTaxRuleDto = z.object({
  serviceTaxRuleId: z.number().int().positive().nullable(),
})
export type ServiceTaxRuleDto = z.infer<typeof serviceTaxRuleDto>

export const serviceIbscbsDto = z.object({
  nbs:    z.string().regex(/^\d{9}$/, 'NBS tem 9 dígitos (sem pontos)').nullable().optional(),
  ibscbs: ibscbsDto.nullable().optional(),
}).refine(b => b.nbs !== undefined || b.ibscbs !== undefined,
  { message: 'Informe a NBS e/ou a classificação IBS/CBS', path: ['ibscbs'] })
export type ServiceIbscbsDto = z.infer<typeof serviceIbscbsDto>

/** Campos do catálogo da interface services que cada rota própria carrega (a obrigatoriedade do cliente vale só sobre eles). */
export const SERVICE_TAX_RULE_FIELDS = ['tb_service_tax_rule_id'] as const
export const SERVICE_IBSCBS_FIELDS   = ['classification_code', 'place_indicator_code'] as const

/** Catálogo de campos da interface services (seed sql/62) × caminho no payload deste DTO —
 *  o nome da coluna nem sempre é a chave (obrigatoriedade apertada pelo cliente). */
export const SERVICE_FIELD_PATHS: Readonly<Record<string, string>> = {
  tb_category_id:         'categoryId',
  tb_financial_plans_id:  'financialPlansId',
  tb_service_tax_rule_id: 'serviceTaxRuleId',
  classification_code:    'ibscbs.classificationCode',
  place_indicator_code:   'ibscbs.placeIndicatorCode',
}
