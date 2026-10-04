-- fiscal-api (NÚCLEO) 004 — DOMÍNIO do modelo da habilitação como FATO DO BANCO (D-F45 = Q-F56 (a), Valdo 2026-10-04;
-- parecer do guardião conceitual no §17 de Infra-IA/prompts/prompt_apis_fiscais_isoladas.md). 1º CHECK da casa.
--
-- Por quê: a trava "todas as linhas da institution" é a PK completa POR LINHA com a lista fechada dos modelos
-- (`lockIssuerRows` — PADROES_BANCO §9 regra 8); ela só enxerga TUDO se o domínio for fechado no banco. Antes, um
-- modelo fora da lista ('XX') ficava fora da trava e da contagem da cerca (gate adversarial r7 do delta, F3).
-- Dono: o núcleo (dono da tabela — D-F35). Modelo NOVO (57…) = migration do núcleo que ESTENDE o domínio (o catálogo
-- crescendo, não reforma). NÃO entra aqui: "réplica ⇒ SE" (é história da migração do setes-api — quem garante é o único
-- produtor de réplica, o `migrate:setes` — D-F42) nem tabela-catálogo de modelos (lê-la antes do FOR UPDATE recriaria o
-- snapshot antes da trava).
-- Motor: MariaDB ≥ 10.2 e MySQL ≥ 8.0.16 APLICAM CHECK; MySQL < 8.0.16 aceita e IGNORA em silêncio — o boot do núcleo
-- confere que o motor recusa um modelo fora do domínio (`assertIssuerModelDomainEnforced`) e falha alto se não recusar.
-- Linhas existentes que violem o domínio fazem este ALTER FALHAR (conferência embutida) — no dev só há (1,'SE').
ALTER TABLE `tb_establishment_issuer`
  ADD CONSTRAINT `ck_establishment_issuer_model` CHECK (`model` IN ('SE', '55', '65'));
