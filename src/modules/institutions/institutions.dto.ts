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

const institutionBase = entityFiscalBody.extend({
  active: z.enum(['S', 'N']).optional(),
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
  })
)

export const institutionUpdateDto = withFiscalRefinements(institutionBase)

export type InstitutionCreateDto = z.infer<typeof institutionCreateDto>
export type InstitutionUpdateDto = z.infer<typeof institutionUpdateDto>

/** Interruptor da chave do sincronizador (D-PR43 — Valdo 2026-10-18: "só criar uma opção para desativar"): 'N' = o estabelecimento sai
 *  do legado (a web volta a escrever os cadastros — D-PR32/D-PR41 revista); 'S' = religa a MESMA chave, recusado se a web criou linha
 *  nas tabelas do legado no período (Q-PR47 (a)). Limites (grupo do sync, §9.2 do `setes-sync/verificacao-comissao-margem-mercadoria.md`):
 *  o setes-sync guarda a chave válida em cache por até 5 min (o desligamento avisa: pare o sincronizador ANTES — Q-PR46 (a)). */
export const syncApiKeyActiveDto = z.object({ active: z.enum(['S', 'N']) })
