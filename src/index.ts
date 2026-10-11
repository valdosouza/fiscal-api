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

// banco
export * from './db/pool'
export * from './db/tx'
export * from './db/schema'
export * from './db/migrations'

// autenticação pelo login do produto (D-F13)
export * from './auth/product-jwt'

// cofre (D-F16) e certificado A1
export * from './secret/cipher'
export * from './secret/certificate'

// emitente: certificado + habilitação por modelo (D-F34)
export * from './establishment/establishment.repository'
export * from './establishment/establishment'

// transporte fiscal comum
export * from './transport/types'
export * from './transport/https-json'
export * from './transport/xmldsig'

// arquivo fiscal (XML)
export * from './storage/fiscal-storage'

// voz: vocabulário + contrato de leitura (D-F33)
export * from './voice/kinds'
export * from './voice/reading'

// fonte de fatos Gestão 2027 — base (D-F10/D-F32)
export * as erp from './erp/facts'

// borda HTTP comum
export * from './http/http'

// tipos do driver (a família usa o MESMO mysql2 do núcleo — nunca uma 2ª cópia com tipos divergentes)
export type { Pool, PoolConnection } from 'mysql2/promise'
