-- fiscal-api (NÚCLEO) 005 — os domínios da HABILITAÇÃO ficam BINÁRIOS: `model` (D-NE84 = Q-NE84 (a), gates da NE-1a parte 2) e `environment`
-- (D-F120 = Q-F131 (a), gates da A1 da F2a) — Valdo 2026-10-12; executada na F2a (Rodada 1 da F2a, Infra-IA/prompts/prompt_apis_fiscais_isoladas.md
-- §22; `prompt_onda_nfe_sefaz.md` §12.9.7.2).
--
-- Por quê: a 004 avalia `model IN ('SE','55','65')` na colação da tabela (utf8mb4_unicode_ci) — 'se' PASSA no CHECK, e a trava "todas as
-- linhas da institution" (`lockIssuerRows`, PK por linha com a lista fechada) e a cerca da virada por modelo leem 'SE' exato: a linha 'se'
-- ficaria fora das duas (provado no dev: MariaDB 10.4.20 aceita 'se' com a 004). `environment` (H/P) não tinha CHECK nenhum: 'h' era H para
-- o SQL e outra coisa para o código (o ambiente congelado na tentativa decide registro fiscal e prova — D-F120). Mesma regra do `kind`,
-- `source` e `environment` da NFS-e (D-F107/D-F120): o domínio publicado é BINÁRIO.
-- Dono: o NÚCLEO (dono da tabela — D-F35; o item (11) da nota da F2a dizia "migration da nfse-api" — corrigido no §22.5).
-- Troca no MESMO ALTER: sai o CHECK _ci da 004, entram os binários com nome próprio. Linha existente fora do domínio binário faz o ALTER
-- FALHAR e a versão NÃO é registrada (conferência embutida — no dev só há ('SE','P'), contado no `fiscal_api` e na origem do setes-api).
-- RE-EXECUTÁVEL (D-F123 = Q-F133 (a)): se o processo morrer entre o ALTER e o registro em `_migrations`, o próximo boot reaplica sem erro
-- (`DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT IF NOT EXISTS` — provado no MariaDB 10.4.20; a mesma forma da 002 da nfse-api).
-- ⚠️ F3 (MySQL 8): `IF [NOT] EXISTS` em CONSTRAINT é SÓ do MariaDB, como já eram a 002/003 do núcleo e da nfse-api — a cadeia é revista na
-- ida para a SaveInCloud se o motor for MySQL 8 (lá também `DROP CONSTRAINT` exige ≥ 8.0.19 e `INSERT IGNORE` rebaixa CHECK a aviso).
-- O boot sonda o modelo ('ZZ' e 'se') e o ambiente ('X' e 'h') — todas têm de ser recusadas pelo CHECK de NOME certo.
ALTER TABLE `tb_establishment_issuer`
  DROP CONSTRAINT IF EXISTS `ck_establishment_issuer_model`,
  ADD CONSTRAINT IF NOT EXISTS `ck_establishment_issuer_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('SE', '55', '65')),
  ADD CONSTRAINT IF NOT EXISTS `ck_establishment_issuer_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P'));
