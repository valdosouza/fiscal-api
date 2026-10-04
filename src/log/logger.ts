/**
 * Log estruturado mínimo (molde do setes-api). Nunca recebe segredo: chave privada, senha do
 * PKCS#12 e chave-mestra não entram em `meta` (regra 5 do CLAUDE.md do núcleo).
 */
export interface Logger {
  info:  (msg: string, meta?: object) => void
  warn:  (msg: string, meta?: object) => void
  error: (msg: string, meta?: object) => void
}

export const logger: Logger = {
  info:  (msg, meta) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`, meta ?? ''),
  warn:  (msg, meta) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, meta ?? ''),
}

export default logger
