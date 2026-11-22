-- 081 (CENTRAL) — ORIGEM DOS CADASTROS só W e D: `tb_institution.source_kind` passa de W/L/P para W/D (passo setes-api:PROD.E10.P1;
-- D-OI10, Valdo 2026-11-01 — governanca/entradas/prompt_opcoes_de_integracao.md §1; D-PR70/D-PR73/D-PR75, prompts/prompt_modulo_products.md
-- Rodada 11). W = a web é dona do catálogo · D = o ERP Desktop é dono (era L). A letra P sai: o PDV nunca é dono (é abastecido pela
-- retaguarda, web ou desktop). Virar Web é a troca D → W no cadastro, só com a chave do sincronizador bloqueada (D-PR73/D-PR76).
--
-- ADITIVA (nenhuma coluna sai): troca o DOMÍNIO dos dois CHECKs da 072 e converte as linhas — 'L' → 'D' (mesmo fato, letra nova) e
-- 'P' → 'W' (em P o catálogo já era da web — D-PR47; hoje nenhuma linha P fora de schema descartável). Depois da 081 a 072 segue no
-- histórico como está (instalação nova roda 072 → 081).
--
-- Re-executável POR SCHEMA de cliente (o runner roda a central a cada onboarding — precedente da 027/072): cada DDL é guardado por
-- information_schema e o re-run não emite ALTER nenhum (o ALTER em tb_institution pede o MDL da linha que todo cunhador de id trava).
--  1. algum dos dois CHECKs ainda fala de 'L' (o domínio da 072) → DROP dos dois (IF EXISTS);
--  2. UPDATE das linhas L/P só se houver alguma (contagem sem trava antes — no re-run não sai UPDATE nenhum);
--  3. faltam os CHECKs (recém-derrubados, ou estado parcial de uma execução interrompida entre 1 e 3 — DDL não é transacional) → ADD
--     com o domínio novo + COMMENT das duas colunas, num ALTER só.
--  4. (D-PR75, Valdo 2026-11-22: a troca D → W grava quem e quando, SEM motivo) o `ck_institution_transition_author` da 079 ("data, autor
--     e motivo juntos") vira "data e autor juntos; sem data, nenhum dos três": guardado pela cláusula (a da 079 exige o motivo) ou pela
--     ausência (estado parcial) → DROP IF EXISTS + ADD num ALTER só; o `ck_institution_transition_reason` (motivo nunca só branco) fica.
-- CHECK BINÁRIO nomeado (PADROES §11 regra 11), conferido no boot pelo NOME + sonda (`assertInstitutionSourceKindSchema`). Espelho no
-- repositório sql: fica para a janela PROD.E7.P2 (como a 072/079). Provada em schema descartável: scripts/prove-081-institution-source-kind-w-d.ts.

SET @old_domain := (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                     WHERE constraint_schema = 'setes_central' AND table_name = 'tb_institution'
                       AND constraint_name IN ('ck_institution_source_kind', 'ck_institution_transition_ended')
                       AND check_clause LIKE '%''L''%');
SET @ddl := IF(@old_domain > 0,
  'ALTER TABLE `setes_central`.`tb_institution` DROP CONSTRAINT IF EXISTS `ck_institution_source_kind`, DROP CONSTRAINT IF EXISTS `ck_institution_transition_ended`',
  'SELECT 1');
PREPARE stmt_drop_old FROM @ddl;
EXECUTE stmt_drop_old;
DEALLOCATE PREPARE stmt_drop_old;

-- o UPDATE só sai se houver linha a converter (leitura consistente, sem trava): sem índice em source_kind, o UPDATE varreria a tabela
-- com trava X em toda linha de tb_institution a cada re-run por schema (gate socrático da PROD.E10.P1, M1)
SET @to_convert := (SELECT COUNT(*) FROM `setes_central`.`tb_institution` WHERE `source_kind` COLLATE utf8mb4_bin IN ('L', 'P'));
SET @dml := IF(@to_convert > 0,
  'UPDATE `setes_central`.`tb_institution` SET `source_kind` = IF(`source_kind` COLLATE utf8mb4_bin = ''L'', ''D'', ''W'') WHERE `source_kind` COLLATE utf8mb4_bin IN (''L'', ''P'')',
  'SELECT 1');
PREPARE stmt_backfill FROM @dml;
EXECUTE stmt_backfill;
DEALLOCATE PREPARE stmt_backfill;

SET @ck_count := (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                   WHERE constraint_schema = 'setes_central' AND table_name = 'tb_institution'
                     AND constraint_name IN ('ck_institution_source_kind', 'ck_institution_transition_ended'));
-- o MODIFY (só COMMENT) repete tipo, nulo, padrão e a COLAÇÃO APLICADA da coluna (revisar-ddl: lida do information_schema, não presumida)
SET @sk_collation := (SELECT COLLATION_NAME FROM information_schema.COLUMNS
                       WHERE table_schema = 'setes_central' AND table_name = 'tb_institution' AND column_name = 'source_kind');
SET @ddl := IF(@ck_count < 2,
  CONCAT('ALTER TABLE `setes_central`.`tb_institution` MODIFY COLUMN `source_kind` CHAR(1) COLLATE ', @sk_collation, ' NOT NULL COMMENT ''Origem dos cadastros (D-PR47/D-OI10): W a web é dona do catálogo · D o ERP Desktop é dono; muda só pela troca D → W no cadastro, com a chave do sincronizador bloqueada (D-PR73)'', MODIFY COLUMN `transition_ended_at` DATETIME DEFAULT NULL COMMENT ''Instante da troca D → W da origem dos cadastros (D-PR73) — write-once; NULL = nunca foi D ou ainda é'', ADD CONSTRAINT IF NOT EXISTS `ck_institution_source_kind` CHECK (`source_kind` COLLATE utf8mb4_bin IN (''W'', ''D'')), ADD CONSTRAINT IF NOT EXISTS `ck_institution_transition_ended` CHECK (`transition_ended_at` IS NULL OR `source_kind` COLLATE utf8mb4_bin <> ''D'')'),
  'SELECT 1');
PREPARE stmt_new_checks FROM @ddl;
EXECUTE stmt_new_checks;
DEALLOCATE PREPARE stmt_new_checks;

SET @author_old := (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                     WHERE constraint_schema = 'setes_central' AND table_name = 'tb_institution'
                       AND constraint_name = 'ck_institution_transition_author'
                       AND check_clause LIKE '%transition_end_reason` IS NOT NULL%');
SET @author_count := (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                       WHERE constraint_schema = 'setes_central' AND table_name = 'tb_institution'
                         AND constraint_name = 'ck_institution_transition_author');
SET @ddl := IF(@author_old > 0 OR @author_count = 0,
  'ALTER TABLE `setes_central`.`tb_institution` DROP CONSTRAINT IF EXISTS `ck_institution_transition_author`, ADD CONSTRAINT `ck_institution_transition_author` CHECK ((`transition_ended_at` IS NULL AND `transition_ended_by` IS NULL AND `transition_end_reason` IS NULL) OR (`transition_ended_at` IS NOT NULL AND `transition_ended_by` IS NOT NULL))',
  'SELECT 1');
PREPARE stmt_author FROM @ddl;
EXECUTE stmt_author;
DEALLOCATE PREPARE stmt_author;
