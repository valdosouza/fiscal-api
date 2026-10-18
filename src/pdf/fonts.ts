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
    // D-NE131 (Valdo 2026-10-17): um papel tem UMA fonte no documento inteiro — a grade medida não muda no meio; registrar de novo com a
    // MESMA fonte é inofensivo
    if (Object.prototype.hasOwnProperty.call(base.roles, role) && base.roles[role] !== font) {
      throw new RangeError(`fontes da base: o papel "${role}" já é ${base.roles[role]} neste documento (um papel, uma fonte — D-NE131)`)
    }
  }
  for (const [role, font] of entries) {
    base.roles[role] = font
    doc.registerFont(role, font)
  }
}

/**
 * O papel tem de estar no registro DA BASE e o desenho usa a fonte DESSE registro (re-gates D14 e S1/R7-L1: conferir num registro e desenhar
 * pelo do pdfkit deixava `doc.registerFont` direto pôr a fonte Symbol na porta do WinAnsi). Devolve a fonte-padrão do papel.
 */
function fontOfRole(doc: PDFKit.PDFDocument, role: string): StandardFont {
  const base = baseDocument(doc)
  if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(base.roles, role)) {
    throw new RangeError(`fontes da base: papel "${String(role)}" não registrado na base (registerFontRoles / fontRoles do createPdf)`)
  }
  return base.roles[role] as StandardFont
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
 * ou `horizontalScaling` em notação de expoente, é recusada antes de qualquer `q`). Fora, de propósito — LIMITES CONHECIDOS:
 * - `columns` (re-gate D6): nas folhas de transbordo o pdfkit reabre a 2ª coluna no topo da margem, por cima do espaço que o cabeçalho
 *   reservou (D-NE125); a NE-5 decide se o DANFE precisa de colunas;
 * - `wordSpacing` e `characterSpacing` (gate R7-L2): no pdfkit 0.20.2 o `wordSpacing` APAGA quebras de linha (troca todo espaço duplo, inclusive
 *   a quebra, por um espaço) e não entra na largura medida; o `characterSpacing` conta duas vezes no sublinhado. O DANFE não precisa de nenhum.
 * Espaçamentos só POSITIVOS (gate R7-L6: negativo leva o texto para fora da folha em silêncio); `lineGap` maior que zero — o pdfkit trata
 * `lineGap: 0` como "não informado" e usa o do documento.
 * - texto GIRADO (D-NE130 — o canhoto vertical do DANFE paisagem, MOC 7.00 Anexo II 3.8.2): não há `rotation` na porta; a família gira o
 *   DOCUMENTO em volta do `writeText` (`save()` → `rotate()` → `writeText` → `restore()`) — caminho que a cerca da NE-5 PERMITE.
 *
 * LINHA ÚNICA (D-NE132/D-NE133, Valdo 2026-10-17 — gate R7-M2/L7): `lineBreak: false` COM `width` é a CÉLULA do DANFE — a base escreve UMA linha,
 * alinhada por ela dentro da largura (no pdfkit 0.20.2, havendo `width`, o texto passa pelo quebrador de linha, quebra e ABRE FOLHA); texto que
 * não cabe na largura é RECUSADO (a família mede antes com `measureText` e abrevia ou reduz o corpo). Depois de toda escrita de linha única
 * (`lineBreak: false`, com ou sem `width`) o `x` volta para onde ela COMEÇOU — o pdfkit o deixava no fim do texto e a coluna de rótulos escrita
 * só com `y` virava escada.
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
  readonly underline?: boolean
  readonly strike?: boolean
}
export interface WriteTextOptions extends TextLayoutOptions {
  readonly x?: number
  readonly y?: number
  readonly sizePt?: number
}

