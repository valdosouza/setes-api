-- 078 — Fase IBS/CBS, D-IB127/D-IB128/D-IB129 (setes-api:IBS.E6.P7 — Infra-IA/prompts/prompt_fase_ibs_cbs.md §17): a VIEW
-- publicada da OPÇÃO de apuração do IBS/CBS do Simples (regApIBSCBSSN — NT 009), para o leitor do núcleo
-- (`fiscal-api` `readEstablishmentIbscbsAssessment`, a nfse-api no DPS). Contrato (nome e colunas) no subpath puro
-- `fiscal-api/ibscbs-assessment` (`ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW`/`_COLUMNS` — D-IB129); o teste
-- `ibscbs-assessment-view.test.ts` confere esta lista contra ele.
--
-- Só as linhas VIVAS, sem resolver nada (D-IB127/§17.3): a vigente na competência ("linha viva de maior valid_from ≤ data; sem
-- linha = 1") é escolhida pelo seletor ÚNICO do núcleo (`ibscbsAssessmentOf` — D-IB128), nunca aqui: sem NOT EXISTS/MAX, sem
-- COALESCE para '1' (nunca há linha "1" implícita), sem valid_until. Fora da lista: `deleted` (a view já filtra), `tb_user_id`,
-- `created_at`, `updated_at` (sem consumidor — D-IB77).
-- PADROES §11 regra 3: SELECT simples — FUNDÍVEL (sem subconsulta na lista, GROUP BY, DISTINCT, LIMIT); o WHERE de quem lê
-- (`tb_institution_id = ? AND valid_from <= ?`) desce até a PK da tabela (EXPLAIN provado em scripts/prove-ibscbs-assessment.ts).
-- Nenhuma coluna derivada de literal: sem COLLATE (as colunas vêm da tabela, com a colação dela).
-- GRANT: o usuário da API fiscal já lê `setes\_%` (nfse-api/ops/grants.sql — §17.1 R4); a view não pede linha nova.
-- Re-executável (CREATE OR REPLACE). Rodar com o usuário dono de sempre (o DEFINER da view é quem a recria).
-- Espelho no canônico (`sql/03_*.sql`, bloco das VIEWs) no mesmo passo — lá com `SET NAMES utf8mb4` antes, como as outras views.
CREATE OR REPLACE VIEW `vw_establishment_ibscbs_assessment` AS
SELECT a.`tb_institution_id`,
       a.`valid_from`,
       a.`assessment`
  FROM `tb_establishment_ibscbs_assessment` a
 WHERE a.`deleted` = 'N';
