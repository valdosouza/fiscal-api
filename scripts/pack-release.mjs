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
import { readFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, copyFileSync, constants as fsConstants } from 'node:fs'
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
  // D-F226: número de RASCUNHO por iteração de uma frente (`v1.1.0-ne3.1`, `-ne3.2`…) — cada tentativa tem arquivo NOVO (o cache do npm
  // entrega calado o conteúdo antigo de um nome repetido); a cerca dos consumidores recusa rascunho no `main` deles
  // semver sem zero à esquerda; rascunho = <frente>.<n> (letra primeiro, iteração ≥ 1) — gate adversarial do delta, LOW 5
  if (!tag || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-z][0-9a-z]*\.[1-9]\d*)?$/.test(tag) || !out) fail('uso: node scripts/pack-release.mjs vX.Y.Z[-frente.N] <pasta-de-saída>')

  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel')
  let commit
  try { commit = git(repo, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`) } catch { fail(`a tag ${tag} não existe neste clone`) }

  // tudo o que pode recusar barato recusa ANTES de criar qualquer coisa (gate adversarial L3)
  const dest = path.resolve(out)
  const version = tag.slice(1)
  const file = path.join(dest, `fiscal-api-${version}.tgz`)
  if (existsSync(file)) fail(`já existe ${file} — um pacote publicado nunca é regravado (versão nova = número novo)`)

  // D-F229: a suíte do núcleo VERDE no commit da tag é condição do pacote (desde a D-F228 as cercas sobre o fonte do núcleo moram SÓ nela).
  // Ela roda NESTA pasta (não na cópia de %TEMP%): vários testes do núcleo leem as pastas irmãs do workspace (nfse-api, setes-api) — numa
  // cópia isolada não provariam nada. Por isso esta pasta tem de estar EXATAMENTE na tag e sem alteração; o `npm test` não compila nada.
  if (git(repo, 'rev-parse', 'HEAD') !== commit) fail(`a suíte roda nesta pasta, que tem de estar NA tag ${tag} (git checkout ${tag} ou o ff do main antes)`)
  if (git(repo, 'status', '--porcelain') !== '') fail('esta pasta tem alteração ou arquivo novo — a suíte tem de rodar sobre o commit da tag, limpo')
  try { run('npm', ['test'], repo, ['ignore', 'ignore', 'inherit']) } catch { fail(`a suíte do núcleo FALHOU no commit da tag ${tag} — nada foi empacotado (D-F229)`) }

  const work = mkdtempSync(path.join(tmpdir(), `fiscal-api-${tag}-`))
  const copy = path.join(work, 'fiscal-api')
  const staging = path.join(work, 'pacote')
  const cleanup = () => {
    // só a cópia DESTE script — nunca `git worktree prune` global (podaria worktree alheia com a pasta fora do ar — gate adversarial L1)
    try { git(repo, 'worktree', 'remove', '--force', copy) } catch { /* a remoção da pasta abaixo resolve; o registro órfão fica com o nome fiscal-api-vX… */ }
    rmSync(work, { recursive: true, force: true })
  }
  // Ctrl+C/encerramento no meio do `npm ci` também limpa (kill forçado do processo NÃO roda nada: sobra a pasta em %TEMP% com o nome
  // `fiscal-api-vX.Y.Z-*` e o registro da worktree — limpar com `git worktree remove --force <pasta>` — gate adversarial L2)
  const onSignal = (sig) => { cleanup(); console.error(`[pack-release] INTERROMPIDO (${sig}) — nada foi gravado na saída`); process.exit(130) }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(sig, onSignal)
  try {
    git(repo, 'worktree', 'add', '--detach', copy, commit)
    const pkg = JSON.parse(readFileSync(path.join(copy, 'package.json'), 'utf8'))
    if (pkg.name !== 'fiscal-api') fail(`a tag ${tag} não é do núcleo (package.json = ${pkg.name})`)
    if (pkg.version !== version) fail(`a tag ${tag} aponta para um package.json com a versão ${pkg.version}`)

    run('npm', ['ci', '--no-audit', '--no-fund'], copy, ['ignore', 'ignore', 'inherit'])
    mkdirSync(staging)
    // empacota DENTRO da pasta temporária; a saída só recebe o arquivo depois de TODAS as conferências (gate adversarial M2 — o pacote
    // recusado ficava na saída com o nome canônico e a 2ª execução o tratava como "já publicado")
    run('npm', ['pack', '--pack-destination', path.relative(copy, staging)], copy, ['ignore', 'ignore', 'inherit'])   // relativo: %TEMP% com espaço (LOW 8)
    if (git(copy, 'status', '--porcelain') !== '') fail('o build sujou a cópia da tag (arquivo gerado fora do .gitignore?) — investigar')
    const staged = path.join(staging, `fiscal-api-${version}.tgz`)
    if (!existsSync(staged)) fail(`o npm pack não gerou fiscal-api-${version}.tgz`)

    const bytes = readFileSync(staged)
    mkdirSync(dest, { recursive: true })
    if (existsSync(file)) fail(`já existe ${file} — alguém gravou enquanto o pacote era gerado`)
    copyFileSync(staged, file, fsConstants.COPYFILE_EXCL)
    console.log(JSON.stringify({
      file,
      version,
      tag,
      commit,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      bytes: bytes.length,
    }, null, 2))
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.removeListener(sig, onSignal)
    cleanup()
  }
}

try {
  main()
} catch (e) {
  console.error(`[pack-release] RECUSADO: ${e instanceof Refused ? e.message : (e && e.message) || e}`)
  process.exitCode = 1
}
