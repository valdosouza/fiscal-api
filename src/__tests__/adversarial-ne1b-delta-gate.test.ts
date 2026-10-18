/// <reference types="jest" />
// RE-GATE ADVERSARIAL do DELTA da NE-1b (revisor independente, 2026-10-17 — skill `testar-adversarial.md`): ataques ao retrabalho 3d37aea da base
// de PDF (`fiscal-api/pdf`, branch `ne1b`) — `pdf/state.ts` (`isolated`), marca em linha única, `normalizeColor`, `sheetStart` isolado com o `y`
// mantido (D-NE125), `writeText` (D-NE126), Code-128 com teto/runs lineares/`code128Bars` estrito, recusa da lib como RangeError da base.
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — quando a correção
// entrar, o `it.failing` passa a FALHAR (o comportamento mudou) e vira `it` comum. Oráculos de `pdf-oracle.ts` (decodificador Code-128 próprio,
// jsQR, intérprete de trechos de texto com fonte/corpo/cor/opacidade vigentes).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as surface from '../pdf'
import {
  createPdf, writeText, drawWatermark, drawBars, drawMatrix, code128Bars, code128Symbols, qrMatrix, normalizeColor, cmToPt, CODE128,
} from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount, decodeCode128, readQr } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')
const KEY = '4126104ABC2DEF000135550010000000071000000075'
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const MARK = { font: 'Helvetica' as const, sizePt: 50, color: [0, 0, 0, 35] as const, opacity: 0.4 }
const A4_HEIGHT = 841.89
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ')
/** Profundidade final e mínima de q/Q de uma stream (balanceada = { final: 0, min: 0 }). */
const qBalance = (ops: string) => {
  let d = 0, min = 0
  for (const l of ops.split('\n')) { const t = l.trim(); if (t === 'q') d++; else if (t === 'Q') { d--; min = Math.min(min, d) } }
  return { final: d, min }
}
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string, any>
/** O estado JS do pdfkit que a família enxerga (o mesmo da lista do `isolated` + o que ficou FORA dela). */
const STATE_KEYS = ['_font', '_fontSize', '_fontSource', '_fontFamily', '_fillColor', '_wrapper', '_textOptions', 'x', 'y', '_lineGap', 'page'] as const
const snapshot = (doc: PDFKit.PDFDocument) => {
  const d = internals(doc)
  return { values: STATE_KEYS.map(k => d[k]), depth: d._ctmStack.length, ctm: [...d._ctm] }
}
const changedKeys = (doc: PDFKit.PDFDocument, before: ReturnType<typeof snapshot>) => {
  const now = snapshot(doc)
  return [...STATE_KEYS.filter((_, i) => !Object.is(now.values[i], before.values[i])),
    ...(now.depth !== before.depth ? ['_ctmStack'] : []), ...(now.ctm.join() !== before.ctm.join() ? ['_ctm'] : [])]
}

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
/** Menor número de símbolos de DADOS com os conjuntos A e C (programação dinâmica) — régua independente do "minimizar" da NT. */
function optimalAC(t: string): number {
  const isD = (c: string) => c >= '0' && c <= '9'
  const n = t.length
  const best: [number, number][] = Array.from({ length: n + 1 }, () => [Infinity, Infinity])
  best[n] = [0, 0]
  for (let i = n - 1; i >= 0; i--) {
    for (let k = 0; k < 2; k++) {
      const a = Math.min(1 + best[i + 1][0], 1 + best[i][1])
      const pair = i + 1 < n && isD(t[i]) && isD(t[i + 1]) ? 1 + best[i + 2][1] : Infinity
      const c = Math.min(pair, 1 + best[i][0])
      best[i] = [Math.min(best[i][0], a), Math.min(best[i][1], c)]
    }
  }
  return Math.min(best[0][0], best[0][1])
}
const symbolsOf = (start: number, data: number[]) => ({ start, data, check: data.reduce((s, v, k) => s + v * (k + 1), start) % 103 })

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — MEDIUM
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b re-gate do delta — achados MEDIUM', () => {
  it('[CORRIGIDO — ACHADO MEDIUM] D1 — `_lineGap` ficou FORA do `isolated`: o cabeçalho que chama `doc.lineGap(6)` no sheetStart muda o espaçamento de TODO o conteúdo da família (150 linhas: 4 folhas em vez de 2)', async () => {
    // O contrato D-NE125 convida a mexer no estilo DENTRO do sheetStart (o próprio teste do contrato faz `fillColor('red').fontSize(40)` lá);
    // `lineGap` é estado JS do pdfkit como fonte e corpo (`_lineGap`, lido pelo quebrador a cada linha) e não está na lista do `state.ts`.
    // `doc.moveDown()` do cabeçalho também lê o `_lineGap` da família (o vazamento vale nos dois sentidos).
    async function layout(headerSetsGap: boolean) {
      const w = createPdf({
        marginCm: 1, title: 'D1', creationDate: FIXED, fontRoles: ROLES,
        sheetStart: (d, sheet) => {
          writeText(d, 'title', `CABEÇALHO ${sheet}`, { x: 40, y: 30, sizePt: 10, lineBreak: false })
          if (headerSetsGap) d.lineGap(6)
          d.y = 60
        },
      })
      writeText(w.doc, 'content', lines(150), { sizePt: 9 })
      const pages = pdfContentOps(await w.end())
      return pages.map(ops => pdfTextRuns(ops).filter(r => r.text.startsWith('linha ')).slice(0, 3).map(r => Math.round(r.yPdf * 100) / 100))
    }
    expect(await layout(true)).toEqual(await layout(false))
  })

  it('[CORRIGIDO — ACHADO MEDIUM] D2 — `writeText` com `y` e SEM `x` DESCARTA todas as opções: alinhamento e largura somem, e `lineBreak: false` vira quebra de linha que ABRE FOLHA', async () => {
    // fonts.ts:writeText chama `doc.text(texto, undefined, y, opções)`; no pdfkit 0.20.2 `_initOptions(x = {}, y, options = {})` troca o `x`
    // undefined pelo default `{}`, que por ser objeto VIRA as opções — as verdadeiras (4º argumento) são jogadas fora. O contrato da porta diz
    // "Posição (x/y) e corpo (sizePt) opcionais"; com x e y juntos (ou nenhum) funciona — só a forma "só y" estraga, em silêncio.
    const w = createPdf({ marginCm: 1, title: 'D2', creationDate: FIXED, fontRoles: ROLES })
    const left = w.doc.page.margins.left
    writeText(w.doc, 'content', 'R$ 1.234,56', { x: left, y: 100, width: 150, align: 'right', sizePt: 9 })   // controle: x E y
    writeText(w.doc, 'content', 'R$ 1.234,56', { y: 130, width: 150, align: 'right', sizePt: 9 })            // só y (x corrente = a mesma margem)
    writeText(w.doc, 'content', 'X'.repeat(400), { y: 160, lineBreak: false, sizePt: 9 })                     // uma linha, cortada na borda
    writeText(w.doc, 'content', 'Y'.repeat(30), { y: w.doc.page.height - 30, lineBreak: false, sizePt: 9 })  // perto do pé: não pode abrir folha
    const pdf = await w.end()
    const runs = pdfTextRuns(pdfContentOps(pdf)[0])
    const value = runs.filter(r => r.text === 'R$ 1.234,56').map(r => r.x)
    // observado: { folhas: 2, soY: 28.35 (encostado à esquerda, largura da folha), linhasDoX: 5 }
    expect({ folhas: pdfPageCount(pdf), soY: value[1], linhasDoX: runs.filter(r => /^X+$/.test(r.text)).length })
      .toEqual({ folhas: 1, soY: value[0], linhasDoX: 1 })
  })

  it('[CORRIGIDO — ACHADO MEDIUM] D3 — sheetStart com `save()` sem `restore()`: o `isolated` fecha o `q` ERRADO — o conteúdo da família nas folhas de transbordo sai VERMELHO e TRANSLÚCIDO (o sintoma do HIGH A1, por outra porta)', async () => {
    // isolated: save() [q da base] → sheetStart: fillColor('red', 0.3); save() [q dele]; rotate → isolated.restore() fecha o q DELE; o q da base fica
    // aberto até o fim da folha, com o vermelho translúcido vigente no PDF (o JS `_fillColor` volta, o operador não). `_ctmStack` fica +1.
    // Uma conferência de profundidade da pilha antes do restore transformaria isto em recusa legível.
    let outcome: unknown
    try {
      const w = createPdf({
        marginCm: 1, title: 'D3', creationDate: FIXED, fontRoles: ROLES,
        sheetStart: (d, n) => {
          writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 30, sizePt: 10, lineBreak: false })
          if (n > 1) { d.fillColor('red', 0.3); d.save(); d.rotate(10) }                        // esqueceu o restore()
          d.y = 60
        },
      })
      writeText(w.doc, 'content', lines(150), { sizePt: 9 })
      const pages = pdfContentOps(await w.end())
      outcome = pages.map(ops => ({
        q: qBalance(ops).final,
        estilos: [...new Set(pdfTextRuns(ops).filter(r => r.text.startsWith('linha ')).map(r => `${r.color}|${r.translucent}`))],
      }))
    } catch (e) {
      outcome = /base de PDF/.test((e as Error).message) ? 'recusa-legivel' : `erro:${(e as Error).message}`
    }
    // observado: [{ q: 0, estilos: ['|false'] }, { q: 1, estilos: ['1 0 0|true'] }]
    expect(['recusa-legivel', [{ q: 0, estilos: ['|false'] }, { q: 0, estilos: ['|false'] }]]).toContainEqual(outcome)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — LOW
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b re-gate do delta — achados LOW', () => {
  it('[CORRIGIDO — ACHADO LOW] D4 — sheetStart que termina noutra folha (`switchToPage` sem voltar): `doc.page` fica fora do `isolated` — o q/Q atravessa folhas (folha 1 com `Q` sobrando) e o conteúdo da folha 2 é escrito POR CIMA da folha 1, que fica em branco', async () => {
    async function build(switchBack: boolean): Promise<unknown> {
      try {
        const w = createPdf({
          marginCm: 1, title: 'D4', creationDate: FIXED, fontRoles: ROLES,
          sheetStart: (d, n) => {
            if (n === 1) return
            const y = d.y
            d.switchToPage(n - 2)                                                                  // "continua na folha seguinte" na anterior
            writeText(d, 'content', 'continua na folha seguinte', { x: 40, y: d.page.height - 40, sizePt: 7, lineBreak: false })
            if (switchBack) d.switchToPage(n - 1)
            d.y = y
          },
        })
        writeText(w.doc, 'content', lines(150), { sizePt: 9 })
        const pdf = await w.end()
        return { folhas: pdfPageCount(pdf), q: pdfContentOps(pdf).map(o => qBalance(o).final) }
      } catch (e) {
        return /base de PDF/.test((e as Error).message) ? 'recusa-legivel' : `erro:${(e as Error).message}`
      }
    }
    // observado sem voltar: { folhas: 2, q: [-1] } — só a folha 1 tem conteúdo (as duas metades sobrepostas) e um `Q` a mais; sem repor o y o
    // mesmo sheetStart dá 72 folhas
    const control = await build(true)
    expect(control).toEqual({ folhas: 2, q: [0, 0] })
    expect(['recusa-legivel', control]).toContainEqual(await build(false))
  })

  it('[CORRIGIDO — ACHADO LOW] D5 — o `y` em que o sheetStart PARA não é conferido: NaN estoura como Error genérico do pdfkit; um rodapé escrito por último (y no pé) faz CADA linha abrir folha (150 linhas → 151 folhas)', async () => {
    // D-NE125: "o y em que ele PARAR fica sendo o começo do conteúdo". Um sheetStart que desenha cabeçalho E rodapé (o rodapé por último) deixa o
    // y abaixo da área útil; o quebrador de linha emite uma linha e abre folha, de novo e de novo. Conferir "finito e com espaço para 1 linha".
    async function attempt(tail: (d: PDFKit.PDFDocument) => void): Promise<string> {
      try {
        const w = createPdf({
          marginCm: 1, title: 'D5', creationDate: FIXED, fontRoles: ROLES,
          sheetStart: (d, n) => { writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 30, sizePt: 10, lineBreak: false }); tail(d) },
        })
        writeText(w.doc, 'content', lines(150), { sizePt: 9 })
        const pdf = await w.end()
        return `folhas:${pdfPageCount(pdf)}`
      } catch (e) {
        return /base de PDF/.test((e as Error).message) ? 'recusa-legivel' : `erro:${(e as Error).message}`
      }
    }
    const nan = await attempt(d => { d.y = NaN })
    const footer = await attempt(d => writeText(d, 'fixed', 'emitido pelo sistema', { x: 40, y: d.page.height - 30, sizePt: 6, lineBreak: false }))
    expect({ nan, footer }).toEqual({ nan: 'recusa-legivel', footer: expect.stringMatching(/^(recusa-legivel|folhas:[23])$/) })
  })

  it('[TRATADO — ACHADO LOW] D6 — texto em COLUNAS nas folhas de transbordo reabria a 2ª coluna no topo da margem, POR CIMA do espaço do cabeçalho: a porta `writeText` RECUSA `columns` (lista fechada de opções — LIMITE CONHECIDO; a NE-5 decide se o DANFE precisa de colunas)', async () => {
    // pdfkit: LineWrapper.nextSection() fixa `startY = page.margins.top` ao abrir folha; a 2ª coluna recomeçava nele (observado: [206.1, 34.5, 34.5]).
    const reserve = 200
    const w = createPdf({
      marginCm: 1, title: 'D6', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 30, sizePt: 20, lineBreak: false }); d.y = reserve },
    })
    expect(() => writeText(w.doc, 'content', lines(400), { sizePt: 9, columns: 2 } as any)).toThrow(/opção de texto "columns" fora da porta/)
    expect(pdfPageCount(await w.end())).toBe(1)
  })

  it('[CORRIGIDO — ACHADO LOW] D7 — o isolamento é só de SAÍDA: o cabeçalho sem corpo explícito herda o corpo corrente da família — 12 pt na folha 1, 9 pt na folha de transbordo (cabeçalho "repetido" diferente)', async () => {
    const w = createPdf({
      marginCm: 1, title: 'D7', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 30, lineBreak: false }); d.y = 60 },
    })
    writeText(w.doc, 'content', lines(150), { sizePt: 9 })
    const pages = pdfContentOps(await w.end())
    const sizes = pages.flatMap(ops => pdfTextRuns(ops).filter(r => r.text.startsWith('CABEÇALHO')).map(r => r.size))
    expect(new Set(sizes).size).toBe(1)
  })

  it('[CORRIGIDO — ACHADO LOW] D8 — a passada por folha NÃO roda isolada: um encadeado (`continued`) pendente da família desloca e reembrulha o "FOLHA n/N", e a opacidade do fim da folha vale para ele mesmo com `fillColor` explícito', async () => {
    // (a) `_initOptions` funde o `_textOptions` vivo (width 200) e o `_wrapper` vivo leva o `continuedX` → x 419,25 em vez de 400; um `isolated`
    // na passada fecharia isto. (b) a passada escreve no FIM da stream da folha, com o estado gráfico que o conteúdo deixou: `fillColor('black')`
    // sem opacidade não emite `gs` → o rótulo herda o ca 0,2 (só um `q` na abertura da folha + `Q` antes da passada dá estado limpo).
    const w = createPdf({ marginCm: 1, title: 'D8', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'texto', { x: 40, y: 200, sizePt: 9 })
    w.doc.fillColor('black', 0.2)
    writeText(w.doc, 'content', 'Obs: ', { x: 40, y: 300, width: 200, continued: true, sizePt: 9 })     // encadeado que a família não fechou
    const pdf = await w.end(d => {
      d.fillColor('black')
      writeText(d, 'title', 'FOLHA 1/1', { x: 400, y: 20, sizePt: 8, lineBreak: false })
    })
    const label = pdfTextRuns(pdfContentOps(pdf)[0]).find(r => r.text === 'FOLHA 1/1')!
    expect({ x: label.x, translucido: label.translucent }).toEqual({ x: 400, translucido: false })
  })

  it('[CORRIGIDO — ACHADO LOW] D9 — o thenable RECUSADO não é observado: a promessa de um sheetStart/passada assíncrono que depois rejeita vira `unhandledRejection` (no Node 20 derruba o processo do serviço)', () => {
    let observed = false
    const thenable = { then: () => { observed = true } }
    expect(() => createPdf({ marginCm: 1, title: 'D9', sheetStart: () => thenable as any })).toThrow(/síncrono/)
    expect(observed).toBe(true)
  })

  it('[CORRIGIDO — ACHADO LOW] D10 — CMYK com BURACO (`[0, , 0, 35]`) passa no `normalizeColor` (o `every` pula buracos) e grava `0  0 0.35 scn` — 3 operandos para DeviceCMYK', async () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [0, , 0, 35] as unknown as [number, number, number, number]
    const w = createPdf({ marginCm: 1, title: 'D10', creationDate: FIXED })
    let refused = false
    try { drawBars(w.doc, code128Bars(code128Symbols('1234')), { x: 20, y: 20, width: 200, height: 20 }, { color: sparse }) } catch (e) { refused = e instanceof RangeError }
    const scn = (pdfContentOps(await w.end())[0] ?? '').split('\n').filter(l => / scn$/.test(l))
    expect(refused || scn.every(l => l.trim().split(/\s+/).length === 5)).toBe(true)
  })

  it('[CORRIGIDO — ACHADO LOW] D11 — ângulo finito gigante (|a| > ~5,7e307) virava Infinity em radianos (Error genérico): agora é REDUZIDO módulo 360 — aceito, sem erro, pilha intacta (o ataque verde dos ângulos extremos já exigia aceitar 1e300)', async () => {
    const { doc, end } = createPdf({ marginCm: 1, title: 'D11', creationDate: FIXED })
    const depth = internals(doc)._ctmStack.length
    let outcome: string
    try { drawWatermark(doc, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: 'gray', angleDeg: 1e308 }); outcome = 'aceitou' } catch (e) {
      outcome = e instanceof RangeError ? 'recusa-legivel' : `erro:${(e as Error).message}`
    }
    expect(internals(doc)._ctmStack.length).toBe(depth)
    expect(outcome).toBe('aceitou')
    expect(pdfTextRuns(pdfContentOps(await end())[0]).map(r => r.text)).toEqual(['SEM VALOR FISCAL'])
  })

  it('[CORRIGIDO — ACHADO LOW] D12 — `writeText` só confere x/y/corpo: `rotation: NaN` deixa `q` aberto e a pilha da matriz +1 (Error genérico); `horizontalScaling: 1e-7` grava "1e-7 Tz" (expoente não é número de PDF)', async () => {
    const w = createPdf({ marginCm: 1, title: 'D12', creationDate: FIXED, fontRoles: ROLES })
    const depth = internals(w.doc)._ctmStack.length
    let rotation: string
    try { writeText(w.doc, 'content', 'abc', { x: 40, y: 40, rotation: NaN } as any); rotation = 'aceitou' } catch (e) {
      rotation = e instanceof RangeError && internals(w.doc)._ctmStack.length === depth ? 'recusa-limpa' : 'recusa-suja'
    }
    let scalingRefused = false
    try { writeText(w.doc, 'content', 'abc', { x: 40, y: 80, horizontalScaling: 1e-7 } as any) } catch (e) { scalingRefused = e instanceof RangeError }
    const tz = (pdfContentOps(await w.end())[0] ?? '').split('\n').filter(l => / Tz$/.test(l))   // as duas recusadas: nada desenhado
    expect({ rotation, tz: scalingRefused || tz.every(l => /^-?\d*\.?\d+ Tz$/.test(l.trim())) }).toEqual({ rotation: 'recusa-limpa', tz: true })
  })

  it('[CORRIGIDO — ACHADO LOW] D13 — data com ano fora de 0000–9999 passa: o pdfkit corta o ano em 4 dígitos — 12026-10-17 sai "D:2026…" no PDF (data errada calada)', async () => {
    let outcome: string
    try {
      const pdf = await createPdf({ marginCm: 1, title: 'D13', creationDate: new Date('+012026-10-17T00:00:00Z') }).end()
      outcome = /\(D:(\d{14})Z\)/.exec(pdf.toString('latin1'))?.[1] ?? 'sem-data'
    } catch (e) { outcome = e instanceof RangeError ? 'recusa-legivel' : `erro:${(e as Error).message}` }
    expect(outcome).toBe('recusa-legivel')
  })

  it('[CORRIGIDO — ACHADO LOW] D14 — `writeText` aceita papel registrado FORA da base (`doc.registerFont` direto): com Symbol, "abc" sai em letras gregas — a garantia WinAnsi da D-NE126 confere o registro do pdfkit, não o da base', async () => {
    const w = createPdf({ marginCm: 1, title: 'D14', creationDate: FIXED, fontRoles: ROLES })
    w.doc.registerFont('simbolo', 'Symbol')
    let outcome: string
    try { writeText(w.doc, 'simbolo', 'abc', { x: 40, y: 40 }); outcome = 'aceitou' } catch (e) { outcome = e instanceof RangeError ? 'recusou' : 'erro' }
    const pdf = await w.end()
    expect({ outcome, symbol: /\/BaseFont \/Symbol/.test(pdf.toString('latin1')) }).toEqual({ outcome: 'recusou', symbol: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b re-gate do delta — o `isolated` do sheetStart resistiu', () => {
  it('sheetStart que LANÇA no meio (depois de mudar fonte, corpo, cor, opacidade, traço, matriz e abrir encadeado): o erro sobe, o estado JS e a pilha voltam, o q/Q da folha fecha e o documento ainda fecha', async () => {
    const w = createPdf({
      marginCm: 1, title: 'R1', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        if (n === 1) return
        d.fillColor('red', 0.3).fontSize(40).font('Courier').lineWidth(7).strokeOpacity(0.1).rotate(33)
        writeText(d, 'title', 'cabeçalho ', { continued: true, width: 100 })
        throw new Error('falhou no cabeçalho')
      },
    })
    const { doc } = w
    writeText(doc, 'content', 'antes', { x: cmToPt(1), y: 40, sizePt: 9 })                       // x da margem = o x que a folha nova recebe
    doc.fillColor('#333333')
    const before = snapshot(doc)
    expect(() => writeText(doc, 'content', lines(150))).toThrow('falhou no cabeçalho')
    // y fica com quem o sheetStart deixou (D-NE125), page é a folha que o transbordo abriu — o resto volta
    expect(changedKeys(doc, before).filter(k => k !== 'y' && k !== 'page' && k !== '_ctm')).toEqual([])
    expect(internals(doc)._ctm).toEqual([1, 0, 0, -1, 0, doc.page.height])                    // a matriz-base da folha nova, sem a rotação
    const pages = pdfContentOps(await w.end())
    expect(pages.map(qBalance)).toEqual(pages.map(() => ({ final: 0, min: 0 })))
  })

  it('sheetStart com traço, opacidade e rotação SEM salvar (sem save desbalanceado): nada chega ao conteúdo das folhas de transbordo — texto opaco, na cor da família, matriz-base', async () => {
    const w = createPdf({
      marginCm: 1, title: 'R2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        d.strokeColor('red').strokeOpacity(0.2).lineWidth(9).dash(3, {}).fillColor([0, 100, 0, 0], 0.3).rotate(25)
        d.rect(10, 10, 50, 50).stroke()
        writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 30, sizePt: 10, lineBreak: false })
        d.y = 60
      },
    })
    writeText(w.doc, 'content', lines(150), { sizePt: 9 })
    expect(internals(w.doc)._ctm).toEqual([1, 0, 0, -1, 0, w.doc.page.height])
    const pages = pdfContentOps(await w.end())
    expect(pages).toHaveLength(2)
    for (const ops of pages) {
      expect(qBalance(ops)).toEqual({ final: 0, min: 0 })
      const runs = pdfTextRuns(ops).filter(r => r.text.startsWith('linha '))
      expect([...new Set(runs.map(r => `${r.size}|${r.color}|${r.translucent}`))]).toEqual(['9||false'])
      expect(Math.min(...runs.map(r => r.x))).toBeCloseTo(cmToPt(1), 3)
    }
  })

  it('encadeado PENDENTE nos dois sentidos: o `continued` que o cabeçalho deixa aberto não captura o texto da família, e o `continued` da família (largura 200) não entra no cabeçalho — a cadeia da família atravessa a quebra inteira', async () => {
    const w = createPdf({
      marginCm: 1, title: 'R3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        drawWatermark(d, 'SEM VALOR FISCAL', MARK)
        writeText(d, 'title', `CABEÇALHO ${n}: `, { x: 300, y: 20, width: 250, align: 'right', continued: true, sizePt: 8 })   // fica pendente
        d.y = 60
      },
    })
    const { doc } = w
    writeText(doc, 'content', 'Informações complementares: ', { x: 40, y: 700, width: 200, continued: true, sizePt: 9 })
    writeText(doc, 'title', words(300), { continued: true, sizePt: 9 })
    writeText(doc, 'content', ' FIM.', { sizePt: 9 })
    const pages = pdfContentOps(await w.end())
    expect(pages).toHaveLength(2)
    const headerX = pages.map(ops => pdfTextRuns(ops).filter(r => r.text.startsWith('CABEÇALHO')).map(r => r.x))
    expect(headerX[0]).toHaveLength(1)
    expect(headerX[1][0]).toBeGreaterThan(headerX[0][0] - 10)                                     // alinhado à direita nos 250 dele, nas duas folhas
    const family = pages.flatMap(ops => pdfTextRuns(ops).filter(r => !r.text.startsWith('CABEÇALHO') && r.text !== 'SEM VALOR FISCAL'))
    expect(Math.max(...family.map(r => r.x))).toBeLessThan(40 + 200)                              // nenhum trecho da família foi parar na cadeia do cabeçalho
    expect([...new Set(family.map(r => `${r.size}|${r.color}|${r.translucent}`))]).toEqual(['9||false'])
    expect(Math.min(...pdfTextRuns(pages[1]).filter(r => family.includes(r)).map(r => A4_HEIGHT - r.yPdf))).toBeGreaterThanOrEqual(60)
    expect(family.map(r => r.text).join('')).toContain('FIM.')
    expect(family.map(r => r.text).join(' ')).toContain('palavra299')
  })

  it('sheetStart que DEVOLVE o próprio doc (`d => d.text(...)`) não é tomado por assíncrono (o PDFDocument não é thenable)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R4', creationDate: FIXED, sheetStart: d => d.text('', 10, 10) as unknown as void })
    w.doc.addPage()
    expect(pdfPageCount(await w.end(d => d.text('x', 10, 10, { lineBreak: false }) as unknown as void))).toBe(2)
  })
})

