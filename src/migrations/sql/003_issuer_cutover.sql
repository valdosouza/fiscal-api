-- fiscal-api (NÚCLEO) 003 — VIRADA da emissão como FATO na linha da habilitação (D-F39 = Q-F48 (a), Valdo 2026-10-04;
-- modelagem do guardião conceitual — §16 de Infra-IA/prompts/prompt_apis_fiscais_isoladas.md).
--
-- Substitui a variável FISCAL_LEGACY_INSTITUTIONS (cerca por configuração de processo — gates da F1: uma instância sem
-- a variável abria a cerca e dois contadores de nDPS cunhavam o MESMO Id de DPS). WRITE-ONCE e MONOTÔNICO
-- (NULL → instante, nunca volta): nenhuma instância diverge e uma leitura velha só RECUSA.
--   NULL      = RÉPLICA da habilitação do ERP (cópia do migrate:setes) — abrir o emissor, cunhar nDPS, tomar o aluguel
--               do rodízio e escrever o emitente recusam (409 FISCAL_CUTOVER_PENDING).
--   instante  = a API fiscal da família do MODELO emite por esta habilitação desde então (UTC).
-- Quem grava: o INSERT do emitente pela própria API (NOW() — a virada acontece no nascimento); o migrate:setes grava
-- NULL na cópia; SÓ o ato `--cutover` faz NULL → NOW(), em TODAS as linhas da institution (o A1 é UM por
-- estabelecimento — D-N31), na transação da re-sincronia final. Revive / ON DUPLICATE KEY nunca tocam a coluna.
-- Transição: o ADD COLUMN deixa NULL nas linhas existentes — no dev a única é a cópia (1,'SE') do setes-api, ou seja,
-- réplica: exatamente o estado da cerca anterior (FISCAL_LEGACY_INSTITUTIONS=1). Nenhum UPDATE.
ALTER TABLE `tb_establishment_issuer`
  ADD COLUMN IF NOT EXISTS `cutover_at` DATETIME DEFAULT NULL
    COMMENT 'Virada (D-F39): desde quando (UTC) a API fiscal emite por esta habilitação; NULL = réplica do ERP. Write-once.'
    AFTER `refresh_lease_until`;
