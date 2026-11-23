-- 077 — Fase IBS/CBS, D-IB99/D-IB100: a OPÇÃO de apuração do IBS/CBS do Simples (regApIBSCBSSN — NT 009) vira fato
-- DATADO de cada estabelecimento — Infra-IA/prompts/prompt_fase_ibs_cbs.md §14.
--   D-IB99  (Valdo 2026-10-31): configuração com data de início; sem preenchimento vale 1 (efeito legal de não optar — D-IB1);
--           2/3 são GRAVADOS e o faturamento recusa a nota cuja competência cai na vigência deles até o cálculo do regime
--           regular existir (D-IB11/D-IB12).
--   D-IB100 (Valdo 2026-10-31 = Q-IB103 (b), parecer do guardião): peça PRÓPRIA só da opção — fato gerador próprio (opção
--           CGSN 194, semestral e irretratável no semestre). opSimpNac/regApTribSN/pTotTribSN/regEspTrib/CRT seguem em
--           tb_entity_tax (convenção "sem história" — limite conhecido) até o próprio 1º fato datado; nada muda no núcleo
--           nem na nfse-api (o leiaute 1.01 do DPS não leva o campo). REVÊ a letra da D-IB7 (tabela única do enquadramento).
--
-- Vida da linha (regra na peça @shared/ibscbs-assessment, não aqui): sem valid_until — a linha seguinte fecha a anterior (a
-- PK impede sobreposição por construção); inserir só com valid_from >= hoje do estabelecimento; alterar/excluir (soft) só
-- linha FUTURA; linha vigente ou passada é imutável; 2/3 só a partir de 01/01/2027. SEM backfill: "sem linha" = 1 é o
-- efeito legal, e uma linha '1' explícita só fecha um período 2/3 (backfill criaria duas representações de "não optou").
-- Escopo: ESTABELECIMENTO (PADROES §12 — a opção é feita por CNPJ; filiais da mesma raiz repetem o valor: limite da frente
-- do grupo). revisar-ddl: domínio fechado por CHECK BINÁRIO com sonda no boot pelo NOME (PADROES §11 regras 11/16 —
-- `assertEstablishmentIbscbsAssessmentChecks`); CREATE TABLE IF NOT EXISTS + ADD CONSTRAINT IF NOT EXISTS = re-executável
-- (MariaDB 10.4); provado em schema descartável (scripts/prove-ibscbs-assessment.ts) antes da árvore viva.

-- 0. Referência central presente? Falta = erro 1146 com o NOME da tabela (nunca errno 150).
SELECT 1 FROM `setes_central`.`tb_institution` LIMIT 0;

CREATE TABLE IF NOT EXISTS `tb_establishment_ibscbs_assessment` (
  `tb_institution_id` INT NOT NULL,
  `valid_from`        DATE NOT NULL COMMENT 'Data de efeito da opção (competência a partir da qual vale)',
  `assessment`        CHAR(1) NOT NULL
    COMMENT 'regApIBSCBSSN (NT 009): 1 IBS e CBS pelo SN · 2 CBS pelo SN e IBS pelo regime regular · 3 IBS e CBS pelo regime regular',
  `tb_user_id`        INT NOT NULL COMMENT 'Quem registrou a opção (fato editado por gente)',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `valid_from`),
  CONSTRAINT `fk_establishment_ibscbs_assessment_institution`
    FOREIGN KEY (`tb_institution_id`)
    REFERENCES `setes_central`.`tb_institution` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Domínio fechado (D-IB26): binário — no _ci da tabela um valor fora do domínio de outra caixa passaria.
ALTER TABLE `tb_establishment_ibscbs_assessment`
  ADD CONSTRAINT IF NOT EXISTS `ck_establishment_ibscbs_assessment`
    CHECK (`assessment` COLLATE utf8mb4_bin IN ('1', '2', '3'));

-- D-IB101 + D-IB103: a FRONTEIRA da opção é a última nota VIVA emitida pelo ERP WEB (evento E de emissão), lida pelo escritor da opção
-- ENQUANTO segura a trava que o faturamento lê. Lida a partir do FATO que a define — o evento E — pelo índice desse fato: varredura
-- descendente por (institution, kind, deleted, data) que para na 1ª nota viva (gates do delta: ADV-D101-02 — a MAX sem índice varria
-- todas as notas, 4–6 s com o faturamento parado; ADV-D103-01 — filtrar as notas pela EXISTÊNCIA do evento materializava todos os
-- eventos e varria as notas do ERP Desktop mais novas: 1,3–1,6 s com 300 mil notas). Provado: O(1) linhas lidas (1 ms). Índice ADITIVO
-- em tabela quente: InnoDB cria online; re-executável (IF NOT EXISTS).
ALTER TABLE `tb_invoice_event`
  ADD KEY IF NOT EXISTS `idx_invoice_event_issue` (`tb_institution_id`, `kind`, `deleted`, `dt_record`);
