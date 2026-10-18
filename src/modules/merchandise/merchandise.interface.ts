/**
 * Tipos do módulo merchandise — Cadastro de Produtos (MERCADORIA), onda 1 (Infra-IA/prompts/prompt_modulo_products.md §16;
 * D-PR1…D-PR31). Mercadoria = tb_product com kind ∈ {P, M} (D-PR4) + a especialização fiscal tb_merchandise + as UNIDADES DE VENDA
 * tb_merchandise_trade_unit (D-PR15). Caminho INDIVIDUAL (D5 do serviço): este módulo nunca enxerga nem toca serviço (kind 'S').
 * Nome do módulo = nome da tabela no banco (D-PR3); rótulo da tela "Produtos". tb_stock (maquete do legado) NÃO é tocada.
 * Espelho no app: apps/web/lib/app/modules/merchandise/ (a onda 1 do app espera os branches `densidade`/`shell`).
 */

export type MerchandiseKind = 'P' | 'M'

export interface MerchandiseListRow {
  id:                  number
  identifier:          string
  description:         string
  kind:                MerchandiseKind
  categoryId:          number
  categoryDescription: string | null
  brandId:             number
  brandDescription:    string | null
  ncm:                 string | null
  active:              'S' | 'N'
}

/** Unidade-base (nível 1 — fator 1 por definição; D-PR15) exibida e editada na aba Principal. */
export interface BaseUnitRow {
  measureId:           number
  measureAbbreviation: string | null
  measureDescription:  string | null
  packageId:           number | null
  packageDescription:  string | null
  gtin:                string | null
}

export interface MerchandisePriceRow {
  priceListId:          number
  priceListDescription: string | null
  priceTag:             number | null
  /** % de comissão por produto nesta tabela (D-PR9); null = a do vendedor. */
  aliqKickback:         number | null
}

export interface MerchandiseFull extends MerchandiseListRow {
  financialPlansId:          number | null
  financialPlansDescription: string | null
  note:                      string | null
  // fiscal do BEM (D-PR22 — do grupo)
  cest:                      string | null
  /** Origem da mercadoria (tabela A do CST, 0–8). */
  origin:                    string
  /** Finalidade (0–7) — presunção do cadastro que o seletor da regra casa. */
  purpose:                   string
  /** ST DERIVADA da presença do CEST (R5-Q5) — nunca coluna; só exibição. */
  st:                        boolean
  /** null = o produto nasceu fora da web (sync/legado) e ainda não tem nível base. */
  baseUnit:                  BaseUnitRow | null
  /** Designações (D-PR16): nível tributável e nível vendido por omissão; null = o padrão. */
  taxableTradeLevel:         number | null
  defaultSaleTradeLevel:     number | null
  prices:                    MerchandisePriceRow[]
}

export interface BaseUnitInput {
  measureId:  number
  packageId?: number | null
  gtin?:      string | null
}

export interface MerchandisePriceInput {
  priceListId:   number
  priceTag:      number | null
  aliqKickback?: number | null
}

export interface MerchandiseInput {
  /** Em branco → a API preenche com o próprio id na criação (D1 do serviço). */
  identifier?:       string | null
  description:       string
  kind:              MerchandiseKind
  categoryId:        number
  financialPlansId?: number | null
  /** Marca obrigatória (D-PR5) — vinculada à institution (criar na hora pelo lookup). */
  brandId:           number
  active?:           'S' | 'N'
  note?:             string | null
  /** NCM pleno de 8 dígitos (D36) — opcional no cadastro; sem ele o faturamento barra (MISSING_NCM). */
  ncm?:              string | null
  cest?:             string | null
  origin:            string
  purpose:           string
  baseUnit:          BaseUnitInput
  prices?:           MerchandisePriceInput[]
}

/** Nível da sub-rota "Unidades e GTIN" (vinculada B — §12.1). */
export interface TradeUnitRow {
  level:               number
  measureId:           number
  measureAbbreviation: string | null
  measureDescription:  string | null
  packageId:           number | null
  packageDescription:  string | null
  factor:              number
  gtin:                string | null
}

export interface TradeUnitsView {
  levels:                TradeUnitRow[]
  taxableTradeLevel:     number | null
  defaultSaleTradeLevel: number | null
}

export interface TradeUnitInput {
  /** Ausente = nível NOVO (a API numera: maior nível já usado + 1 — nunca reaproveita número). */
  level?:     number | null
  measureId:  number
  packageId?: number | null
  factor:     number
  gtin?:      string | null
}

export interface TradeUnitsInput {
  levels:                 TradeUnitInput[]
  /** Ausente = não mexe na designação gravada; null = volta ao padrão (A-PR2). */
  taxableTradeLevel?:     number | null
  defaultSaleTradeLevel?: number | null
}

/** Contagens dos cartões do painel de vínculos (GET /:id/links — D-PR25, §10.5 item 4). */
export interface MerchandiseLinks {
  tradeUnits: number
  taxRules:   number
}

export interface MerchandiseLookupRow {
  id:          number
  description: string | null
  /** = description — contrato { id, name } das listas de apoio da pesquisa avançada. */
  name?:       string | null
}
