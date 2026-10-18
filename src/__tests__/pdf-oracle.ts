/**
 * ORÁCULOS dos testes da base de PDF (D-NE118) — independentes da lib de símbolos e do código de produção:
 * - a tabela de larguras do Code-128 (ISO/IEC 15417) e um decodificador completo (conjuntos A, B e C, DV, Stop);
 * - a extração do texto de um PDF do pdfkit (streams FlateDecode; texto em `<hex> Tj`/`TJ`, bytes WinAnsi → CP1252).
 */
import zlib from 'zlib'
import jsQR from 'jsqr'

/** Monta a imagem (RGBA) da matriz com zona de silêncio de 4 módulos e lê com o jsQR (leitor independente — só devDependency). */
export function readQr(m: { readonly size: number; readonly rows: readonly (readonly boolean[])[] }, scale = 4): string | null {
  const quiet = 4, W = (m.size + 2 * quiet) * scale
  const rgba = new Uint8ClampedArray(W * W * 4).fill(255)
  m.rows.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = ((r + quiet) * scale + dy) * W + (c + quiet) * scale + dx
      rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = 0
    }
  }))
  return jsQR(rgba, W, W)?.data ?? null
}

const PATTERNS = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212',
  '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122',
  '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131',
  '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122',
  '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142',
  '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112']
const BY_PATTERN = new Map(PATTERNS.map((p, v) => [p, v]))

/** Larguras → valores dos símbolos (Start … DV, Stop). Lança se algum padrão não existe. */
export function code128Values(widths: readonly number[]): number[] {
  const out: number[] = []
  let i = 0
  while (i < widths.length) {
    const take = widths.length - i === 7 ? 7 : 6
    const key = widths.slice(i, i + take).join('')
    const v = BY_PATTERN.get(key)
    if (v === undefined) throw new Error(`padrão Code-128 inexistente: ${key}`)
    out.push(v)
    i += take
  }
  return out
}

/** Decodifica as larguras como um leitor faria: confere Start, DV mód. 103 e Stop; devolve o texto e os valores. */
export function decodeCode128(widths: readonly number[]): { text: string; values: number[] } {
  const values = code128Values(widths)
  if (values[values.length - 1] !== 106) throw new Error('sem Stop')
  const [start, ...rest] = values.slice(0, -1)
  const check = rest.pop()!
  const sum = rest.reduce((s, v, k) => s + v * (k + 1), start) % 103
  if (sum !== check) throw new Error(`DV não confere: ${sum} × ${check}`)
  let set = start === 103 ? 'A' : start === 104 ? 'B' : start === 105 ? 'C' : null
  if (!set) throw new Error('Start inválido')
  let text = ''
  for (const v of rest) {
    if (set === 'C') {
      if (v < 100) text += String(v).padStart(2, '0')
      else if (v === 100) set = 'B'
      else if (v === 101) set = 'A'
      else throw new Error(`valor ${v} inesperado em C`)
    } else if (set === 'A') {
      if (v < 64) text += String.fromCharCode(v + 32)
      else if (v === 99) set = 'C'
      else if (v === 100) set = 'B'
      else throw new Error(`valor ${v} inesperado em A`)
    } else {
      if (v < 96) text += String.fromCharCode(v + 32)
      else if (v === 99) set = 'C'
      else if (v === 101) set = 'A'
      else throw new Error(`valor ${v} inesperado em B`)
    }
  }
  return { text, values }
}

