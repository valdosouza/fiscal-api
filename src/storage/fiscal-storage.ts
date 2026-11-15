import fs from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { DEFAULT_TIME_ZONE, isValidTimeZone, todayIn } from '../time/zone'
import { CNPJ_FORM } from '../federal-id/federal-id'

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
  /** Grava e devolve um identificador do arquivo (caminho, no disco). */
  save(key: FiscalFileKey, name: string, xml: string, when?: Date): string
  /** Localiza pelo nome usando as dicas de data (UTC do banco); null se não existe. */
  find(key: FiscalFileLookup, name: string, hints?: FiscalDateHint[]): string | null
  read(ref: string): string
  /** /health: a raiz JÁ EXISTE e grava, lê e apaga um arquivo de sonda (nunca cria a raiz — volume desmontado = false). */
  probe(): boolean
}

const NAME_RE = /^[A-Za-z0-9._-]+$/
const ONLY_DOTS = /^\.+$/

/** Nome de arquivo aceito: só [A-Za-z0-9._-], nunca '.', '..' ou só pontos (seriam a pasta, não um arquivo). */
function validName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && !ONLY_DOTS.test(name)
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
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
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
    const serieRoot = path.join(this.kindRoot(key.cnpj, key.environment, key.kind), fiscalSerieFolder(key.serie))
    const dir = this.dayDir(serieRoot, when, assertZone(key.zone))
    // a RAIZ nunca é criada aqui: volume desmontado = erro, nunca o XML no disco efêmero do sistema (sem o backup — P-DEP-2)
    if (!isDir(this.root)) throw new Error(`Raiz do arquivo fiscal não existe: ${this.root}`)
    fs.mkdirSync(dir, { recursive: true })
    const full = path.join(dir, name)
    // nunca um arquivo pela metade (mesma regra do cofre antigo — D-N30): tmp + rename
    const tmp = `${full}.${randomUUID()}.tmp`
    fs.writeFileSync(tmp, xml, 'utf8')
    fs.renameSync(tmp, full)
    return full
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
