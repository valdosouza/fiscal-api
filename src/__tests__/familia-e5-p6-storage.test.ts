import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import { FsFiscalStorage, FiscalFileConflictError, type FiscalFileKey } from '../storage/fiscal-storage'
import { ErrorCodes, ErrorCatalog } from '../errors/error-codes'
import * as barrel from '../index'

/** FAMILIA.E5.P6.T1 — D-NE41/RF-NFE-73: o arquivo fiscal é de gravação única (pelo nome, em todos os dias da série). */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-s30-'))
const C = '12345678000195'
const key = (o: Partial<FiscalFileKey> = {}): FiscalFileKey => ({ cnpj: C, kind: 'nfe', serie: 1, environment: 'H', zone: 'America/Sao_Paulo', ...o })
const DAY1 = new Date('2026-11-24T15:00:00Z')
const DAY2 = new Date('2026-11-25T15:00:00Z')
const leftovers = (dir: string): string[] => {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...leftovers(p)); else if (e.name.endsWith('.tmp')) out.push(p)
  }
  return out
}
const serieDir = (o: Partial<FiscalFileKey> = {}) => path.join(root, o.cnpj ?? C, (o.environment ?? 'H') === 'H' ? 'H' : '.', o.kind ?? 'nfe', String(o.serie ?? 1))

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })
const aged = (f: string) => { const old = new Date(Date.now() - 60_000); fs.utimesSync(f, old, old) }