const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'
const cp1252 = (bytes: Buffer): string => [...bytes].map(b => (b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join('')

/** Texto de cada stream de conteúdo (uma por folha no pdfkit), linha a linha na ordem de escrita. */
export function pdfTextByStream(pdf: Buffer): string[][] {
  const s = pdf.toString('latin1')
  const pages: string[][] = []
  let i = 0
  while ((i = s.indexOf('stream', i)) !== -1) {
    if (s.slice(i - 3, i) === 'end') { i += 6; continue }
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    let txt: string
    try { txt = zlib.inflateSync(raw).toString('latin1') } catch { txt = raw.toString('latin1') }
    const lines: string[] = []
    for (const m of txt.matchAll(/\[(.*?)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
      const parts = m[1] !== undefined ? [...m[1].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]) : [m[2]]
      lines.push(parts.map(h => cp1252(Buffer.from(h, 'hex'))).join(''))
    }
    if (/\bBT\b|\bre\b/.test(txt)) pages.push(lines)
    i = end + 9
  }
  return pages
}

/** A opacidade de PREENCHIMENTO (`ca`) de cada ExtGState do PDF, por nome de recurso (`Gs1` → 0.2); sem `ca` = não mexe no preenchimento. */
function extGStateFillOpacity(s: string): Record<string, number | null> {
  const byObject: Record<string, number | null> = {}
  for (const m of s.matchAll(/(\d+) 0 obj\s*<<([^>]*\/Type \/ExtGState[^>]*)>>/g)) {
    const ca = /\/ca ([\d.]+)/.exec(m[2])
    byObject[m[1]] = ca ? Number(ca[1]) : null
  }
  const byName: Record<string, number | null> = {}
  for (const m of s.matchAll(/\/(Gs\d+) (\d+) 0 R/g)) if (m[2] in byObject) byName[m[1]] = byObject[m[2]]
  return byName
}

/**
 * Os operadores crus de cada stream de conteúdo que desenha algo (uma por folha no pdfkit), na ordem. Cada `/GsN gs` sai ANOTADO com a
 * opacidade de preenchimento real do ExtGState (`/GsN gs %ca=0.2`; `%ca=-` quando ele não mexe no preenchimento) — o `gs` de opacidade 1 que
 * a base emite para AFIRMAR o desenho opaco não é "translúcido".
 */
export function pdfContentOps(pdf: Buffer): string[] {
  const s = pdf.toString('latin1')
  const opacity = extGStateFillOpacity(s)
  const out: string[] = []
  let i = 0
  while ((i = s.indexOf('stream', i)) !== -1) {
    if (s.slice(i - 3, i) === 'end') { i += 6; continue }
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    let txt: string
    try { txt = zlib.inflateSync(raw).toString('latin1') } catch { txt = raw.toString('latin1') }
    if (/\bBT\b|\bre\b/.test(txt)) {
      out.push(txt.replace(/^\/(Gs\d+) gs$/gm, (_l, name: string) => `/${name} gs %ca=${opacity[name] ?? '-'}`))
    }
    i = end + 9
  }
  return out
}

/** Retângulos `x y w h re` (no espaço do pdfkit: origem no canto de cima, como as caixas da base). */
export const pdfRects = (ops: string): [number, number, number, number][] =>
  [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])

export interface TextRun {
  readonly text: string
  /** Recurso da fonte (ex.: "F3") e corpo em pontos. */
  readonly font: string
  readonly size: number
  /** Posição do texto no espaço do PDF (`Tm`; y de baixo para cima). */
  readonly x: number
  readonly yPdf: number
  /** Operandos da cor de preenchimento vigente ('' = a cor inicial do PDF, preto). */
  readonly color: string
  /** Há opacidade (`gs`) vigente no estado gráfico. */
  readonly translucent: boolean
}

/** Mini-intérprete: cada trecho de texto com fonte, corpo, posição, cor e opacidade VIGENTES (q/Q empilham o estado gráfico). */
export function pdfTextRuns(ops: string): TextRun[] {
  const runs: TextRun[] = []
  let gs = { color: '', translucent: false }
  const stack: (typeof gs)[] = []
  let font = '', size = 0, x = 0, y = 0
  for (const raw of ops.split('\n')) {
    const line = raw.trim()
    if (line === 'q') stack.push({ ...gs })
    else if (line === 'Q') gs = stack.pop() ?? { color: '', translucent: false }
    else if (/ (scn|sc|rg|k)$/.test(line)) gs = { ...gs, color: line.replace(/ (scn|sc|rg|k)$/, '') }
    else if (/ gs( %ca=\S+)?$/.test(line)) {
      // anotado pelo `pdfContentOps`: translúcido só com ca < 1; ExtGState sem `ca` não mexe no preenchimento; sem anotação = conservador
      const ca = /%ca=(\S+)$/.exec(line)?.[1]
      if (ca === undefined) gs = { ...gs, translucent: true }
      else if (ca !== '-') gs = { ...gs, translucent: Number(ca) < 1 }
    }
    else if (/ Tf$/.test(line)) { const m = /^\/(\S+) ([\d.]+) Tf$/.exec(line); if (m) { font = m[1]; size = Number(m[2]) } }
    else if (/ Tm$/.test(line)) { const p = line.split(/\s+/); x = Number(p[4]); y = Number(p[5]) }
    else if (/T[Jj]$/.test(line)) {
      const parts = /TJ$/.test(line) ? [...line.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => h[1]) : [(/<([0-9a-fA-F]+)>/.exec(line) ?? [])[1] ?? '']
      runs.push({ text: parts.map(h => cp1252(Buffer.from(h, 'hex'))).join(''), font, size, x, yPdf: y, color: gs.color, translucent: gs.translucent })
    }
  }
  return runs
}

/** Quantas folhas o PDF declara (`/Type /Page`, sem `/Pages`). */
export const pdfPageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page(?!s)\b/g) ?? []).length

