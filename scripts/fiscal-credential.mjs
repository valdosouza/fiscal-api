// D-NE226 (Valdo 2026-11-22, `prompt_onda_nfe_sefaz.md` §22.7; fiscal-api:FAMILIA.E5.P4.T4): CADASTRO de uma credencial fiscal do
// FORNECEDOR (o CSRT da Setes) até a tela existir (`setes-app:NFE.E2.P1`). Ferramenta SÓ do Valdo — roda do clone, depois do `npm run build`
// (importa do `dist/`); `scripts/` fica fora do pacote.
//
// O VALOR é lido da ENTRADA PADRÃO — sem eco quando é terminal. NUNCA argumento (ficaria no histórico do shell e na lista de processos),
// nunca arquivo versionado, nunca log: o script imprime só o que gravou, sem o valor.
//
// Uso:
//   node scripts/fiscal-credential.mjs --env-file <.env do serviço> --state PR --model 55 --environment H --type CSRT --code-id 01 \
//        --valid-from 2026-11-22T00:00:00-03:00
// O `.env` é lido pelo mesmo leitor simples `CHAVE=valor` da suíte ao vivo (sem dotenv — D-F224): DB_HOST, DB_PORT, DB_USER, DB_PASSWORD,
// FISCAL_DB_NAME. A sessão é a da casa (pool do núcleo: UTC, estrita).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function readEnvFile(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function parseArgs(argv) {
  const want = ['env-file', 'state', 'model', 'environment', 'type', 'code-id', 'valid-from']
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '')
    if (!want.includes(k) || argv[i + 1] === undefined) throw new Error(`argumento inesperado: ${argv[i]} (esperados: ${want.map(w => `--${w}`).join(' ')})`)
    out[k] = argv[i + 1]
  }
  for (const k of want) if (!out[k]) throw new Error(`falta --${k}`)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(out['valid-from'])) {
    throw new Error('--valid-from tem de ser um instante com fuso, ex.: 2026-11-22T00:00:00-03:00')
  }
  return out
}

/** O valor pela entrada padrão: terminal = sem eco, caractere a caractere até o Enter; cano = tudo, sem a quebra final. */
function readSecret(prompt) {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let s = ''
      stdin.setEncoding('utf8')
      stdin.on('data', c => { s += c })
      stdin.on('end', () => resolve(s.replace(/\r?\n$/, '')))
      stdin.on('error', reject)
    })
  }
  return new Promise(resolve => {
    process.stderr.write(prompt)
    let s = ''
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); resolve(s); return
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); continue }
        s += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = { ...readEnvFile(args['env-file']) }
  const core = await import(pathToFileURL(path.resolve(here, '..', 'dist', 'index.js')).href)
  const value = await readSecret(`Valor do ${args.type} (${args.state} ${args.model} ${args.environment}) — não aparece na tela: `)
  const pool = core.createFiscalPool(core.dbConfigFromEnv(env))
  const conn = await pool.getConnection()
  try {
    // a gravação e o encerramento da anterior numa transação só (gate socrático): ou as duas, ou nenhuma
    await conn.beginTransaction()
    const row = await core.saveProviderFiscalCredential(conn, {
      state: args.state, model: args.model, environment: args.environment, type: args.type, codeId: args['code-id'], codeValue: value,
      validFrom: new Date(args['valid-from']), userId: null,
    })
    await conn.commit()
    console.log(`gravado: ${row.state} ${row.type} ${row.model} ${row.environment} code_id=${row.codeId} desde ${row.validFrom} (UTC)`)
  } catch (err) {
    await conn.rollback().catch(() => undefined)
    throw err
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch(err => {
  // a mensagem das peças nunca carrega o valor; a de outro erro (banco) também não o tem
  console.error(`não gravado: ${err?.message ?? err}`)
  process.exit(1)
})
