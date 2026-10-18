/**
 * Isolamento do estado do pdfkit (gates da NE-1b, 2026-10-17 — HIGH provado pelos dois revisores; D-NE125/D-NE128).
 *
 * CONHECIMENTO NEGATIVO: no pdfkit 0.20.2 o `save()`/`restore()` guarda só a MATRIZ (q/Q no PDF + `_ctmStack`). Fonte, corpo, espaçamento de
 * linha, cor, posição e o texto ENCADEADO (`continued`) da família vivem no objeto JS (`_font`, `_fontSize`, `_fontSource`, `_fontFamily`,
 * `_lineGap`, `_fillColor`, `_wrapper`, `_textOptions`, `x`, `y` — `_strokeColor` NÃO existe nesta versão) e o quebrador de linha REAPLICA
 * `_fillColor` depois de abrir folha. Código que mexe nisso sem devolver faz o texto da família continuar no estilo dele. E o `q` NÃO limpa o
 * estado gráfico — só o guarda: quem desenha herda a cor/opacidade que o conteúdo deixou (por isso o `neutral`).
 * Estes nomes são INTERNOS do pdfkit — a versão é exata no package.json (D-NE124) e trocá-la exige os testes dos gates (A1/A2, D1–D8).
 *
 * Interno da base (não sai pela superfície `fiscal-api/pdf`).
 */
import { baseDocument } from './base-document'

const TEXT_STATE = ['_font', '_fontSize', '_fontSource', '_fontFamily', '_lineGap', '_fillColor', '_wrapper', '_textOptions', 'x', 'y'] as const
export type KeptState = 'y'

export interface IsolateOptions {
  /** O que fica como o código isolado deixou (o `sheetStart` deixa o `y` como começo do conteúdo — D-NE125). */
  readonly keep?: readonly KeptState[]
  /** Envolve em q/Q e confere o equilíbrio (padrão true); a MEDIDA de texto não desenha e não precisa (D-NE129). */
  readonly graphics?: boolean
  /**
   * Estado de entrada NEUTRO = o de uma folha nova (re-gate S3): preto opaco, traço de 1 pt contínuo, Helvetica 12, espaçamento 0 — o
   * `sheetStart` e a passada não herdam o fim do conteúdo. Não zera lineCap/lineJoin/miterLimit nem RECORTE — LIMITE CONHECIDO (gate socrático
   * do delta, achado 5): o operador de recorte do PDF não se desfaz; dentro de `save()` ele morre no `restore()` (e `save()` aberto na abertura de
   * folha ou no fim do conteúdo é erro de uso — D-NE134 / gate L3), mas um `clip()` da família FORA de `save()` vale até o fim da folha e recorta
   * também o que a passada escreve nela ("Folha n/N"). A base não tem como desfazê-lo — a família recorta só dentro de `save()`/`restore()`.
   */
  readonly neutral?: boolean
  /** Quem roda (para a mensagem de erro de uso). */
  readonly who?: string
}

/**
 * A fonte-padrão `font` ainda É a fonte-padrão no documento (gate final F-L2/socrático L1): o `doc.font(nome)` do pdfkit consulta o registro
 * (`_registeredFonts`) e o cache (`_fontFamilies`) ANTES das fontes-padrão — `doc.registerFont('Times-Roman', 'Symbol')` ou um
 * `doc.font('Symbol', 'Times-Roman')` faria a porta desenhar Symbol. Recusa legível antes de desenhar.
 */
