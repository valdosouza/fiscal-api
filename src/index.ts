/**
 * fiscal-api — NÚCLEO COMUM das APIs fiscais do Gestão 2027 (biblioteca — D-F17).
 * Consumido por `nfse-api` e `nfe-api` (e, só o contrato de leitura da voz, pelo setes-api — D-F33).
 * Plano e decisões: Infra-IA/prompts/prompt_apis_fiscais_isoladas.md (§7, §12, §14).
 */

// erros, log, tempo
export * from './errors/http-error'
export * from './errors/error-codes'
export * from './errors/ambiguous-cause'
export { logger } from './log/logger'
export type { Logger } from './log/logger'
export * from './time/zone'

// inscrição federal (CPF/CNPJ alfanumérico — D-CJ2): peça pura, também no subpath `fiscal-api/federal-id`
export * from './federal-id/federal-id'

// opção de apuração do IBS/CBS do Simples (D-IB128/D-IB129): regra de leitura e contrato da view — peça pura, também no subpath
// `fiscal-api/ibscbs-assessment`
export * from './ibscbs-assessment/ibscbs-assessment'

// FÓRMULA DO vNF (W16-10 datada pelo fato — D-NE215, FAMILIA.E5.P4.T2): peça PURA, também no subpath `fiscal-api/merchandise-total`
export * from './merchandise-total/merchandise-total'

// banco
export * from './db/pool'
export * from './db/tx'
export * from './db/check'
export * from './db/schema'
export * from './db/migrations'

// autenticação pelo login do produto (D-F13)
export * from './auth/product-jwt'
// veredito de acesso — a peça ÚNICA (costura A1 da auth-api, D-AU6); também no subpath `fiscal-api/access`
export * as access from './access/access'

// cofre (D-F16) e certificado A1
export * from './secret/cipher'
export * from './secret/certificate'
// os DONOS de segredo cifrado do cofre e a rotação da chave-mestra sobre todos eles (FAMILIA.E5.P7)
export * from './secret/sealed-store'
export * from './secret/sealed-stores'

// emitente: certificado + habilitação por modelo (D-F34); catálogo dos modelos (D-NE10 — parte 2 da NE-1a)
export * from './establishment/issuer-models'
export * from './establishment/establishment.repository'
export * from './establishment/establishment'
// a LEITURA PUBLICADA da habilitação por modelo (FAMILIA.E5.P3 — D-NE170): a view da 007, com o ambiente de cada modelo; o leitor está também
// em `fiscal-api/reading`, e o SQL cru (`issuerViewSelect`/`issuerViewQuery`) só aqui
export * from './establishment/issuer-view'
// o EMITTER: habilitação + A1 + transmissões vivas de TODAS as famílias (D-NE9 — parte 2 da NE-1a)
export * from './emitter/emitter'

// transporte fiscal comum
export * from './transport/types'
export * from './transport/https-json'
export * from './transport/xmldsig'
// leitura de XML do fisco por PARSER (N17 — D-NE72; parte 2 da NE-1a, passo 7)
export * from './xml/reader'
// ESCRITOR de XML (D-NE214 — FAMILIA.E5.P4.T1): aditivo, simétrico ao leitor; sem subpath (o ERP não escreve XML)
export * from './xml/writer'

// RESPONSÁVEL TÉCNICO da instância (D-NE217 — FAMILIA.E5.P4.T3): dados públicos do `infRespTec` pelo ambiente, conferidos no boot da família
export * from './technical-responsible/technical-responsible'

// CONFIGURAÇÃO FISCAL POR UF (migration 006 — D-NE221…D-NE226, FAMILIA.E5.P4.T4): exigências, credenciais do dono certo, boot e escrita
export * from './fiscal-code/fiscal-code'

// CONTA DE ENVIO DE E-MAIL do estabelecimento (migration 009 — D-NE236, FAMILIA.E5.P7): a credencial SMTP do cliente, senha cifrada pelo
// cofre; o núcleo GUARDA, quem envia é a família (D-NE261). Fora de `fiscal-api/reading` (lado de escrita e segredo)
export * from './smtp-credential/smtp-credential.repository'
export * from './smtp-credential/smtp-credential'

// arquivo fiscal (XML)
export * from './storage/fiscal-storage'

// referência da nota no ERP (NE-1a — terminal por parâmetro, D-NE12)
export * from './ref/invoice-ref'

// voz: vocabulário + contrato de leitura (D-F33) — projeção comum + leitura POR família (NE-1a, D-NE56)
export * from './voice/kinds'
export * from './voice/reading'
export * from './voice/family-reader'
export * from './voice/families/service'
export * from './voice/families'
// NE-2 (D-NE158, Valdo 2026-10-20): a leitura publicada da NF-e nasceu aqui, fora do catálogo e de `fiscal-api/reading`; ENTROU nos dois na
// janela da NE-6 (fiscal-api:FAMILIA.E5.P3)
export * from './voice/families/merchandise'
// a PROVA de "não registrada" da NF-e (FAMILIA.E5.P6.T2 — D-NE235): só o veredito; fora de `fiscal-api/reading` (a decisão é da família)
export * from './voice/families/merchandise-proof'
// a ESCRITA da voz por família (D-F108 — parte 2 da NE-1a) e a transação sob a trava da nota (D-NE74)
export * from './voice/event-table'
export * from './voice/outcome'
export * from './voice/policy'
export * from './erp/invoice-tx'

// NUMERAÇÃO (NE-2 — D-NE161): faixas RETIRADAS da numeração do 55/65 (fato NOSSO, não voz) — peça própria, fora do catálogo da voz; em
// `fiscal-api/reading` desde a janela da NE-6 (FAMILIA.E5.P3 — o SQL cru só aqui)
export * from './numbering/withdrawn-ranges'
// FAMILIA.E5.P5 (D-NE255/D-NE257): o ÚLTIMO NÚMERO da NF-e por série e ambiente — lado de ESCRITA, só aqui no barrel (fora de `reading`)
export * from './numbering/number-sequence'

// VALORES DE IBS/CBS DO FISCO na NFS-e (fase IBS/CBS — D-IB124…D-IB126): dado do fisco gravado uma vez, NÃO é voz — peça da família de
// serviço, fora do catálogo da voz e de `fiscal-api/reading` até o 1º leitor (a conferência dos títulos no setes-api — D-IB125, junto do
// GRANT da view); a nfse-api (dona da view, migration 008) confere a view no boot por ela
export * from './voice/families/service-authority-ibscbs'

// OPÇÃO DE APURAÇÃO DO IBS/CBS do estabelecimento (fase IBS/CBS — D-IB127…D-IB129): leitor da view `vw_establishment_ibscbs_assessment`
// do schema do cliente (nasce em setes-api:IBS.E6.P7), fora de `fiscal-api/reading` (molde da D-IB125); a regra é a da peça pura
export * from './erp/establishment-ibscbs-assessment'

// fonte de fatos Gestão 2027 — base (D-F10/D-F32)
export * as erp from './erp/facts'

// borda HTTP comum
export * from './http/http'

// tipos do driver (a família usa o MESMO mysql2 do núcleo — nunca uma 2ª cópia com tipos divergentes)
export type { Pool, PoolConnection } from 'mysql2/promise'
