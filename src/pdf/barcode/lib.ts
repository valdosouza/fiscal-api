/**
 * A ÚNICA porta para a lib de símbolos (D-NE119: bwip-js 4.11.4, versão EXATA no package.json). Nada fora deste arquivo importa `bwip-js`
 * (cerca `pdf-cerca.test.ts`); trocar a lib = trocar este arquivo.
 *
 * D-NE118: o Code-128 entra em modo `raw` — os SÍMBOLOS são decididos pela peça `code128Symbols` (a regra da NT); a lib só converte em
 * larguras de barra/espaço e acrescenta o dígito de verificação e o Stop. A tipagem da lib não declara a opção `raw` — vai pela forma de texto.
 */
import * as bwipjs from 'bwip-js'

type LinearRaw = Array<{ sbs?: number[] }>
type MatrixRaw = Array<{ pixs?: number[]; pixx?: number; pixy?: number }>

/**
 * Recusa da lib por regra de ENTRADA ("bwipp.<código>…", ex.: texto grande demais para o símbolo) vira RangeError da BASE — mensagem própria,
 * sem o texto nem a mensagem da lib (gate adversarial A12b); qualquer outro erro da lib sobe como está (defeito, não entrada).
 */
function callLib<T>(call: () => T): T {
  try {
    return call()
  } catch (e) {
    if (/^bwipp\./.test(e instanceof Error ? e.message : '')) {
      throw new RangeError('a lib de símbolos recusou a entrada (grande demais ou fora do que o símbolo aceita)')
    }
    throw e
  }
}

/** Larguras (barra, espaço, barra, …) do Code-128 a partir do Start + dados; a lib acrescenta o DV e o Stop. */
export function code128Widths(startAndData: readonly number[]): number[] {
  const text = startAndData.map(v => `^${String(v).padStart(3, '0')}`).join('')
  const out = callLib(() => bwipjs.raw('code128', text, 'raw')) as unknown as LinearRaw
  const sbs = out?.[0]?.sbs
  if (!Array.isArray(sbs) || sbs.length === 0 || !sbs.every(w => Number.isInteger(w) && w > 0)) {
    throw new Error('a lib de símbolos não devolveu as larguras do Code-128')
  }
  return [...sbs]
}

/** Matriz QR (linha a linha, `true` = módulo escuro) — o nível de correção vem de quem chama. */
export function qrModules(text: string, ecLevel: 'L' | 'M' | 'Q' | 'H'): boolean[][] {
  if (!['L', 'M', 'Q', 'H'].includes(ecLevel)) throw new RangeError('nível de correção do QR inválido')   // a string de opções da lib não aceita mais nada
  const out = callLib(() => bwipjs.raw('qrcode', text, `eclevel=${ecLevel}`)) as unknown as MatrixRaw
  const m = out?.[0]
  const size = m?.pixx
  if (!m || !Array.isArray(m.pixs) || !Number.isInteger(size) || size! <= 0 || m.pixy !== size || m.pixs.length !== size! * size!) {
    throw new Error('a lib de símbolos não devolveu a matriz do QR')
  }
  const rows: boolean[][] = []
  for (let r = 0; r < size!; r++) rows.push(m.pixs.slice(r * size!, (r + 1) * size!).map(v => v !== 0))
  return rows
}
