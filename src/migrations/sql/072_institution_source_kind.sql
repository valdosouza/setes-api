-- 072 (CENTRAL) — ORIGEM DOS CADASTROS do estabelecimento: `tb_institution.source_kind` + `transition_ended_at`
-- (cadastro de produtos, Rodada 7 — Infra-IA/prompts/prompt_modulo_products.md; D-PR47/D-PR48/D-PR49, Valdo 2026-10-20;
-- parecer do guardião 2026-10-20; frente do terminal D-TM10: o fato na linha da FUNDADORA é o fato do GRUPO).
--
-- `source_kind` CHAR(1) = o TIPO DA FONTE EXTERNA que alimenta o estabelecimento (as mesmas letras do tb_terminal.kind):
--   W = nenhuma (nativo web)                    → o catálogo de base é da WEB
--   L = servidor desktop do legado (transição)  → o catálogo de base é do LEGADO; a web só consulta (salvo o enquadramento fiscal — D-PR45)
--   P = PDVs (mandam só movimento)              → o catálogo de base é da WEB (os PDVs o recebem)
-- Declarado pelo Super no cadastro — NOT NULL SEM DEFAULT (fato declarado, nunca presumido). MONOTÔNICO: só muda pelo
-- ato "encerrar a transição" (L → W ou L → P, uma vez), que grava `transition_ended_at` (write-once). A contradição
-- "L com data" morre por construção (ck_institution_transition_ended). A chave do sincronizador (tb_sync_api_key)
-- volta a ser só AUTENTICAÇÃO — a guarda de escrita dos cadastros (`catalogOwnerGuard`) lê ESTE fato, nunca a chave.
--
-- Backfill (uma vez, só nas linhas ainda NULL): estabelecimento com chave do sincronizador VIVA (`deleted = 'N'` — ativa OU
-- pausada: a pausa é interruptor de emergência e não muda o dono, D-PR48; W nunca tem chave por construção) = 'L' (dev:
-- setes_setes); os demais = 'W'. 'P' não nasce do backfill (nenhum cliente PDV hoje). Gate adversarial R7 (ADV-R7-06): com
-- `active = 'S'` uma chave pausada no instante da migration viraria W — e W não volta.
--
-- A tabela é CENTRAL e o runner roda esta migration POR SCHEMA de cliente — inclusive AO VIVO, no onboarding de um cliente
-- novo (`createInstitution` → `runMigrationsForSchema`): TODO statement de DDL é guardado por information_schema (precedente
-- da 027), de modo que o re-run por schema não emite ALTER nenhum (um ALTER em tb_institution pede o MDL exclusivo da linha
-- que todo cunhador de id trava — gate socrático da Rodada 7). CHECK BINÁRIO nomeado (PADROES §11 regra 11), conferido no
-- boot pelo NOME da constraint + sonda (`assertInstitutionSourceKindSchema`, @shared/catalog-owner).
-- Espelho no repo sql: 01_setes_central_ddl.sql (tb_institution). Provada em schema descartável:
-- scripts/prove-072-institution-source-kind.ts.

SET @col_exists := (SELECT COUNT(*) FROM information_schema.columns
                     WHERE table_schema = 'setes_central' AND table_name = 'tb_institution' AND column_name = 'source_kind');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `setes_central`.`tb_institution` ADD COLUMN `source_kind` CHAR(1) DEFAULT NULL COMMENT ''Origem dos cadastros (D-PR47): W nativo web · L transição do desktop legado (catálogo do legado, web só consulta) · P PDV (catálogo da web); muda só pelo ato encerrar a transição (L → W/P)'' AFTER `schema_name`',
  'SELECT 1');
PREPARE stmt_source_kind FROM @ddl;
EXECUTE stmt_source_kind;
DEALLOCATE PREPARE stmt_source_kind;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.columns
                     WHERE table_schema = 'setes_central' AND table_name = 'tb_institution' AND column_name = 'transition_ended_at');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `setes_central`.`tb_institution` ADD COLUMN `transition_ended_at` DATETIME DEFAULT NULL COMMENT ''Instante do ato encerrar a transição do legado (D-PR48) — write-once; NULL = nunca foi L ou ainda é'' AFTER `source_kind`',
  'SELECT 1');
PREPARE stmt_transition_ended FROM @ddl;
EXECUTE stmt_transition_ended;
DEALLOCATE PREPARE stmt_transition_ended;

UPDATE `setes_central`.`tb_institution` i
   SET i.`source_kind` = IF(EXISTS (SELECT 1 FROM `setes_central`.`tb_sync_api_key` k
                                     WHERE k.`tb_institution_id` = i.`id` AND k.`deleted` = 'N'), 'L', 'W')
 WHERE i.`source_kind` IS NULL;

SET @is_nullable := (SELECT COUNT(*) FROM information_schema.columns
                      WHERE table_schema = 'setes_central' AND table_name = 'tb_institution' AND column_name = 'source_kind' AND is_nullable = 'YES');
SET @ddl := IF(@is_nullable = 1,
  'ALTER TABLE `setes_central`.`tb_institution` MODIFY COLUMN `source_kind` CHAR(1) NOT NULL COMMENT ''Origem dos cadastros (D-PR47): W nativo web · L transição do desktop legado (catálogo do legado, web só consulta) · P PDV (catálogo da web); muda só pelo ato encerrar a transição (L → W/P)''',
  'SELECT 1');
PREPARE stmt_not_null FROM @ddl;
EXECUTE stmt_not_null;
DEALLOCATE PREPARE stmt_not_null;

SET @ck_count := (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                   WHERE constraint_schema = 'setes_central' AND table_name = 'tb_institution'
                     AND constraint_name IN ('ck_institution_source_kind', 'ck_institution_transition_ended'));
SET @ddl := IF(@ck_count < 2,
  'ALTER TABLE `setes_central`.`tb_institution` ADD CONSTRAINT IF NOT EXISTS `ck_institution_source_kind` CHECK (`source_kind` COLLATE utf8mb4_bin IN (''W'', ''L'', ''P'')), ADD CONSTRAINT IF NOT EXISTS `ck_institution_transition_ended` CHECK (`transition_ended_at` IS NULL OR `source_kind` COLLATE utf8mb4_bin <> ''L'')',
  'SELECT 1');
PREPARE stmt_checks FROM @ddl;
EXECUTE stmt_checks;
DEALLOCATE PREPARE stmt_checks;
