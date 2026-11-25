import fs from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { DEFAULT_TIME_ZONE, isValidTimeZone, todayIn } from '../time/zone'
import { CNPJ_FORM } from '../federal-id/federal-id'
import { isProductionEnv } from '../util/environment'
import { ErrorCodes } from '../errors/error-codes'

/**
 * ARQUIVO FISCAL (XML dito ao fisco e devolvido por ele) atrás de uma interface com backend trocável (D-F16). Em produção o backend
 * é o DISCO do servidor, com o backup da SaveInCloud (P-DEP-2). Layout da D-F241 (Valdo, 2026-11-15):
 *   <raiz>/<cnpj>/<tipo>/<série>/<ano>/<mês>/<dia>/<nome>      — PRODUÇÃO
 *   <raiz>/<cnpj>/H/<tipo>/<série>/<ano>/<mês>/<dia>/<nome>    — HOMOLOGAÇÃO (Q-N38a)
 * tipo = nfse | nfe | nfce; série sem zeros à esquerda (uma forma só); data NA ZONA do estabelecimento (Q-TZ7) — a busca também
 * tenta a data da hora oficial.
 */

export type FiscalFileEnvironment = 'H' | 'P'
export type FiscalDocumentKind = 'nfse' | 'nfe' | 'nfce'

export const FISCAL_DOCUMENT_KINDS: readonly FiscalDocumentKind[] = ['nfse', 'nfe', 'nfce']

/** Onde o arquivo mora (tudo menos a data e o nome). */
export interface FiscalFileKey {
  cnpj: string
  kind: FiscalDocumentKind
  /** NF-e/NFC-e: a série da chave (0–999); NFS-e: a série da DPS (a chave da NFS-e não a contém). */
  serie: string | number
  environment: FiscalFileEnvironment
  zone: string
}

/** Dica de data da busca: instante do banco (UTC 'YYYY-MM-DD HH:MM:SS'), ISO com fuso ou `Date`. */
export type FiscalDateHint = string | Date | null | undefined

/** Busca: a série pode faltar (varre todas as séries do tipo). */
export type FiscalFileLookup = Omit<FiscalFileKey, 'serie'> & { serie?: string | number | null }

export interface FiscalStorage {
  /**
   * Grava e devolve um identificador do arquivo (caminho, no disco). GRAVAÇÃO ÚNICA (FAMILIA.E5.P6.T1 — D-NE41, RF-NFE-73): um arquivo
   * fiscal, uma vez escrito, é fato imutável. O nome já existe (em qualquer dia da mesma série, ambiente e tipo — índice `.once/` da série, sem varredura) com os MESMOS bytes =
   * devolve o caminho que já existe, nada é tocado; com bytes DIFERENTES = `FiscalFileConflictError`, nada é tocado. XML vazio ou que não é texto é recusado. Nunca há flag de
   * sobrescrita. Quem chama trata o conflito como pendência crítica (NF-e) ou aviso (NFS-e), nunca o ignora em silêncio.
   */
  save(key: FiscalFileKey, name: string, xml: string, when?: Date): string
  /** Localiza pelo nome usando as dicas de data (UTC do banco); null se não existe. */
  find(key: FiscalFileLookup, name: string, hints?: FiscalDateHint[]): string | null
  read(ref: string): string
  /**
   * Opcional: prepara (uma vez) o índice de gravação única das séries que já têm arquivos — chamar no deploy, com o serviço parado, antes de
   * atender; sem ela a primeira gravação de cada série grande varre os dias dentro da requisição. Devolve quantas séries viu.
   */
  warm?(): number
  /** /health: a raiz JÁ EXISTE e grava, lê e apaga um arquivo de sonda (nunca cria a raiz — volume desmontado = false). */
  probe(): boolean
}

/** Conflito de gravação única: o arquivo já existe com OUTRO conteúdo. A mensagem leva o caminho, nunca o conteúdo. */
export class FiscalFileConflictError extends Error {
  readonly code = ErrorCodes.FISCAL_FILE_CONFLICT
  constructor(readonly path: string) {
    super(`Arquivo fiscal já existe com outro conteúdo (gravação única): ${path}`)
    this.name = 'FiscalFileConflictError'
  }
}

/** Tamanho máximo do nome (o temporário no índice leva mais 41 caracteres; o disco aceita 255). */
const MAX_NAME = 150
const NAME_RE = /^[A-Za-z0-9._-]+$/
const ONLY_DOTS = /^\.+$/

