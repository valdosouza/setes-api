-- 084 — IBS/CBS do SIMPLES NO DAS a partir de 2027: o percentual do mês, a atividade (cAtivSN) e o que o item declara
-- (passo setes-api:IBS.E9.P5; D-IB133, D-IB138, D-IB139, D-IB140, D-IB141 — Vault, prompts/prompt_fase_ibs_cbs.md).
--
-- Quatro peças (parecer do guardião, D-IB122): (1) o percentual do mês por ESTABELECIMENTO, IBS e CBS separados (D-IB138);
-- (2) a atividade PADRÃO do estabelecimento e (3) a EXCEÇÃO opcional da mercadoria, NULL = herda (D-IB139); (4) o congelamento do
-- item do Simples, irmão de `tb_order_item_ibscbs`, SEM `kind` (D-IB9), com os valores que o cálculo do mesmo passo grava
-- (D-NE248: coluna nasce com o cálculo). `classification_code` fica em `tb_order_item_ibscbs` (1:1; não se duplica).
--
-- Domínios fechados por CHECK BINÁRIO (PADROES §11): a atividade é 01-04 (a 90, não tributável, a NT não detalha: A-IB138d).
-- PRÉ-REQUISITO: nenhum além do schema do cliente (a referência a `setes_central.tb_institution` é a da 077).
-- Re-executável (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ADD CONSTRAINT IF NOT EXISTS).
-- Espelho no canônico (`sql/03_schema_cliente_ddl.sql`) no MESMO passo.

-- 0. Referência central presente? Falta = erro 1146 com o NOME da tabela (nunca errno 150).
SELECT 1 FROM `setes_central`.`tb_institution` LIMIT 0;

-- 1. O percentual (alíquota efetiva) do Simples de um estabelecimento num mês — pIBSSN e pCBSSN da NF-e (RF-SN-13, RF-SN-29).
--    O mês é 'AAAA-MM' (molde da 051). Sem anexo por ora (D-IB138). Escrita só pela peça @shared/ibscbs-simples-rate.
CREATE TABLE IF NOT EXISTS `tb_establishment_simples_rate` (
  `tb_institution_id` INT NOT NULL,
  `competence`        CHAR(7) NOT NULL COMMENT 'Mês de apuração, AAAA-MM',
  `ibs_rate`          DECIMAL(7,4) NOT NULL COMMENT 'pIBSSN: percentual efetivo do IBS no Simples (0 a 100, até 4 casas)',
  `cbs_rate`          DECIMAL(7,4) NOT NULL COMMENT 'pCBSSN: percentual efetivo da CBS no Simples (0 a 100, até 4 casas)',
  `tb_user_id`        INT NOT NULL COMMENT 'Quem cadastrou o percentual (fato editado por gente)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `competence`),
  CONSTRAINT `fk_establishment_simples_rate_institution`
    FOREIGN KEY (`tb_institution_id`)
    REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `tb_establishment_simples_rate`
  ADD CONSTRAINT IF NOT EXISTS `ck_establishment_simples_rate_competence`
    CHECK (`competence` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE `tb_establishment_simples_rate`
  ADD CONSTRAINT IF NOT EXISTS `ck_establishment_simples_rate_range`
    CHECK (`ibs_rate` BETWEEN 0 AND 100 AND `cbs_rate` BETWEEN 0 AND 100);

-- 2. Atividade PADRÃO do estabelecimento (cAtivSN, I17d): a linha do próprio emitente em `tb_entity_tax` (id = institution).
--    NULL = sem padrão cadastrado (vale 01 no faturamento: A-IB138b).
ALTER TABLE `tb_entity_tax`
  ADD COLUMN IF NOT EXISTS `simples_activity` CHAR(2) DEFAULT NULL
    COMMENT 'cAtivSN padrão do estabelecimento (Simples, NF-e 2027): 01 revenda e industrializados · 02 demais bens · 03/04 Zona Franca. NULL = 01'
    AFTER `simples_assessment`;

ALTER TABLE `tb_entity_tax`
  ADD CONSTRAINT IF NOT EXISTS `ck_entity_tax_simples_activity`
    CHECK (`simples_activity` IS NULL OR `simples_activity` COLLATE utf8mb4_bin IN ('01', '02', '03', '04'));

-- 3. EXCEÇÃO da mercadoria: NULL = herda a do estabelecimento (D-IB139).
ALTER TABLE `tb_merchandise`
  ADD COLUMN IF NOT EXISTS `simples_activity` CHAR(2) DEFAULT NULL
    COMMENT 'cAtivSN desta mercadoria quando difere do padrão do estabelecimento (NULL = herda)';

ALTER TABLE `tb_merchandise`
  ADD CONSTRAINT IF NOT EXISTS `ck_merchandise_simples_activity`
    CHECK (`simples_activity` IS NULL OR `simples_activity` COLLATE utf8mb4_bin IN ('01', '02', '03', '04'));

-- 4. O que o item do Simples declara — gravado pelo faturamento (única escrita: `persistItemTaxes`). Chave dos registros
--    irmãos do item, SEM `kind` (D-IB9; D-NE220 garante o id único). Registro histórico: sem FK; os CHECKs guardam o formato.
--    Os percentuais ficam COPIADOS do mês usado (a nota não muda se o cadastro mudar depois).
CREATE TABLE IF NOT EXISTS `tb_order_item_ibscbs_simples` (
  `tb_order_id`       INT(11) NOT NULL,
  `tb_order_item_id`  INT(11) NOT NULL,
  `tb_institution_id` INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `activity_code`     CHAR(2) NOT NULL COMMENT 'cAtivSN declarado pelo item',
  `competence`        CHAR(7) NOT NULL COMMENT 'Mês do percentual usado, AAAA-MM',
  `ibs_rate`          DECIMAL(7,4) NOT NULL COMMENT 'pIBSSN usado (%)',
  `cbs_rate`          DECIMAL(7,4) NOT NULL COMMENT 'pCBSSN usado (%)',
  `base_value`        DECIMAL(15,2) NOT NULL COMMENT 'Base do item (receita da operação do item, RF-SN-03)',
  `ibs_value`         DECIMAL(15,2) NOT NULL COMMENT 'vIBSSN',
  `cbs_value`         DECIMAL(15,2) NOT NULL COMMENT 'vCBSSN',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`),
  CONSTRAINT `ck_order_item_ibscbs_simples_activity` CHECK (`activity_code` COLLATE utf8mb4_bin IN ('01', '02', '03', '04')),
  CONSTRAINT `ck_order_item_ibscbs_simples_competence` CHECK (`competence` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
