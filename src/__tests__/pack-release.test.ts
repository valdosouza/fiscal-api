/// <reference types="jest" />
// D-F221 (2026-11-05 — prompt_apis_fiscais_isoladas.md §23) + gate adversarial do DEPLOY.E1.P1 (M2, L1, L3): o `scripts/pack-release.mjs`
// roda num repositório git TEMPORÁRIO de mentira (um "fiscal-api" mínimo, sem dependências) — nunca na árvore do núcleo.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'

jest.setTimeout(240_000)

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'pack-release.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-release-test-'))
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** Repositório "fiscal-api" mínimo com a tag `v<version>`; `prepare` opcional (para sujar a cópia). */
function fakeCore(name: string, version: string, prepare?: string): string {
  const repo = path.join(tmp, name)
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  const pkg: Record<string, unknown> = { name: 'fiscal-api', version, private: true, files: ['index.js'] }
  if (prepare) pkg.scripts = { prepare }
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
    name: 'fiscal-api', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'fiscal-api', version } },
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* text=auto eol=lf\n')
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'pack-release.mjs'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'teste@local')
  git(repo, 'config', 'user.name', 'teste')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'tag', '-a', `v${version}`, '-m', 'teste')
  return repo
}

const pack = (repo: string, tag: string, out: string) =>
  spawnSync(process.execPath, ['scripts/pack-release.mjs', tag, out], { cwd: repo, encoding: 'utf8' })

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('pack-release.mjs', () => {
  it('caminho feliz: grava o pacote com a integridade e não deixa cópia temporária nem worktree registrada', () => {
    const repo = fakeCore('ok', '1.0.0')
    const out = path.join(tmp, 'saida-ok')
    const r = pack(repo, 'v1.0.0', out)
    expect(r.status).toBe(0)
    const res = JSON.parse(r.stdout)
    expect(res.file).toBe(path.join(out, 'fiscal-api-1.0.0.tgz'))
    expect(res.integrity).toMatch(/^sha512-/)
    expect(fs.existsSync(res.file)).toBe(true)
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    // a 2ª execução recusa regravar
    const again = pack(repo, 'v1.0.0', out)
    expect(again.status).toBe(1)
    expect(again.stderr).toMatch(/nunca é regravado/)
  })

  it('[M2] build que suja a cópia: RECUSA e NÃO deixa o pacote recusado na saída (nem cria a pasta de saída)', () => {
    const repo = fakeCore('sujo', '1.0.9', `node -e "require('fs').writeFileSync('lixo.txt','x')"`)
    const out = path.join(tmp, 'saida-suja')
    const r = pack(repo, 'v1.0.9', out)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/sujou a cópia/)
    expect(fs.existsSync(path.join(out, 'fiscal-api-1.0.9.tgz'))).toBe(false)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('[L1] recusa não poda a worktree de OUTRA pessoa cuja pasta está fora do ar', () => {
    const repo = fakeCore('alheia', '1.0.0')
    fs.writeFileSync(path.join(repo, 'package.json'), fs.readFileSync(path.join(repo, 'package.json'), 'utf8').replace('"1.0.0"', '"1.0.1"'))
    git(repo, 'commit', '-q', '-am', 'versão 1.0.1 sem tag certa')
    git(repo, 'tag', '-a', 'v1.0.2', '-m', 'tag com versão divergente')
    const other = path.join(tmp, 'wt-alheia')
    git(repo, 'worktree', 'add', '-q', '--detach', other, 'HEAD')
    fs.rmSync(other, { recursive: true, force: true })                     // disco removível desligado, por exemplo
    const r = pack(repo, 'v1.0.2', path.join(tmp, 'saida-alheia'))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/versão 1\.0\.1/)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('wt-alheia')
    expect(fs.existsSync(path.join(tmp, 'saida-alheia'))).toBe(false)
  })

  it('[D-F226] aceita o número de RASCUNHO por iteração (1.1.0-ne3.1) e grava o arquivo com o nome dele', () => {
    const repo = fakeCore('rascunho', '1.1.0-ne3.1')
    const out = path.join(tmp, 'saida-rascunho')
    const r = pack(repo, 'v1.1.0-ne3.1', out)
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(out, 'fiscal-api-1.1.0-ne3.1.tgz'))).toBe(true)
  })

  it('recusa tag malformada e tag inexistente antes de criar qualquer coisa', () => {
    const repo = fakeCore('tags', '1.0.0')
    for (const tag of ['1.0.0', 'v1.0', 'v1.0.0-', 'v1.0.0-RC', 'v1.0.0-a..1', 'v1.0.0 ', 'v1.0.0;calc']) expect(pack(repo, tag, path.join(tmp, 'x')).status).toBe(1)
    expect(pack(repo, 'v9.9.9', path.join(tmp, 'x')).stderr).toMatch(/não existe/)
    expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false)
  })
})
