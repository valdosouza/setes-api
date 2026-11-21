-- 080 (SCHEMA DO CLIENTE) — FABRICANTE da mercadoria: `tb_merchandise_factory` (cadastro de produtos, Rodada 9 — Vault:
-- prompts/prompt_modulo_products.md; D-PR10, D-PR60…D-PR65, A-PR6; passo setes-api:PROD.E9.P1; regras RF-NFE-32/33).
--
-- Conceito: especialização 1:1 OPCIONAL da mercadoria — o CNPJ do fabricante (CNPJFab, I05e da NF-e), que a nota exige quando o item é
-- produzido em escala NÃO relevante (indEscala = 'N' → rej. 879 sem ele). O indEscala fica onde já estava
-- (`tb_merchandise.manuf_sign_ind_scale`). Sem entidade "fabricante": a NF-e só consome as 14 posições. O fabricante é da MERCADORIA,
-- nunca da `tb_brand` (catálogo compartilhado entre clientes — D-PR10, achado 0.12). D-PR65 (Valdo, 2026-11-21) trocou a coluna da
-- D-PR59 por esta tabela.
--
-- Escopo (PADROES §12, D-GE2): tabela do GRUPO — `tb_institution_id` na chave, como a 071. Um fabricante por mercadoria POR CONSTRUÇÃO
-- (PK). A FK vai para `tb_merchandise` (não `tb_product`): fabricante de serviço é impossível pelo banco; o valor é o mesmo id do produto.
-- "Sem fabricante" = não ter linha VIVA (nunca CNPJ NULL nem o sentinela '0' — D-CJ5). Trocar = UPDATE da mesma linha (reviver grava o
-- CNPJ NOVO); limpar = deleted = 'S' (PADROES §3.1 — nada de DELETE). O único UNIQUE é a PK: o upsert por ela é seguro (PADROES §9 regra 10).
--
-- No banco só a FORMA do CNPJ (D-PR61): canônico [0-9A-Z]{12}[0-9]{2}, sem máscara, maiúsculas (`utf8mb4_bin` recusa a minúscula; o CHAR
-- descarta o espaço do fim, que então reprova o {14}). O CNPJ alfanumérico é aceito JÁ (D-PR64); o dígito verificador (módulo 11 com
-- ASCII − 48) é da peça FederalId no DTO. A coerência com o indEscala ('N' exige; CNPJ só com 'N') é do DTO (D-PR60/D-PR62). Só o
-- setes-api escreve nesta tabela; o setes-sync não a conhece (pedido D-PR63 — contrato entre grupos antes de ele gravar aqui).
--
-- Limite conhecido (o mesmo da 079): o modo de sessão do servidor não é estrito — texto acima de 14 posições é TRUNCADO antes do CHECK;
-- quem recusa o 15º caractere é o DTO (isValidCnpj exige a forma canônica exata).
--
-- Re-executável (CREATE TABLE IF NOT EXISTS com as constraints no CREATE). O 001_baseline não cria esta tabela. Provada em schema
-- descartável: scripts/prove-080-merchandise-factory.ts.

CREATE TABLE IF NOT EXISTS `tb_merchandise_factory` (
  `tb_institution_id` INT NOT NULL,
  `tb_merchandise_id` INT NOT NULL,
  `cnpj`              CHAR(14) NOT NULL COMMENT 'CNPJ do fabricante (CNPJFab, I05e) — canônico [0-9A-Z]{12}[0-9]{2}, sem máscara (D-PR64)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_merchandise_id`),
  KEY `idx_mf_merchandise` (`tb_merchandise_id`, `tb_institution_id`),
  CONSTRAINT `fk_mf_merchandise` FOREIGN KEY (`tb_merchandise_id`, `tb_institution_id`)
    REFERENCES `tb_merchandise` (`id`, `tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `ck_mf_cnpj_form` CHECK (`cnpj` COLLATE utf8mb4_bin REGEXP '^[0-9A-Z]{12}[0-9]{2}$'),
  CONSTRAINT `ck_mf_deleted` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Fabricante da mercadoria: CNPJ do fabricante (CNPJFab) — especialização 1:1 (PROD.E9.P1, D-PR65)';
