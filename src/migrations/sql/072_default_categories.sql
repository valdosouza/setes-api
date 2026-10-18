-- 072 — CATEGORIAS PADRÃO "Produtos" (kind P) e "Serviços" (kind S) (cadastro de produtos, Rodada 6 —
-- Infra-IA/prompts/prompt_modulo_products.md; Q-PR38' (a) + Q-PR49 (a), Valdo 2026-10-18).
--
-- Por que migration e não seed: tb_category vive no schema de CADA cliente — só a migration roda em todos os
-- schemas E no onboarding do cliente novo (o seed do repo sql roda à mão num schema só).
--
-- Regra: em cada estabelecimento do schema SEM chave do sincronizador ativa, cria a categoria do kind que ele
-- ainda não tem VIVA — raiz, posit_level = o próprio id em 3 dígitos (peça @shared/tree-path: acima de 999
-- imprime inteiro — o LPAD do MySQL truncaria), id MAX+1 do estabelecimento contando as excluídas (o id nunca
-- volta com outro significado). Estabelecimento COM sincronizador: a categoria é do legado (todas nascem 'P';
-- dois escritores em tb_category = o id da web no espaço do gerador dele) — nada é criado; quando a chave for
-- DESLIGADA, o ato cria "Serviços" (peça @shared/category-kind — mesmas descrições).
-- "Viva" = não excluída E ativa (o mesmo da peça @shared/category-kind). Idempotente (NOT EXISTS da categoria
-- viva): reexecutar não duplica. Hoje 1 estabelecimento por schema
-- (tb_institution.schema_name UNIQUE); na frente do GRUPO a categoria é tabela do grupo (PADROES §12) e esta
-- regra passa a olhar só a fundadora.
INSERT INTO tb_category (id, tb_institution_id, description, posit_level, kind, active, created_at, updated_at, deleted)
SELECT x.next_id, x.inst, 'Produtos',
       IF(x.next_id > 999, CAST(x.next_id AS CHAR), LPAD(x.next_id, 3, '0')),
       'P', 'S', NOW(), NOW(), 'N'
  FROM (SELECT i.id AS inst,
               COALESCE((SELECT MAX(c.id) FROM tb_category c WHERE c.tb_institution_id = i.id), 0) + 1 AS next_id
          FROM setes_central.tb_institution i
         WHERE i.schema_name = DATABASE() AND i.deleted = 'N'
           AND NOT EXISTS (SELECT 1 FROM setes_central.tb_sync_api_key k
                            WHERE k.tb_institution_id = i.id AND k.active = 'S' AND k.deleted = 'N')
           AND NOT EXISTS (SELECT 1 FROM tb_category c
                            WHERE c.tb_institution_id = i.id AND c.kind = 'P' AND c.deleted = 'N' AND c.active = 'S')) x;

INSERT INTO tb_category (id, tb_institution_id, description, posit_level, kind, active, created_at, updated_at, deleted)
SELECT x.next_id, x.inst, 'Serviços',
       IF(x.next_id > 999, CAST(x.next_id AS CHAR), LPAD(x.next_id, 3, '0')),
       'S', 'S', NOW(), NOW(), 'N'
  FROM (SELECT i.id AS inst,
               COALESCE((SELECT MAX(c.id) FROM tb_category c WHERE c.tb_institution_id = i.id), 0) + 1 AS next_id
          FROM setes_central.tb_institution i
         WHERE i.schema_name = DATABASE() AND i.deleted = 'N'
           AND NOT EXISTS (SELECT 1 FROM setes_central.tb_sync_api_key k
                            WHERE k.tb_institution_id = i.id AND k.active = 'S' AND k.deleted = 'N')
           AND NOT EXISTS (SELECT 1 FROM tb_category c
                            WHERE c.tb_institution_id = i.id AND c.kind = 'S' AND c.deleted = 'N' AND c.active = 'S')) x;
