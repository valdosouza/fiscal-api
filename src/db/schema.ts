import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'

/**
 * Validação do schema de cliente ANTES de interpolar em SQL (mesma regra do setes-api: o valor vem
 * do JWT assinado, mas nunca entra em query sem passar aqui).
 */
export const SCHEMA_RE = /^setes_[a-z0-9_]+$/

export function assertSchema(schemaName: string): string {
  if (!SCHEMA_RE.test(String(schemaName ?? ''))) {
    throw new HttpError(400, `schemaName inválido: ${schemaName}`, undefined, ErrorCodes.VALIDATION_FAILED)
  }
  return schemaName
}