/** Nome de arquivo aceito: só [A-Za-z0-9._-], nunca '.', '..', só pontos (seriam a pasta, não um arquivo) nem começando por ponto (reservado). */
function validName(name: unknown): name is string {
  // nome que começa por ponto é reservado: `.ready` e `.once` são do índice de gravação única
  return typeof name === 'string' && NAME_RE.test(name) && !ONLY_DOTS.test(name) && !name.startsWith('.') && !name.endsWith('.tmp') && name.length <= MAX_NAME
}

function assertZone(zone: string): string {
  const z = zone || DEFAULT_TIME_ZONE
  if (!isValidTimeZone(z)) throw new Error(`Zona inválida para o arquivo fiscal: ${zone}`)
  return z
}

/** Dica → instante; dica ilegível = null (a busca cai na varredura). */
function hintInstant(h: FiscalDateHint): Date | null {
  if (!h) return null
  if (h instanceof Date) return Number.isNaN(h.getTime()) ? null : h
  const v = String(h).trim()
  // com fuso explícito (Z ou ±hh:mm) vale como está; sem fuso é o UTC do banco (Q-TZ1)
  const d = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) ? new Date(v) : new Date(`${v.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
const SERIE_RE = /^\d{1,5}$/

/** Série → nome da pasta (forma canônica: sem zeros à esquerda; '000' = '0'). Fora do formato = erro, nunca outra pasta. */
export function fiscalSerieFolder(serie: string | number): string {
  const raw = typeof serie === 'number' ? (Number.isSafeInteger(serie) && serie >= 0 ? String(serie) : '') : serie
  if (typeof raw !== 'string' || !SERIE_RE.test(raw)) throw new Error(`Série inválida para o arquivo fiscal: ${String(serie)}`)
  return String(Number(raw))
}

function assertKind(kind: string): asserts kind is FiscalDocumentKind {
  if (!(FISCAL_DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new Error(`Tipo de documento inválido para o arquivo fiscal: ${kind}`)
}

function assertEnvironment(environment: string): asserts environment is FiscalFileEnvironment {
  if (environment !== 'H' && environment !== 'P') throw new Error(`Ambiente inválido para o arquivo fiscal: ${environment}`)
}

/**
 * Raiz do arquivo fiscal pela configuração. Produção (`NODE_ENV=production`): `STORAGE_PATH` obrigatório e ABSOLUTO — o XML nunca
 * cai na pasta de execução do app (P-DEP-2). Fora dela: `STORAGE_PATH` resolvido, ou `<cwd>/storage`.
 */
export function fiscalStorageRootFromEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const raw = env.STORAGE_PATH?.trim()
  if (isProductionEnv(env.NODE_ENV)) {
    if (!raw) throw new Error('STORAGE_PATH ausente em produção — o XML fiscal iria para a pasta de execução (P-DEP-2: disco do servidor)')
    if (!path.isAbsolute(raw)) throw new Error(`STORAGE_PATH relativo em produção (${raw}) — use o caminho absoluto do disco do servidor (P-DEP-2)`)
    return path.normalize(raw)
  }
  return path.resolve(cwd, raw || 'storage')
}

export class FsFiscalStorage implements FiscalStorage {
  constructor(private readonly root: string) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`Raiz do arquivo fiscal precisa ser absoluta: ${String(root)}`)
  }

  private envRoot(cnpj: string, environment: FiscalFileEnvironment): string {
    // D-CJ2: a pasta é a FORMA CANÔNICA (letras maiúsculas — o Windows ignora a caixa, o Linux não: uma forma só, nunca duas pastas);
    // nunca tirar caracteres (o CNPJ alfanumérico viraria a pasta de OUTRO número)
    if (typeof cnpj !== 'string' || !CNPJ_FORM.test(cnpj)) throw new Error(`CNPJ inválido para o arquivo fiscal: ${cnpj}`)
    assertEnvironment(environment)
    const base = path.join(this.root, cnpj)
    return environment === 'H' ? path.join(base, 'H') : base
  }

  private kindRoot(cnpj: string, environment: FiscalFileEnvironment, kind: FiscalDocumentKind): string {
    assertKind(kind)
    return path.join(this.envRoot(cnpj, environment), kind)
  }

  private dayDir(serieRoot: string, when: Date, zone: string): string {
    const [year, month, day] = todayIn(zone, when).split('-')
    return path.join(serieRoot, year, month, day)
  }

  save(key: FiscalFileKey, name: string, xml: string, when: Date = new Date()): string {
    if (!validName(name)) throw new Error(`Nome de arquivo fiscal inválido: ${name}`)
    // XML vazio ou que não é texto nunca é gravado: congelaria para sempre o nome com um arquivo errado (a trava impede o conserto)
    if (typeof xml !== 'string' || xml.trim().length === 0) throw new Error(`XML fiscal vazio ou inválido para o arquivo ${name}`)
    const serieRoot = path.join(this.kindRoot(key.cnpj, key.environment, key.kind), fiscalSerieFolder(key.serie))
    const dir = this.dayDir(serieRoot, when, assertZone(key.zone))
    // a RAIZ nunca é criada aqui: volume desmontado = erro, nunca o XML no disco efêmero do sistema (sem o backup — P-DEP-2)
    if (!isDir(this.root)) throw new Error(`Raiz do arquivo fiscal não existe: ${this.root}`)
    const bytes = Buffer.from(xml, 'utf8')
    const onceDir = ensureOnceIndex(serieRoot)
    const full = path.join(dir, name)
    const claim = path.join(onceDir, name)
    // nunca um arquivo pela metade (mesma regra do cofre antigo — D-N30): tmp COMPLETO e DURÁVEL (fsync) e só então a publicação. O tmp mora
    // no índice da série (mesmo volume do dia, e nenhum dia vazio fica para trás se a gravação falhar)
    const tmp = path.join(onceDir, `${name}.${randomUUID()}.tmp`)
    try {
      writeDurable(tmp, bytes)
      // GRAVAÇÃO ÚNICA pelo NOME em todos os dias da série (S5), sem varredura no caminho comum: o ÍNDICE da série (`.once/<nome>`) é a
      // reivindicação atômica do nome — `link` (nunca `rename`, que substitui em silêncio): EEXIST = alguém chegou antes, em qualquer
      // dia. Sem suporte a link (EPERM/ENOSYS, volume de rede) falha ALTO: cair no `rename` reabriria o buraco da sobrescrita
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.linkSync(tmp, claim)
        } catch (err) {
          if (errnoOf(err) !== 'EEXIST') throw err
          const resolved = resolveClaimed(serieRoot, claim, full, tmp, bytes)
          if (resolved !== null) return resolved
          continue                                            // a reivindicação sumiu enquanto líamos (o vencedor desistiu): de novo
        }
        // quem reivindicou publica no dia (o índice é o MESMO arquivo, outra entrada de diretório); se não conseguir, desfaz a
        // reivindicação — nunca deixa o nome preso a um arquivo que não está no dia
        try {
          fs.mkdirSync(dir, { recursive: true })
          fs.linkSync(tmp, full)
        } catch (err) {
          if (errnoOf(err) === 'EEXIST') {
            try { return sameBytesOrConflict(full, bytes) } catch (e2) { releaseClaim(claim); throw e2 }
          }
          releaseClaim(claim)
          throw err
        }
        return full
      }
      throw new Error(`Arquivo fiscal ${name}: a reivindicação do nome mudou sem parar — tente de novo`)
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* o tmp some sozinho ou nunca existiu */ }
    }
  }

  /**
   * Prepara (uma vez) o índice de gravação única de toda série que já tem arquivos, para a primeira gravação de cada série não varrer os
   * dias dentro de uma requisição. Chamar no deploy, ANTES de o serviço atender (a migração de layout da nfse-api já para o serviço).
   * Idempotente; devolve quantas séries foram vistas.
   */
  warm(): number {
    if (!isDir(this.root)) throw new Error(`Raiz do arquivo fiscal não existe: ${this.root}`)
    let seen = 0
    const failed: string[] = []
    const kinds = (base: string) => FISCAL_DOCUMENT_KINDS.filter(k => isDir(path.join(base, k)))
    for (const e of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !CNPJ_FORM.test(e.name)) continue
      const cnpjDir = path.join(this.root, e.name)
      for (const base of [cnpjDir, path.join(cnpjDir, 'H')]) {
        for (const kind of kinds(base)) {
          for (const serie of subdirs(path.join(base, kind), /^\d{1,5}$/)) {
            seen++
            try { ensureOnceIndex(path.join(base, kind, serie)) } catch (err) { failed.push(`${path.join(base, kind, serie)}: ${err instanceof Error ? err.message : String(err)}`) }
          }
        }
      }
    }
    if (failed.length > 0) throw new Error(`warm: ${failed.length} série(s) sem índice — ${failed.join(' | ')}`)
    return seen
  }

  find(key: FiscalFileLookup, name: string, hints: FiscalDateHint[] = []): string | null {
    if (!validName(name)) return null                         // '../..' nunca sai da pasta do CNPJ
    assertEnvironment(key.environment)
    const zone = assertZone(key.zone)
    const instants = hints.map(hintInstant).filter((d): d is Date => d !== null)
    const envs: FiscalFileEnvironment[] = key.environment === 'H' ? ['H', 'P'] : ['P']
    const serie = key.serie === null || key.serie === undefined || key.serie === '' ? null : fiscalSerieFolder(key.serie)
    for (const env of envs) {
      const kindRoot = this.kindRoot(key.cnpj, env, key.kind)
      if (!fs.existsSync(kindRoot)) continue
      const series = serie !== null ? [serie] : subdirs(kindRoot, /^\d{1,5}$/)
      for (const s of series) {
        const serieRoot = path.join(kindRoot, s)
        for (const d of instants) {
          for (const z of zone === DEFAULT_TIME_ZONE ? [zone] : [zone, DEFAULT_TIME_ZONE]) {
            const p = path.join(this.dayDir(serieRoot, d, z), name)
            if (isFile(p)) return p
          }
        }
      }
      // varredura, do mais novo ao mais antigo: série(s) / ano / mês / dia (só pastas no formato — a `H` nunca é varrida por P,
      // porque mora fora do tipo)
      for (const s of series) {
        const serieRoot = path.join(kindRoot, s)
        for (const y of subdirs(serieRoot, /^\d{4}$/)) {
          for (const m of subdirs(path.join(serieRoot, y), /^\d{2}$/)) {
            for (const d of subdirs(path.join(serieRoot, y, m), /^\d{2}$/)) {
              const p = path.join(serieRoot, y, m, d, name)
              if (isFile(p)) return p
            }
          }
        }
      }
    }
    return null
  }

  read(ref: string): string {
    return fs.readFileSync(ref, 'utf8')
  }

  probe(): boolean {
    // grava, lê e apaga de verdade: disco cheio, só leitura ou permissão errada aparecem no /health, não na 1ª emissão
    const file = path.join(this.root, `.probe-${randomUUID()}.tmp`)
    if (!isDir(this.root)) return false                       // nunca cria a raiz: volume desmontado aparece aqui
    try {
      const mark = `probe ${new Date().toISOString()}`
      fs.writeFileSync(file, mark, 'utf8')
      const ok = fs.readFileSync(file, 'utf8') === mark
      fs.unlinkSync(file)
      return ok
    } catch {
      try { fs.unlinkSync(file) } catch { /* sonda nem chegou a existir */ }
      return false
    }
  }
}

/** Pasta do índice de gravação única, dentro da série (nome fora do formato dos dias: a busca por dia nunca a olha). */
const ONCE_DIR = '.once'
const ONCE_READY = '.ready'
const TMP_RE = /\.[0-9a-f-]{36}\.tmp$/

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code

/** Grava o arquivo temporário COMPLETO e no disco (fsync): uma queda não deixa um arquivo vazio que a trava congelaria. */
function writeDurable(tmp: string, bytes: Buffer): void {
  const fd = fs.openSync(tmp, 'wx')
  try {
    fs.writeSync(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function releaseClaim(claim: string): void {
  try { fs.unlinkSync(claim) } catch { /* já não existe */ }
}

/** Espera curta e SÍNCRONA (o `save` é síncrono). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * O índice da série. Série sem o marcador `.ready` (a primeira gravação depois desta trava, ou arquivos de antes dela) recebe, UMA vez,
 * uma entrada de índice por arquivo já existente (link físico — nenhum byte é copiado; o primeiro nome vence). O marcador só nasce
 * depois do fim da varredura: duas gravações simultâneas na primeira vez varrem as duas (idempotente) e nenhuma passa sem ela.
 */
function ensureOnceIndex(serieRoot: string): string {
  const onceDir = path.join(serieRoot, ONCE_DIR)
  const ready = path.join(onceDir, ONCE_READY)
  if (isFile(ready)) return onceDir
  fs.mkdirSync(onceDir, { recursive: true })
  for (const y of subdirs(serieRoot, /^\d{4}$/)) {
    for (const m of subdirs(path.join(serieRoot, y), /^\d{2}$/)) {
      for (const d of subdirs(path.join(serieRoot, y, m), /^\d{2}$/)) {
        const dayDir = path.join(serieRoot, y, m, d)
        for (const e of fs.readdirSync(dayDir, { withFileTypes: true })) {
          if (!e.isFile() || TMP_RE.test(e.name) || !validName(e.name)) continue
          try { fs.linkSync(path.join(dayDir, e.name), path.join(onceDir, e.name)) } catch (err) { if (errnoOf(err) !== 'EEXIST') throw err }
        }
      }
    }
  }
  try { fs.writeFileSync(ready, '1', { flag: 'wx' }) } catch (err) { if (errnoOf(err) !== 'EEXIST') throw err }
  return onceDir
}

/** O arquivo `name` em algum dia da série: primeiro o dia pedido, depois a varredura (só no caminho raro de quem perdeu a corrida). */
function locateInSerie(serieRoot: string, name: string, preferred: string): string | null {
  if (isFile(preferred)) return preferred
  for (const y of subdirs(serieRoot, /^\d{4}$/)) {
    for (const m of subdirs(path.join(serieRoot, y), /^\d{2}$/)) {
      for (const d of subdirs(path.join(serieRoot, y, m), /^\d{2}$/)) {
        const p = path.join(serieRoot, y, m, d, name)
        if (isFile(p)) return p
      }
    }
  }
  return null
}

/**
 * O nome já foi reivindicado (EEXIST no índice). Mesmos BYTES (da reivindicação E do arquivo do dia) = devolve o caminho do arquivo do
 * dia em que ele está; outros = conflito. UMA varredura para achar o dia do vencedor (caminho raro). Se ele ainda não publicou e a
 * reivindicação é RECENTE (menos de 2 s — volume lento), espera sem varrer de novo (olha o dia pedido a cada 25 ms e varre a cada
 * 0,5 s); passado o prazo o vencedor com certeza caiu (índice sem arquivo do dia): bytes diferentes = conflito; mesmos bytes = quem
 * chega publica no dia dele, refaz a reivindicação e repara. `null` = a reivindicação sumiu enquanto líamos (o vencedor desistiu).
 */
const CLAIM_GRACE_MS = 2000

function resolveClaimed(serieRoot: string, claim: string, full: string, tmp: string, bytes: Buffer): string | null {
  let claimed: Buffer
  let claimedAt: number
  try { claimed = fs.readFileSync(claim); claimedAt = fs.statSync(claim).mtimeMs } catch (err) { if (errnoOf(err) === 'ENOENT') return null; throw err }
  const name = path.basename(claim)
  const same = claimed.equals(bytes)
  let where = locateInSerie(serieRoot, name, full)
  if (where === null && !same) throw new FiscalFileConflictError(claim)
  for (let i = 1; where === null && Date.now() - claimedAt < CLAIM_GRACE_MS; i++) {
    pause(25)
    where = isFile(full) ? full : (i % 20 === 0 ? locateInSerie(serieRoot, name, full) : null)
  }
  if (where !== null) {
    // o arquivo do dia também tem de ser o mesmo (trocado por fora, ou escritor antigo, não passa por "igual")
    if (!same || !fs.readFileSync(where).equals(bytes)) throw new FiscalFileConflictError(where)
    return where
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.linkSync(tmp, full)
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') return sameBytesOrConflict(full, bytes)
    throw err
  }
  // o vencedor desistiu (soltou a reivindicação) enquanto reparávamos: o índice volta a ter o nome, apontando para o arquivo do dia
  try { fs.linkSync(full, claim) } catch (err) { if (errnoOf(err) !== 'EEXIST') throw err }
  return full
}

/** Arquivo que já existe: mesmos BYTES (sem normalizar fim de linha nem BOM) = o caminho dele; outros = conflito. Ilegível sobe como erro alto. */
function sameBytesOrConflict(existing: string, bytes: Buffer): string {
  if (!fs.readFileSync(existing).equals(bytes)) throw new FiscalFileConflictError(existing)
  return existing
}

/** Subpastas no formato, da mais nova para a mais antiga (o XML procurado quase sempre é recente). */
function subdirs(dir: string, re: RegExp): string[] {
  if (!isDir(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && re.test(e.name)).map(e => e.name).sort().reverse()
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}
