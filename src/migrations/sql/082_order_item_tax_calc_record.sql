-- 082 — Registro do CÁLCULO do faturamento por item (D-NE248, Valdo 2026-11-23; passo setes-api:NFE.E1.P1.T3, PM-24).
--
-- O faturamento não congela dado de cadastro, mas registra o cálculo inteiro, a ponto de comprovar de onde veio cada valor. O motor
-- (`src/shared/tax-rule`) calculava e o faturamento DESCARTAVA: o ICMS da operação e o diferimento (vICMSOp, pDif, vICMSDif — CST 51
-- e CSOSN), o VALOR do IPI (a tabela só tinha base e alíquota) e o ISS retido. Estas colunas recebem esses resultados
-- (`persistItemTaxes`, `billing.repository.ts`; o mapa campo → coluna é `TAX_CALC_RECORD`, com cerca de compilação).
--
-- Todas NULL por padrão: NULL = "o motor não calculou" (linha antiga, linha do sincronizador, CST sem diferimento) — nunca lido
-- como zero. Nenhuma linha existente é regravada. Sem coluna para o que o faturamento não calcula (imposto de importação,
-- desonerado, DIFAL, ST retido): nascem com o cálculo. `operation_value`/`deferred_value` em (15,6): o (10,6) das irmãs estoura em
-- 10.000,00. Re-executável (ADD COLUMN IF NOT EXISTS). Espelho no canônico (`sql/03_schema_cliente_ddl.sql`) no MESMO passo.
ALTER TABLE `tb_order_item_icms`
  ADD COLUMN IF NOT EXISTS `operation_value` DECIMAL(15,6) DEFAULT NULL AFTER `approximate_tax`,
  ADD COLUMN IF NOT EXISTS `deferred_aliq` DECIMAL(10,2) DEFAULT NULL AFTER `operation_value`,
  ADD COLUMN IF NOT EXISTS `deferred_value` DECIMAL(15,6) DEFAULT NULL AFTER `deferred_aliq`;

ALTER TABLE `tb_order_item_ipi`
  ADD COLUMN IF NOT EXISTS `tag_value` DECIMAL(15,2) DEFAULT NULL AFTER `aliq_value`;

ALTER TABLE `tb_order_item_issqn`
  ADD COLUMN IF NOT EXISTS `withheld_value` DECIMAL(10,2) DEFAULT NULL AFTER `tag_value`;
