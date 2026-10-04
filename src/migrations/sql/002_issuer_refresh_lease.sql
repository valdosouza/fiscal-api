-- fiscal-api (NÚCLEO) 002 — ALUGUEL da consulta ativa na linha da habilitação (gates da F1, 2026-10-04).
--
-- O rodízio ("uma passada por estabelecimento", herdado do `runningRefresh` em memória da Onda 3) usava uma
-- trava nomeada SEGURANDO uma conexão do pool enquanto pedia outra para trabalhar: com tantas passadas
-- simultâneas quanto conexões no pool, o serviço inteiro travava (gate socrático HIGH-2 / adversarial
-- MEDIUM, provado com pool de 2). O aluguel é um FATO de controle na própria linha do emissor do modelo:
-- "uma passada deste modelo está em curso até X" — tomado por UPDATE atômico (nenhuma conexão retida) e
-- devolvido no fim; queda do processo = o aluguel vence sozinho. Nenhum Map/Set em memória (regra 3/4).
ALTER TABLE `tb_establishment_issuer`
  ADD COLUMN IF NOT EXISTS `refresh_lease_until` DATETIME DEFAULT NULL
    COMMENT 'Consulta ativa deste modelo em curso até este instante (UTC); NULL/passado = livre' AFTER `dps_last_number`;
