-- 085 — IBS/CBS do REGIME REGULAR: o que o motor calculou, por tributo, para o item da mercadoria, congelado no faturamento
-- (passo setes-api:IBS.E9.P4; D-IB135, D-IB143, D-IB144, D-IB145 — Vault, prompts/prompt_fase_ibs_cbs.md).
--
-- Duas peças (parecer do guardião, D-IB122): (1) uma linha por TRIBUTO apurado no regular (U = IBS da UF, M = IBS do município,
-- C = CBS), com a alíquota nominal, a redução, a alíquota efetiva e o valor — tabela filha do item, chave dos irmãos mais `tax`,
-- SEM `kind` (D-IB9); (2) a BASE do item (`vBC`, um valor por item: o motor devolve um só) na peça 1:1 que já existe,
-- `tb_order_item_ibscbs` (083). Coluna nasce com o cálculo que a grava (D-NE248): sem diferimento (fora do passo, RF-BC-12), sem
-- modo de cálculo (por fora sempre, A-IB143b), sem `S`, `vIBS` nem totais (deriváveis). O item do Simples no DAS continua em
-- `tb_order_item_ibscbs_simples` (084) e não tem linha aqui; isso nasce da lógica do faturamento, não de CHECK.
--
-- Domínio fechado por CHECK BINÁRIO (PADROES §11). `reduction_rate` NULL = o código não leva `gRed`; nunca 0 no lugar de NULL.
-- PRÉ-REQUISITO: 083 aplicada. Sem FK (registro histórico, como a 083 e a 084).
-- Re-executável (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ADD CONSTRAINT IF NOT EXISTS).
-- Espelho no canônico (`sql/03_schema_cliente_ddl.sql`) no MESMO passo.

-- 1. O que o motor calculou para UM tributo do item — gravado pelo faturamento (única escrita: `persistItemTaxes`).
CREATE TABLE IF NOT EXISTS `tb_order_item_ibscbs_tax` (
  `tb_order_id`       INT(11) NOT NULL,
  `tb_order_item_id`  INT(11) NOT NULL,
  `tb_institution_id` INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `tax`               CHAR(1) NOT NULL COMMENT 'U = IBS da UF · M = IBS do município · C = CBS',
  `nominal_rate`      DECIMAL(7,4) NOT NULL COMMENT 'pIBSUF / pIBSMun / pCBS: alíquota nominal vigente na emissão (0 a 100, até 4 casas)',
  `reduction_rate`    DECIMAL(7,4) DEFAULT NULL COMMENT 'pRedAliq: redução do cClassTrib (NULL = sem o grupo gRed)',
  `effective_rate`    DECIMAL(7,4) NOT NULL COMMENT 'pAliqEfet: alíquota efetiva (igual à nominal sem redução)',
  `tax_value`         DECIMAL(15,2) NOT NULL COMMENT 'vIBSUF / vIBSMun / vCBS',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`, `tax`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `tb_order_item_ibscbs_tax`
  ADD CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_tax`
    CHECK (`tax` COLLATE utf8mb4_bin IN ('U', 'M', 'C'));

ALTER TABLE `tb_order_item_ibscbs_tax`
  ADD CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_range`
    CHECK (`nominal_rate` BETWEEN 0 AND 100 AND `effective_rate` BETWEEN 0 AND 100
           AND (`reduction_rate` IS NULL OR `reduction_rate` BETWEEN 0 AND 100));

ALTER TABLE `tb_order_item_ibscbs_tax`
  ADD CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_effective`
    CHECK (`effective_rate` <= `nominal_rate`);

-- 2. A base de cálculo do item (vBC) — NULL = o item não foi calculado (as linhas da 083 continuam válidas).
ALTER TABLE `tb_order_item_ibscbs`
  ADD COLUMN IF NOT EXISTS `base_value` DECIMAL(15,2) DEFAULT NULL
    COMMENT 'vBC do item no regime regular, um por item (NULL = não calculado)' AFTER `classification_code`;