describe('FsFiscalStorage.save — gravação única (T1)', () => {
  // sonda: sem link físico a trava não existe (S4) — o teste diz isso em vez de falhar por outro motivo
  it('o disco do teste aceita link físico (premissa da trava)', () => {
    const a = path.join(root, 'sonda-a'); const b = path.join(root, 'sonda-b')
    fs.writeFileSync(a, 'x'); fs.linkSync(a, b)
    expect(fs.readFileSync(b, 'utf8')).toBe('x')
    expect(() => fs.linkSync(a, b)).toThrow(/EEXIST/)
  })

  it('primeira gravação grava; repetida com os MESMOS bytes devolve o caminho e não toca em nada', () => {
    const st = new FsFiscalStorage(root)
    const p = st.save(key(), 'A-nfe.xml', '<a>ç</a>', DAY1)
    const before = fs.statSync(p)
    const again = st.save(key(), 'A-nfe.xml', '<a>ç</a>', DAY1)
    expect(again).toBe(p)
    expect(fs.statSync(again).ino).toBe(before.ino)
    expect(st.read(p)).toBe('<a>ç</a>')
    expect(leftovers(root)).toEqual([])
  })

  it('repetida com bytes DIFERENTES = conflito nomeado, arquivo intacto, sem tmp sobrando, sem o conteúdo na mensagem', () => {
    const st = new FsFiscalStorage(root)
    const p = st.save(key(), 'B-nfe.xml', '<b>original</b>', DAY1)
    let err: unknown
    try { st.save(key(), 'B-nfe.xml', '<b>OUTRO-SEGREDO</b>', DAY1) } catch (e) { err = e }
    expect(err).toBeInstanceOf(FiscalFileConflictError)
    expect((err as FiscalFileConflictError).code).toBe(ErrorCodes.FISCAL_FILE_CONFLICT)
    expect((err as Error).message).toContain(p)
    expect((err as Error).message).not.toContain('OUTRO-SEGREDO')
    expect(st.read(p)).toBe('<b>original</b>')
    expect(leftovers(root)).toEqual([])
    expect(ErrorCatalog[ErrorCodes.FISCAL_FILE_CONFLICT]).toMatch(/gravação única/)
  })

  it('bytes, não texto: BOM e fim de linha diferentes são conflito', () => {
    const st = new FsFiscalStorage(root)
    st.save(key(), 'C-nfe.xml', '<c>\n</c>', DAY1)
    expect(() => st.save(key(), 'C-nfe.xml', '<c>\r\n</c>', DAY1)).toThrow(FiscalFileConflictError)
    expect(() => st.save(key(), 'C-nfe.xml', '﻿<c>\n</c>', DAY1)).toThrow(FiscalFileConflictError)
    expect(st.save(key(), 'C-nfe.xml', '<c>\n</c>', DAY1)).toContain('C-nfe.xml')
  })

  it('S5: o mesmo nome noutro dia da série — igual devolve o caminho do dia antigo; diferente é conflito; nenhum segundo arquivo', () => {
    const st = new FsFiscalStorage(root)
    const p1 = st.save(key(), 'D-nfe.xml', '<d/>', DAY1)
    expect(st.save(key(), 'D-nfe.xml', '<d/>', DAY2)).toBe(p1)
    expect(() => st.save(key(), 'D-nfe.xml', '<d2/>', DAY2)).toThrow(FiscalFileConflictError)
    expect(fs.existsSync(path.join(path.dirname(path.dirname(p1)), '25', 'D-nfe.xml'))).toBe(false)
  })

  it('outra série, outro tipo, outro ambiente e outro CNPJ têm o seu espaço de nomes', () => {
    const st = new FsFiscalStorage(root)
    st.save(key(), 'E-nfe.xml', '<e/>', DAY1)
    for (const o of [{ serie: 2 }, { kind: 'nfce' as const }, { environment: 'P' as const }, { cnpj: '98765432000198' }]) {
      expect(() => st.save(key(o), 'E-nfe.xml', '<outro/>', DAY1)).not.toThrow()
    }
  })

  it('nome diferente para o mesmo fato NÃO é coberto aqui (é a D-NE41 pelo digVal, na nfe-api)', () => {
    const st = new FsFiscalStorage(root)
    st.save(key(), 'F1-nfe.xml', '<f/>', DAY1)
    expect(() => st.save(key(), 'F2-nfe.xml', '<f/>', DAY1)).not.toThrow()
  })

  it('o nome existente é uma pasta: sobe erro alto (nunca vira conflito mudo nem sobrescreve)', () => {
    const st = new FsFiscalStorage(root)
    const dir = path.join(root, C, 'H', 'nfe', '1', '2026', '11', '24')
    fs.mkdirSync(path.join(dir, 'G-nfe.xml'), { recursive: true })
    let err: unknown
    try { st.save(key(), 'G-nfe.xml', '<g/>', DAY1) } catch (e) { err = e }
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR')
    expect(err).not.toBeInstanceOf(FiscalFileConflictError)
    expect(fs.existsSync(path.join(serieDir(), '.once', 'G-nfe.xml'))).toBe(false)         // a reivindicação foi desfeita
    expect(fs.statSync(path.join(dir, 'G-nfe.xml')).isDirectory()).toBe(true)
    expect(leftovers(root)).toEqual([])
  })

  it('XML vazio, só espaço ou que não é texto é recusado (congelaria o nome com um arquivo errado)', () => {
    const st = new FsFiscalStorage(root)
    for (const bad of ['', '   \n', undefined, null, 5, [60, 97, 62], Buffer.from('<a/>')]) {
      expect(() => st.save(key(), 'H-nfe.xml', bad as never, DAY1)).toThrow(/vazio ou inválido/)
    }
    expect(fs.existsSync(path.join(root, C, 'H', 'nfe', '1', '2026', '11', '24', 'H-nfe.xml'))).toBe(false)
    expect(st.save(key(), 'H-nfe.xml', '<h/>', DAY1)).toContain('H-nfe.xml')            // o nome continua livre para o XML certo
  })

  it('falha ao gravar o tmp (disco cheio): o erro sobe, não sobra tmp, e o nome continua livre', () => {
    const st = new FsFiscalStorage(root)
    const spy = jest.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }) })
    try {
      expect(() => st.save(key(), 'I-nfe.xml', '<i/>', DAY1)).toThrow(/ENOSPC/)
    } finally { spy.mockRestore() }
    expect(leftovers(root)).toEqual([])
    expect(fs.existsSync(path.join(serieDir(), '.once', 'I-nfe.xml'))).toBe(false)
    expect(st.save(key(), 'I-nfe.xml', '<i/>', DAY1)).toContain('I-nfe.xml')
  })

  it('sem suporte a link físico (EPERM/ENOSYS): o erro sobe alto, nada é gravado, nunca cai no rename', () => {
    const st = new FsFiscalStorage(root)
    for (const code of ['EPERM', 'ENOSYS']) {
      const link = jest.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error(`${code}: link`), { code }) })
      const ren = jest.spyOn(fs, 'renameSync')
      try {
        expect(() => st.save(key(), `J-${code}-nfe.xml`, '<j/>', DAY1)).toThrow(new RegExp(code))
        expect(ren).not.toHaveBeenCalled()
      } finally { link.mockRestore(); ren.mockRestore() }
      expect(leftovers(root)).toEqual([])
      expect(fs.existsSync(path.join(root, C, 'H', 'nfe', '1', '2026', '11', '24', `J-${code}-nfe.xml`))).toBe(false)
    }
  })

  it('série de ANTES da trava: o índice nasce uma vez a partir dos arquivos existentes (sem copiar bytes) e passa a valer', () => {
    const st = new FsFiscalStorage(root)
    const legacyDir = path.join(root, C, 'H', 'nfe', '7', '2026', '03', '05')
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacy = path.join(legacyDir, 'L-nfe.xml')
    fs.writeFileSync(legacy, '<legado/>')
    const k = key({ serie: 7 })
    expect(() => st.save(k, 'L-nfe.xml', '<outro/>', DAY1)).toThrow(FiscalFileConflictError)       // o legado também é gravação única
    expect(st.save(k, 'L-nfe.xml', '<legado/>', DAY2)).toBe(legacy)
    expect(fs.readFileSync(legacy, 'utf8')).toBe('<legado/>')
    const once = path.join(serieDir({ serie: 7 }), '.once')
    expect(fs.existsSync(path.join(once, '.ready'))).toBe(true)
    expect(fs.statSync(path.join(once, 'L-nfe.xml')).ino).toBe(fs.statSync(legacy).ino)             // link físico, não cópia
    expect(st.find({ ...k }, 'L-nfe.xml', [])).toBe(legacy)                                         // a busca por dia nunca olha o índice
  })

  it('o vencedor caiu entre reivindicar e publicar (índice sem arquivo do dia): mesmos bytes reparam no dia de quem chega; outros são conflito', () => {
    const st = new FsFiscalStorage(root)
    const k = key({ serie: 8 })
    st.save(k, 'warm-nfe.xml', '<w/>', DAY1)                                                         // cria o índice e o marcador da série
    const once = path.join(serieDir({ serie: 8 }), '.once')
    fs.writeFileSync(path.join(once, 'R-nfe.xml'), '<r/>')
    aged(path.join(once, 'R-nfe.xml'))
    expect(() => st.save(k, 'R-nfe.xml', '<r2/>', DAY1)).toThrow(FiscalFileConflictError)
    const fixed = st.save(k, 'R-nfe.xml', '<r/>', DAY1)
    expect(fs.readFileSync(fixed, 'utf8')).toBe('<r/>')
    expect(st.save(k, 'R-nfe.xml', '<r/>', DAY2)).toBe(fixed)
  })

  it('custo: com 1.000 dias na série, gravar um nome novo não varre os dias', () => {
    const st = new FsFiscalStorage(root)
    const k = key({ serie: 9 })
    st.save(k, 'warm-nfe.xml', '<w/>', DAY1)
    const sd = serieDir({ serie: 9 })
    for (let i = 0; i < 1000; i++) {
      const d = path.join(sd, String(2000 + Math.floor(i / 360)), String(1 + Math.floor((i % 360) / 30)).padStart(2, '0'), String(1 + (i % 30)).padStart(2, '0'))
      fs.mkdirSync(d, { recursive: true })
    }
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 20; i++) st.save(k, `novo-${i}-nfe.xml`, `<n${i}/>`, DAY2)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20
    expect(ms).toBeLessThan(150)                              // folga larga: a varredura de 1.000 dias custava dezenas de ms por save
  })

  it('índice órfão numa série de 1.000 dias: a espera é limitada (nada de 20 varreduras) — mesmos bytes reparam, outros são conflito', () => {
    const st = new FsFiscalStorage(root)
    const k = key({ serie: 10 })
    st.save(k, 'warm-nfe.xml', '<w/>', DAY1)
    const sd = serieDir({ serie: 10 })
    for (let i = 0; i < 1000; i++) fs.mkdirSync(path.join(sd, String(2000 + Math.floor(i / 360)), String(1 + Math.floor((i % 360) / 30)).padStart(2, '0'), String(1 + (i % 30)).padStart(2, '0')), { recursive: true })
    fs.writeFileSync(path.join(sd, '.once', 'O1-nfe.xml'), '<o/>')
    fs.writeFileSync(path.join(sd, '.once', 'O2-nfe.xml'), '<q/>')
    aged(path.join(sd, '.once', 'O1-nfe.xml')); aged(path.join(sd, '.once', 'O2-nfe.xml'))
    const t0 = Date.now()
    expect(fs.readFileSync(st.save(k, 'O1-nfe.xml', '<o/>', DAY2), 'utf8')).toBe('<o/>')
    expect(() => st.save(k, 'O2-nfe.xml', '<outro/>', DAY2)).toThrow(FiscalFileConflictError)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('nomes que começam por ponto são reservados (colidiriam com o marcador do índice)', () => {
    const st = new FsFiscalStorage(root)
    for (const n of ['.ready', '.once', '.oculto.xml']) expect(() => st.save(key(), n, '<x/>', DAY1)).toThrow(/inválido/)
    expect(st.find(key(), '.ready', [])).toBeNull()
  })

  it('warm(): prepara o índice das séries que já têm arquivos, uma vez, sem copiar bytes; depois o save não varre', () => {
    const wroot = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-s30-warm-'))
    try {
      const day = path.join(wroot, C, 'nfe', '3', '2026', '05', '06')
      fs.mkdirSync(day, { recursive: true })
      fs.writeFileSync(path.join(day, 'W-nfe.xml'), '<w/>')
      const hday = path.join(wroot, C, 'H', 'nfse', '2', '2026', '05', '06')
      fs.mkdirSync(hday, { recursive: true })
      fs.writeFileSync(path.join(hday, 'X-nfse.xml'), '<x/>')
      const st = new FsFiscalStorage(wroot)
      expect(st.warm()).toBe(2)
      expect(fs.statSync(path.join(wroot, C, 'nfe', '3', '.once', 'W-nfe.xml')).ino).toBe(fs.statSync(path.join(day, 'W-nfe.xml')).ino)
      expect(fs.existsSync(path.join(wroot, C, 'H', 'nfse', '2', '.once', '.ready'))).toBe(true)
      expect(st.warm()).toBe(2)                                                                       // idempotente
      expect(() => st.save(key({ kind: 'nfe', serie: 3, environment: 'P' }), 'W-nfe.xml', '<outro/>', DAY1)).toThrow(FiscalFileConflictError)
    } finally { fs.rmSync(wroot, { recursive: true, force: true }) }
    expect(() => new FsFiscalStorage(path.join(root, 'nao-existe')).warm()).toThrow(/não existe/)
  })

  it('reivindicação RECENTE sem arquivo do dia (vencedor lento): quem chega com os mesmos bytes espera o prazo antes de reparar; outros bytes são conflito na hora', () => {
    const st = new FsFiscalStorage(root)
    const k = key({ serie: 11 })
    st.save(k, 'warm-nfe.xml', '<w/>', DAY1)
    const once = path.join(serieDir({ serie: 11 }), '.once')
    fs.writeFileSync(path.join(once, 'S1-nfe.xml'), '<s/>')
    fs.writeFileSync(path.join(once, 'S2-nfe.xml'), '<z/>')
    const t0 = Date.now()
    expect(() => st.save(k, 'S2-nfe.xml', '<outro/>', DAY2)).toThrow(FiscalFileConflictError)
    expect(Date.now() - t0).toBeLessThan(1000)
    const t1 = Date.now()
    const repaired = st.save(k, 'S1-nfe.xml', '<s/>', DAY2)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1800)                                              // esperou o vencedor lento
    expect(fs.readFileSync(repaired, 'utf8')).toBe('<s/>')
  })

  it('o arquivo do dia trocado por fora (outros bytes que a reivindicação): conflito, não "igual"', () => {
    const st = new FsFiscalStorage(root)
    const k = key({ serie: 12 })
    const p = st.save(k, 'T-nfe.xml', '<t/>', DAY1)
    fs.unlinkSync(p)                                                                                  // alguém troca o arquivo do dia, o índice fica com o inode velho
    fs.writeFileSync(p, '<trocado/>')
    expect(() => st.save(k, 'T-nfe.xml', '<t/>', DAY2)).toThrow(FiscalFileConflictError)
  })

  it('nome que termina em .tmp ou passa de 150 caracteres é recusado (formato do temporário e limite do disco)', () => {
    const st = new FsFiscalStorage(root)
    expect(() => st.save(key(), 'x.tmp', '<x/>', DAY1)).toThrow(/inválido/)
    expect(() => st.save(key(), `${'a'.repeat(147)}.xml`, '<x/>', DAY1)).toThrow(/inválido/)
    expect(st.save(key(), `${'a'.repeat(140)}.xml`, '<x/>', DAY1)).toContain('aaaa')
  })

  it('warm(): a falha de uma série (pasta suja) não deixa as outras sem índice; o erro lista a série', () => {
    const wroot = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-s30-warm2-'))
    try {
      const bad = path.join(wroot, C, 'nfe', '1')
      const good = path.join(wroot, C, 'nfe', '2')
      fs.mkdirSync(bad, { recursive: true }); fs.mkdirSync(good, { recursive: true })
      fs.writeFileSync(path.join(bad, '.once'), 'lixo')                                               // `.once` como arquivo
      const st = new FsFiscalStorage(wroot)
      expect(() => st.warm()).toThrow(/1 série\(s\) sem índice/)
      expect(fs.existsSync(path.join(good, '.once', '.ready'))).toBe(true)
    } finally { fs.rmSync(wroot, { recursive: true, force: true }) }
  })

  it('o erro de conflito sai pelo barrel', () => {
    expect(barrel.FiscalFileConflictError).toBe(FiscalFileConflictError)
  })
})