describe('NE-1b re-gate do delta — marca d\'água e cor resistiram', () => {
  it('ângulos 0/90/360/−720/1e300, 20.000 caracteres a 1000 pt e quebras de linha no texto: UMA folha, UM trecho, a folha corrente e TODO o estado da família (inclusive o encadeado vivo) intactos, q/Q balanceado', async () => {
    const cases: [number, string, number][] = [
      [0, 'SEM VALOR FISCAL', 50], [90, 'SEM VALOR FISCAL', 50], [360, 'SEM VALOR FISCAL', 50], [-720, 'CANCELADA', 140],
      [1e300, 'SEM VALOR FISCAL', 50], [-45, 'X'.repeat(20_000), 1000], [-45, 'A\nB\r\nC D\tE', 80],
    ]
    for (const [angle, text, size] of cases) {
      const w = createPdf({ marginCm: 1, title: 'R5', creationDate: FIXED, fontRoles: ROLES })
      writeText(w.doc, 'content', 'antes ', { x: 40, y: 40, width: 300, continued: true, sizePt: 9 })
      const before = snapshot(w.doc)
      drawWatermark(w.doc, text, { font: 'Helvetica', sizePt: size, color: 'gray', opacity: 0.3, angleDeg: angle })
      expect([angle, changedKeys(w.doc, before)]).toEqual([angle, []])
      writeText(w.doc, 'content', 'depois')
      const pdf = await w.end()
      expect([angle, pdfPageCount(pdf)]).toEqual([angle, 1])
      const ops = pdfContentOps(pdf)[0]
      expect([angle, qBalance(ops)]).toEqual([angle, { final: 0, min: 0 }])
      const runs = pdfTextRuns(ops)
      expect([angle, runs.filter(r => r.size === size).length]).toEqual([angle, 1])
      expect(runs.filter(r => r.size === 9).map(r => r.translucent)).toEqual(runs.filter(r => r.size === 9).map(() => false))
    }
  })

  it('cor no limite: CMYK 0 e 100 viram "0 0 0 0"/"1 1 1 1"; hex de 3 e 6 em maiúsculas = minúsculas; −0 vira "0"; nomes com caixa diferente, hex malformado, espaços e CMYK fora da faixa são RECUSADOS', async () => {
    const operands = async (color: surface.PdfColor) => {
      const w = createPdf({ marginCm: 1, title: 'R6', creationDate: FIXED })
      drawBars(w.doc, code128Bars(code128Symbols('1234')), { x: 20, y: 20, width: 200, height: 20 }, { color })
      return pdfContentOps(await w.end())[0].split('\n').filter(l => / scn$/.test(l)).map(l => l.trim())
    }
    expect(await operands([0, 0, 0, 0])).toEqual(['0 0 0 0 scn'])
    expect(await operands([100, 100, 100, 100])).toEqual(['1 1 1 1 scn'])
    expect(await operands([-0, 0, 0, 35])).toEqual(['0 0 0 0.35 scn'])
    expect(await operands('#ABC')).toEqual(await operands('#aabbcc'))
    expect(await operands('#AABBCC')).toEqual(await operands('#aabbcc'))
    expect(await operands('black')).toEqual(['0 0 0 scn'])
    const bad: unknown[] = ['Gray', 'BLACK', 'Black', '#abcd', '#ggg', ' #fff', '#fff ', '#fff\n', '', 'transparent', 'constructor', [0, 0, 0],
      [0, 0, 0, 0, 0], [0, 0, 0, '35'], [0, 0, 0, 100.0001], [0, 0, 0, -0.0001], [0, 0, 0, Infinity], null, undefined, 0x000000]
    for (const c of bad) expect(() => normalizeColor(c as any)).toThrow(RangeError)
  })
})