export function assertStandardFontIntact(doc: PDFKit.PDFDocument, font: string): void {
  const d = doc as unknown as { _registeredFonts?: Record<string, unknown>; _fontFamilies?: Record<string, { name?: string } | undefined> }
  const registered = !!d._registeredFonts && Object.prototype.hasOwnProperty.call(d._registeredFonts, font)
  const cached = d._fontFamilies && Object.prototype.hasOwnProperty.call(d._fontFamilies, font) ? d._fontFamilies[font] : undefined
  // gate R9-L2: o nome de uma fonte EMBUTIDA é o PostScript do arquivo — confere também que o cache é uma fonte-PADRÃO do pdfkit
  const impostor = !!cached && (cached.name !== font || Object.getPrototypeOf(cached) !== baseDocument(doc).standardFontPrototype)
  if (registered || impostor) {
    throw new RangeError(`fontes da base: o nome da fonte-padrão "${font}" foi sobreposto no pdfkit (registerFont/font por fora) — a porta não desenha (D-NE126)`)
  }
}

/**
 * A fonte-padrão posta no documento PELA conferência (gate R9-L1): conferir longe do `doc.font` deixava código de quem chama que roda no meio
 * (getter de opção, `toString` do texto, getter de elemento da cor) sobrepor o nome depois da conferência. Toda porta da base troca de fonte por aqui.
 */
export function useStandardFont(doc: PDFKit.PDFDocument, font: string): void {
  assertStandardFontIntact(doc, font)
  doc.font(font)
}

/**
 * Marca das guardas instaladas pela base (aponta para a função que cada uma envolve). As guardas, a entrada, a saída e a limpeza do isolado chamam a
 * ORIGINAL (`rawOf`) — cada isolado conta SÓ os `save()` da família feitos enquanto a guarda DELE está instalada (gate R9-L5 / socrático do delta,
 * achado 1: o `save()` de entrada de um isolado aninhado passava pela guarda do de fora).
 */
const GUARD = Symbol('fiscal-api/pdf:guarda-da-base')
type Raw = (this: unknown, ...args: unknown[]) => unknown
type Guarded = Raw & { [GUARD]?: Raw }
const rawOf = (fn: Guarded): Raw => {
  let f: Guarded | undefined = fn
  while (f && f[GUARD]) f = f[GUARD] as Guarded
  return f as Raw
}

/**
 * D-NE138 (Valdo 2026-10-17 — Q-NE138 (a)), no NÍVEL DE CIMA do documento da base: trocar de folha com `save()` da família aberto é erro de uso
 * legível ANTES de trocar (a extensão da D-NE134 ao `switchToPage` — gate R9-L6: `save()` numa folha e `restore()` noutra zeravam a pilha, o
 * `end()` aceitava e o "Folha n/N" saía recortado). Voltar a uma folha anterior SEM `save()` aberto (preencher os totais da folha 1 depois que
 * os itens transbordaram — `bufferPages`) segue livre. Instalada pelo `createPdf`.
 */
export function guardSheetSwitch(doc: PDFKit.PDFDocument): void {
  const d = doc as unknown as Record<string, any>
  const original = d.switchToPage as Guarded
  const guarded: Guarded = function guardedSwitchToPage(...args: unknown[]) {
    if ((d._ctmStack as unknown[]).length > 0) {
      throw new Error('base de PDF: há save() aberto — feche com restore() antes de trocar de folha (switchToPage — D-NE138)')
    }
    return original.apply(doc, args)
  }
  guarded[GUARD] = original
  d.switchToPage = guarded
}

/**
 * Roda `run` com o estado da família guardado: o texto encadeado dela fica FORA, o estado gráfico do PDF volta pelo q/Q e o estado JS volta
 * campo a campo (menos o `keep`). Dentro dele a folha é a DELE (D-NE138): `switchToPage` é barrado NA HORA — o `sheetStart` e a passada desenham
 * na própria folha, e o controle de folha por `save()` (gates F-L4/R9-L5) deixou de existir junto com a troca. Erro de USO dentro dele —
 * `restore()` a mais (barrado NA HORA — gate R7-M1), `save()` sem `restore()` (gate D3), abrir folha (gate D4) — é corrigido para o PDF continuar
 * balanceado (os `save()` extras fecham na folha do isolado) e LANÇA com mensagem da base; o erro de quem rodou sobe sem ser trocado.
 */
