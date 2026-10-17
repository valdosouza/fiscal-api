/**
 * Fontes da base de PDF (D-NE120): só as fontes-PADRÃO do PDF (sem embutir; codificação WinAnsi = CP1252). A base dá o MECANISMO — papel
 * (título, conteúdo, fixo…) → fonte; a ESCOLHA é da família, pela norma dela (MOC 7.00 Anexo II 3.7: Times New Roman ou Courier New).
 * Symbol e ZapfDingbats ficam de fora (não são WinAnsi).
 *
 * Texto fora do WinAnsi (emoji, setas, letras de outros alfabetos…) vira `?` pelo `toWinAnsi` — substituição VISÍVEL (nunca some calado) e
 * CONTADA para quem chama registrar. D-NE126 (Valdo 2026-10-17): a GARANTIA é de construção — a família escreve SÓ por `writeText` (que
 * sempre passa pelo `toWinAnsi`); `doc.text` direto com caractere fora do WinAnsi CORROMPE a linha no pdfkit (gate adversarial A4) e fica
 * fora da garantia — a cerca que o proíbe na família nasce com o DANFE (NE-5).
 */
export const STANDARD_FONTS = Object.freeze([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
] as const)
export type StandardFont = typeof STANDARD_FONTS[number]

const ROLE_NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/

/** Liga cada papel a uma fonte-padrão no documento: depois, a família escreve `doc.font('<papel>')`. */
export function registerFontRoles<R extends string>(doc: PDFKit.PDFDocument, roles: Readonly<Record<R, StandardFont>>): void {
  const entries = Object.entries(roles) as [string, StandardFont][]
  if (entries.length === 0) throw new RangeError('fontes da base: informe ao menos um papel')
  for (const [role, font] of entries) {
    // gate adversarial A9: nome de propriedade do Object.prototype ("toString", "constructor") confunde a busca interna do pdfkit
    if (!ROLE_NAME.test(role) || (STANDARD_FONTS as readonly string[]).includes(role) || role in Object.prototype) {
      throw new RangeError(`fontes da base: papel "${role}" inválido (minúscula no início, sem nome de fonte-padrão nem de propriedade do JS)`)
    }
    if (!(STANDARD_FONTS as readonly string[]).includes(font)) throw new RangeError(`fontes da base: "${font}" não é fonte-padrão WinAnsi`)
    doc.registerFont(role, font)
  }
}

/** Os 27 caracteres que o CP1252 põe em 0x80–0x9F (o resto do WinAnsi = Latin-1 imprimível) — texto constante, não coleção em memória. */
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ'
  + '‘’“”•–—˜™š›œžŸ'
export const WINANSI_REPLACEMENT = '?'

const representable = (ch: string, cp: number): boolean =>
  (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || CP1252_EXTRA.includes(ch)

/**
 * O texto que o pdfkit consegue escrever numa fonte-padrão: NFC (o "e" + acento combinante vira "é"), quebra de linha única `\n`, tabulação
 * vira espaço; todo o resto sem representação vira `?` (contado em `replaced`, um por caractere — emoji conta 1).
 */
export function toWinAnsi(text: string): { readonly text: string; readonly replaced: number } {
  let replaced = 0
  let out = ''
  for (const ch of String(text).normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x0A || representable(ch, cp)) out += ch
    else { out += WINANSI_REPLACEMENT; replaced++ }
  }
  return Object.freeze({ text: out, replaced })
}

export interface WriteTextOptions extends PDFKit.Mixins.TextOptions {
  readonly x?: number
  readonly y?: number
  readonly sizePt?: number
}

/**
 * A ÚNICA porta de texto da família (D-NE126): papel de fonte REGISTRADO + `toWinAnsi` sempre. Posição (`x`/`y`) e corpo (`sizePt`) opcionais;
 * as demais opções vão ao pdfkit como estão (largura, alinhamento, `continued`…). Devolve quantos caracteres viraram `?`.
 */
export function writeText(doc: PDFKit.PDFDocument, role: string, text: string, opts: WriteTextOptions = {}): { readonly replaced: number } {
  const registered = (doc as unknown as { _registeredFonts?: Record<string, unknown> })._registeredFonts
  if (typeof role !== 'string' || !registered || !Object.prototype.hasOwnProperty.call(registered, role)) {
    throw new RangeError(`fontes da base: papel "${String(role)}" não registrado (registerFontRoles / fontRoles do createPdf)`)
  }
  const { x, y, sizePt, ...textOptions } = opts ?? {}
  for (const [what, v] of [['x', x], ['y', y]] as const) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 14400)) throw new RangeError(`fontes da base: posição ${what} inválida`)
  }
  if (sizePt !== undefined && (typeof sizePt !== 'number' || !Number.isFinite(sizePt) || sizePt <= 0 || sizePt > 1000)) {
    throw new RangeError('fontes da base: corpo inválido')
  }
  const t = toWinAnsi(typeof text === 'string' ? text : String(text ?? ''))
  doc.font(role)
  if (sizePt !== undefined) doc.fontSize(sizePt)
  if (x !== undefined || y !== undefined) doc.text(t.text, x, y, textOptions)
  else doc.text(t.text, textOptions)
  return Object.freeze({ replaced: t.replaced })
}