describe('NE-1b re-gate do delta — Code-128, QR e a lib resistiram', () => {
  it('3.000 textos de 21 a 120 caracteres (runs longos de dígito, a parte nova): o leitor lê o texto, o DV é o nosso e o comprimento é o ÓTIMO A/C; acima do limite da lib, RangeError da base sem eco', () => {
    const rnd = seeded(2026)
    const AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let drawn = 0
    for (let k = 0; k < 3000; k++) {
      const len = 21 + Math.floor(rnd() * 100)
      const digitBias = rnd()
      const t = Array.from({ length: len }, () => (rnd() < digitBias ? String(Math.floor(rnd() * 10)) : AN[10 + Math.floor(rnd() * 26)])).join('')
      const s = code128Symbols(t)
      if (s.data.length !== optimalAC(t)) throw new Error(`não ótimo: ${t}`)
      let bars
      try { bars = code128Bars(s) } catch (e) {
        if (!(e instanceof RangeError) || /bwipp|[0-9A-Z]{8,}/.test((e as Error).message)) throw e
        continue
      }
      const decoded = decodeCode128(bars.widths)
      if (decoded.text !== t || decoded.values.join() !== [s.start, ...s.data, s.check, 106].join()) throw new Error(`leitura errada: ${t}`)
      drawn++
    }
    expect(drawn).toBeGreaterThan(2500)
  })

  it('o teto exportado (128) é maior que o da lib para texto de LETRAS (a lib aceita até 124 símbolos de dados): 125–128 letras dão recusa LEGÍVEL da base, nunca barras truncadas', () => {
    for (const n of [124, 125, 128]) {
      const s = code128Symbols('A'.repeat(n))
      if (n === 124) { expect(decodeCode128(code128Bars(s).widths).text).toBe('A'.repeat(124)); continue }
      let err: unknown
      try { code128Bars(s) } catch (e) { err = e }
      expect([n, err instanceof RangeError, /bwipp|AAAA/.test((err as Error).message), (err as any).cause]).toEqual([n, true, false, undefined])
    }
  })

  it('`code128Bars` com símbolos VÁLIDOS feitos à mão: 200 pares em C → recusa legível; 257 dados → recusa da base; troca de conjunto redundante no fim → as barras leem o MESMO texto (DV e Stop conferidos)', () => {
    const big = symbolsOf(CODE128.START_C, Array.from({ length: 200 }, (_, i) => i % 100))
    expect(() => code128Bars(big)).toThrow(RangeError)
    expect(() => code128Bars(symbolsOf(CODE128.START_C, Array.from({ length: 257 }, (_, i) => i % 100)))).toThrow(/símbolos inválidos/)
    expect(decodeCode128(code128Bars(symbolsOf(CODE128.START_C, [12, 34, CODE128.CODE_A_FROM_C])).widths).text).toBe('1234')
    expect(decodeCode128(code128Bars(symbolsOf(CODE128.START_A, [CODE128.CODE_C_FROM_A, 12, 34])).widths).text).toBe('1234')
  })

  it('QR acima da capacidade: recusa RÁPIDA, RangeError da base, sem eco do texto nem da lib e sem `cause`', () => {
    for (const n of [2954, 20_000, 2_000_000]) {
      const t0 = Date.now()
      let err: unknown
      try { qrMatrix(`SEGREDO-${'x'.repeat(n)}`, { ecLevel: 'L' }) } catch (e) { err = e }
      expect([n, err instanceof RangeError, /SEGREDO|bwipp|xxxx/.test((err as Error).message), (err as any).cause]).toEqual([n, true, false, undefined])
      expect(Date.now() - t0).toBeLessThan(3000)
    }
  })

  it('a recusa por tamanho não engole defeito: matriz e barras do mesmo PDF continuam lidas de volta depois de recusas na mesma montagem', async () => {
    const url = `https://www.fazenda.pr.gov.br/nfce/qrcode?p=${KEY}|2|1|1|ABCDEF0123456789`
    const w = createPdf({ marginCm: 1, title: 'R11', creationDate: FIXED })
    expect(() => qrMatrix('x'.repeat(5000), { ecLevel: 'M' })).toThrow(RangeError)
    expect(() => code128Bars(code128Symbols('A'.repeat(128)))).toThrow(RangeError)
    const m = qrMatrix(url, { ecLevel: 'M' })
    drawMatrix(w.doc, m, { x: cmToPt(2), y: cmToPt(2), size: cmToPt(3) })
    expect(readQr(m)).toBe(url)
    expect(decodeCode128(code128Bars(code128Symbols(KEY)).widths).text).toBe(KEY)
    expect(pdfPageCount(await w.end())).toBe(1)
  })
})

