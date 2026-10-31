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

// emitente: certificado + habilitação por modelo (D-F34); catálogo dos modelos (D-NE10 — parte 2 da NE-1a)
export * from './establishment/issuer-models'
export * from './establishment/establishment.repository'
export * from './establishment/establishment'
// o EMITTER: habilitação + A1 + transmissões vivas de TODAS as famílias (D-NE9 — parte 2 da NE-1a)
export * from './emitter/emitter'

// transporte fiscal comum
export * from './transport/types'
export * from './transport/https-json'
export * from './transport/xmldsig'
// leitura de XML do fisco por PARSER (N17 — D-NE72; parte 2 da NE-1a, passo 7)
export * from './xml/reader'

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
// a ESCRITA da voz por família (D-F108 — parte 2 da NE-1a) e a transação sob a trava da nota (D-NE74)
export * from './voice/event-table'
export * from './voice/outcome'
export * from './voice/policy'
export * from './erp/invoice-tx'

// fonte de fatos Gestão 2027 — base (D-F10/D-F32)
export * as erp from './erp/facts'

// borda HTTP comum
export * from './http/http'

// tipos do driver (a família usa o MESMO mysql2 do núcleo — nunca uma 2ª cópia com tipos divergentes)
export type { Pool, PoolConnection } from 'mysql2/promise'
