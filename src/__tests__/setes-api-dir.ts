// D-F117 (= Q-F123 (a), Valdo 2026-10-12 — Rodada 1 da F2a, `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22.6): a F2a se desenvolve
// numa WORKTREE do setes-api; as cercas do núcleo que vigiam o setes-api leem `SETES_API_DIR` (padrão: a árvore viva) e FALHAM ALTO quando o
// que vigiam some (antes `existsSync` pulava calado — a cerca da D-NE77 não veria o 1º import da A2 na worktree, só depois do merge = deploy).
// Gêmeo de `nfse-api/src/__tests__/voice-kind-fence.ts` (mesmos nomes); o nome relativo segue `setes-api/…` em qualquer pasta.
import fs from 'fs'
import path from 'path'

export const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
export const SETES_API_DIR = path.resolve(process.env.SETES_API_DIR ?? path.join(WORKSPACE, 'setes-api'))

export function mustExist(p: string): true {
  if (!fs.existsSync(p)) {
    throw new Error(`D-F117: a cerca vigia ${p}, que NÃO existe — o arquivo saiu (F2a?) e a cerca precisa ser revista na mesma entrega, ou `
      + 'SETES_API_DIR aponta para o lugar errado')
  }
  return true
}
/** Caminho dentro do setes-api (`SETES_API_DIR`) que TEM de existir. */
export function setesApiPath(...parts: string[]): string {
  const p = path.join(SETES_API_DIR, ...parts)
  mustExist(p)
  return p
}
/** Nome relativo ao workspace, com o setes-api SEMPRE como `setes-api/…` (mesmo numa worktree). */
export function relWorkspace(file: string): string {
  const abs = path.resolve(file)
  if (abs === SETES_API_DIR || abs.startsWith(SETES_API_DIR + path.sep)) return `setes-api/${path.relative(SETES_API_DIR, abs)}`.replace(/\\/g, '/')
  return path.relative(WORKSPACE, abs).replace(/\\/g, '/')
}

/** Arquivos do setes-api (src + scripts) — para as cercas do "depois da F2a" (nada do código fiscal pode ter sobrado). */
export function setesApiSources(): string[] {
  const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : []))
  return [...walk(path.join(SETES_API_DIR, 'src')), ...walk(path.join(SETES_API_DIR, 'scripts'))]
}

/**
 * F2a, etapa A3 (D-F110/D-F50): o setes-api com a F2a APLICADA = a migration de nome FIXO `NNN_f2a_fiscal_passivo.sql` no disco do
 * SETES_API_DIR (o mesmo nome que a nfse-api confere em `_migrations` antes do ato da virada).
 */
export function setesApiF2aApplied(): boolean {
  const dir = path.join(SETES_API_DIR, 'src', 'migrations', 'sql')
  return fs.existsSync(dir) && fs.readdirSync(dir).some(f => /^\d{3}_f2a_fiscal_passivo\.sql$/.test(f))
}

/**
 * D-F117 revisto na A3: caminho que EXISTE até a A3 da F2a e MORRE nela. Existe → devolve o caminho (a cerca do "antes" vale). Não existe
 * → só com a F2a APLICADA no SETES_API_DIR (senão falha ALTO, como o `mustExist`) e devolve null: quem chama confere o invariante do
 * "depois" (o código fiscal saiu do setes-api). Uma árvore sem o arquivo e sem a F2a é um setes-api QUEBRADO, nunca "a cerca passa calada".
 */
export function setesApiPathUntilF2a(...parts: string[]): string | null {
  const p = path.join(SETES_API_DIR, ...parts)
  if (fs.existsSync(p)) return p
  if (!setesApiF2aApplied()) {
    throw new Error(`D-F117: a cerca vigia ${p}, que NÃO existe, e o setes-api em ${SETES_API_DIR} não tem a F2a aplicada `
      + '(migration NNN_f2a_fiscal_passivo.sql) — arquivo sumido fora da A3, ou SETES_API_DIR errado')
  }
  return null
}
