-- fiscal-api (NÚCLEO) 001 — tabelas COMUNS às famílias no banco `fiscal_api`
-- (extração fiscal, F0 — Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §14).
--
-- Dono deste DDL: o núcleo (D-F35). As tabelas de cada família (DPS/transmissão/voz da
-- NFS-e; NF-e amanhã) vivem nas migrations da própria família, com namespace próprio
-- em `_migrations` (criada pelo executor, não por migration).
-- Banco: `fiscal_api` (D-F7 — nunca `setes_*`), escopo por linha `tb_institution_id`
-- (a institution do produto; id global de setes_central — D-F14). Sem FK para o ERP:
-- outro banco. Formas herdadas da migration 058 do setes-api ("muda de casa, não de
-- conceito" — D-F34).

-- ---------------------------------------------------------------------------
-- 1. Certificado A1 do ESTABELECIMENTO (D-N31: UM por estabelecimento, serve H e P e
--    todas as famílias). D-F16: a chave privada fica CIFRADA (AES-256-GCM, chave-mestra
--    em variável de ambiente, versão para rotação); o certificado é público. O `cnpj` é o
--    do CN do e-CNPJ — fato do CERTIFICADO, conferido no upload contra o CNPJ do ERP
--    (D-N29b); fatos do EMITENTE (IM, cMun, regime) NUNCA vêm para cá (D-F10).
--    Metadados públicos gravados no upload: o alerta de vencimento (1000 clientes)
--    não decifra nada. Excluir o A1 = segredos NULL + deleted 'S' (chave excluída não
--    fica guardada); reenviar revive a linha.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_establishment_certificate` (
  `tb_institution_id`  INT(11) NOT NULL COMMENT 'Estabelecimento = institution do produto (setes_central.tb_institution.id) — sem FK, outro banco',
  `cnpj`               CHAR(14) DEFAULT NULL COMMENT 'CNPJ do CN do e-CNPJ (fato do certificado — D-N29b)',
  `certificate_pem`    TEXT DEFAULT NULL COMMENT 'Certificado folha (público)',
  `private_key_cipher` VARBINARY(8192) DEFAULT NULL COMMENT 'Chave privada PEM cifrada AES-256-GCM (D-F16); NULL = sem A1',
  `private_key_iv`     VARBINARY(12) DEFAULT NULL COMMENT 'IV do GCM (96 bits)',
  `private_key_tag`    VARBINARY(16) DEFAULT NULL COMMENT 'Tag de autenticação do GCM',
  `cipher_key_version` SMALLINT DEFAULT NULL COMMENT 'Versão da chave-mestra que cifrou (rotação)',
  `subject`            VARCHAR(512) DEFAULT NULL,
  `issued_by`          VARCHAR(512) DEFAULT NULL COMMENT 'Autoridade certificadora (issuer do X.509)',
  `not_before`         DATETIME DEFAULT NULL COMMENT 'Início da vigência (UTC)',
  `not_after`          DATETIME DEFAULT NULL COMMENT 'Fim da vigência (UTC) — alerta de vencimento sem decifrar',
  `fingerprint256`     VARCHAR(95) DEFAULT NULL,
  `tb_user_id`         INT(11) DEFAULT NULL COMMENT 'Autor do upload (usuário do produto — referência opaca)',
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`),
  KEY `idx_establishment_certificate_not_after` (`not_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. HABILITAÇÃO do emissor por MODELO (D-E1/D-N4; nome mantido — D-F34). Autoridade
--    DERIVADA do modelo (SE → ADN; 55/65 → SEFAZ), nunca coluna. Habilitado = linha viva
--    + A1 vigente (D-E4, sem `active`). `serie`/`dps_last_number` só do SE: a série e o
--    número do 55/65 são cunhados pelo ERP no faturamento (D-F21). O contador do nDPS é
--    do emissor e nunca volta (D-N18).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_establishment_issuer` (
  `tb_institution_id` INT(11) NOT NULL,
  `model`             VARCHAR(2) NOT NULL COMMENT 'SE (NFS-e nacional) · 55 (NF-e) · 65 (NFC-e)',
  `environment`       CHAR(1) NOT NULL DEFAULT 'H' COMMENT 'H homologação/produção restrita · P produção',
  `serie`             VARCHAR(5) DEFAULT NULL COMMENT 'Série do DPS (só SE — D-F21)',
  `dps_last_number`   INT(11) NOT NULL DEFAULT 0 COMMENT 'Último nDPS cunhado (só SE — D-N18); contínuo mesmo trocando a série',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `model`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
