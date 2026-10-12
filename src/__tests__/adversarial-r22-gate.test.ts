/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 22 das APIs fiscais (D-F105…D-F106, Valdo 2026-10-11) — NÚCLEO fiscal-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no núcleo (só TEXTO em `src/voice/kinds.ts` — o código mexido mora na família):
//  - D-F105 (= Q-F111 (a)): a cerca da voz S vale só para a família NFS-e; no NÚCLEO a cerca (`nfse-api/src/__tests__/voice-kind-fence.ts`)
//    só olha SQL na tabela `tb_invoice_service_transmission_event` (`sqlOnly`) — o `kind: 'S'` do núcleo é da NF-e (NE-3, D-NE33).
//  - D-F106 (= Q-F112 (b)): o escritor da NFS-e é tipado pela lista POSITIVA da família — `SERVICE_VOICE_WRITE_KINDS = ['A','R','C','K','F','N']
//    as const satisfies readonly TransmissionEventKind[]` e `ServiceVoiceWriteKind` DERIVA dela (a 1ª forma, `Extract<…>`, evaporava calada
//    se o tipo comum virasse `any` — ressalva do adversarial, fechada na sessão); P/D que a NE-1a trouxer (D-NE14) não entram lá.
// Conversão pós-correção (2026-10-11, §21.16): os dois testes que fixavam a 1ª forma (`Extract` e a regex antiga da cerca) passaram a fixar
// a forma CORRIGIDA — marcados `[CORRIGIDO na sessão]`. A questão "onde mora a lista da família quando o escritor for para o núcleo" é a
// Q-F114 da Rodada 23 (R22-08; este arquivo a chamava de Q-F113 antes da numeração consolidada — Q-F113 é o domínio do CHECK da F2a).
// Os ataques de escape do tipo e da cerca (matriz compilada em memória, NE-1a simulada) moram no r22 da nfse-api; aqui: o que o
// NÚCLEO promete e o que a NE-1a (D-NE13: máquina tentativa × voz no núcleo) fará com essas duas defesas — Q-F114.
//
//  * ACHADOS (`it.failing('[SEV R22-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual: é a prova do achado.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: puro (sem banco, sem socket, sem fisco). Lê a nfse-api e o setes-api só como TEXTO. Testemunhas de COMPILAÇÃO
// (`@ts-expect-error`) são conferidas pelo ts-jest: um `@ts-expect-error` sem erro QUEBRA a compilação deste arquivo.
import { setesApiPathUntilF2a, setesApiSources, relWorkspace } from './setes-api-dir'   // D-F117: SETES_API_DIR, falha alto
import fs from 'fs'
import path from 'path'
import * as core from '../index'
import { FINAL_TRANSMISSION_KINDS, TransmissionEventKind, TransmissionSource } from '../voice/kinds'
import { isLiveTransmission } from '../voice/reading'

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => relWorkspace(f)                                  // D-F117
const walk = (dir: string, ext: RegExp): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name), ext)) : ext.test(d.name) ? [path.join(dir, d.name)] : []))
const NFSE_REPO = path.join(WORKSPACE, 'nfse-api', 'src', 'nfse', 'repository.ts')
const NFSE_FAMILY = path.join(WORKSPACE, 'nfse-api', 'src', 'nfse', 'voice-family.ts')
// D-F117 revisto na A3 da F2a: o escritor da voz do setes-api existe até a A3 (que o remove); depois, null = cerca do "depois"
const SETES_REPO = setesApiPathUntilF2a('src', 'shared', 'invoice-transmission', 'transmission.repository.ts')
const FENCE = path.join(WORKSPACE, 'nfse-api', 'src', '__tests__', 'voice-kind-fence.ts')

// --- igualdade de tipos (testemunha de compilação) ---
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const assertType = <T extends true>(): T => true as T

/** A definição da D-F106 reproduzida SOBRE O TIPO REAL DO NÚCLEO (o texto da família é conferido no 1º teste). */
const FAMILY_LIST = ['A', 'R', 'C', 'K', 'F', 'N'] as const satisfies readonly TransmissionEventKind[]
type ServiceWrite = typeof FAMILY_LIST[number]
/** A NE-1a simulada: o tipo comum ganha P (em processamento) e D (denegada) — D-NE14. */
type WideKind = TransmissionEventKind | 'P' | 'D'
const FAMILY_LIST_AFTER_NE1A = ['A', 'R', 'C', 'K', 'F', 'N'] as const satisfies readonly WideKind[]
type ServiceWriteAfterNe1a = typeof FAMILY_LIST_AFTER_NE1A[number]

// ===========================================================================
// D-F106 — a lista POSITIVA sobre o tipo do núcleo
// ===========================================================================

