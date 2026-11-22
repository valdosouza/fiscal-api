-- fiscal-api (NÚCLEO) 007 — VIEW PUBLICADA da HABILITAÇÃO por modelo (fiscal-api:FAMILIA.E5.P3.T1; D-NE170 = Q-NE170 (a), Valdo 2026-10-31,
-- literal: "View do núcleo (a)" — prompt_onda_nfe_sefaz.md; nomes do guardião conceitual, anexo da ficha
-- projetos/fiscal-api/GERAL/ficha-familia-e5-p3-pareceres.md).
--
-- Por quê: o ERP cunha o nNF do 55 (D-F21) e a faixa retirada é por AMBIENTE (D-NE161/D-NE163), mas o ambiente do modelo mora aqui, na
-- habilitação. O ERP o lê por ESTA view, VIVA ao cunhar, junto da `vw_invoice_number_void` — nunca cache nem cópia (uma fonte só; a opção
-- de guardar o ambiente no ERP foi rejeitada como 2ª fonte). Contrato de leitura entre serviços = view (D-F15/D-F32).
--
-- O que publica: só institution, modelo, ambiente e a VIRADA (D-F39). `serie`, `dps_last_number` e `refresh_lease_until` são internos da
-- NFS-e e do rodízio; usuário e datas de auditoria ficam fora. `deleted` FILTRA e não se publica (habilitação apagada = "sem linha").
-- `cutover_at` vai SEM filtro: NULL (réplica do ERP) e "sem linha" (não habilitado) são fatos diferentes, e quem os separa é o leitor —
-- regra na view (`can_issue`, `cutover_at IS NOT NULL`) seria maquete. Todos os modelos do domínio aparecem (a habilitação POR MODELO);
-- quem restringe ao 55/65 é o cunhador.
--
-- FUNDÍVEL (PADROES_BANCO §11 regra 3): sem subconsulta na lista, GROUP BY, DISTINCT ou LIMIT; nenhuma coluna derivada de literal (sem
-- COLLATE). A leitura pela PK (`establishment/issuer-view.ts`) é `const` — provado no motor (`motor-banco.live.test.ts`).
-- SQL SECURITY DEFINER (o padrão): o GRANT de SELECT na view basta ao leitor — o GRANT ao `setes_api` é passo próprio na nfe-api e na
-- nfse-api (PM-9), não desta migration.
CREATE OR REPLACE VIEW `vw_establishment_issuer` AS
SELECT i.`tb_institution_id`, i.`model`, i.`environment`, i.`cutover_at`
  FROM `tb_establishment_issuer` i
 WHERE i.`deleted` = 'N';
