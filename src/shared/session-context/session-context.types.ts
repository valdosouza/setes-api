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
  /** D-PR47 revista pela D-OI10: a ORIGEM DOS CADASTROS do estabelecimento (W a web é dona · D o ERP Desktop é dono) e o DONO do
   *  catálogo de base derivado dela ('web' | 'desktop' — D-PR70) — o app ORIENTA o usuário quando o dono é o ERP Desktop.
   *  UX apenas: nada recusa (D-PR77 — a guarda saiu).
   *  null = fato ilegível (institution excluída). */
  sourceKind:   SourceKind | null
  catalogOwner: CatalogOwner | null
}
