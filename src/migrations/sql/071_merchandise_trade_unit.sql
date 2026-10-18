-- 071 — UNIDADE DE VENDA da mercadoria (frente do cadastro de produtos, onda 1 —
-- Infra-IA/prompts/prompt_modulo_products.md §12/§16.2; D-PR1, D-PR15…D-PR19, D-PR30, D-PR31, A-PR1).
--
-- Conceito (parecer do guardião): a unidade comercial é um NÍVEL da mercadoria — a unidade em que
-- ela é contada × um FATOR em unidades-base × um GTIN próprio. O nível 1 é a unidade-BASE (fator 1
-- por definição) e nasce com o produto; a caixa com GTIN-14 é OUTRO nível do MESMO produto.
-- A mercadoria DESIGNA qual nível é o tributável (uTrib/cEANTrib da NF-e) e qual é o vendido quando o
-- item não diz — duas colunas aditivas NULL em tb_merchandise, únicas POR CONSTRUÇÃO (FK, nunca flag).
-- Contrato de leitura da NE-4: qTrib = qCom × fator(vendido) ÷ fator(tributável). O cadastro nunca
-- calcula qTrib nem congela nada (a NE-6 congela por item).
--
-- Escopo (PADROES_BANCO §12, D-GE2): tabela do GRUPO (chave do tb_product). A tb_stock (maquete do
-- legado) NÃO é tocada; o sync continua gravando tb_merchandise sem conhecer as colunas novas.
--
-- Garantias no BANCO (MariaDB ≥ 10.2 — colunas PERSISTENT indexadas; NULL não conflita em UNIQUE):
--  · GTIN único entre os níveis VIVOS do catálogo (D-PR19) pela IDENTIDADE GS1: o GTIN-13 7891234567895 e
--    o GTIN-14 07891234567895 são o MESMO código — a unicidade compara a forma de 14 dígitos (zeros à
--    esquerda, `live_gtin`); o GTIN é GRAVADO como foi digitado (é o cEAN impresso) — A-PR3 (gate ADV-05)
--  · (unidade, fator) único entre os níveis VIVOS do mesmo produto (D-PR31)
--  · nível 1 = fator 1; fator > 0; GTIN só com 8/12/13/14 dígitos (o DV é da peça de validação)
-- Nível designado não se exclui: a regra é da aplicação (D-PR30, 409); a FK só impede o DELETE físico.
CREATE TABLE IF NOT EXISTS `tb_merchandise_trade_unit` (
  `tb_institution_id` INT NOT NULL,
  `tb_merchandise_id` INT NOT NULL,
  `level`             INT NOT NULL COMMENT '1 = unidade-base (fator 1); demais = níveis comerciais (caixa, fardo...)',
  `tb_measure_id`     INT NOT NULL COMMENT 'Unidade (setes_central.tb_measure) — a abreviação vai no uCom/uTrib',
  `tb_package_id`     INT DEFAULT NULL COMMENT 'Embalagem descritiva (D-PR18) — NULL = sem; nunca a sentinela',
  `factor`            DECIMAL(14,6) NOT NULL COMMENT 'Quantas unidades-base o nível contém (> 0)',
  `gtin`              VARCHAR(14) DEFAULT NULL COMMENT 'GTIN GS1 do nível (cEAN); NULL = sem GTIN (o literal SEM GTIN nunca é gravado)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  `live_gtin`         VARCHAR(14) AS (IF(`deleted` = 'N', LPAD(`gtin`, 14, '0'), NULL)) PERSISTENT
                      COMMENT 'GTIN das linhas vivas na forma de 14 dígitos da GS1 — sustenta o UNIQUE do catálogo (D-PR19, A-PR3)',
  `live_marker`       TINYINT AS (IF(`deleted` = 'N', 1, NULL)) PERSISTENT
                      COMMENT '1 nas linhas vivas, NULL nas excluídas — sustenta o UNIQUE (unidade, fator) (D-PR31)',
  PRIMARY KEY (`tb_institution_id`, `tb_merchandise_id`, `level`),
  UNIQUE KEY `uq_mtu_live_gtin` (`tb_institution_id`, `live_gtin`),
  UNIQUE KEY `uq_mtu_live_unit_factor` (`tb_institution_id`, `tb_merchandise_id`, `tb_measure_id`, `factor`, `live_marker`),
  KEY `idx_mtu_merchandise` (`tb_merchandise_id`, `tb_institution_id`),
  KEY `idx_mtu_measure` (`tb_measure_id`),
  KEY `idx_mtu_package` (`tb_package_id`),
  CONSTRAINT `fk_mtu_merchandise` FOREIGN KEY (`tb_merchandise_id`, `tb_institution_id`)
    REFERENCES `tb_merchandise` (`id`, `tb_institution_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_mtu_measure` FOREIGN KEY (`tb_measure_id`)
    REFERENCES `setes_central`.`tb_measure` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_mtu_package` FOREIGN KEY (`tb_package_id`)
    REFERENCES `setes_central`.`tb_package` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `ck_mtu_level` CHECK (`level` >= 1),
  CONSTRAINT `ck_mtu_factor` CHECK (`factor` > 0),
  CONSTRAINT `ck_mtu_base_factor` CHECK (`level` <> 1 OR `factor` = 1),
  CONSTRAINT `ck_mtu_gtin_form` CHECK (`gtin` IS NULL OR `gtin` REGEXP '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'),
  CONSTRAINT `ck_mtu_deleted` CHECK (`deleted` IN ('N', 'S'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Unidade de venda da mercadoria: nível × unidade × fator × GTIN (D-PR15)';

-- Designações da mercadoria (D-PR16): aditivas, NULL = o padrão (tributável = a própria unidade vendida;
-- vendido por omissão = a base). FK composta para o nível do MESMO produto — a designação só aponta nível
-- que existe; NULL não é conferido (MATCH SIMPLE).
ALTER TABLE `tb_merchandise`
  ADD COLUMN IF NOT EXISTS `taxable_trade_level` INT DEFAULT NULL
    COMMENT 'Nível tributável (uTrib/cEANTrib — D-PR16); NULL = a própria unidade vendida',
  ADD COLUMN IF NOT EXISTS `default_sale_trade_level` INT DEFAULT NULL
    COMMENT 'Nível vendido quando o item não diz (D-PR16); NULL = a unidade-base';

ALTER TABLE `tb_merchandise`
  ADD CONSTRAINT `fk_merchandise_taxable_level` FOREIGN KEY IF NOT EXISTS
    (`tb_institution_id`, `id`, `taxable_trade_level`)
    REFERENCES `tb_merchandise_trade_unit` (`tb_institution_id`, `tb_merchandise_id`, `level`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_merchandise_sale_level` FOREIGN KEY IF NOT EXISTS
    (`tb_institution_id`, `id`, `default_sale_trade_level`)
    REFERENCES `tb_merchandise_trade_unit` (`tb_institution_id`, `tb_merchandise_id`, `level`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
