import { AddressRow, AddressInput, PhoneRow, PhoneInput, SocialMediaRow, SocialMediaInput } from '@shared/entity'

/**
 * Tipos do módulo establishment — autoatendimento do ADMIN do PRÓPRIO
 * institution sobre um SUBCONJUNTO da cadeia de entidade fiscal
 * compartilhada (@shared/entity). NUNCA aceita :id de rota (elimina IDOR
 * por construção) — institutionId vem sempre de req.institution (adminGuard).
 *
 * Contrato fechado com o app (nomes exatamente como no EstablishmentDto/
 * EstablishmentUpdateDto do prompt): `socials`, não `socialMedia` — a
 * tradução para o nome interno da cadeia acontece no service.
 */

/** GET /api/establishment — document/personType são SOMENTE LEITURA. */
export interface EstablishmentDto {
  nameCompany: string
  nickTrade:   string | null
  document:    string
  personType:  'F' | 'J'
  ie:          string | null
  im:          string | null
  /** Regime tributário do PRÓPRIO estabelecimento (D39: mantido SÓ aqui) —
   *  rótulo canônico de TAX_REGIMES em tb_entity_tax (entity = institution). */
  taxRegime:   string | null
  /** Fatos do EMITENTE consumidos pelos documentos fiscais (Onda 3 — D-E3/D-E23). */
  simplesRegime:    string | null
  /** regApTribSN (D-N19a/Q-N36) — só com simplesRegime '3', e aí obrigatório. */
  simplesAssessment: string | null
  /** pTotTribSN (Q-N37) — % aproximado da alíquota efetiva do Simples; só com simplesRegime '3', e aí obrigatório. */
  simplesTotalTaxAliquot: number | null
  /** cAtivSN padrão do estabelecimento (IBS.E9.P5, D-IB139): 01-04; null = 01. */
  simplesActivity:  string | null
  specialTaxRegime: string | null
  cnae:             string | null
  addresses:   AddressRow[]
  phones:      PhoneRow[]
  socials:     SocialMediaRow[]
}

/**
 * Resposta do PUT /api/establishment: o DTO + o aviso da D-IB105 (aditivo — o GET não o leva). `validFrom` = início da 1ª opção
 * FUTURA 2/3 de apuração do IBS/CBS quando ESTE salvamento tirou o estabelecimento do Simples; null = sem aviso. Nunca recusa.
 */
export interface EstablishmentUpdateResult extends EstablishmentDto {
  ibscbsAssessmentNotice: { validFrom: string } | null
}

/**
 * PUT /api/establishment — subconjunto EDITÁVEL. document/personType
 * NUNCA aparecem aqui (o DTO Zod nem os aceita — mais estreito, não erro).
 */
export interface EstablishmentUpdateInput {
  nameCompany: string
  nickTrade:   string | null
  ie?:         string | null
  im?:         string | null
  /** Campo avulso (D39.2) — null limpa; undefined não toca a tributação. */
  taxRegime?:  string | null
  simplesRegime?:    string | null
  simplesAssessment?: string | null
  simplesTotalTaxAliquot?: number | null
  simplesActivity?:  string | null
  specialTaxRegime?: string | null
  cnae?:             string | null
  addresses:   AddressInput[]
  phones:      PhoneInput[]
  socials:     SocialMediaInput[]
}
