/**
 * QR da base de PDF (D-NE32/D-NE119): a matriz de módulos — a NFC-e (F5) e, pela NT 2026.010 §4.5, também o DANFE modelo 55 (ZX02) usam.
 * Só ASCII imprimível: a URL de consulta do fisco é ASCII, e outro texto deixaria a codificação dos bytes por conta da lib.
 */
import { qrModules } from './lib'

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  /** Módulos por lado (sem a zona de silêncio — ela é da área livre em volta, responsabilidade do layout da família). */
  readonly size: number
  /** `rows[r][c]` = módulo escuro. */
  readonly rows: readonly (readonly boolean[])[]
}

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/

export function qrMatrix(text: string, opts: { readonly ecLevel: QrErrorCorrection }): QrMatrix {
  if (typeof text !== 'string' || !PRINTABLE_ASCII.test(text)) throw new RangeError('QR da base: só ASCII imprimível, ao menos 1 caractere')
  const ecLevel = opts?.ecLevel                                   // lido UMA vez (gate adversarial A12: um getter trocava o valor entre ler e usar)
  if (!['L', 'M', 'Q', 'H'].includes(ecLevel)) throw new RangeError('QR da base: nível de correção L, M, Q ou H')
  const rows = qrModules(text, ecLevel).map(r => Object.freeze(r))
  return Object.freeze({ size: rows.length, rows: Object.freeze(rows) })
}