/**
 * Os operadores de CADA folha ainda no documento (antes do `end()` — o pdfkit guarda o conteúdo da folha sem comprimir em `page.content.buffer`
 * até fechar). Para conferir o equilíbrio q/Q de um documento que a base recusa fechar (D-NE144: a falha do `sheetStart` o deixa inválido).
 */
export function liveContentOps(doc: PDFKit.PDFDocument): string[] {
  const d = doc as unknown as {
    _pageBuffer: { content: { buffer: Buffer[] } }[]
    _opacityRegistry: Record<string, [{ data: { ca?: number } }, string]>
  }
  const opacity: Record<string, string> = {}
  for (const [dictionary, name] of Object.values(d._opacityRegistry)) {
    // como o PDF final grava (6 casas — gate R11-L5: 0,9999999 era "translúcido" aqui e "opaco" no PDF)
    opacity[name] = dictionary.data.ca === undefined ? '-' : String(Math.round(dictionary.data.ca * 1e6) / 1e6)
  }
  // falha FECHADO também sem folhas ou com folhas já despejadas (gate R12-L3: depois do `end()`/`flushPages` devolvia [] e o `.every` passava vazio)
  const start = (doc as unknown as { _pageBufferStart: number })._pageBufferStart
  if (d._pageBuffer.length === 0 || start !== 0) throw new Error('oráculo: o documento não tem todas as folhas vivas (fechado ou com flushPages)')
  return d._pageBuffer.map((p, i) => {
    const ops = Buffer.concat(p.content.buffer).toString('latin1')
    // falha FECHADO (gate socrático L3): toda folha do pdfkit começa pela matriz-base; conteúdo vazio = documento já fechado ou outro pdfkit
    if (!/^1 0 0 -1 0 [\d.]+ cm\n/.test(ops)) throw new Error(`oráculo: a folha ${i + 1} não tem o conteúdo vivo (documento fechado ou pdfkit diferente)`)
    return ops.replace(/^\/(Gs\d+) gs$/gm, (_l, name: string) => `/${name} gs %ca=${opacity[name] ?? '-'}`)   // a mesma anotação do pdfContentOps
  })
}

/** Equilíbrio q/Q de uma folha (o fim e o mínimo da profundidade). */
export function qDepth(ops: string): { final: number; min: number } {
  let depth = 0
  let min = 0
  for (const raw of ops.split('\n')) {
    const l = raw.trim()
    if (l === 'q') depth++
    else if (l === 'Q') { depth--; min = Math.min(min, depth) }
  }
  return { final: depth, min }
}
