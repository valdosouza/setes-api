import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'
import { CategoryKind } from '@shared/category-kind'
import { SourceKind } from '@shared/catalog-owner'

/**
 * Tipos do CONCRETO Institution (tb_institution na setes_central).
 * A cadeia de entidade fiscal é COMPARTILHADA: @shared/entity/entity.types
 * (skill cadastro-entidade-fiscal.md) — aqui fica só o que é do concreto.
 * Espelho no app: apps/web/lib/app/modules/institutions/domain/entity/object_institution.dart
 * (cadeia base em apps/web/lib/app/shared/entity/domain/).
 */

/** Cadeia completa + campos do concreto enviados no POST/PUT. */
export interface InstitutionInput extends EntityFiscalInput {
  active?: 'S' | 'N'
  /** D-PR47: o TIPO DA FONTE EXTERNA que alimenta o estabelecimento (W nativo web · L transição do desktop legado · P PDV) — declarado
   *  pelo Super no cadastro (obrigatório no POST), IMUTÁVEL na edição (409 SOURCE_KIND_IMMUTABLE se vier diferente): só muda pelo ato
   *  "encerrar a transição" (D-PR48/D-PR49). */
  sourceKind?: SourceKind
}

/** Linha da pesquisa (GET /api/institutions). */
export interface InstitutionListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  schemaName:  string
  active:      'S' | 'N' | null
  sourceKind:  SourceKind
}

/** Objeto COMPLETO devolvido no GET /api/institutions/:id. */
export interface InstitutionFull extends EntityFiscalFull {
  schemaName:        string
  active:            'S' | 'N' | null
  sourceKind:        SourceKind
  /** Instante do ato "encerrar a transição" (write-once); NULL = nunca foi L ou ainda é. */
  transitionEndedAt: string | null
  /** Autor do ato (tb_user.id do Super que o executou — D-PR53/D-PR57); NULL junto com `transitionEndedAt`. */
  transitionEndedBy: number | null
  /** Nome de exibição do autor (só leitura — D-PR57: a tela mostra autor e motivo ao lado da data); NULL sem ato. */
  transitionEndedByName: string | null
  /** Motivo do ato, como gravado (aparado — D-PR53); NULL junto com `transitionEndedAt`. */
  transitionEndReason: string | null
}

/** O FATO do estabelecimento sem a cadeia (leituras do interruptor da chave e do ato — D-PR47/D-PR48). */
export interface InstitutionFact {
  schemaName:        string
  sourceKind:        SourceKind
  transitionEndedAt: string | null
}

/** Resposta do ato "encerrar a transição" (POST /api/institutions/:id/end-legacy-transition — D-PR48/D-PR49). */
export interface LegacyTransitionResult {
  sourceKind:          SourceKind
  transitionEndedAt:   string | null
  /** id da categoria padrão criada por natureza (null = já havia uma viva). */
  defaultCategories:   Record<CategoryKind, number | null>
  /** Destino W: chaves do sincronizador inativadas em definitivo; destino P: 0 (os PDVs seguem com a chave — A-PR4/Q-PR60). */
  syncKeysInactivated: number
}

/**
 * Primeiro administrador do cliente, criado no PRÓPRIO onboarding (decisão
 * do Valdo, 2026-08-15 — A2: cliente nunca existe sem dono). Vira um usuário
 * comum da cadeia central com vínculo kind='admin' nesta institution.
 */
export interface InstitutionAdminInput {
  nameCompany: string
  nickTrade:   string
  email:       string
  password:    string
}

/**
 * Chave de sincronização da institution (tb_sync_api_key — D12 da revisão
 * do sincronizador: uma chave por estabelecimento, header X-Api-Key).
 * GET/POST /api/institutions/:id/sync-api-key.
 */
export interface SyncApiKeyRow {
  apiKey:            string
  establishmentCode: string
  active:            'S' | 'N'
}
