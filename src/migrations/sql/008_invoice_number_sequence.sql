-- fiscal-api (NÚCLEO) 008 — o ÚLTIMO NÚMERO da NF-e/NFC-e por estabelecimento × modelo × série × ambiente (fiscal-api:FAMILIA.E5.P5;
-- D-NE255, D-NE257, D-NE263 e D-NE265, Valdo 2026-11-23 — prompt_onda_nfe_sefaz.md §24.11; nomes do guardião conceitual, ficha
-- projetos/fiscal-api/GERAL/ficha-familia-e5-p5-ultimo-numero-nfe.md).
--
-- Por quê: a D-NE257 TROCA a D-F21 no ponto do número — o nNF do 55 deixa de ser cunhado pelo ERP web no faturamento (MAX+1 em `tb_invoice`,
-- sem ambiente) e passa a nascer na TRANSMISSÃO, na nfe-api, do último número guardado AQUI. A série continua do ERP (D-NE11, D-NE243). Os
-- comentários da 001 e da 007 que dizem "cunhados pelo ERP no faturamento" ficam como história (migration aplicada não se edita).
--
-- Por que tabela própria e não coluna na habilitação: `tb_establishment_issuer` é UMA linha por estabelecimento × modelo, com UM ambiente
-- vigente e `serie` só do SE. Aqui cada AMBIENTE tem a sua linha: a virada H→P não toca nada (a linha de H fica parada, a de P é outra), e
-- voltar a H continua de onde parou. É outro controle, paralelo à tabela de controle de notas do ERP web (D-NE255/D-NE258) — não se confundem.
--
-- NASCIMENTO: em HOMOLOGAÇÃO a linha nasce sozinha na 1ª geração (o primeiro número é o 1 — D-NE243). Em PRODUÇÃO ela NUNCA nasce sozinha
-- (D-NE265): alguém abre a sequência com o número inicial (`openNumberSequence`); até lá, gerar número em P é recusado e nada é gravado.
-- `last_number` = o último número JÁ gerado (0 = nenhum ainda); nunca volta. A inutilização só vale até ele (D-NE263).
--
-- DOMÍNIOS FECHADOS = CHECK BINÁRIO de nome próprio (molde da 005/006): modelo só de mercadoria (55/65 — a NFS-e tem o nDPS na habilitação),
-- ambiente H/P, `deleted` N/S; série 0–999 e número 0–999999999 pelo leiaute (RF-NFE-44: `TSerie` e `TNF` do PL_010f). O boot sonda cada um
-- (`assertNumberSequenceDomainsEnforced`). `deleted` existe pelo padrão das tabelas (PADROES_BANCO §3); nenhuma peça o grava 'S' — o contador
-- não se exclui, e uma linha 'S' faz as peças falharem alto (nunca "recomeça do 1").
-- A PK é o ÚNICO índice único: o upsert da 1ª geração em H é seguro (PADROES_BANCO §9 regra 10).
-- RE-EXECUTÁVEL (D-F123): CREATE TABLE IF NOT EXISTS, sem semente.
CREATE TABLE IF NOT EXISTS `tb_invoice_number_sequence` (
  `tb_institution_id` INT(11) NOT NULL,
  `model`             CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '55 (NF-e) · 65 (NFC-e)',
  `serie`             SMALLINT UNSIGNED NOT NULL COMMENT 'Série da nota (a do ERP), numérica: 0 a 999',
  `environment`       CHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'H homologação · P produção: cada ambiente tem a sua linha',
  `last_number`       INT UNSIGNED NOT NULL COMMENT 'Último número gerado neste eixo (0 = nenhum). O próximo é este mais 1 e nunca volta',
  `tb_user_id`        INT(11) DEFAULT NULL COMMENT 'Quem abriu a sequência (produção); NULL quando nasceu sozinha em homologação',
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `model`, `serie`, `environment`),
  CONSTRAINT `ck_invoice_number_sequence_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('55', '65')),
  CONSTRAINT `ck_invoice_number_sequence_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  CONSTRAINT `ck_invoice_number_sequence_serie` CHECK (`serie` BETWEEN 0 AND 999),
  CONSTRAINT `ck_invoice_number_sequence_last_number` CHECK (`last_number` BETWEEN 0 AND 999999999),
  CONSTRAINT `ck_invoice_number_sequence_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
