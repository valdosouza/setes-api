/**
 * Estado de sessão derivado (decisão 17 do Framework de Configurações —
 * substituto das variáveis globais GB_* do Delphi). O JWT permanece
 * IDENTIDADE MÍNIMA ({ institutionId, userId, role, schemaName }); fatos
 * derivados vivem AQUI, resolvidos por request com cache TTL, e vão ao app
 * no bloco `context` do login (UX apenas — enforcement é sempre da API).
 * Valor novo de sessão = campo novo neste tipo + resolver no service:
 * PROIBIDO variável global solta.
 */
import type { SourceKind, CatalogOwner } from '@shared/catalog-owner'

export interface SessionContext {
  /**
   * Existe registro em tb_salesman com id = userId na institution do JWT
   * (herança por PK: tb_user.id = tb_entity.id = tb_salesman.id — decisão 15).
   */
  isSalesman: boolean
  /** D-PR47 (Rodada 7 de produtos): a ORIGEM DOS CADASTROS do estabelecimento (W nativo web · L transição do desktop legado · P PDV) e
   *  quem é o DONO do catálogo de base derivado dela — o app trava o cadastro em L e libera só o enquadramento fiscal do serviço
   *  (D-PR45). UX apenas: quem recusa é a `catalogOwnerGuard` (409 CATALOG_LEGACY_OWNED). null = fato ilegível (institution excluída). */
  sourceKind:   SourceKind | null
  catalogOwner: CatalogOwner | null
}