describe('NE-1b re-gate do delta — reprodutibilidade e cercas resistiram', () => {
  it('a MESMA data dá os MESMOS bytes com tudo junto: marca no sheetStart E na passada, cabeçalho com y reservado, barras, QR, transbordo e "FOLHA n/N"; outra data muda os bytes', async () => {
    const build = async (creationDate: Date) => {
      const w = createPdf({
        marginCm: 0.5, title: 'R12', creationDate, fontRoles: ROLES,
        sheetStart: (d, n) => {
          drawWatermark(d, 'SEM VALOR FISCAL', MARK)
          writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 20, sizePt: 10, lineBreak: false })
          d.y = 60
        },
      })
      drawBars(w.doc, code128Bars(code128Symbols(KEY)), { x: cmToPt(0.5), y: cmToPt(2.5), width: cmToPt(11.5), height: cmToPt(0.8) })
      drawMatrix(w.doc, qrMatrix(`https://exemplo.sefaz/consulta?chave=${KEY}`, { ecLevel: 'M' }), { x: cmToPt(17), y: cmToPt(2.5), size: cmToPt(2) })
      writeText(w.doc, 'content', lines(200), { x: 30, y: 200, sizePt: 9 })
      return w.end((d, { sheet, total }) => {
        drawWatermark(d, 'CANCELADA', { ...MARK, color: 'gray', angleDeg: 30 })
        writeText(d, 'title', `FOLHA ${sheet}/${total}`, { x: 450, y: 10, sizePt: 8, lineBreak: false })
      })
    }
    const a = await build(FIXED)
    const b = await build(new Date(FIXED.getTime()))
    expect(pdfPageCount(a)).toBe(3)
    expect(a.equals(b)).toBe(true)
    expect(a.equals(await build(new Date(FIXED.getTime() + 1000)))).toBe(false)
  })

  it('o `isolated` não sai pela superfície `fiscal-api/pdf` e `pdf/state.ts` só é importado por `pdf/draw.ts` e `pdf/pdf-writer.ts`', () => {
    expect(Object.keys(surface)).not.toContain('isolated')
    const SRC = path.resolve(__dirname, '..')
    const STATE = path.join(SRC, 'pdf', 'state.ts')
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' ? [] : walk(path.join(dir, d.name))) : /\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [path.join(dir, d.name)] : [])
    const importsState = (file: string): boolean => {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      let hit = false
      const visit = (n: ts.Node): void => {
        let spec: string | undefined
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text
        else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
          && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) spec = n.arguments[0].text
        if (spec && spec.startsWith('.')) {
          const base = path.resolve(path.dirname(file), spec)
          if ([`${base}.ts`, path.join(base, 'index.ts'), base].includes(STATE)) hit = true
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
      return hit
    }
    const importers = walk(SRC).filter(importsState).map(f => path.relative(SRC, f).replace(/\\/g, '/')).sort()
    // D-NE129 (Valdo 2026-10-17): a porta de MEDIDA (`measureText`, em fonts.ts) mede no papel/corpo pedidos SEM mexer no estado da família
    expect(importers).toEqual(['pdf/draw.ts', 'pdf/fonts.ts', 'pdf/pdf-writer.ts'])
  })
})
