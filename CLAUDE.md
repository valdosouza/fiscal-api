# CLAUDE.md — fiscal-api

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e, em
especial, **`Infra-IA/fiscal-api/INDEX.md`** (START HERE deste projeto). Decisões vigentes e questões
abertas: `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` (§7 decisões D-F, §8 questões Q-F).
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.

## Estado (2026-10-03)

**Fase 0 — sem código.** D-F1…D-F3 decididas pelo Valdo; a F1 (extração da NFS-e do setes-api para
cá) só começa quando as questões Q-F2…Q-F26 do prompt fecharem. Não crie `src/` antes disso.

## O que este projeto É

Serviço de DOCUMENTO fiscal, consumido por qualquer cliente licenciado e seus múltiplos aplicativos:
*um emitente habilitado declara um documento ao fisco e recebe a voz dele*. Famílias `/v1/nfse`
(ADN / Sefin Nacional) e `/v1/nfe` (SEFAZ — NF-e 55, NFC-e 65 apontada). Responde pelo FORMATO e
pela CONVERSA com o fisco (leiaute, assinatura, mTLS, tentativa, voz, XML, PDF).

## O que este projeto NÃO É (fronteira — parecer do guardião conceitual)

- Não calcula imposto. Não conhece pedido, nota, cliente nem cadeia de entidade de quem chama.
- **Nenhum import ou SQL sobre `tb_invoice`, `tb_order`, `tb_entity*`** — a cerca é testada por grep.
- Não é o setes-api: o setes-api é UM dos aplicativos (`tb_licensee_app`) de cada licenciado.
- Não aplica efeitos no ERP: a voz fica aqui; o efeito é de quem chama, que acusa (`ack`).

## Regras inegociáveis

1. Estado é DERIVADO da última voz da última tentativa — nunca coluna `status`.
2. 2xx ilegível do fisco = ambíguo (502 / K em voo), nunca aceite; recusa de REGRA ≠ transitório.
3. Idempotência por construção: UNIQUE `(licensee, emitter, external_code)`.
4. Nenhum `Map/Set` de controle em memória de processo — trava no banco ou worker.
5. Segredo nunca em coluna, log ou resposta; PKCS#12 abre no upload, senha não persiste.
6. Banco próprio `fiscal_api` (NUNCA `setes_*`), escopo por linha `tb_licensee_id`.
7. Molde de código: setes-api (`gateway/ · modules/ · shared/ · migrations/`, módulo em 6 arquivos —
   `Infra-IA/setes-api/ARQUITETURA_MODULOS_API.md`); `PADROES_BANCO.md` + skill `revisar-ddl.md`
   antes de qualquer DDL; Swagger em todo endpoint; gates socrático/adversarial antes de "pronto".

## Palavras da casa (não renomear)

licenciado (`tb_licensee`) · aplicativo do licenciado (`tb_licensee_app`) · emitente (`tb_emitter`)
· habilitação/emissor (`tb_issuer`, por MODELO) · documento (`tb_fiscal_document`) · tentativa ·
voz (append-only, kind + código cru + source) · `external_code` (referência de quem chama) ·
autoridade (adaptador por fisco) · família (`nfse` | `nfe`).
