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
import { assertStandardFontIntact, isolated, useStandardFont } from './state'
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
  const font = base.roles[role] as StandardFont
  assertStandardFontIntact(doc, font)                    // e o NOME da fonte-padrão não foi sobreposto no pdfkit (gate final F-L2)
  return font
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
 * Os espaços do FIM fora (D-NE137) num laço do fim para o começo — linear (gate R9-L4: a regex `/ +$/` recomeça em CADA espaço de uma corrida
 * longa no meio do texto e falha no caractere seguinte, O(n²)). "Espaço" = U+0020 e o NBSP U+00A0 (D-NE141, Valdo 2026-10-17 — Q-NE141 (a)): os
 * brancos que sobram depois do `toWinAnsi` (tabulação já virou espaço; os demais brancos do Unicode viraram `?`) — o que o pdfkit apara (`\s`) no
 * alinhamento, sem a quebra de linha (essa a linha única recusa).
 */
function trimTrailingSpaces(text: string): string {
  let end = text.length
  while (end > 0 && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0xA0)) end--
  return end === text.length ? text : text.slice(0, end)
}

/** O `PDFNumber` do pdfkit 0.20.2: o maior float32 que não passa de `n` (é assim que o quebrador de linha guarda o limite de baixo). */
function float32Down(n: number): number {
  const f = new Float32Array([n])
  if (f[0] <= n) return f[0]
  const u = new Uint32Array(f.buffer)
  if (n <= 0) u[0] += 1; else u[0] -= 1
  return f[0]
}

/**
 * D-NE140 (Valdo 2026-10-17 — Q-NE140 (a)): a base compensa o arredondamento do pdfkit na ENTRADA do bloco. O quebrador de linha guarda o pé da
 * folha arredondado PARA BAIXO em float32 e confere a 1ª linha em float64 (`y + altura da linha`): um bloco posto EXATAMENTE onde a medida diz que
 * cabe passava do pé por ~1e-4 pt e abria folha antes de escrever (gate final F-L6) — com um recorte da família aberto, a D-NE134 deixava o
 * documento sem conserto (gate socrático do delta, achado 6). Só quando a 1ª linha cabe no pé EXATO e não no arredondado: o `y` sobe o que falta
 * (até 1 ulp de float32 do pé — ~6e-5 pt no A4, ~1e-3 pt no papel de 14.400 pt; invisível). "Cabe no pé exato" com folga RELATIVA de 2^-40 × pé
 * (~7e-10 pt no A4 — gates R10-M1/socrático M1: a altura que a medida devolve é `(y + lh) − y` em float64 e erra 1 a 3 ulps; sem a folga, ~5 % dos
 * corpos do DANFE ainda abriam folha). O que não cabe de verdade (1e-6 pt além do pé, p.ex.) fica com o pdfkit. Fora do encadeado aberto (o quebrador dele já guardou o limite) e sem
 * `height` — CONHECIMENTO NEGATIVO (provado por sonda na execução): com `height` a mesma conferência só avança a coluna e a linha é escrita; não há o
 * que compensar.
 */
