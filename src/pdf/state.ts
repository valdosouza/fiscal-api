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
const TEXT_STATE = ['_font', '_fontSize', '_fontSource', '_fontFamily', '_lineGap', '_fillColor', '_wrapper', '_textOptions', 'x', 'y'] as const
export type KeptState = 'y'

export interface IsolateOptions {
  /** O que fica como o código isolado deixou (o `sheetStart` deixa o `y` como começo do conteúdo — D-NE125). */
  readonly keep?: readonly KeptState[]
  /** Envolve em q/Q e confere o equilíbrio (padrão true); a MEDIDA de texto não desenha e não precisa (D-NE129). */
  readonly graphics?: boolean
  /** Estado de entrada NEUTRO (cor e traço pretos opacos, corpo 12, espaçamento 0) — o `sheetStart` e a passada não herdam o fim do conteúdo. */
  readonly neutral?: boolean
  /** Quem roda (para a mensagem de erro de uso). */
  readonly who?: string
}

/**
 * Roda `run` com o estado da família guardado: o texto encadeado dela fica FORA, o estado gráfico do PDF volta pelo q/Q e o estado JS volta
 * campo a campo (menos o `keep`). Erro de USO dentro dele — `save()` sem `restore()` (gate D3), terminar noutra folha (gate D4) — é corrigido
 * para o PDF continuar balanceado e LANÇA com mensagem da base.
 */
export function isolated<T>(doc: PDFKit.PDFDocument, run: () => T, opts: IsolateOptions = {}): T {
  const d = doc as unknown as Record<string, any>
  const saved = TEXT_STATE.map(k => d[k])
  const graphics = opts.graphics ?? true
  const page = doc.page
  const sheets = (d._pageBuffer as unknown[]).length
  d._wrapper = null
  d._textOptions = null
  let depth = 0
  let ours: unknown = null
  const who = opts.who ?? 'o desenho'
  const hadOwnRestore = Object.prototype.hasOwnProperty.call(d, 'restore')
  const previousRestore = d.restore as () => unknown
  if (graphics) {
    doc.save(); depth = d._ctmStack.length; ours = d._ctmStack[depth - 1]                // a ENTRADA do nosso save (um array novo por save)
    // gate R7-M1: `restore()` a MAIS barrado NA HORA, antes de emitir o `Q` — acusar depois não desfaz o que vazou para o resto da folha
    d.restore = function guardedRestore(this: unknown) {
      if (d._ctmStack.length <= depth) throw new Error(`base de PDF: ${who} deu restore() a mais (fecharia o estado que não abriu)`)
      return previousRestore.call(doc)
    }
  }
  const unguard = (): void => { if (!graphics) return; if (hadOwnRestore) d.restore = previousRestore; else delete d.restore }
  let result: T | undefined
  let failure: { error: unknown } | null = null
  try {
    // estado de entrada NEUTRO = o de uma folha nova (re-gate S3): preto opaco, traço de 1 pt contínuo, Helvetica 12, espaçamento 0
    if (opts.neutral) doc.fillColor('#000000', 1).strokeColor('#000000', 1).lineWidth(1).undash().font('Helvetica').fontSize(12).lineGap(0)
    result = run()
  } catch (error) {
    failure = { error }                                  // o erro de quem rodou sobe DEPOIS da limpeza — nunca trocado pelo de uso
  }
  unguard()
  let misuse: string | null = null
  if (doc.page !== page) {
    misuse = (d._pageBuffer as unknown[]).length !== sheets
      ? 'abriu folha nova — o total que ela recebeu ficou errado' : 'terminou noutra folha (switchToPage sem voltar)'
    // o save() aberto NA OUTRA folha fecha lá (re-gate R7-L3b) antes de voltar
    if (graphics) while (d._ctmStack.length > depth) doc.restore()
    const index = (d._pageBuffer as unknown[]).indexOf(page)
    if (index >= 0) doc.switchToPage(d._pageBufferStart + index)
  }
  if (graphics) {
    if (d._ctmStack.length > depth) misuse = misuse ?? 'deixou save() sem restore()'
    else if (d._ctmStack.length < depth || d._ctmStack[depth - 1] !== ours) {
      // re-gate R7-M1: restore() A MAIS fechou o estado do isolamento (e `restore(); save()` equilibra a contagem com OUTRA entrada) — o que
      // veio depois ficou fora de qualquer q; reabre o que falta para o PDF seguir balanceado e acusa
      misuse = misuse ?? 'deu restore() a mais (fechou o estado que não abriu)'
    }
    while (d._ctmStack.length > depth) doc.restore()
    while (d._ctmStack.length < depth) doc.save()
    doc.restore()
  }
  const keep = (opts.keep ?? []) as readonly string[]
  TEXT_STATE.forEach((k, i) => { if (!keep.includes(k)) d[k] = saved[i] })
  if (failure) throw failure.error
  if (misuse) throw new Error(`base de PDF: ${who} ${misuse}`)
  return result as T
}
