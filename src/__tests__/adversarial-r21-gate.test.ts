/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 21 das APIs fiscais (D-F102…D-F104, Valdo 2026-10-11) — NÚCLEO fiscal-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no núcleo (conhecimento negativo, SEM mudança de comportamento — `src/voice/kinds.ts` e `src/voice/reading.ts`):
//  - D-F102 (= Q-F108 (a)): a voz S não tem produtor nem saída; quem criar produtor de S dá a ela a saída da D-F51 na MESMA entrega.
//    A cerca (e os escapes dela) mora no r21 da nfse-api; aqui: o núcleo não escreve voz, S segue no vocabulário (VIVA) e a saída
//    prometida devolve a prova — mas só na reconferência SEGUINTE.
//  - D-F103 (= Q-F109 (a)): `kind` CHAR(1) sem CHECK de domínio (colação _ci); "os escritores são TIPADOS"; CHECK binário só na
//    migration da F2a, conferido no boot (molde da D-F45).
//  - D-F104 (= Q-F110 (a)): `reconfirmationProven` fica BOOLEANA até a F2a (o veredito com motivo se decide lá).
//
//  * ACHADOS (`it.failing('[SEV R21-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual: é a prova do achado.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: puro (sem banco, sem socket, sem fisco). Lê a nfse-api (script, migrations) e o setes-api só como TEXTO.
import fs from 'fs'
import path from 'path'
import * as core from '../index'
import {
  reconfirmationCandidate, reconfirmationProven, mapTransmissionView, isLiveTransmission, TransmissionView,
} from '../voice/reading'
import { FINAL_TRANSMISSION_KINDS, TransmissionEventKind } from '../voice/kinds'

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => path.relative(WORKSPACE, f).replace(/\\/g, '/')
const walk = (dir: string, ext: RegExp): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name), ext)) : ext.test(d.name) ? [path.join(dir, d.name)] : []))
const workspaceHas = (...p: string[]) => fs.existsSync(path.join(WORKSPACE, ...p))

/** Linha CRUA do SELECT de `transmissionViewSelect` (molde do r20): candidata = tentativa 1, F por CONSULTA em P, F às 01/10 10:00. */
const raw = (over: any = {}) => ({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: null, nfseNumber: null, dhProc: null, lastQueriedAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: null, createdAt: '2026-10-01 09:59:00',
  lastEvent: 2, lastKind: 'F', lastCode: null, lastMessage: 'Sem resposta do fisco e nenhuma NFS-e gerada para este DPS — envio interrompido',
  lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-01 10:00:00', ...over,
})
const row = (over: any = {}) => mapTransmissionView(raw(over))
/** Candidata com o E2404 da reconferência em 02/10 10:00 (POSTERIOR ao F de 01/10 10:00). */
const cand = (over: any = {}) => row({ nfseNotGeneratedAt: '2026-10-02 10:00:00', ...over })
/** Irmã 2 da MESMA identidade, reservada 01/10 11:00, voz às 11:00:05. */
const sib = (lastKind: any, over: any = {}) => ({
  ...row({ attempt: 2, createdAt: '2026-10-01 11:00:00', lastEvent: 1, lastSource: 'P', lastEventAt: '2026-10-01 11:00:05', ...over }),
  lastKind,
}) as TransmissionView

// ===========================================================================
// D-F104 — a prova fica BOOLEANA até a F2a (e sem consumidor antes dela)
// ===========================================================================

// testemunha de COMPILAÇÃO: o retorno é EXATAMENTE `boolean` (um veredito com motivo — opção (b) da Q-F110 — não compila aqui)
type ProofReturn = ReturnType<typeof reconfirmationProven>
const PROOF_IS_BOOLEAN: [ProofReturn] extends [boolean] ? ([boolean] extends [ProofReturn] ? true : false) : false = true

