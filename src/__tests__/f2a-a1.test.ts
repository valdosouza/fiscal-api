/// <reference types="jest" />
// F2a — etapa A1 (Rodada 1 da F2a, Valdo 2026-10-12: "siga as recomendações" — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22):
//  - D-F109: `reconfirmationVerdict(vida)` — o veredito da reconferência com MOTIVO (barreira "irmã viva" ANTES da prova);
//  - D-NE66 (b): `readFamilyTransmissions(…)` — o leitor que já MAPEIA (nota (5) da F2a: caso POSITIVO com linha real da view);
//  - D-NE84/D-F107: `assertCheckRefuses` — a sonda do boot prova CHECK aplicado E binário.
// Puro: sem banco (o driver é simulado na forma do mysql2), sem fisco.
import fs from 'fs'
import path from 'path'
import {
  ReconfirmReason, ServiceTransmissionView, SERVICE_VOICE_READING, reconfirmationCandidate, reconfirmationProven, reconfirmationVerdict,
} from '../voice/families/service'
import { ReadQueryable, readFamilyTransmissions, readFamilyTransmissionsMany, assertFamilyViewsReadable } from '../voice/family-reader'
import { inLife, isLiveTransmission } from '../voice/reading'
import { invoiceRef, WEB_TERMINAL } from '../ref/invoice-ref'
import { assertCheckRefuses, CheckProbe } from '../db/check'
import { assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced } from '../establishment/establishment.repository'
import ts from 'typescript'
import { WORKSPACE, setesApiPath, relWorkspace } from './setes-api-dir'
import { TransmissionEventKind } from '../voice/kinds'

const DPS = 'DPS410690221234567800019900001000000000000042'
/** Linha da vida já mapeada (a forma de `ServiceTransmissionView`). */
const row = (over: Partial<ServiceTransmissionView> = {}): ServiceTransmissionView => ({
  institutionId: 1, invoiceId: 8011, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P', accessKey: null, authorityRecorded: false,
  lastQueriedAt: null, createdAt: '2026-10-01 10:00:00', lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q',
  lastDh: null, lastEventAt: '2026-10-01 10:05:00', serie: '1', dpsNumber: 42, dpsId: DPS, nfseNumber: null, dhProc: null,
  nfseNotGeneratedAt: null, ...over,
})
const PROVEN = row({ nfseNotGeneratedAt: '2026-10-01 11:00:00' })

