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

/** Os operadores crus de cada stream de conteúdo que desenha algo (uma por folha no pdfkit), na ordem. */
export function pdfContentOps(pdf: Buffer): string[] {
  const s = pdf.toString('latin1')
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
    if (/\bBT\b|\bre\b/.test(txt)) out.push(txt)
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
    else if (/ gs$/.test(line)) gs = { ...gs, translucent: true }
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
