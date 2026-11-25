-- fiscal-api (NÚCLEO) 009 — a CONTA DE ENVIO DE E-MAIL do estabelecimento (a credencial SMTP do cliente — fiscal-api:FAMILIA.E5.P7; D-NE236,
-- Valdo 2026-11-22 — prompt_onda_nfe_sefaz.md §24.6; PM-13 de 2026-11-25; nomes do guardião conceitual, ficha
-- projetos/fiscal-api/GERAL/ficha-familia-e5-p7-credencial-smtp.md).
--
-- Conceito: o estabelecimento tem UMA conta de envio de e-mail, cuja SENHA só quem envia abre. O e-mail da nota ao destinatário sai pelo SMTP
-- do emitente (D-NE236); quem ENVIA é a família (a nfe-api — D-NE261). O núcleo só GUARDA: nenhum transporte de e-mail aqui.
--
-- Dono: o NÚCLEO (tabela COMUM às famílias — D-F35). Nada do ERP (D-F10): `tb_institution_id` é referência opaca, sem FK (outro banco), como a
-- do A1 (001). Sem ambiente (H/P) e sem modelo: a conta é do ESTABELECIMENTO, não do documento. Sem FK à habilitação (a conta pode existir
-- antes dela).
--
-- SEGREDO SÓ CIFRADO (D-F16; PADROES_BANCO §11 regra 6 — NÃO é a exceção de texto puro da 006/D-NE223): a senha em AES-256-GCM pela
-- chave-mestra do cofre, versão por linha (`cipher_key_version` — rotação), AAD = `tb_establishment_smtp_credential:<tb_institution_id>` (a
-- cifra copiada para a linha de outro estabelecimento não abre). Host, porta, segurança, usuário e remetente são dados claros (não são segredo).
--
-- PRESENÇA DO SEGREDO POR CONSTRUÇÃO (`ck_establishment_smtp_credential_secret_presence`): linha VIVA tem cifra, IV, tag e versão; linha
-- APAGADA não tem nenhum (senha excluída não fica guardada). Não existe "linha viva sem senha" — o estado que o A1 trata por regra no código.
--
-- DOMÍNIOS FECHADOS = CHECK de nome próprio (molde da 005/006/008): `security` só `tls` (TLS implícito) ou `starttls`, em colação BINÁRIA —
-- não há valor "sem cifra": a senha do cliente nunca trafega em claro; `deleted` N/S binário (sob `_ci`, 'n' contaria como viva); porta 1 a
-- 65535. O boot sonda cada um (`assertSmtpCredentialDomainsEnforced`). Nenhuma porta padrão é derivada de `security`: a porta é dado.
-- A PK é o ÚNICO índice único: o upsert é seguro (PADROES_BANCO §9 regra 10).
-- RE-EXECUTÁVEL (D-F123): CREATE TABLE IF NOT EXISTS, sem semente. ⚠️ F3 (MySQL 8): os CHECKs com COLLATE se conferem na ida para lá.
CREATE TABLE IF NOT EXISTS `tb_establishment_smtp_credential` (
  `tb_institution_id`  INT(11) NOT NULL COMMENT 'Estabelecimento = institution do produto (setes_central.tb_institution.id) — sem FK, outro banco',
  `host`               VARCHAR(255) NOT NULL COMMENT 'Servidor SMTP do cliente (nome ou IP)',
  `port`               SMALLINT UNSIGNED NOT NULL COMMENT 'Porta do servidor: 1 a 65535 (dado — nunca derivada de security)',
  `security`           VARCHAR(8) NOT NULL COMMENT 'tls (TLS implícito) · starttls — não existe opção sem cifra',
  `username`           VARCHAR(255) NOT NULL COMMENT 'Usuário da conta SMTP',
  `sender_address`     VARCHAR(254) NOT NULL COMMENT 'Endereço que a conta usa como remetente (fato da conta)',
  `password_cipher`    VARBINARY(1024) DEFAULT NULL COMMENT 'Senha cifrada AES-256-GCM (D-F16); NULL só na linha apagada',
  `password_iv`        VARBINARY(12) DEFAULT NULL COMMENT 'IV do GCM (96 bits)',
  `password_tag`       VARBINARY(16) DEFAULT NULL COMMENT 'Tag de autenticação do GCM',
  `cipher_key_version` SMALLINT DEFAULT NULL COMMENT 'Versão da chave-mestra que cifrou (rotação)',
  `tb_user_id`         INT(11) DEFAULT NULL COMMENT 'Quem gravou (usuário do produto — referência opaca)',
  `created_at`         DATETIME DEFAULT NULL,
  `updated_at`         DATETIME DEFAULT NULL,
  `deleted`            CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`),
  CONSTRAINT `ck_establishment_smtp_credential_security_bin` CHECK (`security` COLLATE utf8mb4_bin IN ('tls', 'starttls')),
  CONSTRAINT `ck_establishment_smtp_credential_port` CHECK (`port` BETWEEN 1 AND 65535),
  CONSTRAINT `ck_establishment_smtp_credential_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S')),
  CONSTRAINT `ck_establishment_smtp_credential_secret_presence` CHECK (
    (`deleted` = 'N' AND `password_cipher` IS NOT NULL AND `password_iv` IS NOT NULL AND `password_tag` IS NOT NULL AND `cipher_key_version` IS NOT NULL)
    OR (`deleted` = 'S' AND `password_cipher` IS NULL AND `password_iv` IS NULL AND `password_tag` IS NULL AND `cipher_key_version` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