describe('D-F106 (= Q-F112 (b)) sobre o vocabulário do NÚCLEO', () => {
  it('[CORRIGIDO na sessão] a família define a lista como CONSTANTE (`SERVICE_VOICE_WRITE_KINDS = [\'A\', \'R\', \'C\', \'K\', \'F\', \'N\'] as const satisfies readonly TransmissionEventKind[]`) e `ServiceVoiceWriteKind` DERIVA dela — na nfse-api sobre o tipo DESTE núcleo (import de `fiscal-api`), no DESCRITOR da família (`voice-family.ts`, NE-1a parte 2 — D-F108), no setes-api sobre o vocabulário próprio dele; o funil confere a MESMA constante em execução (na nfse-api, o funil GENÉRICO do núcleo sobre o `writeKinds` do descritor)', () => {
    if (!fs.existsSync(NFSE_FAMILY)) return                                  // núcleo isolado (sem o workspace)
    // a nfse-api a CONGELA em execução (gate NE1A2-11 da parte 2 da NE-1a — `Object.freeze(…)`); a cópia do setes-api fica como está (morre na F2a)
    const list = /export const SERVICE_VOICE_WRITE_KINDS = (?:Object\.freeze\()?\['A', 'R', 'C', 'K', 'F', 'N'\] as const satisfies readonly TransmissionEventKind\[\]/
    const derived = /export type ServiceVoiceWriteKind = typeof SERVICE_VOICE_WRITE_KINDS\[number\]/
    const funnel = /if \(!SERVICE_VOICE_WRITE_SET\.has\(e\?\.kind as string\)\) \{\s*throw new Error\(`D-F106:/
    const nfse = read(NFSE_FAMILY)
    for (const re of [list, derived, /VoiceEventInput<ServiceVoiceWriteKind>/, /writeKinds: SERVICE_VOICE_WRITE_KINDS,/]) expect(nfse).toMatch(re)
    expect(nfse).toMatch(/import \{[^}]*\bTransmissionEventKind\b[^}]*\} from 'fiscal-api'/)
    expect(nfse).not.toMatch(/ServiceVoiceWriteKind = Extract</)               // a 1ª forma (fail-open com `any`) não volta
    // o funil da nfse-api é o GENÉRICO do núcleo — sobre o `writeKinds` do descritor, ANTES de qualquer query
    const core = read(path.join(SRC_ROOT, 'voice', 'event-table.ts'))
    // gates da parte 2 (NE1A2-03): o funil confere o kind lido UMA vez (o mesmo valor vai ao INSERT)
    expect(core).toMatch(/const kind = e\?\.kind as unknown[\s\S]*?if \(typeof kind !== 'string' \|\| !writeSet\.has\(kind\)\) \{\s*throw new Error\(`D-F106:/)
    expect(core.indexOf('!writeSet.has(kind)')).toBeLessThan(core.indexOf('await conn.query'))
    if (fs.existsSync(NFSE_REPO)) expect(read(NFSE_REPO)).toMatch(/export const insertTransmissionEvent = SERVICE_VOICE_FAMILY\.insertTransmissionEvent/)
    if (SETES_REPO) {
      const setes = read(SETES_REPO)
      for (const re of [list, derived, funnel, /kind:\s+ServiceVoiceWriteKind/]) expect(setes).toMatch(re)
      expect(setes).not.toMatch(/ServiceVoiceWriteKind = Extract</)
    } else {
      // F2a aplicada (D-F110): o setes-api NÃO escreve a voz — nenhum escritor nem lista de escrita sobrou nele
      const left = setesApiSources().filter(f => /insertTransmissionEvent|SERVICE_VOICE_WRITE_KINDS|ServiceVoiceWriteKind/.test(read(f)))
      expect(left.map(rel)).toEqual([])
    }
  })
  it('resistiu: sobre o tipo REAL do núcleo, a lista da família é EXATAMENTE A/R/C/K/F/N (S fora) — e continua a MESMA quando a NE-1a alargar o tipo comum com P/D (testemunhas de compilação)', () => {
    const same: Equal<ServiceWrite, 'A' | 'R' | 'C' | 'K' | 'F' | 'N'> = assertType()
    const stable: Equal<ServiceWriteAfterNe1a, ServiceWrite> = assertType()
    // @ts-expect-error — S fora da família (D-F102/D-F106)
    const s: ServiceWrite = 'S'
    // @ts-expect-error — P (NF-e, em processamento) não entra na NFS-e
    const p: ServiceWriteAfterNe1a = 'P'
    // @ts-expect-error — D (NF-e, denegada) não entra na NFS-e
    const d: ServiceWriteAfterNe1a = 'D'
    expect([same, stable, s, p, d]).toEqual([true, true, 'S', 'P', 'D'])
  })
  it('contexto [NE-1a — D-NE14]: a testemunha quebrou como previsto — o vocabulário comum agora é S/A/R/C/K/F/N + P (viva) e D (final); S segue nele e VIVO (D-F102); a lista de escrita da NFS-e NÃO mudou (A/R/C/K/F/N)', () => {
    const today: Equal<TransmissionEventKind, 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N' | 'P' | 'D'> = assertType()
    expect(today).toBe(true)
    expect(FINAL_TRANSMISSION_KINDS.has('S')).toBe(false)
    expect([FINAL_TRANSMISSION_KINDS.has('P'), FINAL_TRANSMISSION_KINDS.has('D')]).toEqual([false, true])
    expect(isLiveTransmission({ attempt: 1, accessKey: null, lastKind: 'S' })).toBe(true)
    // a família de serviço segue sem S/P/D sobre o tipo comum ALARGADO (a lista dela deriva da constante — D-F106)
    const stillSix: Equal<ServiceWrite, 'A' | 'R' | 'C' | 'K' | 'F' | 'N'> = assertType()
    expect(stillSix).toBe(true)
  })
  it('[CORRIGIDO na sessão] ressalva do adversarial: o `Extract` era fail-OPEN se o tipo comum virasse `any` (dava `any` — a D-F106 evaporava calada); DERIVADO da constante literal, o tipo da família continua A/R/C/K/F/N com o comum `any` OU `string` — e o `satisfies` segue barrando kind fora do comum', () => {
    const open: Equal<Extract<any, 'A'>, any> = assertType()                  // por que a 1ª forma foi trocada
    const leak: Extract<any, 'A'> = 'S'                                       // compilava: com `any` a lista positiva sumia
    const ifAny = ['A', 'R', 'C', 'K', 'F', 'N'] as const satisfies readonly any[]
    const ifString = ['A', 'R', 'C', 'K', 'F', 'N'] as const satisfies readonly string[]
    const holdsAny: Equal<typeof ifAny[number], 'A' | 'R' | 'C' | 'K' | 'F' | 'N'> = assertType()
    const holdsString: Equal<typeof ifString[number], 'A' | 'R' | 'C' | 'K' | 'F' | 'N'> = assertType()
    // @ts-expect-error — com o tipo comum real, um kind que não existe nele não passa pelo `satisfies`
    const unknownKind = ['A', 'Z'] as const satisfies readonly TransmissionEventKind[]
    const sentinel: 'S' extends ServiceWrite ? never : true = true
    expect([open, leak, holdsAny, holdsString, unknownKind.length, sentinel]).toEqual([true, 'S', true, true, 2, true])
  })
})

// ===========================================================================
// D-F105 — a cerca no núcleo só olha SQL na tabela da NFS-e
// ===========================================================================

describe('D-F105 (= Q-F111 (a)) — a cerca é da FAMÍLIA; no núcleo, só SQL', () => {
  it('[CORRIGIDO na sessão] o aviso do `kinds.ts` diz exatamente o que a cerca faz — `sqlOnly` decidido pelo caminho do núcleo e SQL só na tabela da NFS-e (a tabela numa CONSTANTE e o S em qualquer aspa — R22-07)', () => {
    const kinds = read(path.join(SRC_ROOT, 'voice', 'kinds.ts'))
    const header = kinds.slice(0, kinds.indexOf('export type TransmissionEventKind'))
    expect(header).toMatch(/D-F105/)
    expect(header).toMatch(/D-F106/)
    expect(header).toMatch(/ServiceVoiceWriteKind/)
    if (!fs.existsSync(FENCE)) return
    const fence = read(FENCE)
    expect(fence).toMatch(/sqlOnly: path\.resolve\(f\)\.startsWith\(CORE_ROOT \+ path\.sep\)/)
    expect(fence).toMatch(/const VOICE_TABLE = 'invoice_service_transmission_event'/)
    expect(fence).toMatch(/\$\{INSERT_HEAD\}\[\^;\]\*\$\{VOICE_TABLE\}\\b\[\^;\]\*\$\{S_LIT\}/)
    expect(fence).not.toMatch(/transmission_event\\b\[\^;\]\*'S'/)             // a regex antiga (só aspa simples, tabela fixa) não volta
  })
  it('resistiu [convertido na NE-1a parte 2 — D-F108/D-NE74: o escritor VEIO]: o núcleo tem EXATAMENTE UM escritor da voz — o GENÉRICO `voice/event-table.ts`, exportado só como FÁBRICA de família (`defineVoiceFamily`), com a tabela do DESCRITOR (`${table}`) e o tipo de entrada GENÉRICO (`VoiceEventInput<K>`); nenhum INSERT/REPLACE/UPDATE com o NOME de uma tabela da voz (.ts ou .sql) e nenhum tipo de ENTRADA de família (`ServiceVoiceWriteKind`/`TransmissionEventInput`) no núcleo', () => {
    const WRITE = /\b(?:INSERT|REPLACE|UPDATE)\b[^;\n]*?transmission_event\b/i
    const files = walk(SRC_ROOT, /\.(?:ts|sql)$/)
    expect(files.length).toBeGreaterThan(20)
    expect(files.filter(f => WRITE.test(read(f))).map(rel)).toEqual([])
    expect(Object.keys(core).filter(k => /insert.*(?:event|voice)|write.*(?:event|voice)|voiceWriter|VoiceFamily/i.test(k))).toEqual(['defineVoiceFamily'])
    const GENERIC_WRITE = /\b(?:INSERT|REPLACE)\b[^;]*?\$\{table\}/
    expect(files.filter(f => GENERIC_WRITE.test(read(f))).map(rel)).toEqual(['fiscal-api/src/voice/event-table.ts'])
    expect(files.filter(f => /ServiceVoiceWriteKind|TransmissionEventInput/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, ''))).map(rel)).toEqual([])
  })
})

