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