describe('D-F109 — reconfirmationVerdict(vida): o veredito com MOTIVO, a barreira ANTES da prova', () => {
  const cases: [string, ServiceTransmissionView[], ReconfirmReason][] = [
    ['F por consulta em P com E2404 posterior → provada', [PROVEN], 'provada'],
    ['tentativa VIVA na vida (reserva sem voz) → irma-viva, mesmo com o E2404 gravado', [PROVEN, row({ attempt: 2, lastKind: null, lastEvent: null, lastEventAt: null, lastSource: null })], 'irma-viva'],
    ['tentativa VIVA de outra identidade (outro ambiente) → irma-viva (a barreira do plano olha a vida inteira)', [PROVEN, row({ attempt: 2, environment: 'H', lastKind: 'K', lastSource: 'P' })], 'irma-viva'],
    ['K vigente (cancelamento em voo) → irma-viva', [row({ lastKind: 'K', lastSource: 'P' })], 'irma-viva'],
    ['vida REGISTRADA pelo fisco → nao-exigida', [row({ accessKey: '4'.repeat(50), authorityRecorded: true, lastKind: 'A', lastSource: 'P' })], 'nao-exigida'],
    ['F por consulta em HOMOLOGAÇÃO → nao-exigida (Q-CA5b)', [row({ environment: 'H' })], 'nao-exigida'],
    ['F direto (source P) → nao-exigida', [row({ lastSource: 'P' })], 'nao-exigida'],
    ['vida vazia → nao-exigida', [], 'nao-exigida'],
    ['candidata sem E2404 → sem-e2404', [row()], 'sem-e2404'],
    ['E2404 anterior à reapresentação do Id numa irmã (R direta, mesma identidade) → apresentada-depois', [row({ nfseNotGeneratedAt: '2026-10-01 10:10:00' }), row({ attempt: 2, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-01 10:20:00', lastEventAt: '2026-10-01 10:25:00' })], 'apresentada-depois'],
    ['a candidata é a ÚLTIMA F por consulta — sem E2404 nela → sem-e2404 (o E2404 de uma F anterior não vale por ela)', [row({ nfseNotGeneratedAt: '2026-10-01 10:10:00' }), row({ attempt: 2, createdAt: '2026-10-01 10:20:00', lastEventAt: '2026-10-01 10:25:00' })], 'sem-e2404'],
    ['E2404 no MESMO segundo do F → apresentada-depois (estritamente maior)', [row({ nfseNotGeneratedAt: '2026-10-01 10:05:00' })], 'apresentada-depois'],
    ['irmã sem Id do DPS → sem-identidade (falha FECHADO)', [PROVEN, row({ attempt: 2, dpsId: null, lastKind: 'R', lastSource: 'P' })], 'sem-identidade'],
    ['instante ISO (fora do formato do leitor) → instante-invalido', [row({ nfseNotGeneratedAt: '2026-10-01T11:00:00Z' })], 'instante-invalido'],
  ]
  it.each(cases)('%s', (_l, life, reason) => {
    expect(reconfirmationVerdict(life).reason).toBe(reason)
  })
  it('a candidata vem junto (nula nas saídas que não reconferem) e o veredito é IMUTÁVEL', () => {
    const v = reconfirmationVerdict([PROVEN])
    expect([v.candidate?.attempt, Object.isFrozen(v)]).toEqual([1, true])
    expect(reconfirmationVerdict([row({ lastKind: 'K' })]).candidate).toBeNull()
    expect(() => { (v as any).reason = 'nao-exigida' }).toThrow(TypeError)
  })
  it('UMA regra: em vida sem tentativa viva, `provada` ⟺ `reconfirmationProven(candidata, vida)` — varredura de vidas incoerentes', () => {
    const kinds: (TransmissionEventKind | null)[] = ['F', 'R', 'A', 'C', 'N']
    const at = ['2026-10-01 10:00:00', '2026-10-01 10:05:00', '2026-10-01 11:00:00', null]
    let checked = 0
    for (const k2 of kinds) for (const e of at) for (const c2 of at) for (const env2 of ['P', 'H'] as const) {
      const life = [row({ nfseNotGeneratedAt: e }), row({ attempt: 2, lastKind: k2, environment: env2, createdAt: c2, lastSource: k2 === 'F' ? 'Q' : 'P',
        ...(k2 === 'A' ? { accessKey: '4'.repeat(50), authorityRecorded: true } : {}) })]
      if (life.some(isLiveTransmission)) continue
      const cand = reconfirmationCandidate(life)
      const v = reconfirmationVerdict(life)
      expect(v.candidate).toBe(cand)
      if (cand) { expect([life, v.reason === 'provada']).toEqual([life, reconfirmationProven(cand, life)]); checked++ }
    }
    expect(checked).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// D-NE66 (b) — o leitor que já MAPEIA (o caminho público da F2a)
// ---------------------------------------------------------------------------
/** A linha CRUA como o driver a devolve do SELECT da view (alias = nome do campo; o registro em 'S'/'N'). */
const RAW = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 8011, terminal: 0, attempt: 1, lifeEvent: 7, environment: 'P', accessKey: null, authorityRecorded: 'N',
  lastQueriedAt: '2026-10-01 11:00:00', createdAt: '2026-10-01 10:00:00', lastEvent: 2, lastKind: 'F', lastCode: 'E2404', lastMessage: null,
  lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-01 10:05:00', serie: '1', dpsNumber: '42', dpsId: DPS, nfseNumber: null, dhProc: null,
  nfseNotGeneratedAt: '2026-10-01 11:00:00', ...over,
})
const driver = (rows: unknown) => {
  const calls: { sql: string; params: unknown }[] = []
  const q: ReadQueryable = { query: async (sql: string, params?: unknown) => { calls.push({ sql, params }); return [rows, []] } }
  return { q, calls }
}

describe('D-NE66 (b) — readFamilyTransmissions: a leitura pública já MAPEIA', () => {
  it('caso POSITIVO pela linha real da view (nota (5) da F2a): leitor PELA VIDA (D-F119) → mapa → veredito `provada`', async () => {
    const { q, calls } = driver([RAW()])
    const life = await readFamilyTransmissions(q, SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, WEB_TERMINAL), 7)
    expect(life.map(t => [t.attempt, t.authorityRecorded, t.dpsNumber])).toEqual([[1, false, 42]])   // FATO booleano, número
    expect(reconfirmationVerdict(life).reason).toBe('provada')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission v WHERE/)
    expect(calls[0].sql).toMatch(/v\.terminal = \? AND v\.life_event = \? ORDER BY v\.attempt$/)    // terminal e vida por parâmetro (D-NE12/D-F119)
    expect(calls[0].params).toEqual([1, 8011, WEB_TERMINAL, 7])
  })
  it('D-F119: linha de OUTRA vida vinda do driver (filtro perdido, view torta) derruba a leitura — nunca entra na decisão; vida inválida nem pergunta', async () => {
    await expect(readFamilyTransmissions(driver([RAW(), RAW({ lifeEvent: 3, attempt: 0 })]).q, SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, 0), 7))
      .rejects.toThrow(/nota 8011 na vida 3, que não foi pedida/)
    for (const bad of [0, -1, 1.5, NaN, undefined as any]) {
      const d = driver([])
      await expect(readFamilyTransmissions(d.q, SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, 0), bad)).rejects.toThrow(/Vida da nota inválido/)
      expect(d.calls).toHaveLength(0)
    }
  })
  it('D-F119/gates F2A1-01: o veredito (como o `currentOf`) RECUSA lista que mistura vidas ou notas — nunca `nao-exigida` pelo registro de outra vida', () => {
    const oldH = row({ lifeEvent: 3, environment: 'H', accessKey: '4'.repeat(50), authorityRecorded: true, lastKind: 'A', lastSource: 'P' })
    expect(() => reconfirmationVerdict([oldH, row({ attempt: 2 })])).toThrow(/reconfirmationVerdict: lista mistura lifeEvent/)
    expect(() => reconfirmationVerdict([row(), row({ invoiceId: 8012, attempt: 2 })])).toThrow(/mistura invoiceId/)
  })
  it('o registro vem como FATO: a linha registrada (\'S\') é registrada; a linha sem a coluna FALHA ALTO (migration da família não aplicada)', async () => {
    const reg = await readFamilyTransmissions(driver([RAW({ accessKey: '4'.repeat(50), authorityRecorded: 'S', lastKind: 'A', lastSource: 'P' })]).q,
      SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, 0), 7)
    expect([reg[0].authorityRecorded, reconfirmationVerdict(reg).reason]).toEqual([true, 'nao-exigida'])
    await expect(readFamilyTransmissions(driver([RAW({ authorityRecorded: undefined })]).q, SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, 0), 7))
      .rejects.toThrow(/sem authority_recorded/)
  })
  it('o driver que não devolve LINHAS (OkPacket, undefined) falha ALTO — nunca vira "nenhuma tentativa"', async () => {
    for (const bad of [undefined, { affectedRows: 0 }, null]) {
      await expect(readFamilyTransmissions(driver(bad).q, SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 8011, 0), 7)).rejects.toThrow(/não devolveu linhas/)
    }
  })
  it('lote (selo da lista): uma pergunta para N notas, cada uma na vida PEDIDA (pares — D-F119), terminal por parâmetro; lista vazia = nada a perguntar', async () => {
    const { q, calls } = driver([RAW(), RAW({ invoiceId: 8012, lifeEvent: 2 })])
    const rows = await readFamilyTransmissionsMany(q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [{ invoiceId: 8011, lifeEvent: 7 }, { invoiceId: 8012, lifeEvent: 2 }])
    expect(rows.map(r => r.invoiceId)).toEqual([8011, 8012])
    expect(calls[0].params).toEqual([1, 0, [[8011, 7], [8012, 2]]])
    const empty = driver([])
    expect(await readFamilyTransmissionsMany(empty.q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [])).toEqual([])
    expect(empty.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// D-NE84 / D-F107 — a sonda do boot: CHECK APLICADO e BINÁRIO
// ---------------------------------------------------------------------------
const checkErr = (name = 'ck_x') => Object.assign(new Error(`CONSTRAINT \`${name}\` failed`), { errno: 4025 })
function poolWith(onQuery: (sql: string, params?: unknown[]) => Promise<any>) {
  const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), destroy: jest.fn(), query: jest.fn(onQuery) }
  return { conn, pool: { getConnection: jest.fn(async () => conn) } as any }
}
const P = (value: string): CheckProbe => ({ value, constraint: 'ck_x', sql: 'INSERT INTO t (k) VALUES (?)', params: [value] })

describe('D-NE84/D-F107 — assertCheckRefuses', () => {
  it('as duas sondas recusadas pelo CHECK → passa; transação desfeita; conexão volta ao pool', async () => {
    const { conn, pool } = poolWith(async () => { throw checkErr() })
    await expect(assertCheckRefuses(pool, 'x', [P('ZZ'), P('se')])).resolves.toBeUndefined()
    expect([conn.rollback.mock.calls.length, conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([1, 1, 0])
  })
  it('motor que IGNORA CHECK (aceita tudo) → "não aplica CHECK"; CHECK _ci (recusa \'ZZ\', aceita \'se\') → "NÃO é o domínio publicado"', async () => {
    await expect(assertCheckRefuses(poolWith(async () => [{ affectedRows: 1 }]).pool, 'x', [P('ZZ'), P('se')])).rejects.toThrow(/não aplica CHECK/)
    const ci = poolWith(async (_s, p) => { if (p?.[0] === 'ZZ') throw checkErr(); return [{ affectedRows: 1 }] })
    await expect(assertCheckRefuses(ci.pool, 'x', [P('ZZ'), P('se')])).rejects.toThrow(/aceitou x fora do domínio \(se\) e recusou o resto|NÃO é o domínio publicado/i)
    expect(ci.conn.rollback).toHaveBeenCalledTimes(1)
  })
  it('a boot do modelo leva \'ZZ\' E \'se\' (D-NE84) — com um CHECK _ci (recusa \'ZZ\', aceita \'se\') o boot FALHA alto', async () => {
    const ci = poolWith(async (_s, p) => { if (p?.[0] === 'ZZ') throw checkErr('ck_establishment_issuer_model_bin'); return [{ affectedRows: 1 }] })
    await expect(assertIssuerModelDomainEnforced(ci.pool)).rejects.toThrow(/NÃO é o domínio publicado/)
    expect(ci.conn.query.mock.calls.map(c => c[1])).toEqual([['ZZ'], ['se']])
  })
  it('sem FK (tabela filha): desliga na sessão, RESTAURA no fim; se não restaurar, a conexão é DESTRUÍDA (nunca volta ao pool com a sessão alterada)', async () => {
    const ok = poolWith(async sql => { if (/^INSERT/.test(sql)) throw checkErr(); return [{}] })
    await assertCheckRefuses(ok.pool, 'x', [P('S'), P('f')], { withoutForeignKeys: true })
    expect(ok.conn.query.mock.calls.map(c => c[0])).toEqual(['SELECT @@SESSION.foreign_key_checks AS v', 'SET SESSION foreign_key_checks = 0',
      'INSERT INTO t (k) VALUES (?)', 'INSERT INTO t (k) VALUES (?)', 'SET SESSION foreign_key_checks = 1'])
    expect([ok.conn.release.mock.calls.length, ok.conn.destroy.mock.calls.length]).toEqual([1, 0])
    const broken = poolWith(async sql => { if (/^INSERT/.test(sql)) throw checkErr(); if (/= 1$/.test(sql)) throw new Error('caiu'); return [{}] })
    await assertCheckRefuses(broken.pool, 'x', [P('S'), P('f')], { withoutForeignKeys: true })
    expect([broken.conn.release.mock.calls.length, broken.conn.destroy.mock.calls.length]).toEqual([0, 1])
  })
  it('outro erro (sem GRANT, FK, coluna) sobe COMO ESTÁ — nunca vira "o motor aplica"; nenhuma sonda vazia', async () => {
    const e = Object.assign(new Error('denied'), { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' })
    const { conn, pool } = poolWith(async () => { throw e })
    await expect(assertCheckRefuses(pool, 'x', [P('S')])).rejects.toBe(e)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    await expect(assertCheckRefuses(pool, 'x', [])).rejects.toThrow(/nenhuma sonda/)
  })
  it('a migration 005 do núcleo é a que o boot confere (modelo — lista igual à da 004 — e ambiente H/P, colação binária, re-executável — D-F120/D-F123)', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/sql/005_issuer_domains_binary.sql'), 'utf8')
    expect(sql).toMatch(/ADD CONSTRAINT IF NOT EXISTS `ck_establishment_issuer_model_bin` CHECK \(`model` COLLATE utf8mb4_bin IN \('SE', '55', '65'\)\),/)
    expect(sql).toMatch(/ADD CONSTRAINT IF NOT EXISTS `ck_establishment_issuer_environment_bin` CHECK \(`environment` COLLATE utf8mb4_bin IN \('H', 'P'\)\);/)
  })
})

// ---------------------------------------------------------------------------
// D-F113 / D-F120 / D-F122 (Rodada 1 da F2a e gates da A1 — Valdo 2026-10-12)
// ---------------------------------------------------------------------------
describe('D-F113 — assertFamilyViewsReadable: a família INSTALADA é o catálogo VOICE_READINGS e a view de cada uma responde ao SELECT publicado', () => {
  it('pergunta a view de tentativas de CADA família do catálogo (SELECT publicado, WHERE 1 = 0 — nenhuma linha lida)', async () => {
    const { q, calls } = driver([])
    await assertFamilyViewsReadable(q, 'fiscal_api')
    expect(calls.map(c => c.sql.replace(/\s+/g, ' '))).toEqual([expect.stringMatching(/^SELECT .*v\.authority_recorded AS authorityRecorded.* FROM `fiscal_api`\.vw_invoice_service_transmission v WHERE 1 = 0$/)])
  })
  it('view ausente, coluna faltando (authority_recorded — nota (9) da F2a) ou sem GRANT → falha ALTO no boot com o nome da família e da view', async () => {
    for (const e of [{ code: 'ER_NO_SUCH_TABLE', errno: 1146 }, { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }, { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }]) {
      const q: ReadQueryable = { query: async () => { throw Object.assign(new Error('x'), e) } }
      await expect(assertFamilyViewsReadable(q, 'fiscal_api')).rejects.toThrow(new RegExp(`família "service" \\(fiscal_api\\.vw_invoice_service_transmission\\).*${e.code}.*D-F113`))
    }
    await expect(assertFamilyViewsReadable(driver([]).q, 'fiscal_api', [])).rejects.toThrow(/catálogo de famílias vazio/)
  })
})

describe('D-F120 — o ambiente da habilitação: sonda \'X\' e \'h\', cada uma com PK própria, pelo CHECK de nome certo', () => {
  it('as duas recusadas pelo `ck_establishment_issuer_environment_bin` → passa; recusa por OUTRO CHECK (o do modelo) não prova', async () => {
    const ok = poolWith(async () => { throw checkErr('ck_establishment_issuer_environment_bin') })
    await expect(assertIssuerEnvironmentDomainEnforced(ok.pool)).resolves.toBeUndefined()
    expect(ok.conn.query.mock.calls.map(c => c[1])).toEqual([['55', 'X'], ['65', 'h']])            // PKs (0,'55') e (0,'65') — nunca colidem
    const other = poolWith(async () => { throw checkErr('ck_establishment_issuer_model_bin') })
    await expect(assertIssuerEnvironmentDomainEnforced(other.pool)).rejects.toThrow(/ck_establishment_issuer_model_bin/)
  })
})

describe('D-F122 (= Q-F132 (a)) — ninguém desliga o CHECK na sessão', () => {
  /** Textos (literais de string e template) de um fonte TS — comentários não contam (a regra é citada em comentários). */
  const tsTexts = (code: string): string[] => {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
      else if (ts.isTemplateExpression(n)) out.push([n.head.text, ...n.templateSpans.map(s => s.literal.text)].join('?'))
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (['node_modules', 'dist', '__tests__'].includes(d.name) ? [] : walk(path.join(dir, d.name))) : /\.(?:ts|sql)$/.test(d.name) ? [path.join(dir, d.name)] : [])
  const FORBIDDEN = /check_constraint_checks/i
  const offends = (file: string): boolean => {
    const code = fs.readFileSync(file, 'utf8')
    return file.endsWith('.sql') ? FORBIDDEN.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')) : tsTexts(code).some(s => FORBIDDEN.test(s))
  }
  it('a cerca não é cega (pega o SET em string e em migration) e o workspace (núcleo, nfse-api src/scripts, setes-api src/scripts, nfe-api) não usa a variável', () => {
    const tmp = path.join(require('os').tmpdir(), `df122-${process.pid}`)
    fs.mkdirSync(tmp, { recursive: true })
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), "await q.query('SET SESSION check_constraint_checks = 0')")
      fs.writeFileSync(path.join(tmp, 'b.sql'), 'SET check_constraint_checks = 0;')
      fs.writeFileSync(path.join(tmp, 'c.ts'), '// D-F122: nunca SET SESSION check_constraint_checks — comentário não conta')
      expect(['a.ts', 'b.sql', 'c.ts'].map(n => offends(path.join(tmp, n)))).toEqual([true, true, false])
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    const roots = [path.join(WORKSPACE, 'fiscal-api', 'src'), path.join(WORKSPACE, 'nfse-api', 'src'), path.join(WORKSPACE, 'nfse-api', 'scripts'),
      setesApiPath('src'), setesApiPath('scripts')]
    const nfe = path.join(WORKSPACE, 'nfe-api', 'src')
    if (fs.existsSync(nfe)) roots.push(nfe)                                       // a nfe-api ainda não tem código (D-F20)
    const files = roots.flatMap(walk)
    expect(files.length).toBeGreaterThan(200)
    expect(files.filter(offends).map(relWorkspace)).toEqual([])
  })
})