describe('D-F104 (= Q-F110 (a)) — `reconfirmationProven` booleana até a F2a', () => {
  it('resistiu: o retorno é `boolean` no TIPO (testemunha de compilação) e em TODA execução — varredura de candidatas e vidas incoerentes, sem lançar', () => {
    expect(PROOF_IS_BOOLEAN).toBe(true)
    const cands = [cand(), cand({ nfseNotGeneratedAt: null }), cand({ dpsId: null }), cand({ environment: null }), cand({ lastEventAt: '2026-10-02T10:00:00Z' }),
      { ...cand(), lastKind: 'S' as TransmissionEventKind }, { ...cand(), lastKind: undefined as any }, { ...cand(), lastKind: 'f' as any }]
    const lives: TransmissionView[][] = [[], [cand()], [cand(), sib('S')], [cand(), sib('R')], [sib(undefined)], [cand(), sib('K', { dpsId: null })], [cand(), sib(null, { lastEventAt: null })]]
    for (const c of cands) for (const life of lives) {
      let r: unknown
      expect(() => { r = reconfirmationProven(c as any, life) }).not.toThrow()
      expect(typeof r).toBe('boolean')
    }
  })
  it('resistiu: o índice do núcleo NÃO antecipa o veredito com motivo — de "reconfirm*" só o seletor e a prova; nada "verdict"', () => {
    expect(Object.keys(core).filter(k => /reconfirm/i.test(k)).sort()).toEqual(['reconfirmationCandidate', 'reconfirmationProven'])
    expect(Object.keys(core).filter(k => /verdict/i.test(k))).toEqual([])
  })
  it('resistiu: nenhum consumidor de PRODUÇÃO chama `reconfirmationProven` (nfse-api src/scripts, setes-api src — fora de __tests__): o 1º é a F2a, que troca este teste', () => {
    if (!workspaceHas('nfse-api')) return                                    // núcleo isolado (sem o workspace)
    const files = [['nfse-api', 'src'], ['nfse-api', 'scripts'], ['setes-api', 'src']].flatMap(p => walk(path.join(WORKSPACE, ...p), /\.ts$/))
    expect(files.length).toBeGreaterThan(50)
    expect(files.filter(f => /\breconfirmationProven\s*\(/.test(read(f))).map(rel)).toEqual([])
  })
})

// ===========================================================================
// D-F102 no núcleo — S segue no vocabulário (VIVA); o núcleo não escreve voz; a saída prometida devolve a prova (na reconferência seguinte)
// ===========================================================================

describe('D-F102 (= Q-F108 (a)) no núcleo', () => {
  it('contexto: S segue no vocabulário (a opção (c) — tirar S — NÃO foi escolhida) e é VIVA (fora de FINAL); o núcleo NÃO tem escritor da voz (nenhum INSERT/UPDATE/REPLACE na tabela da voz em fiscal-api/src, .ts ou .sql) — a cerca de produtor mora na família', () => {
    const s: TransmissionEventKind = 'S'
    expect(FINAL_TRANSMISSION_KINDS.has(s)).toBe(false)
    expect(isLiveTransmission({ attempt: 1, accessKey: null, lastKind: s })).toBe(true)
    const WRITE = /\b(?:INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO|UPDATE)\s+[^;\n]*?transmission_event\b/i
    expect(walk(SRC_ROOT, /\.(?:ts|sql)$/).filter(f => WRITE.test(read(f))).map(rel)).toEqual([])
  })
  it('resistiu: com a irmã S VIVA nem um E2404 de 2099 prova; a saída que a D-F102 manda dar (S → F por CONSULTA) devolve a prova — mas SÓ na reconferência SEGUINTE (a candidata passa a ser a tentativa 2; o carimbo da 1 é anterior à nova apresentação e não serve)', () => {
    const live = [cand({ nfseNotGeneratedAt: '2099-01-01 00:00:00' }), sib('S')]
    expect(reconfirmationCandidate(live)?.attempt).toBe(1)
    expect(reconfirmationProven(live[0], live)).toBe(false)
    // a saída: a S ganha F por consulta em 02/10 12:00 (depois do carimbo da 1, que é de 02/10 10:00)
    const closed = sib('F', { lastSource: 'Q', lastEvent: 2, lastEventAt: '2026-10-02 12:00:00' })
    const after = [cand(), closed]
    const c2 = reconfirmationCandidate(after)
    expect(c2?.attempt).toBe(2)
    expect(reconfirmationProven(c2!, after)).toBe(false)                       // a 2 ainda sem E2404 posterior ao F dela
    expect(reconfirmationProven(after[0], after)).toBe(false)                  // e o carimbo da 1 é anterior à apresentação da 2
    const restamped = { ...closed, nfseNotGeneratedAt: '2026-10-02 12:30:00' }  // a reconferência seguinte carimba a 2
    expect(reconfirmationProven(restamped, [cand(), restamped])).toBe(true)
  })
})

// ===========================================================================
// D-F103 — `kind` sem CHECK de domínio; escritores tipados; CHECK binário na F2a
// ===========================================================================

describe('D-F103 (= Q-F109 (a)) — domínio de `kind`', () => {
  const famSql = () => [
    ...walk(path.join(WORKSPACE, 'nfse-api', 'src', 'migrations', 'sql'), /\.sql$/),
    ...walk(path.join(SRC_ROOT, 'migrations', 'sql'), /\.sql$/),
  ]
  it('contexto: nenhuma migration (família nfse-api + núcleo) confere o DOMÍNIO de `kind` — o único CHECK que cita `kind` é o da 002 (`kind <> \'C\' OR …`, o código do cancelamento), avaliado na colação _ci da coluna', () => {
    if (!workspaceHas('nfse-api')) return
    const checks = famSql().flatMap(f => [...read(f).matchAll(/CHECK\s*\(([^;]*?)\)\s*;/g)].map(m => ({ f: rel(f), expr: m[1] })))
      .filter(c => /`?kind`?/.test(c.expr))
    expect(checks.map(c => c.f)).toEqual(['nfse-api/src/migrations/sql/002_cancel_event_code.sql'])
    expect(checks[0].expr.replace(/\s+/g, ' ')).toMatch(/^`kind` <> 'C' OR `authority_code` IS NULL OR `authority_code` IN \(/)
    expect(read(path.join(WORKSPACE, 'nfse-api', 'src', 'migrations', 'sql', '001_nfse_baseline.sql'))).toMatch(/`kind`\s+CHAR\(1\) NOT NULL COMMENT 'S · A · R · C · K · F · N'/)
  })
  it('contexto (para a F2a): o molde da D-F45 SONDA o motor com um valor FORA do domínio em qualquer caixa (\'ZZ\') — copiado literalmente para a D-F103 ele NÃO distingue o CHECK binário do CHECK _ci (o defeito que a D-F103 quer fechar); a sonda que distingue é a MINÚSCULA de um kind válido (\'f\') — modelo das duas comparações, não o motor', () => {
    expect(read(path.join(SRC_ROOT, 'establishment', 'establishment.repository.ts'))).toMatch(/VALUES \(0, 'ZZ', 'H', 0, 'N'\)/)
    const DOMAIN = ['S', 'A', 'R', 'C', 'K', 'F', 'N']
    const acceptsCi = (v: string) => DOMAIN.some(d => d.toLowerCase() === v.toLowerCase())   // CHECK em colação _ci
    const acceptsBin = (v: string) => DOMAIN.includes(v)                                    // CHECK em colação binária
    expect([acceptsCi('Z'), acceptsBin('Z')]).toEqual([false, false])                       // 'Z' recusado pelos dois: não prova o binário
    expect([acceptsCi('f'), acceptsBin('f')]).toEqual([true, false])                        // 'f' só o binário recusa: ESTA é a sonda
  })
  it('contexto: o `migrate:setes` é escritor de voz que NÃO passa pelo tipo — `INSERT IGNORE … SELECT … ev.kind` da ORIGEM, sem filtrar o domínio; e a origem (setes-api 058) também não tem CHECK de `kind` — a garantia "escritores TIPADOS" vale só por transitividade', () => {
    if (!workspaceHas('nfse-api', 'scripts', 'migrate-from-setes-api.ts')) return
    const script = read(path.join(WORKSPACE, 'nfse-api', 'scripts', 'migrate-from-setes-api.ts')).replace(/\s+/g, ' ')
    expect(script).toMatch(/INSERT IGNORE INTO tb_invoice_service_transmission_event \([^)]*\bkind\b[^)]*\) SELECT [^;]*\bev\.kind\b/)
    const origin = path.join(WORKSPACE, 'setes-api', 'src', 'migrations', 'sql', '058_nfse_service_branch_issuer_transmission.sql')
    if (fs.existsSync(origin)) {
      const ddl = read(origin)
      expect(ddl).toMatch(/`kind`\s+CHAR\(1\) NOT NULL COMMENT 'S enviado/)
      expect(ddl).not.toMatch(/CHECK\s*\(\s*`?kind`?\s+(?:COLLATE\s+\w+\s+)?IN/i)
    }
  })
  it('[CORRIGIDO na sessão] [LOW R21-05] o aviso da D-F103 (`kinds.ts`) nomeia o ÚNICO escritor que não passa pelo tipo — a cópia do `migrate:setes` (herda o domínio da ORIGEM; com o CHECK binário da F2a, `INSERT IGNORE` × CHECK precisa de decisão de ordem/conferência)', () => {
    const kinds = read(path.join(SRC_ROOT, 'voice', 'kinds.ts'))
    const header = kinds.slice(0, kinds.indexOf('export type TransmissionEventKind'))
    expect(header).toMatch(/D-F103/)
    expect(header).toMatch(/migrate[:-]setes|migrate-from-setes-api/)
  })
})