describe('FsFiscalStorage.save — corrida em PROCESSOS distintos (T1)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-s30-race-'))
  const dist = path.join(work, 'dist')
  const runner = path.join(work, 'child.js')
  const rounds = 20

  beforeAll(() => {
    // o `save` é síncrono: a corrida real só existe entre processos; o filho carrega só o módulo do storage COMPILADO (sem ts-node no projeto)
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/storage/fiscal-storage.ts', '--outDir', dist, '--module', 'commonjs',
      '--target', 'ES2020', '--esModuleInterop', '--skipLibCheck', '--resolveJsonModule', '--types', 'node'],
      { cwd: path.resolve(__dirname, '..', '..'), stdio: 'pipe' })
    fs.writeFileSync(runner, [
      "const fs = require('fs'); const path = require('path')",
      `const { FsFiscalStorage } = require(path.join(${JSON.stringify(dist)}, 'storage', 'fiscal-storage.js'))`,
      'const [, , storeRoot, go, ready, name, xml, when] = process.argv',
      'const st = new FsFiscalStorage(storeRoot)',
      "fs.writeFileSync(ready, '1')",
      'while (!fs.existsSync(go)) { /* barreira: os dois largam juntos */ }',
      'let out',
      `try { out = { ok: true, path: st.save({ cnpj: ${JSON.stringify(C)}, kind: 'nfe', serie: 1, environment: 'H', zone: 'UTC' }, name, xml, new Date(when)) } }`,
      'catch (e) { out = { ok: false, code: e && e.code, name: e && e.name } }',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n'))
  }, 180_000)
  afterAll(() => { fs.rmSync(work, { recursive: true, force: true }) })

  type Out = { ok: boolean; path?: string; code?: string }
  const child = (store: string, go: string, ready: string, name: string, xml: string, when: string): Promise<Out> =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [runner, store, go, ready, name, xml, when])
      let out = ''; let errOut = ''
      c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { errOut += d })
      c.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`filho saiu ${code}: ${errOut}`)))
    })

  const round = async (tag: string, xmlA: string, xmlB: string, whenA: string, whenB: string) => {
    const store = path.join(work, `store-${tag}`)
    fs.mkdirSync(store)
    const go = path.join(work, `go-${tag}`)
    const ra = path.join(work, `ready-a-${tag}`)
    const rb = path.join(work, `ready-b-${tag}`)
    const a = child(store, go, ra, 'R-nfe.xml', xmlA, whenA)
    const b = child(store, go, rb, 'R-nfe.xml', xmlB, whenB)
    const t0 = Date.now()
    while (!(fs.existsSync(ra) && fs.existsSync(rb))) {
      if (Date.now() - t0 > 20_000) throw new Error('filhos não ficaram prontos')
      await new Promise(r => setTimeout(r, 5))
    }
    fs.writeFileSync(go, '1')
    const [oa, ob] = await Promise.all([a, b])
    const serie = path.join(store, C, 'H', 'nfe', '1')
    const stored: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '.once') walk(p) } else stored.push(p) } }
    walk(serie)
    return { oa, ob, stored, tmp: leftovers(store) }
  }
  const D1 = '2026-11-24T15:00:00Z'
  const D2 = '2026-11-26T15:00:00Z'

  it(`mesmo dia, mesmos bytes: as duas voltam o mesmo caminho e fica um arquivo só, inteiro (${rounds} rodadas)`, async () => {
    for (let i = 0; i < rounds; i++) {
      const { oa, ob, stored, tmp } = await round(`eq${i}`, '<r>igual ç</r>', '<r>igual ç</r>', D1, D1)
      expect(oa.ok && ob.ok).toBe(true)
      expect(oa.path).toBe(ob.path)
      expect(stored).toHaveLength(1)
      expect(tmp).toEqual([])
      expect(fs.readFileSync(oa.path!, 'utf8')).toBe('<r>igual ç</r>')
    }
  }, 240_000)

  it(`mesmo dia, bytes DIFERENTES: um filho grava e o outro recebe FISCAL_FILE_CONFLICT; o arquivo é inteiro, de um dos dois (${rounds} rodadas)`, async () => {
    for (let i = 0; i < rounds; i++) {
      const { oa, ob, stored, tmp } = await round(`ne${i}`, '<r>AAAA</r>', '<r>BBBBBB</r>', D1, D1)
      const wins = [oa, ob].filter(r => r.ok)
      const losses = [oa, ob].filter(r => !r.ok)
      expect(wins).toHaveLength(1)
      expect(losses).toHaveLength(1)
      expect(losses[0].code).toBe(ErrorCodes.FISCAL_FILE_CONFLICT)
      expect(stored).toHaveLength(1)
      expect(tmp).toEqual([])
      expect(['<r>AAAA</r>', '<r>BBBBBB</r>']).toContain(fs.readFileSync(wins[0].path!, 'utf8'))
    }
  }, 240_000)

  it(`DIAS diferentes (a janela que a varredura deixava), bytes diferentes: um só arquivo na série inteira e um conflito (${rounds * 2} rodadas)`, async () => {
    for (let i = 0; i < rounds * 2; i++) {
      const { oa, ob, stored, tmp } = await round(`dd${i}`, '<r>AAAA</r>', '<r>BBBBBB</r>', D1, D2)
      const wins = [oa, ob].filter(r => r.ok)
      const losses = [oa, ob].filter(r => !r.ok)
      expect(wins).toHaveLength(1)
      expect(losses).toHaveLength(1)
      expect(losses[0].code).toBe(ErrorCodes.FISCAL_FILE_CONFLICT)
      expect(stored).toHaveLength(1)
      expect(tmp).toEqual([])
      expect(stored[0]).toBe(wins[0].path)
    }
  }, 300_000)

  it(`DIAS diferentes, mesmos bytes: as duas voltam o MESMO caminho e a série tem um arquivo só (${rounds} rodadas)`, async () => {
    for (let i = 0; i < rounds; i++) {
      const { oa, ob, stored, tmp } = await round(`de${i}`, '<r>igual</r>', '<r>igual</r>', D1, D2)
      expect(oa.ok && ob.ok).toBe(true)
      expect(oa.path).toBe(ob.path)
      expect(stored).toHaveLength(1)
      expect(tmp).toEqual([])
    }
  }, 240_000)
})
