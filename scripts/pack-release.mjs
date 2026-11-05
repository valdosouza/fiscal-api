// D-F221…D-F223 (2026-11-05 — prompt_apis_fiscais_isoladas.md §23): gera o PACOTE versionado do núcleo (`fiscal-api-X.Y.Z.tgz`).
//
// O pacote nasce SEMPRE de uma cópia NOVA da tag, criada por este script numa pasta temporária (worktree destacada) e apagada no fim:
// ⚠️ Conhecimento negativo (npm 10.5.0): (1) `npm pack` roda o `prepare` (= build, recompila o `dist`) NA PASTA ONDE RODA — mesmo com
// `--dry-run` e `--ignore-scripts`; numa árvore de trabalho ele recompilaria o `dist` de quem usa a pasta. (2) O `npm pack` NÃO normaliza o
// fim de linha: um arquivo editado e não re-extraído (LF) × o mesmo arquivo extraído com `core.autocrlf=true` (CRLF) dão integridades
// DIFERENTES com o mesmo commit — e o `git status` não acusa (compara normalizado). Por isso o `.gitattributes` fixa LF em tudo o que vai
// no pacote, o `tsconfig.build.json` fixa `newLine: lf` no `dist`, e a cópia é sempre NOVA.
//
// Uso (de qualquer clone do núcleo; a pasta atual não é tocada):   node scripts/pack-release.mjs <tag vX.Y.Z> <pasta-de-saída>
// Saída: o arquivo, o sha512 (`integrity` que o lock do consumidor grava) e o commit. A prova da reprodução (T2 do DEPLOY.E1.P1) = rodar
// de novo e conferir o MESMO sha512 (o `npm pack` fixa a data dos arquivos em 1985-10-26).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

class Refused extends Error {}
// `throw`, nunca `process.exit` — o `finally` que apaga a cópia temporária tem de rodar
const fail = (msg) => { throw new Refused(msg) }
// no Windows o `npm` é um .cmd e o node (≥ 20.12/21.7.3) só o abre com `shell` — que junta os argumentos SEM aspas: argumento com espaço
// ou aspas é recusado em vez de partido em dois
const run = (cmd, args, cwd, stdio = 'pipe') => {
  const shell = process.platform === 'win32' && cmd === 'npm'
  if (shell && args.some(a => /[\s"'&|<>^%]/.test(a))) fail(`argumento com espaço ou símbolo do shell: ${JSON.stringify(args)}`)
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio, shell })
}
const git = (cwd, ...a) => run('git', a, cwd).trim()

function main() {
  const [tag, out] = process.argv.slice(2)
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || !out) fail('uso: node scripts/pack-release.mjs vX.Y.Z <pasta-de-saída>')

  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel')
  let commit
  try { commit = git(repo, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`) } catch { fail(`a tag ${tag} não existe neste clone`) }

  const dest = path.resolve(out)
  const version = tag.slice(1)
  const file = path.join(dest, `fiscal-api-${version}.tgz`)
  if (existsSync(file)) fail(`já existe ${file} — um pacote publicado nunca é regravado (versão nova = número novo)`)

  const work = mkdtempSync(path.join(tmpdir(), `fiscal-api-${tag}-`))
  const copy = path.join(work, 'fiscal-api')
  try {
    git(repo, 'worktree', 'add', '--detach', copy, commit)
    const pkg = JSON.parse(readFileSync(path.join(copy, 'package.json'), 'utf8'))
    if (pkg.name !== 'fiscal-api') fail(`a tag ${tag} não é do núcleo (package.json = ${pkg.name})`)
    if (pkg.version !== version) fail(`a tag ${tag} aponta para um package.json com a versão ${pkg.version}`)

    run('npm', ['ci', '--no-audit', '--no-fund'], copy, ['ignore', 'ignore', 'inherit'])
    mkdirSync(dest, { recursive: true })
    run('npm', ['pack', '--pack-destination', dest], copy, ['ignore', 'ignore', 'inherit'])
    if (git(copy, 'status', '--porcelain') !== '') fail('o build sujou a cópia da tag (arquivo gerado fora do .gitignore?) — investigar')

    const bytes = readFileSync(file)
    console.log(JSON.stringify({
      file,
      version,
      tag,
      commit,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      bytes: bytes.length,
    }, null, 2))
  } finally {
    // a cópia não tem junção (o núcleo não depende de `file:`), então apagar a pasta não segue para fora dela
    try { git(repo, 'worktree', 'remove', '--force', copy) } catch { /* a remoção abaixo resolve */ }
    rmSync(work, { recursive: true, force: true })
    try { git(repo, 'worktree', 'prune') } catch { /* nada */ }
  }
}

try {
  main()
} catch (e) {
  console.error(`[pack-release] RECUSADO: ${e instanceof Refused ? e.message : (e && e.message) || e}`)
  process.exitCode = 1
}
