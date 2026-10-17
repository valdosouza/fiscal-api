/**
 * Fontes da base de PDF (D-NE120): só as fontes-PADRÃO do PDF (sem embutir; codificação WinAnsi = CP1252). A base dá o MECANISMO — papel
 * (título, conteúdo, fixo…) → fonte; a ESCOLHA é da família, pela norma dela (MOC 7.00 Anexo II 3.7: Times New Roman ou Courier New).
 * Symbol e ZapfDingbats ficam de fora (não são WinAnsi).
 *
 * Texto fora do WinAnsi (emoji, setas, letras de outros alfabetos…) NÃO chega ao pdfkit: `toWinAnsi` troca cada caractere sem
 * representação por `?` — substituição VISÍVEL (nunca some calado) e CONTADA para quem chama registrar.
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
    if (!ROLE_NAME.test(role) || (STANDARD_FONTS as readonly string[]).includes(role)) {
      throw new RangeError(`fontes da base: papel "${role}" inválido (minúscula no início, sem nome de fonte-padrão)`)
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
