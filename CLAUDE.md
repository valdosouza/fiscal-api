# CLAUDE.md — fiscal-api (NÚCLEO COMUM — biblioteca)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e, em
especial, **`Infra-IA/fiscal-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F85 em
`Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §7; plano no §12, modelo no §14, execução da F1 no **§15**.
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.

## O que este projeto É (D-F17, Valdo 2026-10-03)

A **biblioteca do núcleo comum** das duas APIs fiscais — `nfse-api` (NFS-e/ADN) e `nfe-api`
(NF-e/NFC-e/SEFAZ). **Não roda sozinha**: não tem porta, `server.ts` nem rotas. Os serviços a
consomem como dependência (`file:../fiscal-api` no dev, tag git no deploy).

Conceito: *um emitente habilitado declara um documento fiscal ao fisco e recebe a voz dele.*
O núcleo guarda o que é COMUM às famílias:

- transporte mTLS (`https-json`; SOAP da SEFAZ quando a F4 vier) e assinatura XMLDSig paramétrica
- **emitente** (`tb_establishment_certificate`: o A1 do estabelecimento, chave privada CIFRADA no banco —
  D-F16/D-F34) e **habilitação** por modelo (`tb_establishment_issuer` — D-E1; carrega o contador do DPS e o
  ALUGUEL da consulta ativa `refresh_lease_until`)
- máquina **tentativa × voz** (estado DERIVADO da última voz; ambíguo nunca fecha; recusa ≠ transitório)
- storage do XML (filesystem no dev; backend de produção na F3)
- autenticação pelo **JWT do produto** (RS256, só chave pública — D-F13)
- base da **fonte de fatos Gestão 2027** (leitura SÓ-SELECT de `setes_central`/`setes_*` — D-F10/D-F15)
- migrations do banco **`fiscal_api`** (D-F7), views publicadas para o setes-api (D-F15)

## O que este projeto NÃO É

- Não calcula imposto. Não escreve no ERP (GRANT só SELECT — D-F15). Não aplica efeito no ERP
  (o efeito é do setes-api lendo a voz — D-F11).
- **Nenhum `tb_invoice`/`tb_order`/`tb_entity*` fora da fonte de fatos** — o núcleo de transporte,
  assinatura, cofre e voz é cego ao ERP (teste do terceiro cego vale para o NÚCLEO — D-F10).
- Não tem `tb_licensee`: licenciado = institution do produto (D-F14).

## Regras inegociáveis

1. Estado DERIVADO da última voz da última tentativa — nunca coluna `status`.
2. 2xx ilegível do fisco = ambíguo (em voo), nunca aceite; recusa de REGRA ≠ transitório.
3. Nenhum `Map/Set` de controle em memória de processo — trava no BANCO: `FOR UPDATE` na linha da nota
   do ERP (D-F27 — o mesmo do cancelamento local do setes-api; ordem nota → emissor → DPS → tentativa) e
   ALUGUEL por UPDATE atômico na linha do emissor para o rodízio (nunca conexão retida — gates da F1).
4. Segredo nunca em coluna em claro, log ou resposta; PKCS#12 abre no upload, senha não persiste (D-N5).
5. Banco `fiscal_api` (NUNCA `setes_*`); padrões de `PADROES_BANCO.md` (UTC na sessão, REPEATABLE READ,
   contadores sob lock) + skill `revisar-ddl.md` antes de qualquer DDL.
6. Molde de código: setes-api (`shared/` por peça, testes Jest com mocks na fronteira); gates
   socrático ≥ 0,70 + adversarial sem HIGH antes de "pronto".

## Estado (2026-10-04, 3ª sessão)

**F1 executada + Rodadas 4–9 (§16–§20 do prompt; D-F57 — lacuna (b) pela linha SE — e a cerca D-F31 por LISTA BRANCA, `src/__tests__/fence.ts`, mexeram no núcleo; reconciliação de 2026-10-10 no §20; Rodadas 12–14 (D-F67…D-F82) puseram no núcleo o código do evento de cancelamento e o efeito humano — `HUMAN_EFFECT_CANCEL_CODES`, §21.7)** — `npm test` (80) · `npx tsc --noEmit` · `npm run build`
(a nfse-api consome o `dist/` — reconstruir depois de mexer aqui). Relatório: §15 do prompt. Mapa:
`db/` pool+tx+migrations · `auth/` JWT RS256 · `secret/` cofre+A1 · `establishment/` certificado+habilitação ·
`transport/` mTLS+XMLDSig · `storage/` XML · `voice/` contrato de leitura (D-F33) · `erp/facts.ts` fonte de fatos
base (ÚNICO lugar que lê o ERP) · `http/` borda. Repo GitHub `valdosouza/gestao-2027-fiscal-api` (privado, criado 2026-10-04).
Regras da Rodada 6: a trava da habilitação é POR LINHA da PK (`lockIssuerRows` — nunca faixa: promoção de trava = 1213,
PADROES §9 regra 8); comando curto em linha disputada pela peça `runShortCommand` (D-F41); domínio do `model` = CHECK da
migration 004, conferido no boot pela família (`assertIssuerModelDomainEnforced` — D-F45); `openIssuer` com `schemaName`
dá o predicado COMPLETO da cerca.
