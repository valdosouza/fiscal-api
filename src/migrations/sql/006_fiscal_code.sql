-- fiscal-api (NÚCLEO) 006 — CONFIGURAÇÃO FISCAL POR UF: os códigos que o fisco de uma UF exige no documento (o CSRT do PR hoje; o CSC da
-- NFC-e e outros depois), QUEM os possui e as credenciais (fiscal-api:FAMILIA.E5.P4.T4; D-NE221, D-NE222, D-NE223, D-NE224, D-NE226 —
-- prompt_onda_nfe_sefaz.md §22.5 a §22.7; nomes do guardião conceitual, ficha projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md).
--
-- Dono: o NÚCLEO (tabelas COMUNS às famílias — D-F35). Nada do ERP aqui (D-F10): a UF do EMITENTE é fato do ERP, lido pela família na hora;
-- a credencial do CONTRIBUINTE liga ao estabelecimento pela habilitação do núcleo, sem coluna de UF.
--
-- Quatro tabelas para três ideias:
--   tb_fiscal_code_type                 catálogo dos tipos de código, com o DONO (provider = fornecedor do software, a Setes · taxpayer =
--                                       contribuinte) e a FORMA do code_id (dado, não `if`). Linha nova = tipo novo, sem mudar a estrutura.
--   tb_fiscal_code_requirement          a REGRA: UF × modelo × ambiente exige o tipo, desde `valid_from` (a linha viva é a exigência —
--                                       sem `required`/`active`); `source` cita a NT (nenhuma linha inventada).
--   tb_provider_fiscal_credential       a credencial do FORNECEDOR (UF × modelo × ambiente × tipo), compartilhada por todos os clientes.
--   tb_establishment_fiscal_credential  a credencial do CONTRIBUINTE (estabelecimento × modelo × ambiente × tipo) — sem consumidor até a NFC-e.
-- O dono certo é garantido por CONSTRUÇÃO: cada tabela de credencial tem `owner` fixo (CHECK) e FK composta (tipo, owner) ao catálogo — um
-- CSC na tabela do fornecedor (ou um CSRT na do estabelecimento) não entra.
--
-- VIGÊNCIA (a mesma regra nas três): "ativa" = deleted 'N'; intervalo semiaberto em UTC; a VIGENTE é a viva de MAIOR `valid_from` ≤ instante,
-- e só se `valid_until` for nulo ou > instante (encerrada = nenhuma; nunca volta à anterior). `valid_from` na PK: dois inícios iguais no mesmo
-- escopo = 1062 (a ambiguidade morre na chave). Os até 5 CSRT válidos por UF da NT 2018.005 ficam como histórico.
--
-- EXCEÇÃO NOMEADA (D-NE223, Valdo 2026-11-21): `code_value` fica em TEXTO PURO — contraria a PADROES_BANCO §11 regra 6 ("segredo em coluna só
-- cifrado") e a regra 4 do CLAUDE.md do núcleo, por decisão. Qualquer cópia do banco o mostra: o perímetro é o acesso ao banco. Continua
-- valendo: nunca em log, resposta, código, Vault ou teste.
--
-- DOMÍNIOS FECHADOS = CHECK BINÁRIO de nome próprio (molde da 005 — D-NE84/D-F120), também nas colunas de FK de domínio (`tb_fiscal_code_type_id`,
-- `owner`): a tabela é utf8mb4_unicode_ci e a FK compara pela colação — sem o CHECK binário, 'csrt' e 'Provider' passariam pela FK. O boot sonda
-- cada um (`assertFiscalCodeDomainsEnforced`). Sem valor "ambos" (H/P, 55/65): são duas linhas. Também binário o `deleted` (sob `_ci`, 'n'
-- contaria como viva) e, em cada vigência, o fim DEPOIS do início (uma linha com fim ≤ início seria a "de maior início" e anularia a anterior)
-- — gate adversarial da FAMILIA.E5.P4. Um tipo APAGADO no catálogo não desliga a regra viva (a leitura não filtra o catálogo pelo deleted).
--
-- RE-EXECUTÁVEL (D-F123): CREATE TABLE IF NOT EXISTS; a semente por INSERT … SELECT … WHERE NOT EXISTS com datas FIXAS (nunca NOW(), nunca
-- INSERT IGNORE — cerca `sessao-estrita.test.ts`). ⚠️ F3 (MySQL 8): os CHECKs com REGEXP e COLLATE se conferem na ida para lá, como os da 005.

CREATE TABLE IF NOT EXISTS `tb_fiscal_code_type` (
  `id`              VARCHAR(20) NOT NULL COMMENT 'Código do tipo como o fisco o chama (CSRT, CSC) — PK natural (exceção nomeada ao id inteiro, precedente o model da habilitação)',
  `owner`           VARCHAR(8) NOT NULL COMMENT 'Dono: provider (fornecedor do software — a Setes) · taxpayer (contribuinte)',
  `code_id_pattern` VARCHAR(40) NOT NULL COMMENT 'Forma do code_id (expressão regular ancorada) — CSRT [0-9]{2} pelo XSD (idCSRT)',
  `description`     VARCHAR(100) NOT NULL,
  `created_at`      DATETIME DEFAULT NULL,
  `updated_at`      DATETIME DEFAULT NULL,
  `deleted`         CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_fiscal_code_type_id_owner` (`id`, `owner`),
  CONSTRAINT `ck_fiscal_code_type_id_bin` CHECK (`id` COLLATE utf8mb4_bin REGEXP '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT `ck_fiscal_code_type_owner_bin` CHECK (`owner` COLLATE utf8mb4_bin IN ('provider', 'taxpayer')),
  CONSTRAINT `ck_fiscal_code_type_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_fiscal_code_requirement` (
  `state`                  CHAR(2) NOT NULL COMMENT 'UF (sigla) cujo fisco exige o código',
  `model`                  VARCHAR(2) NOT NULL COMMENT '55 (NF-e) · 65 (NFC-e)',
  `environment`            CHAR(1) NOT NULL COMMENT 'H homologação · P produção',
  `tb_fiscal_code_type_id` VARCHAR(20) NOT NULL,
  `valid_from`             DATETIME NOT NULL COMMENT 'Desde quando (UTC) a UF exige',
  `valid_until`            DATETIME DEFAULT NULL COMMENT 'Até quando (UTC, exclusivo); NULL = sem fim conhecido',
  `source`                 VARCHAR(120) NOT NULL COMMENT 'A norma que cria a exigência (nenhuma linha inventada)',
  `created_at`             DATETIME DEFAULT NULL,
  `updated_at`             DATETIME DEFAULT NULL,
  `deleted`                CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`state`, `model`, `environment`, `tb_fiscal_code_type_id`, `valid_from`),
  KEY `idx_fiscal_code_requirement_type` (`tb_fiscal_code_type_id`),
  CONSTRAINT `fk_fiscal_code_requirement_type` FOREIGN KEY (`tb_fiscal_code_type_id`) REFERENCES `tb_fiscal_code_type` (`id`),
  CONSTRAINT `ck_fiscal_code_requirement_state_bin` CHECK (`state` COLLATE utf8mb4_bin IN ('AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO')),
  CONSTRAINT `ck_fiscal_code_requirement_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('55', '65')),
  CONSTRAINT `ck_fiscal_code_requirement_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  CONSTRAINT `ck_fiscal_code_requirement_type_bin` CHECK (`tb_fiscal_code_type_id` COLLATE utf8mb4_bin REGEXP '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT `ck_fiscal_code_requirement_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S')),
  CONSTRAINT `ck_fiscal_code_requirement_validity` CHECK (`valid_until` IS NULL OR `valid_until` > `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_provider_fiscal_credential` (
  `state`                  CHAR(2) NOT NULL,
  `model`                  VARCHAR(2) NOT NULL,
  `environment`            CHAR(1) NOT NULL,
  `tb_fiscal_code_type_id` VARCHAR(20) NOT NULL,
  `owner`                  VARCHAR(8) NOT NULL DEFAULT 'provider' COMMENT 'Sempre provider (CHECK) — liga ao dono do tipo pela FK composta',
  `valid_from`             DATETIME NOT NULL COMMENT 'Início da vigência (UTC)',
  `valid_until`            DATETIME DEFAULT NULL COMMENT 'Fim da vigência (UTC, exclusivo); NULL = vigente até ser encerrada',
  `code_id`                VARCHAR(10) NOT NULL COMMENT 'Identificador dado pelo fisco (idCSRT); forma pelo code_id_pattern do tipo',
  `code_value`             VARCHAR(100) NOT NULL COMMENT 'O código — TEXTO PURO por decisão (D-NE223, exceção nomeada à PADROES §11 regra 6); nunca em log, resposta, código ou Vault',
  `tb_user_id`             INT(11) DEFAULT NULL COMMENT 'Autor (usuário do produto); NULL = gravado pelo script de cadastro (D-NE226)',
  `created_at`             DATETIME DEFAULT NULL,
  `updated_at`             DATETIME DEFAULT NULL,
  `deleted`                CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`state`, `model`, `environment`, `tb_fiscal_code_type_id`, `valid_from`),
  KEY `idx_provider_fiscal_credential_type_owner` (`tb_fiscal_code_type_id`, `owner`),
  CONSTRAINT `fk_provider_fiscal_credential_type` FOREIGN KEY (`tb_fiscal_code_type_id`, `owner`) REFERENCES `tb_fiscal_code_type` (`id`, `owner`),
  CONSTRAINT `ck_provider_fiscal_credential_owner_bin` CHECK (`owner` COLLATE utf8mb4_bin = 'provider'),
  CONSTRAINT `ck_provider_fiscal_credential_state_bin` CHECK (`state` COLLATE utf8mb4_bin IN ('AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO')),
  CONSTRAINT `ck_provider_fiscal_credential_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('55', '65')),
  CONSTRAINT `ck_provider_fiscal_credential_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  CONSTRAINT `ck_provider_fiscal_credential_type_bin` CHECK (`tb_fiscal_code_type_id` COLLATE utf8mb4_bin REGEXP '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT `ck_provider_fiscal_credential_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S')),
  CONSTRAINT `ck_provider_fiscal_credential_validity` CHECK (`valid_until` IS NULL OR `valid_until` > `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tb_establishment_fiscal_credential` (
  `tb_institution_id`      INT(11) NOT NULL COMMENT 'Estabelecimento = institution do produto (sem FK para o ERP — outro banco)',
  `model`                  VARCHAR(2) NOT NULL,
  `environment`            CHAR(1) NOT NULL,
  `tb_fiscal_code_type_id` VARCHAR(20) NOT NULL,
  `owner`                  VARCHAR(8) NOT NULL DEFAULT 'taxpayer' COMMENT 'Sempre taxpayer (CHECK) — liga ao dono do tipo pela FK composta',
  `valid_from`             DATETIME NOT NULL,
  `valid_until`            DATETIME DEFAULT NULL,
  `code_id`                VARCHAR(10) NOT NULL,
  `code_value`             VARCHAR(100) NOT NULL COMMENT 'O código — TEXTO PURO por decisão (D-NE223); nunca em log, resposta, código ou Vault',
  `tb_user_id`             INT(11) DEFAULT NULL,
  `created_at`             DATETIME DEFAULT NULL,
  `updated_at`             DATETIME DEFAULT NULL,
  `deleted`                CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `model`, `environment`, `tb_fiscal_code_type_id`, `valid_from`),
  KEY `idx_establishment_fiscal_credential_type_owner` (`tb_fiscal_code_type_id`, `owner`),
  CONSTRAINT `fk_establishment_fiscal_credential_issuer` FOREIGN KEY (`tb_institution_id`, `model`) REFERENCES `tb_establishment_issuer` (`tb_institution_id`, `model`),
  CONSTRAINT `fk_establishment_fiscal_credential_type` FOREIGN KEY (`tb_fiscal_code_type_id`, `owner`) REFERENCES `tb_fiscal_code_type` (`id`, `owner`),
  CONSTRAINT `ck_establishment_fiscal_credential_owner_bin` CHECK (`owner` COLLATE utf8mb4_bin = 'taxpayer'),
  CONSTRAINT `ck_establishment_fiscal_credential_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('55', '65')),
  CONSTRAINT `ck_establishment_fiscal_credential_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  CONSTRAINT `ck_establishment_fiscal_credential_type_bin` CHECK (`tb_fiscal_code_type_id` COLLATE utf8mb4_bin REGEXP '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT `ck_establishment_fiscal_credential_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S')),
  CONSTRAINT `ck_establishment_fiscal_credential_validity` CHECK (`valid_until` IS NULL OR `valid_until` > `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Semente do catálogo (RF-NFE-30; o CSC fica catalogado para a NFC-e — formato do id do CSC: até 6 dígitos).
INSERT INTO `tb_fiscal_code_type` (`id`, `owner`, `code_id_pattern`, `description`, `created_at`, `updated_at`, `deleted`)
SELECT 'CSRT', 'provider', '^[0-9]{2}$', 'Código de Segurança do Responsável Técnico (infRespTec/idCSRT e hashCSRT)', '2026-11-22 00:00:00', '2026-11-22 00:00:00', 'N'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tb_fiscal_code_type` WHERE `id` = 'CSRT');
INSERT INTO `tb_fiscal_code_type` (`id`, `owner`, `code_id_pattern`, `description`, `created_at`, `updated_at`, `deleted`)
SELECT 'CSC', 'taxpayer', '^[0-9]{1,6}$', 'Código de Segurança do Contribuinte (QR Code da NFC-e)', '2026-11-22 00:00:00', '2026-11-22 00:00:00', 'N'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tb_fiscal_code_type` WHERE `id` = 'CSC');

-- Semente das regras (RF-NFE-30; NT 2018.005 v1.52 §2.1 e ZD07-10 Obs. 1): PR, NF-e, CSRT obrigatório em H desde 19/01/2026 e em P desde
-- 23/02/2026 (00:00 de Brasília = 03:00 UTC). O 65 do PR não exige (Obs. 2 — implementação futura); nenhuma outra UF tem data no acervo.
INSERT INTO `tb_fiscal_code_requirement` (`state`, `model`, `environment`, `tb_fiscal_code_type_id`, `valid_from`, `valid_until`, `source`, `created_at`, `updated_at`, `deleted`)
SELECT 'PR', '55', 'H', 'CSRT', '2026-01-19 03:00:00', NULL, 'NT 2018.005 v1.52 §2.1 e ZD07-10 (RF-NFE-30)', '2026-11-22 00:00:00', '2026-11-22 00:00:00', 'N'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tb_fiscal_code_requirement`
    WHERE `state` = 'PR' AND `model` = '55' AND `environment` = 'H' AND `tb_fiscal_code_type_id` = 'CSRT' AND `valid_from` = '2026-01-19 03:00:00');
INSERT INTO `tb_fiscal_code_requirement` (`state`, `model`, `environment`, `tb_fiscal_code_type_id`, `valid_from`, `valid_until`, `source`, `created_at`, `updated_at`, `deleted`)
SELECT 'PR', '55', 'P', 'CSRT', '2026-02-23 03:00:00', NULL, 'NT 2018.005 v1.52 §2.1 e ZD07-10 (RF-NFE-30)', '2026-11-22 00:00:00', '2026-11-22 00:00:00', 'N'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tb_fiscal_code_requirement`
    WHERE `state` = 'PR' AND `model` = '55' AND `environment` = 'P' AND `tb_fiscal_code_type_id` = 'CSRT' AND `valid_from` = '2026-02-23 03:00:00');
