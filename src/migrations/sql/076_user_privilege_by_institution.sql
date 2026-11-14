-- 076 — Privilégio POR ESTABELECIMENTO (D-GE3, frente do grupo de estabelecimentos, Rodada 1, Valdo 2026-10-18; passo
-- setes-api:GRUPO.E3.P1, pré-requisito da A2 da auth-api). Coerente com a decisão 10 da Fase 2 ("o mesmo usuário pode ter
-- poderes diferentes por institution"), com o baseline 001 e com o legado; corrige a 003, que tirou a institution da chave.
--
-- Antes: a concessão (`tb_user_has_privilege`) valia para o SCHEMA inteiro — com o grupo (N institutions no mesmo schema), o
-- privilégio dado na matriz valeria na filial, inclusive TRANSMITIR e CANCELAR do fisco. Depois: a institution está na chave e a
-- `vw_user_access` só aceita a concessão da MESMA institution do alcance (a linha reservada na 075).
--
-- Preenchimento: hoje cada schema tem UMA institution viva (a filial só nasce na onda 3 do grupo), e a concessão existente vai para
-- ela — neutro. Schema com MAIS de uma institution viva: o UPDATE abaixo FALHA (erro 1242, "Subquery returns more than 1 row") e o
-- boot para — de propósito: copiar a concessão para todas faria a matriz valer na filial (o contrário da D-GE3), e escolher uma seria
-- decisão do Valdo, nunca do código. (Hoje o caso é inalcançável: `setes_central.tb_institution.schema_name` é ÚNICO; a trava vale
-- para quando a onda 3 do grupo tirar essa chave com um schema ainda sem a 076.) Schema sem institution viva com concessão: a trava
-- `ck_uhp_institution_filled` (CHECK provisório, que o MariaDB confere sobre as linhas que JÁ existem — erro 4025) para ANTES do
-- MODIFY — sem ela, um servidor sem modo estrito (o dev, MariaDB 10.4 sem STRICT) converteria o NULL em 0 calado e só a fk acusaria
-- depois, com os zeros gravados (prova ao vivo, 2026-11-14). O preenchimento também recolhe um 0 de execução anterior.
--
-- Chave: (usuário, institution, interface, privilégio) — o usuário na frente mantém o índice da `fk_uhpriv_to_user` e serve a leitura
-- (`tb_user_id = ? AND tb_institution_id = ?`); a institution ganha índice próprio para a chave estrangeira, como a
-- `tb_institution_has_interface` (003). Re-executável: coluna e chave por IF NOT EXISTS, preenchimento só do que está vazio, a chave
-- primária refeita no MESMO ALTER (a `fk_uhpriv_to_user` nunca fica sem índice) e a view por CREATE OR REPLACE.
-- Espelho no canônico (`sql/03_schema_cliente_ddl.sql`: a tabela e o bloco das VIEWs) no MESMO passo — com `SET NAMES utf8mb4` antes.
ALTER TABLE `tb_user_has_privilege`
  ADD COLUMN IF NOT EXISTS `tb_institution_id` INT NULL AFTER `tb_user_id`;

UPDATE `tb_user_has_privilege`
   SET `tb_institution_id` = (SELECT i.`id`
                                FROM `setes_central`.`tb_institution` i
                               WHERE i.`schema_name` = DATABASE()
                                 AND i.`deleted` = 'N')
 WHERE `tb_institution_id` IS NULL OR `tb_institution_id` = 0;

-- a trava de uma tentativa anterior que morreu entre os dois ALTER (gravada, sem o MODIFY) sai antes — senão o ADD repetiria o nome
ALTER TABLE `tb_user_has_privilege`
  DROP CONSTRAINT IF EXISTS `ck_uhp_institution_filled`;

ALTER TABLE `tb_user_has_privilege`
  ADD CONSTRAINT `ck_uhp_institution_filled` CHECK (`tb_institution_id` IS NOT NULL AND `tb_institution_id` <> 0);

ALTER TABLE `tb_user_has_privilege`
  DROP CONSTRAINT `ck_uhp_institution_filled`,
  MODIFY COLUMN `tb_institution_id` INT NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`tb_user_id`, `tb_institution_id`, `tb_interface_id`, `tb_privilege_id`),
  ADD KEY IF NOT EXISTS `idx_uhp_institution` (`tb_institution_id`);

ALTER TABLE `tb_user_has_privilege`
  ADD CONSTRAINT `fk_uhpriv_to_institution` FOREIGN KEY IF NOT EXISTS (`tb_institution_id`)
    REFERENCES `setes_central`.`tb_institution` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A `vw_user_access` da 075 com a linha reservada da D-GE3 (`AND g.tb_institution_id = r.tb_institution_id`); o resto é idêntico
-- (mesmas colunas, mesma ordem, FUNDÍVEL — PADROES §11 regra 3). A `vw_user_reach` não muda.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_user_access` AS
SELECT r.`tb_user_id`,
       r.`tb_institution_id`,
       r.`tb_interface_id`,
       r.`interface_key`,
       p.`id` AS `tb_privilege_id`,
       p.`description` COLLATE utf8mb4_bin AS `privilege`,
       r.`profile`,
       r.`delegable`
  FROM `vw_user_reach` r
  JOIN `setes_central`.`tb_interface_has_privilege` ihp
    ON ihp.`tb_interface_id` = r.`tb_interface_id` AND ihp.`active` = 'S' AND ihp.`deleted` = 'N'
  JOIN `setes_central`.`tb_privilege` p
    ON p.`id` = ihp.`tb_privilege_id` AND p.`deleted` = 'N'
   AND CHAR_LENGTH(p.`description`) = CHAR_LENGTH(RTRIM(p.`description`))
  LEFT JOIN `tb_user_has_privilege` g
    ON g.`tb_user_id` = r.`tb_user_id`
   AND g.`tb_institution_id` = r.`tb_institution_id`
   AND g.`tb_interface_id` = ihp.`tb_interface_id`
   AND g.`tb_privilege_id` = ihp.`tb_privilege_id`
   AND g.`active` = 'S' AND g.`deleted` = 'N'
 WHERE r.`profile` = 'super'
    OR (r.`profile` = 'admin' AND r.`delegable` = 'N')
    OR g.`tb_user_id` IS NOT NULL;
