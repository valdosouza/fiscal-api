# fiscal-api — núcleo comum das APIs fiscais

Biblioteca (não roda sozinha) consumida pelos serviços **`nfse-api`** (NFS-e / ADN — porta 3002) e
**`nfe-api`** (NF-e / NFC-e / SEFAZ — porta 3003, fase futura): transporte mTLS, assinatura XMLDSig,
emitente (A1 cifrado no banco) e habilitação por modelo, máquina tentativa × voz, storage do XML,
autenticação pelo JWT do produto e migrations do banco `fiscal_api`.

**Estado (2026-10-04): F1 executada** (23 testes) (decisão D-F17 do Valdo: três pastas — núcleo
`fiscal-api` + serviços `nfse-api` e `nfe-api`). Decisões e plano:
`D:\Gestao2027\Infra-IA\prompts\prompt_apis_fiscais_isoladas.md` (§7 e §12); índice:
`D:\Gestao2027\Infra-IA\fiscal-api\INDEX.md`.