function fitFloat32(doc: PDFKit.PDFDocument, y0: number): number | null {
  const lh = doc.currentLineHeight(true)
  const nextY = y0 + lh
  const foot = doc.page.maxY()
  const foot32 = float32Down(foot)
  if (nextY - foot > Math.abs(foot) * 2 ** -40 || nextY <= foot32) return null
  let y = y0
  for (let i = 0; i < 8 && y + lh > foot32; i++) y -= (y + lh - foot32) + Math.abs(foot32) * 2 ** -52
  return y + lh <= foot32 ? y : null
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
 *   DOCUMENTO em volta do `writeText` (`save()` → `rotate()` → `writeText` → `restore()`) — caminho que a cerca da NE-5 PERMITE. Dentro da
 *   rotação só a LINHA ÚNICA é segura (gate socrático L6): o quebrador de linha do pdfkit compara o `y` do espaço GIRADO com o pé da folha e
 *   abriria folha.
 *
 * LINHA ÚNICA (D-NE132/D-NE133/D-NE135…D-NE137, Valdo 2026-10-17 — gates R7-M2/L7 e final): `lineBreak: false` COM `width` é a CÉLULA do DANFE —
 * a base escreve UMA linha, alinhada por ela dentro da largura (`justify` numa linha só = esquerda; no pdfkit 0.20.2, havendo `width`, o texto
 * passa pelo quebrador de linha, quebra e ABRE FOLHA); os espaços do FIM não contam (D-NE137 — medidos, alinhados e desenhados sem eles, como o
 * pdfkit faz); texto que não cabe na largura é RECUSADO (a família mede antes com `measureText` e abrevia ou reduz o corpo). Toda escrita com
 * `lineBreak: false` (com ou sem `width`) recusa `continued: true` (D-NE136 — para juntar trechos na mesma linha: `x` explícito pelo
 * `measureText`, ou `continued` com `width`; `continued: false`, o padrão, passa — D-NE143) e recusa texto encadeado ABERTO (D-NE135 — o pdfkit
 * fundiria a largura da cadeia), e devolve o `x` de onde COMEÇOU (D-NE133 — o pdfkit o deixava no fim do texto e a coluna de rótulos escrita só
 * com `y` virava escada). D-NE139: linha que fica vazia depois de aparada não desenha nada — nem o sublinhado/riscado (a linha de preenchimento
 * do formulário é desenho vetorial da família). D-NE146: TODA escrita `lineBreak: false` (com ou sem `width`) recusa quebra de linha — sem o
 * quebrador o pdfkit cola as linhas na mesma linha de base.
 *
 * TEXTO VAZIO (D-NE147, Valdo 2026-10-18): sem `continued` e sem cadeia aberta, a base não chama o pdfkit — nada é escrito e nenhuma folha abre
 * (a medida do vazio é 0); o `x`/`y` ficam como informados. Com a cadeia ABERTA (D-NE152, Valdo 2026-10-18 — gate R11-L1) a base FECHA a cadeia
 * ela mesma, sem chamar o pdfkit: `x`/`y` onde o fechamento com texto deixaria (o `x` do início da cadeia; o `y` uma linha abaixo da linha
 * encadeada — altura da linha na fonte/corpo do fechamento + `lineGap` + `paragraphGap`, as opções da cadeia valendo onde o fechamento não diz,
 * como no pdfkit). O pdfkit, com `''`, não emite linha: o `y` ficava no topo da linha encadeada (o próximo bloco só com `x` saía por cima do
 * rótulo) e, num corpo maior no pé, abria folha VAZIA.
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
  const d = doc as unknown as { _wrapper?: unknown; _textOptions?: unknown }
  if (textOptions.lineBreak === false) {
    if (t.text.includes('\n')) {
      // D-NE146 (Valdo 2026-10-18 — gate R10-L3): sem quebrador o pdfkit escreve as linhas uma DEPOIS da outra na MESMA linha de base
      throw new RangeError('fontes da base: escrita com lineBreak: false não leva quebra de linha (D-NE146)')
    }
    if (textOptions.continued === true) {                                           // D-NE143: `false` (o padrão) passa
      throw new RangeError('fontes da base: "continued" não combina com lineBreak: false — junte trechos com x pelo advance do measureText ou continued com width (D-NE136)')
    }
    if (d._wrapper || d._textOptions) {
      throw new RangeError('fontes da base: há texto encadeado aberto — feche-o antes (último trecho sem continued) para escrever uma linha única (D-NE135)')
    }
  }
  const singleLine = textOptions.lineBreak === false && textOptions.width !== undefined
  const lineText = singleLine ? trimTrailingSpaces(t.text) : t.text                // D-NE137: espaços do FIM não contam na linha única
  let lineWidth = 0
  if (singleLine) {
    for (const k of ['height', 'ellipsis', 'indent', 'paragraphGap', 'lineGap']) {
      if (textOptions[k] !== undefined) throw new RangeError(`fontes da base: "${k}" não se aplica à linha única (lineBreak: false com width — D-NE132)`)
    }
    // mede ANTES de escrever, sem mexer no estado da família — a recusa não deixa rastro
    lineWidth = isolated(doc, () => { useStandardFont(doc, font); if (sizePt !== undefined) doc.fontSize(sizePt); return doc.widthOfString(lineText) },
      { graphics: false, who: 'writeText' })
    if (lineWidth > (textOptions.width as number) + 1e-6) {
      throw new RangeError('fontes da base: o texto não cabe na largura da linha única — meça antes (measureText) e abrevie ou reduza o corpo (D-NE132)')
    }
  }
  const x0 = x ?? doc.x
  if (!singleLine && textOptions.lineBreak !== false && textOptions.width === undefined && !d._textOptions
    && doc.page.width - x0 - doc.page.margins.right <= 0) {
    // gate final F-L5: sem largura útil a partir de x (além da margem direita) o pdfkit escreveria com largura 0, linhas empilhadas no mesmo y
    throw new RangeError('fontes da base: não há largura útil a partir de x (além da margem direita) — informe width')
  }
  useStandardFont(doc, font)                              // a fonte do registro DA BASE (re-gate S1/R7-L1), conferida AQUI (F-L2/R9-L1)
  if (sizePt !== undefined) doc.fontSize(sizePt)
  if (singleLine) {
    const width = textOptions.width as number
    const align = textOptions.align ?? 'left'
    const dx = align === 'right' ? width - lineWidth : align === 'center' ? (width - lineWidth) / 2 : 0
    const line: Record<string, unknown> = { lineBreak: false }
    if (textOptions.underline !== undefined) line.underline = textOptions.underline
    if (textOptions.strike !== undefined) line.strike = textOptions.strike
    doc.text(lineText, x0 + dx, y ?? doc.y, line)
  } else if (t.text === '' && textOptions.continued !== true && d._wrapper) {
    // D-NE152: o fechamento da cadeia pelo vazio, feito pela base — o que o `_line` do pdfkit faria com o último trecho (avança o `y` da linha
    // encadeada) e o fim do quebrador (devolve o `x` do início), sem a conferência de entrada que abriria folha no pé
    const chain: Record<string, unknown> = { ...((d._textOptions ?? {}) as Record<string, unknown>) }
    for (const [k, v] of Object.entries(textOptions)) if (v !== undefined) chain[k] = v      // como o `_initOptions`: o fechamento vale sobre a cadeia
    if (y !== undefined) doc.y = y
    const lineGap = (chain.lineGap as number) || (doc as unknown as { _lineGap?: number })._lineGap || 0
    doc.y += doc.currentLineHeight(true) + lineGap + ((chain.paragraphGap as number) || 0)
    doc.x = (d._wrapper as { startX: number }).startX
    d._wrapper = null
    d._textOptions = null
  } else if (t.text === '' && textOptions.continued !== true && !d._wrapper && !d._textOptions) {
    // D-NE147 (Valdo 2026-10-18 — gate R10-L1): o vazio mede 0 e não escreve nada — o pdfkit abriria folha VAZIA no pé (a conferência de entrada
    // exige uma linha); a posição fica como o pdfkit a deixaria (x/y informados, sem avançar). Cadeia aberta: o vazio FECHA a cadeia (vai ao pdfkit)
    doc.x = x0
    if (y !== undefined) doc.y = y
  } else {
    // D-NE140: a 1ª linha posta onde a medida diz que cabe não abre folha pelo arredondamento do pdfkit (fora do encadeado aberto e sem quebra)
    const fit = textOptions.lineBreak === false || textOptions.height !== undefined || d._wrapper ? null : fitFloat32(doc, y ?? doc.y)
    if (fit !== null) doc.text(t.text, x0, fit, textOptions)
    else if (x !== undefined || y !== undefined) doc.text(t.text, x0, y ?? doc.y, textOptions)
    else doc.text(t.text, textOptions)
  }
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
 * `width`, quebrando como ele; sem `width`, com a largura que sobra a partir de `x` — sem largura útil, recusa como a escrita). Não desenha e
 * não mexe no estado da família.
 * A largura de cada linha é medida SEM os espaços do fim (D-NE141 — a mesma regra da linha única da D-NE137: medida e escrita dizem o mesmo);
 * `advance` = a ÚLTIMA linha medida COM eles — o quanto o `x` anda para o PRÓXIMO trecho na mesma linha (o caminho da D-NE136: "CNPJ: " mede
 * 21 pt de `width` e anda 24 pt de `advance`; sem ele o número colaria no rótulo — consequência da D-NE141, RATIFICADA na D-NE145, Valdo
 * 2026-10-18). Só sem quebra: se a escrita QUEBRA o texto (pela `width` pedida ou, sem ela, pela largura que sobra a partir de `x`) ou usa
 * `indent`, o `advance` NÃO se aplica (a última linha da escrita é outra). Um
 * bloco posto EXATAMENTE em `pé − altura medida` cabe (D-NE140 — a escrita compensa o arredondamento float32 do pdfkit; gate final F-L6).
 * Sem `width`, a recusa por falta de largura útil olha o `x` (o informado ou o CORRENTE — gate socrático do delta, achado 3): para medir só a
 * LARGURA de um trecho (juntar trechos na mesma linha — D-NE136), passe o `x` onde ele vai ser escrito, nunca dependa do `x` que ficou no documento.
 */
export function measureText(doc: PDFKit.PDFDocument, role: string, text: string, opts: MeasureTextOptions = {}):
  { readonly width: number; readonly advance: number; readonly height: number; readonly replaced: number } {
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
    useStandardFont(doc, font)
    if (sizePt !== undefined) doc.fontSize(sizePt)
    if (x !== undefined) doc.x = x
    if (layout.width === undefined && doc.page.width - doc.x - doc.page.margins.right <= 0) {
      throw new RangeError('fontes da base: não há largura útil a partir de x (além da margem direita) — informe width')
    }
    const lines = t.text.split('\n')
    const width = Math.max(0, ...lines.map(line => doc.widthOfString(trimTrailingSpaces(line), layout)))
    const advance = doc.widthOfString(lines[lines.length - 1], layout)            // D-NE145: a ÚLTIMA linha (onde o próximo trecho entra)
    const height = doc.heightOfString(t.text, layout)
    return Object.freeze({ width, advance, height, replaced: t.replaced })
  }, { graphics: false, who: 'measureText' })
}
