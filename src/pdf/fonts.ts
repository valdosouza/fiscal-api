/**
 * Fontes da base de PDF (D-NE120): só as fontes-PADRÃO do PDF (sem embutir; codificação WinAnsi = CP1252). A base dá o MECANISMO — papel
 * (título, conteúdo, fixo…) → fonte; a ESCOLHA é da família, pela norma dela (MOC 7.00 Anexo II 3.7: Times New Roman ou Courier New).
 * Symbol e ZapfDingbats ficam de fora (não são WinAnsi).
 *
 * Texto fora do WinAnsi (emoji, setas, letras de outros alfabetos…) vira `?` pelo `toWinAnsi` — substituição VISÍVEL (nunca some calado) e
 * CONTADA para quem chama registrar. D-NE126 (Valdo 2026-10-17): a GARANTIA é de construção — a família escreve SÓ por `writeText` (que
 * sempre passa pelo `toWinAnsi`); `doc.text` direto com caractere fora do WinAnsi CORROMPE a linha no pdfkit (gate adversarial A4) e fica
 * fora da garantia — a cerca que o proíbe na família nasce com o DANFE (NE-5). D-NE129: a MEDIDA também tem porta (`measureText`, mesma
 * normalização) — medir o texto cru e escrever o convertido daria alturas diferentes. Papéis e portas só em documento da base (D-NE127); o
 * papel vale pelo registro DA BASE (re-gate D14), nunca pelo do pdfkit.
 */
import { baseDocument } from './base-document'
import { isolated } from './state'
import { MAX_COORDINATE_PT } from './units'

export const STANDARD_FONTS = Object.freeze([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
] as const)
export type StandardFont = typeof STANDARD_FONTS[number]

const ROLE_NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/

/** Liga cada papel a uma fonte-padrão no documento da base (registro DA BASE + do pdfkit): depois, a família escreve por `writeText`. */
export function registerFontRoles<R extends string>(doc: PDFKit.PDFDocument, roles: Readonly<Record<R, StandardFont>>): void {
  const base = baseDocument(doc)
  const entries = Object.entries(roles ?? {}) as [string, StandardFont][]
  if (entries.length === 0) throw new RangeError('fontes da base: informe ao menos um papel')
  for (const [role, font] of entries) {
    // gate adversarial A9: nome de propriedade do Object.prototype ("toString", "constructor") confunde a busca interna do pdfkit
    if (!ROLE_NAME.test(role) || (STANDARD_FONTS as readonly string[]).includes(role) || role in Object.prototype) {
      throw new RangeError(`fontes da base: papel "${role}" inválido (minúscula no início, sem nome de fonte-padrão nem de propriedade do JS)`)
    }
    if (!(STANDARD_FONTS as readonly string[]).includes(font)) throw new RangeError(`fontes da base: "${font}" não é fonte-padrão WinAnsi`)
  }
  for (const [role, font] of entries) {
    base.roles[role] = font
    doc.registerFont(role, font)
  }
}

/** O papel tem de estar no registro DA BASE (re-gate D14: `doc.registerFont` direto punha a fonte Symbol na porta do WinAnsi). */
function assertRole(doc: PDFKit.PDFDocument, role: string): void {
  const base = baseDocument(doc)
  if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(base.roles, role)) {
    throw new RangeError(`fontes da base: papel "${String(role)}" não registrado na base (registerFontRoles / fontRoles do createPdf)`)
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

/**
 * As opções de texto que a porta aceita (re-gate D12 — lista FECHADA: opção que o pdfkit interpretaria sem conferência, como `rotation` NaN
 * ou `horizontalScaling` em notação de expoente, é recusada antes de qualquer `q`). `columns` fica FORA de propósito — LIMITE CONHECIDO (re-gate
 * D6): nas folhas de transbordo o pdfkit reabre a 2ª coluna no topo da margem, por cima do espaço que o cabeçalho reservou (D-NE125); a NE-5
 * decide se o DANFE precisa de colunas.
 */
export interface TextLayoutOptions {
  readonly width?: number
  readonly height?: number
  readonly align?: 'left' | 'center' | 'right' | 'justify'
  readonly lineBreak?: boolean
  readonly continued?: boolean
  readonly ellipsis?: boolean
  readonly indent?: number
  readonly paragraphGap?: number
  readonly lineGap?: number
  readonly characterSpacing?: number
  readonly wordSpacing?: number
  readonly underline?: boolean
  readonly strike?: boolean
}
export interface WriteTextOptions extends TextLayoutOptions {
  readonly x?: number
  readonly y?: number
  readonly sizePt?: number
}

const SIZE_OPTIONS = ['width', 'height'] as const
const GAP_OPTIONS = ['indent', 'paragraphGap', 'lineGap', 'characterSpacing', 'wordSpacing'] as const
const FLAG_OPTIONS = ['lineBreak', 'continued', 'ellipsis', 'underline', 'strike'] as const
const ALIGNS = ['left', 'center', 'right', 'justify']
const LAYOUT_KEYS: readonly string[] = [...SIZE_OPTIONS, ...GAP_OPTIONS, ...FLAG_OPTIONS, 'align']
const finiteIn = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** Valida a lista fechada e devolve só as opções informadas (cópia — o objeto de quem chama nunca vai ao pdfkit). */
function layoutOptions(opts: Record<string, unknown>, extra: readonly string[]): PDFKit.Mixins.TextOptions {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || extra.includes(k)) continue
    if (!LAYOUT_KEYS.includes(k)) throw new RangeError(`fontes da base: opção de texto "${k}" fora da porta (D-NE126)`)
    if ((SIZE_OPTIONS as readonly string[]).includes(k) && !(finiteIn(v, 0, MAX_COORDINATE_PT) && (v as number) > 0)) throw new RangeError(`fontes da base: ${k} inválido`)
    if ((GAP_OPTIONS as readonly string[]).includes(k) && !finiteIn(v, -1000, 1000)) throw new RangeError(`fontes da base: ${k} inválido`)
    if ((FLAG_OPTIONS as readonly string[]).includes(k) && typeof v !== 'boolean') throw new RangeError(`fontes da base: ${k} tem de ser booleano`)
    if (k === 'align' && !ALIGNS.includes(v as string)) throw new RangeError('fontes da base: alinhamento inválido')
    out[k] = v
  }
  return out as PDFKit.Mixins.TextOptions
}
const assertSize = (sizePt: unknown): void => {
  if (sizePt !== undefined && !(finiteIn(sizePt, 0, 1000) && (sizePt as number) > 0)) throw new RangeError('fontes da base: corpo inválido')
}

