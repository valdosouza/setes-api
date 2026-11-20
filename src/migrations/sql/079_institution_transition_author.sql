-- 079 (CENTRAL) — AUTOR e MOTIVO do ato "encerrar a transição" como FATO do objeto: `tb_institution.transition_ended_by` +
-- `transition_end_reason` (cadastro de produtos, Rodada 8 — Vault: prompts/prompt_modulo_products.md; D-PR53, Valdo 2026-10-31;
-- D-PR57, Valdo 2026-11-20; parecer do guardião 2026-11-20; passo setes-api:PROD.E6.P2).
--
-- O ato (`POST /api/institutions/:id/end-legacy-transition`, D-PR48/D-PR49) grava as QUATRO marcas no MESMO UPDATE condicionado:
-- `source_kind` (destino), `transition_ended_at`, `transition_ended_by` (o usuário do token) e `transition_end_reason` (o motivo do
-- corpo, aparado). WRITE-ONCE: depois do ato a institution não é mais L e o UPDATE condicionado (`source_kind = 'L' AND
-- transition_ended_at IS NULL`) nunca mais a alcança. O log do ato segue (D-PR53: "colunas + log").
--
-- CHECK BINÁRIO `ck_institution_transition_author` sobre as TRÊS colunas anuláveis do ato (as três NULL = o ato não aconteceu; as três
-- preenchidas = aconteceu). A D-PR53 fala em "os quatro", mas `source_kind` é NOT NULL desde a 072: a coerência do fato com o ato já é
-- do `ck_institution_transition_ended` (com data, nunca L) — NÃO "corrigir" este CHECK para quatro colunas. W/P sem data = nativo.
-- CHECK `ck_institution_transition_reason`: o motivo preenchido nunca é só branco (o "preenchido" vale por construção; o DTO apara e
-- limita a 255 antes — o modo de sessão do servidor truncaria antes do CHECK).
-- FK `fk_institution_transition_ended_by` → `tb_user(id)` (D-PR57; precedente `fk_ihu_inviter_to_user`): o autor existe. Usuário
-- nunca é apagado fisicamente (PADROES §3.1). EXCEÇÃO NOMEADA à PADROES §1 (o nome segue a D-PR53: o trio _at/_by/_end_reason é UM
-- fato) — não vale como precedente.
--
-- Sem backfill: autor não se inventa. Uma linha com `transition_ended_at` e sem autor faz o ALTER falhar ALTO (ck_institution_
-- transition_author) — na data desta migration o ato nunca rodou em banco nenhum fora dos testes (a 072 ainda não está no main).
--
-- A tabela é CENTRAL e o runner roda esta migration POR SCHEMA de cliente (inclusive ao vivo no onboarding): o DDL é UM ALTER só
-- (colunas + CHECKs + FK juntos — atômico), guardado por information_schema; no re-run por schema não sai ALTER nenhum (um ALTER em
-- tb_institution pede o MDL da linha que todo cunhador de id trava — gate socrático da Rodada 7). A guarda é só "as colunas ainda não
-- existem → ALTER; senão nada": estado parcial (uma peça sem as outras — intervenção manual, ou migration FUTURA que mexa nestas peças,
-- ex.: a tabela `_event` que a D-PR53 prevê se nascer um 2º ato) NÃO é reparado aqui nem quebra o onboarding de schema novo — quem
-- recusa é o boot, pelos NOMES + sonda (`assertInstitutionSourceKindSchema`, @shared/catalog-owner; gate socrático da PROD.E6.P2).
-- Limites conhecidos: write-once só pela aplicação (o CHECK aceita trocar autor/motivo por outro valor não nulo em SQL manual — o mesmo
-- padrão da `transition_ended_at` da 072); `TRIM` do CHECK do motivo tira só espaço (tab/quebra de linha ficam com o trim do DTO).
-- Espelho no repo sql (01_setes_central_ddl.sql): pendente da janela (PROD.E7.P2). Provada em schema descartável: scripts/prove-079-institution-transition-author.ts.

SET @t079_cols := (SELECT COUNT(*) FROM information_schema.columns
                    WHERE table_schema = 'setes_central' AND table_name = 'tb_institution'
                      AND column_name IN ('transition_ended_by', 'transition_end_reason'));
SET @ddl := IF(@t079_cols = 0,
  'ALTER TABLE `setes_central`.`tb_institution` ADD COLUMN `transition_ended_by` INT DEFAULT NULL COMMENT ''Autor do ato encerrar a transição (D-PR53/D-PR57): tb_user.id — write-once, nasce com transition_ended_at'' AFTER `transition_ended_at`, ADD COLUMN `transition_end_reason` VARCHAR(255) DEFAULT NULL COMMENT ''Motivo do ato encerrar a transição (D-PR53) — write-once, nasce com transition_ended_at'' AFTER `transition_ended_by`, ADD CONSTRAINT `ck_institution_transition_author` CHECK ((`transition_ended_at` IS NULL AND `transition_ended_by` IS NULL AND `transition_end_reason` IS NULL) OR (`transition_ended_at` IS NOT NULL AND `transition_ended_by` IS NOT NULL AND `transition_end_reason` IS NOT NULL)), ADD CONSTRAINT `ck_institution_transition_reason` CHECK (`transition_end_reason` IS NULL OR CHAR_LENGTH(TRIM(`transition_end_reason`)) > 0), ADD CONSTRAINT `fk_institution_transition_ended_by` FOREIGN KEY (`transition_ended_by`) REFERENCES `setes_central`.`tb_user` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION',
  'SELECT 1');
PREPARE stmt_t079 FROM @ddl;
EXECUTE stmt_t079;
DEALLOCATE PREPARE stmt_t079;