export function isolated<T>(doc: PDFKit.PDFDocument, run: () => T, opts: IsolateOptions = {}): T {
  const d = doc as unknown as Record<string, any>
  const saved = TEXT_STATE.map(k => d[k])
  const graphics = opts.graphics ?? true
  const page = doc.page
  const sheets = (d._pageBuffer as unknown[]).length
  const who = opts.who ?? 'o desenho'
  d._wrapper = null
  d._textOptions = null
  let depth = 0
  let ours: unknown = null
  const own = (k: string): boolean => Object.prototype.hasOwnProperty.call(d, k)
  const had = { restore: own('restore'), save: own('save'), switchToPage: own('switchToPage') }
  const previous = { restore: d.restore as Guarded, save: d.save as Guarded, switchToPage: d.switchToPage as Guarded }
  const rawSave = rawOf(previous.save)
  const rawRestore = rawOf(previous.restore)
  const rawSwitch = rawOf(previous.switchToPage)
  const install = (k: keyof typeof previous, fn: Guarded): void => { fn[GUARD] = previous[k]; d[k] = fn }
  install('switchToPage', function guardedSwitchToPage() {
    throw new Error(`base de PDF: ${who} trocou de folha (switchToPage) — aqui a folha é a dele (D-NE138)`)
  })
  if (graphics) {
    rawSave.call(doc); depth = d._ctmStack.length; ours = d._ctmStack[depth - 1]         // a ENTRADA do nosso save (um array novo por save)
    install('save', function guardedSave() { return rawSave.call(doc) })
    // gate R7-M1: `restore()` a MAIS barrado NA HORA, antes de emitir o `Q` — acusar depois não desfaz o que vazou para o resto da folha
    install('restore', function guardedRestore() {
      if (d._ctmStack.length <= depth) throw new Error(`base de PDF: ${who} deu restore() a mais (fecharia o estado que não abriu)`)
      return rawRestore.call(doc)
    })
  }
  let result: T | undefined
  let failure: { error: unknown } | null = null
  try {
    if (opts.neutral) doc.fillColor('#000000', 1).strokeColor('#000000', 1).lineWidth(1).undash().font('Helvetica').fontSize(12).lineGap(0)
    result = run()
  } catch (error) {
    failure = { error }                                  // o erro de quem rodou sobe DEPOIS da limpeza — nunca trocado pelo de uso
  }
  for (const k of ['switchToPage', 'save', 'restore'] as const) {
    if (!graphics && k !== 'switchToPage') continue
    if (had[k]) d[k] = previous[k]; else delete d[k]
  }
  let misuse: string | null = null
  if (doc.page !== page) {
    misuse = (d._pageBuffer as unknown[]).length !== sheets
      ? 'abriu folha nova — o total que ela recebeu ficou errado' : 'terminou noutra folha'
    const index = (d._pageBuffer as unknown[]).indexOf(page)
    if (index >= 0) rawSwitch.call(doc, d._pageBufferStart + index)                 // de volta à folha do isolado (a troca nunca passa daqui)
  }
  if (graphics) {
    if (d._ctmStack.length > depth) misuse = misuse ?? 'deixou save() sem restore()'
    else if (d._ctmStack.length < depth || d._ctmStack[depth - 1] !== ours) misuse = misuse ?? 'deu restore() a mais (fechou o estado que não abriu)'
    while (d._ctmStack.length > depth) rawRestore.call(doc)   // os save() extras — todos nesta folha (D-NE138)
    while (d._ctmStack.length < depth) rawSave.call(doc)      // restore() a mais que escapou da guarda (desvio deliberado): rebalanceia
    rawRestore.call(doc)
  }
  const keep = (opts.keep ?? []) as readonly string[]
  TEXT_STATE.forEach((k, i) => { if (!keep.includes(k)) d[k] = saved[i] })
  if (failure) throw failure.error
  if (misuse) throw new Error(`base de PDF: ${who} ${misuse}`)
  return result as T
}