/**
 * A ÚNICA porta de texto da família (D-NE126): papel REGISTRADO NA BASE + `toWinAnsi` sempre. Posição (`x`/`y`) e corpo (`sizePt`) opcionais —
 * só `y` usa o `x` corrente (re-gate D2: no pdfkit 0.20.2 o `x` ausente virava o objeto de OPÇÕES e as verdadeiras eram jogadas fora); as demais
 * opções pela lista fechada `TextLayoutOptions`. Devolve quantos caracteres viraram `?`.
 */
export function writeText(doc: PDFKit.PDFDocument, role: string, text: string, opts: WriteTextOptions = {}): { readonly replaced: number } {
  assertRole(doc, role)
  const all = (opts ?? {}) as Record<string, unknown>
  const { x, y, sizePt } = all as { x?: number; y?: number; sizePt?: number }
  for (const [what, v] of [['x', x], ['y', y]] as const) {
    if (v !== undefined && !finiteIn(v, -MAX_COORDINATE_PT, MAX_COORDINATE_PT)) throw new RangeError(`fontes da base: posição ${what} inválida`)
  }
  assertSize(sizePt)
  const textOptions = layoutOptions(all, ['x', 'y', 'sizePt'])
  const t = toWinAnsi(typeof text === 'string' ? text : String(text ?? ''))
  doc.font(role)
  if (sizePt !== undefined) doc.fontSize(sizePt)
  if (x !== undefined || y !== undefined) doc.text(t.text, x ?? doc.x, y ?? doc.y, textOptions)
  else doc.text(t.text, textOptions)
  return Object.freeze({ replaced: t.replaced })
}

export interface MeasureTextOptions extends Omit<TextLayoutOptions, 'continued' | 'lineBreak' | 'ellipsis' | 'underline' | 'strike' | 'height'> {
  readonly sizePt?: number
}

/**
 * A porta de MEDIDA (D-NE129, Valdo 2026-10-17): o texto passa pela MESMA normalização do `writeText` e é medido no papel/corpo pedidos —
 * `width` = a linha sem quebra; `height` = a altura que o `writeText` ocuparia com essas opções (com `width`, quebrando como ele). Não desenha e
 * não mexe no estado da família.
 */
export function measureText(doc: PDFKit.PDFDocument, role: string, text: string, opts: MeasureTextOptions = {}):
  { readonly width: number; readonly height: number; readonly replaced: number } {
  assertRole(doc, role)
  const all = (opts ?? {}) as Record<string, unknown>
  for (const k of ['continued', 'lineBreak', 'ellipsis', 'underline', 'strike', 'height']) {
    if (all[k] !== undefined) throw new RangeError(`fontes da base: opção "${k}" não se aplica à medida`)
  }
  assertSize(all.sizePt)
  const layout = layoutOptions(all, ['sizePt'])
  const t = toWinAnsi(typeof text === 'string' ? text : String(text ?? ''))
  return isolated(doc, () => {
    doc.font(role)
    if (all.sizePt !== undefined) doc.fontSize(all.sizePt as number)
    const width = Math.max(0, ...t.text.split('\n').map(line => doc.widthOfString(line, layout)))
    const height = doc.heightOfString(t.text, layout)
    return Object.freeze({ width, height, replaced: t.replaced })
  }, { graphics: false, who: 'measureText' })
}
