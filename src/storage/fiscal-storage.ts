import fs from 'fs'
import path from 'path'
import { DEFAULT_TIME_ZONE, monthIn } from '../time/zone'
import { CNPJ_FORM } from '../federal-id/federal-id'

/**
 * ARQUIVO FISCAL (XML dito ao fisco e devolvido por ele) atrás de uma interface com backend
 * trocável (D-F16): filesystem no dev; objeto S3-compatível ou volume compartilhado decidido na F3.
 * Layout herdado do setes-api (para os XMLs da Setes ficarem onde estão no dev):
 *   <root>/<cnpj>/<ano>/<mês>/<nome>       — PRODUÇÃO (o que vai para o contador)
 *   <root>/<cnpj>/H/<ano>/<mês>/<nome>     — HOMOLOGAÇÃO (Q-N38a)
 * Mês = mês contábil NA ZONA do estabelecimento (Q-TZ7); a busca também tenta o mês da hora oficial.
 */

export type FiscalFileEnvironment = 'H' | 'P'

export interface FiscalStorage {
  /** Grava e devolve um identificador do arquivo (caminho, no fs). */
  save(cnpj: string, name: string, xml: string, when: Date, environment: FiscalFileEnvironment, zone: string): string
  /** Localiza pelo nome usando as dicas de data (UTC do banco); null se não existe. */
  find(cnpj: string, name: string, hints: (string | null | undefined)[], environment: FiscalFileEnvironment, zone: string): string | null
  read(ref: string): string
  /** /health: a raiz responde (existe ou pode ser criada e escrita). */
  probe(): boolean
}

const NAME_RE = /^[A-Za-z0-9._-]+$/

export class FsFiscalStorage implements FiscalStorage {
  constructor(private readonly root: string) {}

  private cnpjRoot(cnpj: string, environment: FiscalFileEnvironment): string {
    // D-CJ2: a pasta é a FORMA CANÔNICA (letras maiúsculas — o Windows ignora a caixa, o Linux não: uma forma só, nunca duas pastas);
    // nunca tirar caracteres (o CNPJ alfanumérico viraria a pasta de OUTRO número)
    if (typeof cnpj !== 'string' || !CNPJ_FORM.test(cnpj)) throw new Error(`CNPJ inválido para o arquivo fiscal: ${cnpj}`)
    const base = path.join(this.root, cnpj)
    return environment === 'H' ? path.join(base, 'H') : base
  }

  private monthDir(cnpj: string, when: Date, environment: FiscalFileEnvironment, zone: string): string {
    const [year, month] = monthIn(zone, when).split('-')
    return path.join(this.cnpjRoot(cnpj, environment), year, month)
  }

  save(cnpj: string, name: string, xml: string, when: Date = new Date(), environment: FiscalFileEnvironment = 'P', zone: string = DEFAULT_TIME_ZONE): string {
    if (!NAME_RE.test(name)) throw new Error(`Nome de arquivo fiscal inválido: ${name}`)
    const dir = this.monthDir(cnpj, when, environment, zone)
    fs.mkdirSync(dir, { recursive: true })
    const full = path.join(dir, name)
    // nunca um arquivo pela metade (mesma regra do cofre antigo — D-N30): tmp + rename
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, xml, 'utf8')
    fs.renameSync(tmp, full)
    return full
  }

  find(cnpj: string, name: string, hints: (string | null | undefined)[] = [], environment: FiscalFileEnvironment = 'P', zone: string = DEFAULT_TIME_ZONE): string | null {
    if (!NAME_RE.test(name)) return null                      // '../..' nunca sai da pasta do CNPJ
    const roots: FiscalFileEnvironment[] = environment === 'H' ? ['H', 'P'] : ['P']
    for (const env of roots) {
      for (const h of hints) {
        if (!h) continue
        const d = new Date(`${String(h).replace(' ', 'T')}Z`)     // dicas vêm do banco em UTC (Q-TZ1)
        if (Number.isNaN(d.getTime())) continue
        for (const z of zone === DEFAULT_TIME_ZONE ? [zone] : [zone, DEFAULT_TIME_ZONE]) {
          const p = path.join(this.monthDir(cnpj, d, env, z), name)
          if (fs.existsSync(p)) return p
        }
      }
      const root = this.cnpjRoot(cnpj, env)
      if (!fs.existsSync(root)) continue
      for (const y of fs.readdirSync(root)) {
        if (!/^\d{4}$/.test(y)) continue                         // só pastas de ANO (a `H` não é varrida por P)
        const yd = path.join(root, y)
        if (!fs.statSync(yd).isDirectory()) continue
        for (const m of fs.readdirSync(yd)) {
          const p = path.join(yd, m, name)
          if (fs.existsSync(p)) return p
        }
      }
    }
    return null
  }

  read(ref: string): string {
    return fs.readFileSync(ref, 'utf8')
  }

  probe(): boolean {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.accessSync(this.root, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
}
