import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'

/**
 * DTOs (Zod) do módulo institutions — o bloco da cadeia de entidade fiscal
 * vem COMPONÍVEL de @shared/entity/entity.dto (skill
 * cadastro-entidade-fiscal.md); aqui entram só os campos do concreto.
 * withFiscalRefinements (toggle XOR + kinds únicos) SEMPRE por último —
 * .extend não existe em ZodEffects.
 * Saída: InstitutionListRow / InstitutionFull (institutions.interface.ts).
 */

/** D-PR47 revista pela D-OI10: W = a web é dona do catálogo · D = o ERP Desktop é dono (era L). A letra P saiu (o PDV nunca é dono). */
export const sourceKindDto = z.enum(['W', 'D'])

const institutionBase = entityFiscalBody.extend({
  active: z.enum(['S', 'N']).optional(),
  // na edição: igual ao gravado passa; D → W é a TROCA (só com a chave bloqueada — D-PR73/D-PR76); W → D = 409 SOURCE_KIND_IMMUTABLE
  sourceKind: sourceKindDto.optional(),
})

// Primeiro admin do cliente (A2, 2026-08-15): OBRIGATÓRIO no create e
// inexistente no update — o estabelecimento nunca nasce sem dono, mas a
// manutenção dos usuários é do cadastro de Usuários, não daqui.
// Regras espelham users.dto (senha mín. 5, hash MD5 no service).
const institutionAdminDto = z.object({
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().min(1).max(100),
  email:       z.string().min(1).max(100).email('E-mail inválido'),
  password:    z.string().min(5).max(100),
})

// schema_name: padrão setes_<nome>, informado na inclusão e IMUTÁVEL na
// edição (decisão do Valdo, 2026-07-11) — por isso só existe no create.
export const institutionCreateDto = withFiscalRefinements(
  institutionBase.extend({
    schemaName: z.string().max(100)
      .regex(/^setes_[a-z0-9_]+$/,
        'schemaName deve começar com "setes_" e conter apenas letras minúsculas, números e underscores'),
    admin: institutionAdminDto,
    // D-PR47 (parecer do guardião): fato DECLARADO, nunca presumido — sem default (um cliente do ERP Desktop cadastrado como W nunca
    // conseguiria a chave do sincronizador, e W não volta atrás).
    sourceKind: sourceKindDto,
  })
)

export const institutionUpdateDto = withFiscalRefinements(institutionBase)

export type InstitutionCreateDto = z.infer<typeof institutionCreateDto>
export type InstitutionUpdateDto = z.infer<typeof institutionUpdateDto>

/** Interruptor da chave do sincronizador (D-PR43 + D-PR48 item 1, Rodada 7): só PAUSA de emergência, reversível — 'N' = o setes-sync
 *  recusa a chave (D-SY13: sincronizador INATIVO até reativar; o cache dele leva até 5 min), 'S' = retoma a MESMA chave. NÃO muda o dono
 *  do catálogo, não cria categoria, não confere linhas (isso era a Rodada 6 e caiu). Em W (nativo web, ou trocado de D para W) não há o que
 *  retomar: 409 SYNC_KEY_NOT_FOR_SOURCE. */
export const syncApiKeyActiveDto = z.object({ active: z.enum(['S', 'N']) })
