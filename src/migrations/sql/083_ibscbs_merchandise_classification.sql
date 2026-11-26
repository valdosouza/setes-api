-- 083 — Classificação de IBS/CBS da MERCADORIA: a que a regra de tributação presume e a que o item do pedido declara
-- (passo setes-api:IBS.E9.P3; D-IB9, D-IB133, D-IB134, D-IB135, D-IB136 — Vault, prompts/prompt_fase_ibs_cbs.md).
--
-- Só a CLASSIFICAÇÃO (cClassTrib). O CST nunca é guardado (é o prefixo do código). Sem coluna de valor, de alíquota, de redução
-- ou de diferimento: o faturamento ainda não calcula IBS/CBS, e coluna nasce com o cálculo (D-NE248) — os valores por tributo
-- (IBS.E9.P4) e os do Simples no DAS (IBS.E9.P5) vêm em tabelas próprias.
--
-- PRÉ-REQUISITO: sql/61_ibscbs_reference_ddl.sql aplicado em setes_central.
-- Re-executável (CREATE TABLE IF NOT EXISTS). Espelho no canônico (`sql/03_schema_cliente_ddl.sql`) no MESMO passo.

-- 0. Referência central presente? Falta = erro 1146 com o NOME da tabela (nunca errno 150).
SELECT 1 FROM `setes_central`.`tb_tax_ibscbs_classification` LIMIT 0;

-- 1. Classificação que a regra de MERCADORIA presume — peça 1:1 da regra, como as irmãs `tb_tax_rule_*`
--    (PRESENÇA = a regra define IBS/CBS). FK física ao CÓDIGO (como a 066); a vigência na data do fato é conferida pela peça
--    @shared/ibscbs-classification, no cadastro e no faturamento.
CREATE TABLE IF NOT EXISTS `tb_tax_rule_ibscbs` (
  `id`                   INT(11) NOT NULL COMMENT 'tb_tax_rule.id',
  `classification_code`  CHAR(6) NOT NULL COMMENT 'cClassTrib presumido (CST derivado = prefixo)',
  `created_at`           DATETIME DEFAULT NULL,
  `updated_at`           DATETIME DEFAULT NULL,
  `deleted`              CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  KEY `idx_txr_ibscbs_classification` (`classification_code`),
  CONSTRAINT `fk_txr_ibscbs_rule` FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`),
  CONSTRAINT `fk_txr_ibscbs_classification` FOREIGN KEY (`classification_code`)
    REFERENCES `setes_central`.`tb_tax_ibscbs_classification` (`code`),
  CONSTRAINT `ck_txr_ibscbs_code` CHECK (`classification_code` REGEXP '^[0-9]{6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Classificação que o ITEM declara — gravada pelo faturamento (única escrita: `persistItemTaxes`). Chave dos registros
--    irmãos do item (`tb_order_item_icms`…), SEM `kind` (D-IB9): o faturamento recusa id de item repetido (D-NE220).
--    Sem FK ao catálogo: registro histórico (como as colunas da 066 em `tb_invoice_service`); o CHECK guarda o formato.
CREATE TABLE IF NOT EXISTS `tb_order_item_ibscbs` (
  `tb_order_id`          INT(11) NOT NULL,
  `tb_order_item_id`     INT(11) NOT NULL,
  `tb_institution_id`    INT(11) NOT NULL,
  `terminal`             INT(11) NOT NULL DEFAULT 0,
  `classification_code`  CHAR(6) NOT NULL COMMENT 'cClassTrib declarado pelo item (CST derivado = prefixo)',
  `created_at`           DATETIME DEFAULT NULL,
  `updated_at`           DATETIME DEFAULT NULL,
  `deleted`              CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`),
  CONSTRAINT `ck_order_item_ibscbs_code` CHECK (`classification_code` REGEXP '^[0-9]{6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
