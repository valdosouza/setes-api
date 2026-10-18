/**
 * Privilégios canônicos do catálogo (tb_privilege — seed da casa, ids
 * estáveis desde o gestão desktop). Definições do Valdo (2026-07-12):
 * VISUALIZAR decide o que entra no MENU do usuário regular (opção 1 do
 * workflow); os demais ligam/desligam ações nas telas (decisão 21 Fase 1).
 */
export const PRIVILEGE_INSERIR    = 1
export const PRIVILEGE_ALTERAR    = 2
export const PRIVILEGE_EXCLUIR    = 3
export const PRIVILEGE_IMPRIMIR   = 4
export const PRIVILEGE_FATURAR    = 5
export const PRIVILEGE_VISUALIZAR = 6
/** Cancelar nota (D12 do cancelamento, 2026-09-08 — seed sql/51; aplicado na
 *  rota pelo guard @shared/auth/require-privilege, junto com FATURAR — Q-P5). */
export const PRIVILEGE_CANCELAR   = 7
/** Desconto na baixa acima do teto da institution (D-G32 do cancelamento, Valdo
 *  2026-09-13 — BX-15 do legado exigia senha para QUALQUER desconto; seed sql/55:
 *  privilégio 8 na interface `settlements` + config `max_discount_aliquot`). */
export const PRIVILEGE_DESCONTO   = 8
/** Transmitir o documento ao FISCO (D-E14 / Onda 3 NFS-e, Valdo 2026-09-21 — seed
 *  sql/59: privilégio 9 nas interfaces `service-orders` e `orders`; exigido em
 *  `POST /api/billing/transmit` pelo ramo do pedido). Separado de FATURAR, como o
 *  legado separava AUTORIZAR. */
export const PRIVILEGE_TRANSMITIR = 9
/** Criar item no catálogo CENTRAL compartilhado entre clientes — marca, unidade, embalagem (D-PR33 do cadastro de produtos, Valdo
 *  2026-10-18; seed sql/66: privilégio 10 na interface `merchandise`). O 1º criador fixa a descrição para todos (imutável) — por isso
 *  ato próprio, não o INSERIR da tela. */
export const PRIVILEGE_CATALOGAR = 10