// ===========================================================================
// Q-F114 — a NE-1a (D-NE13/D-NE14) leva a máquina para o núcleo: as duas defesas da NFS-e ficam para trás
// ===========================================================================

/** O escritor "natural" da máquina comum: o vocabulário COMUM no tipo de entrada (a extração literal do `insertTransmissionEvent`). */
interface CoreVoiceInput { kind: TransmissionEventKind | 'P' | 'D'; source: TransmissionSource }
/** A alternativa (a) da Q-F114: o DESCRITOR da família carrega a lista de escrita; o escritor do núcleo é genérico NELA e confere em execução. */
interface VoiceFamily<K extends string> { eventTable: string; writeKinds: readonly K[] }
function voiceWriterFor<K extends string>(family: VoiceFamily<K>) {
  return (e: { kind: K; source: TransmissionSource }): { table: string; kind: K } => {
    if (!family.writeKinds.includes(e.kind)) throw new Error(`kind ${String(e.kind)} fora da família ${family.eventTable}`)
    return { table: family.eventTable, kind: e.kind }
  }
}
const SERVICE_FAMILY: VoiceFamily<typeof FAMILY_LIST[number]> = { eventTable: 'tb_invoice_service_transmission_event', writeKinds: FAMILY_LIST }

describe('D-F108 (= Q-F114 (a), Rodada 23 — executa na NE-1a) — a lista da família mora no DESCRITOR quando o escritor for para o núcleo', () => {
  it('contexto: o escritor da máquina comum tipado pelo vocabulário COMUM (a forma que a extração literal produz) aceita S, P e D para QUALQUER família — inclusive a NFS-e — e a cerca no núcleo é `sqlOnly` com a tabela vinda do descritor (cega: ver o contexto Q-F114 do r22 da nfse-api)', () => {
    const toService: CoreVoiceInput[] = [{ kind: 'S', source: 'P' }, { kind: 'P', source: 'Q' }, { kind: 'D', source: 'Q' }]   // compila
    expect(toService.map(e => e.kind)).toEqual(['S', 'P', 'D'])
  })
  it('contexto (a forma DECIDIDA — D-F108): com o DESCRITOR da família carregando a lista de escrita e o escritor do núcleo genérico nela, o TIPO recusa S/P/D na NFS-e e a EXECUÇÃO recusa o cast — a defesa vai junto com a máquina', () => {
    const writeService = voiceWriterFor(SERVICE_FAMILY)
    // @ts-expect-error — S fora da família de serviço, já no tipo do escritor do NÚCLEO
    expect(() => writeService({ kind: 'S', source: 'P' })).toThrow(/fora da família/)
    // @ts-expect-error — P (da NF-e) idem
    expect(() => writeService({ kind: 'P', source: 'Q' })).toThrow(/fora da família/)
    expect(() => writeService({ kind: 'S' as unknown as 'A', source: 'P' })).toThrow(/fora da família/)            // o cast não passa
    expect(writeService({ kind: 'F', source: 'Q' })).toEqual({ table: 'tb_invoice_service_transmission_event', kind: 'F' })
    // e a NF-e (D-F105: S LEGÍTIMO lá) declara a lista DELA — o mesmo escritor aceita S/P/D para ela
    const writeGoods = voiceWriterFor({ eventTable: 'tb_invoice_merchandise_transmission_event', writeKinds: ['S', 'A', 'R', 'C', 'K', 'F', 'N', 'P', 'D'] as const })
    expect(writeGoods({ kind: 'S', source: 'P' }).kind).toBe('S')
  })
})