const SIZE_OPTIONS = ['width', 'height'] as const
const GAP_OPTIONS = ['indent', 'paragraphGap'] as const
const FLAG_OPTIONS = ['lineBreak', 'continued', 'ellipsis', 'underline', 'strike'] as const
const ALIGNS = ['left', 'center', 'right', 'justify']
const LAYOUT_KEYS: readonly string[] = [...SIZE_OPTIONS, ...GAP_OPTIONS, 'lineGap', ...FLAG_OPTIONS, 'align']
const finiteIn = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** Valida a lista fechada e devolve só as opções informadas (cópia — o objeto de quem chama nunca vai ao pdfkit). */
function layoutOptions(opts: Readonly<Record<string, unknown>>, extra: readonly string[]): PDFKit.Mixins.TextOptions {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || extra.includes(k)) continue
    if (!LAYOUT_KEYS.includes(k)) throw new RangeError(`fontes da base: opção de texto "${k}" fora da porta (D-NE126)`)
    if ((SIZE_OPTIONS as readonly string[]).includes(k) && !(finiteIn(v, 0, MAX_COORDINATE_PT) && (v as number) > 0)) throw new RangeError(`fontes da base: ${k} inválido`)
    if ((GAP_OPTIONS as readonly string[]).includes(k) && !finiteIn(v, 0, 1000)) throw new RangeError(`fontes da base: ${k} inválido (0 a 1000)`)
    if (k === 'lineGap' && !(finiteIn(v, 0, 1000) && (v as number) > 0)) throw new RangeError('fontes da base: lineGap inválido (maior que 0, até 1000)')
    if ((FLAG_OPTIONS as readonly string[]).includes(k) && typeof v !== 'boolean') throw new RangeError(`fontes da base: ${k} tem de ser booleano`)
    if (k === 'align' && !ALIGNS.includes(v as string)) throw new RangeError('fontes da base: alinhamento inválido')
    out[k] = v
  }
  return out as PDFKit.Mixins.TextOptions
}
const assertSize = (sizePt: unknown): void => {
  if (sizePt !== undefined && !(finiteIn(sizePt, 0, 1000) && (sizePt as number) > 0)) throw new RangeError('fontes da base: corpo inválido')
}
const assertPosition = (what: string, v: unknown): void => {
  if (v !== undefined && !finiteIn(v, -MAX_COORDINATE_PT, MAX_COORDINATE_PT)) throw new RangeError(`fontes da base: posição ${what} inválida`)
}
/** As opções lidas UMA vez (gate R7-L5 — a classe do A12: um getter validava um valor e entregava outro). */
const snapshotOptions = (opts: unknown): Readonly<Record<string, unknown>> =>
  Object.freeze({ ...((opts && typeof opts === 'object') ? opts as Record<string, unknown> : {}) })

/**
 * A ÚNICA porta de texto da família (D-NE126): papel REGISTRADO NA BASE + `toWinAnsi` sempre. Posição (`x`/`y`) e corpo (`sizePt`) opcionais —
 * só `y` usa o `x` corrente (re-gate D2: no pdfkit 0.20.2 o `x` ausente virava o objeto de OPÇÕES e as verdadeiras eram jogadas fora); as demais
 * opções pela lista fechada `TextLayoutOptions`. Devolve quantos caracteres viraram `?`.
 */
