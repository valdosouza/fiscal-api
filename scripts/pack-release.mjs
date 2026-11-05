// D-F221…D-F223 (2026-11-05 — prompt_apis_fiscais_isoladas.md §23): gera o PACOTE versionado do núcleo (`fiscal-api-X.Y.Z.tgz`).
//
// ⚠️ Conhecimento negativo (npm 10.5.0): `npm pack` roda o `prepare` (= build, recompila o `dist`) NA PASTA ONDE RODA — mesmo com
// `--dry-run` e com `--ignore-scripts`. Por isso este script SÓ roda numa cópia LIMPA da tag (worktree descartável), nunca na árvore viva:
// recusa árvore suja, HEAD sem a tag `v<version>` exata e a árvore principal do repositório.
//
// Uso (na worktree da tag):   node scripts/pack-release.mjs <pasta-de-saída>
// Saída: o arquivo, o sha512 (`integrity` que o lock do consumidor grava) e o commit. A prova da reprodução (T2) = rodar de novo em
// OUTRA cópia limpa da mesma tag e conferir o MESMO sha512.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(`[pack-release] RECUSADO: ${msg}`); process.exit(1) }

const out = process.argv[2]
if (!out) fail('informe a pasta de saída')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== 'fiscal-api') fail(`rode na raiz do núcleo (package.json = ${pkg.name})`)
const tag = `v${pkg.version}`

if (git('status', '--porcelain') !== '') fail('árvore com alteração — o pacote nasce só de uma cópia LIMPA da tag')
let exact
try { exact = git('describe', '--tags', '--exact-match', 'HEAD') } catch { fail(`HEAD sem tag — esperado ${tag}`) }
if (exact !== tag) fail(`HEAD na tag ${exact}, esperado ${tag} (a versão do package.json)`)
// a árvore principal é a de desenvolvimento: `--git-common-dir` = `.git` só nela
if (git('rev-parse', '--git-common-dir') === '.git') fail('esta é a árvore PRINCIPAL do repositório — use uma worktree descartável da tag')

const dest = path.resolve(out)
mkdirSync(dest, { recursive: true })
const file = path.join(dest, `fiscal-api-${pkg.version}.tgz`)
if (existsSync(file)) fail(`já existe ${file} — um pacote publicado nunca é regravado (versão nova = número novo)`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['pack', '--pack-destination', dest], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
if (git('status', '--porcelain') !== '') fail('o pack sujou a árvore (o build gera arquivo fora do .gitignore?) — investigar antes de usar o pacote')

const bytes = readFileSync(file)
console.log(JSON.stringify({
  file,
  version: pkg.version,
  tag,
  commit: git('rev-parse', 'HEAD'),
  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  bytes: bytes.length,
}, null, 2))