export function writeText(doc: PDFKit.PDFDocument, role: string, text: string, opts: WriteTextOptions = {}): { readonly replaced: number } {
  const font = fontOfRole(doc, role)
  const all = snapshotOptions(opts)
  const { x, y, sizePt } = all as { x?: number; y?: number; sizePt?: number }
  assertPosition('x', x)
  assertPosition('y', y)
  assertSize(sizePt)
  const textOptions = layoutOptions(all, ['x', 'y', 'sizePt']) as Record<string, unknown>
  const t = toWinAnsi(typeof text === 'string' ? text : String(text ?? ''))
  const singleLine = textOptions.lineBreak === false && textOptions.width !== undefined
  let lineWidth = 0
  if (singleLine) {
    for (const k of ['continued', 'height', 'ellipsis', 'indent', 'paragraphGap', 'lineGap']) {
      if (textOptions[k] !== undefined) throw new RangeError(`fontes da base: "${k}" não se aplica à linha única (lineBreak: false com width — D-NE132)`)
    }
    if (t.text.includes('\n')) throw new RangeError('fontes da base: linha única (lineBreak: false com width) não leva quebra de linha (D-NE132)')
    // mede ANTES de escrever, sem mexer no estado da família — a recusa não deixa rastro
    lineWidth = isolated(doc, () => { doc.font(font); if (sizePt !== undefined) doc.fontSize(sizePt); return doc.widthOfString(t.text) },
      { graphics: false, who: 'writeText' })
    if (lineWidth > (textOptions.width as number) + 1e-6) {
      throw new RangeError('fontes da base: o texto não cabe na largura da linha única — meça antes (measureText) e abrevie ou reduza o corpo (D-NE132)')
    }
  }
  doc.font(font)                                          // a fonte do registro DA BASE (re-gate S1/R7-L1), nunca a resolução do pdfkit pelo nome
  if (sizePt !== undefined) doc.fontSize(sizePt)
  const x0 = x ?? doc.x
  if (singleLine) {
    const width = textOptions.width as number
    const align = textOptions.align ?? 'left'
    const dx = align === 'right' ? width - lineWidth : align === 'center' ? (width - lineWidth) / 2 : 0
    const line: Record<string, unknown> = { lineBreak: false }
    if (textOptions.underline !== undefined) line.underline = textOptions.underline
    if (textOptions.strike !== undefined) line.strike = textOptions.strike
    doc.text(t.text, x0 + dx, y ?? doc.y, line)
  } else if (x !== undefined || y !== undefined) doc.text(t.text, x0, y ?? doc.y, textOptions)
  else doc.text(t.text, textOptions)
  if (textOptions.lineBreak === false) doc.x = x0                // D-NE133: a linha única devolve o x de onde começou
  return Object.freeze({ replaced: t.replaced })
}

export interface MeasureTextOptions extends Omit<TextLayoutOptions, 'continued' | 'lineBreak' | 'ellipsis' | 'underline' | 'strike' | 'height'> {
  readonly sizePt?: number
  /** Onde a escrita vai começar — sem `width`, a largura disponível é a que sobra a partir dele (padrão: o `x` corrente). Re-gate S4. */
  readonly x?: number
}

/**
 * A porta de MEDIDA (D-NE129, Valdo 2026-10-17): o texto passa pela MESMA normalização do `writeText` e é medido na fonte do papel (registro da
 * base) e no corpo pedidos — `width` = a linha mais larga, sem quebra; `height` = a altura que o `writeText` ocuparia com essas opções (com
 * `width`, quebrando como ele; sem `width`, com a largura que sobra a partir de `x`). Não desenha e não mexe no estado da família.
 */
export function measureText(doc: PDFKit.PDFDocument, role: string, text: string, opts: MeasureTextOptions = {}):
  { readonly width: number; readonly height: number; readonly replaced: number } {
  const font = fontOfRole(doc, role)
  const all = snapshotOptions(opts)
  for (const k of ['continued', 'lineBreak', 'ellipsis', 'underline', 'strike', 'height']) {
    if (all[k] !== undefined) throw new RangeError(`fontes da base: opção "${k}" não se aplica à medida`)
  }
  const sizePt = all.sizePt as number | undefined
  const x = all.x as number | undefined
  assertSize(sizePt)
  assertPosition('x', x)
  const layout = layoutOptions(all, ['sizePt', 'x'])
  const t = toWinAnsi(typeof text === 'string' ? text : String(text ?? ''))
  return isolated(doc, () => {
    doc.font(font)
    if (sizePt !== undefined) doc.fontSize(sizePt)
    if (x !== undefined) doc.x = x
    const width = Math.max(0, ...t.text.split('\n').map(line => doc.widthOfString(line, layout)))
    const height = doc.heightOfString(t.text, layout)
    return Object.freeze({ width, height, replaced: t.replaced })
  }, { graphics: false, who: 'measureText' })
}
