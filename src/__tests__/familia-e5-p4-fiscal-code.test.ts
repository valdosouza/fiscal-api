// fiscal-api:FAMILIA.E5.P4.T4 — configuração fiscal por UF: exigências, credenciais do dono certo, boot e escrita (D-NE218, D-NE221,
// D-NE223, D-NE224, D-NE226). Unitário com um banco FALSO na fronteira (as consultas da peça, interpretadas em memória); a prova no MOTOR
// (CHECKs, FK composta, 1062, semente, script) está em `motor-banco.live.test.ts`. Ficha: projetos/fiscal-api/GERAL/
// ficha-familia-e5-p4-pecas-ne4.md §5 T4 (tabela dos 14 cenários do §10 de prompts/ResponsavelTecnicoNFE.txt) e §6 ordem 4.
// Valores de código: FICTÍCIOS (textos de teste inventados) — nunca o da Setes.
import fs from 'fs'
import path from 'path'
import {
  FiscalCodeConflictError, FiscalCodeInvalidError, FiscalCodeMissingError, assertRequiredProviderCodesPresent, endProviderFiscalCredential,
  establishmentFiscalCredentialOf, fiscalCodeRequirementsOf, listProviderFiscalCredentials, providerFiscalCredentialOf,
  requiredFiscalCredentialsFor, saveProviderFiscalCredential,
} from '../fiscal-code/fiscal-code'
import * as barrel from '../index'
import { stripComments } from './fence'

const NT_CSRT = 'FICTICIODETESTE0123456789ABCDEF'   // valor de TESTE, inventado (nunca o da Setes)

type Row = Record<string, any>
interface Db { types: Row[]; reqs: Row[]; prov: Row[]; est: Row[]; issuers: Row[]; inserts: unknown[][]; dupOnInsert?: boolean; failWith?: number }

const db = (): Db => ({
  types: [
    { id: 'CSRT', owner: 'provider', pattern: '^[0-9]{2}$', deleted: 'N' },
    { id: 'CSC', owner: 'taxpayer', pattern: '^[0-9]{1,6}$', deleted: 'N' },
  ],
  reqs: [
    { state: 'PR', model: '55', environment: 'H', type: 'CSRT', validFrom: '2026-01-19 03:00:00', validUntil: null, deleted: 'N' },
    { state: 'PR', model: '55', environment: 'P', type: 'CSRT', validFrom: '2026-02-23 03:00:00', validUntil: null, deleted: 'N' },
  ],
  prov: [], est: [], issuers: [], inserts: [],
})

/** O banco falso: entende SÓ as consultas da peça (pela tabela e pela ordem dos parâmetros). */
function fake(d: Db) {
  const owner = (type: string) => d.types.find(t => t.id === type)?.owner
  return {
    query: jest.fn(async (sql: string, p: any[] = []): Promise<[any, any]> => {
      if (/FROM tb_fiscal_code_requirement r/.test(sql) && /r\.state = \?/.test(sql)) {
        const [state, model, env, at] = p
        return [d.reqs.filter(r => r.state === state && r.model === model && r.environment === env && r.deleted === 'N' && r.validFrom <= at)
          .map(r => ({ type: r.type, owner: owner(r.type), validFrom: r.validFrom, validUntil: r.validUntil })), []]
      }
      if (/FROM tb_fiscal_code_requirement r/.test(sql)) {
        const [model, env, at] = p
        return [d.reqs.filter(r => r.model === model && r.environment === env && r.deleted === 'N' && r.validFrom <= at)
          .map(r => ({ state: r.state, type: r.type, owner: owner(r.type), validFrom: r.validFrom, validUntil: r.validUntil })), []]
      }
      if (/FROM tb_provider_fiscal_credential\s+WHERE state/.test(sql)) {
        const [state, model, env, type, at] = p
        return [d.prov.filter(r => r.state === state && r.model === model && r.environment === env && r.type === type && r.owner === 'provider'
          && r.deleted === 'N' && r.validFrom <= at), []]
      }
      if (/FROM tb_establishment_fiscal_credential/.test(sql)) {
        const [inst, model, env, type, at] = p
        return [d.est.filter(r => r.institutionId === inst && r.model === model && r.environment === env && r.type === type && r.owner === 'taxpayer'
          && r.deleted === 'N' && r.validFrom <= at), []]
      }
      if (/FROM tb_establishment_issuer/.test(sql)) {
        const seen = new Set<string>()
        return [d.issuers.filter(i => i.deleted === 'N' && ['55', '65'].includes(i.model)).filter(i => {
          const k = i.model + i.environment; if (seen.has(k)) return false; seen.add(k); return true
        }).map(i => ({ model: i.model, environment: i.environment })), []]
      }
      if (/FROM tb_fiscal_code_type WHERE id = \?/.test(sql)) return [d.types.filter(t => t.id === p[0] && t.deleted === 'N'), []]
      if (/^\s*INSERT INTO tb_provider_fiscal_credential/.test(sql)) {
        d.inserts.push(p)
        if (d.failWith) {
          // como o mysql2 3.x: o comando montado NO CLIENTE, com os valores dentro, vai em err.sql
          throw Object.assign(new Error('Lock wait timeout exceeded'), { errno: d.failWith, code: 'ER_LOCK_WAIT_TIMEOUT', sql: `INSERT … ${p.join(', ')}` })
        }
        if (d.dupOnInsert) throw Object.assign(new Error(`Duplicate entry 'PR-55-H-CSRT-${p[4]}' for key 'PRIMARY'`), { errno: 1062, code: 'ER_DUP_ENTRY' })
        const [state, model, environment, type, validFrom, validUntil, codeId, codeValue, userId] = p
        d.prov.push({ state, model, environment, type, owner: 'provider', validFrom, validUntil, codeId, codeValue, userId, deleted: 'N' })
        return [{ affectedRows: 1 }, []]
      }
      if (/^\s*UPDATE tb_provider_fiscal_credential/.test(sql) && /valid_from < \?/.test(sql)) {
        const [until, state, model, env, type, from, at] = p
        let n = 0
        for (const x of d.prov) if (x.state === state && x.model === model && x.environment === env && x.type === type && x.validFrom < from
          && x.deleted === 'N' && (x.validUntil === null || x.validUntil > at)) { x.validUntil = until; n++ }
        return [{ affectedRows: n }, []]
      }
      if (/^\s*UPDATE tb_provider_fiscal_credential/.test(sql)) {
        const [until, state, model, env, type, from, at] = p
        const r = d.prov.find(x => x.state === state && x.model === model && x.environment === env && x.type === type && x.validFrom === from
          && x.deleted === 'N' && (x.validUntil === null || x.validUntil > at))
        if (r) r.validUntil = until
        return [{ affectedRows: r ? 1 : 0 }, []]
      }
      if (/FROM tb_provider_fiscal_credential WHERE deleted = 'N'/.test(sql)) {
        return [d.prov.filter(r => r.deleted === 'N').map(r => ({ ...r, userId: r.userId ?? null })), []]
      }
      throw new Error(`consulta não prevista no banco falso: ${sql}`)
    }),
  }
}

const AT = new Date('2026-11-22T12:00:00Z')
const H = { state: 'PR', model: '55', environment: 'H', at: AT }
const cred = (over: Row = {}): Row => ({
  state: 'PR', model: '55', environment: 'H', type: 'CSRT', owner: 'provider', validFrom: '2026-01-01 00:00:00', validUntil: null,
  codeId: '01', codeValue: NT_CSRT, deleted: 'N', ...over,
})
const missingOf = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e) { if (e instanceof FiscalCodeMissingError) return e; throw e }
}

describe('FAMILIA.E5.P4.T4 — leitura (cenários do §10 do ResponsavelTecnicoNFE)', () => {
  it('1 · PR com CSRT do fornecedor vigente → a credencial do dono certo', async () => {
    const d = db(); d.prov.push(cred())
    expect(await requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 7 }))
      .toEqual([{ type: 'CSRT', owner: 'provider', codeId: '01', codeValue: NT_CSRT, validFrom: '2026-01-01 00:00:00' }])
  })

  it('2 · PR sem CSRT → FiscalCodeMissingError com UF, tipo, modelo, ambiente e dono; a mensagem não traz valor nenhum', async () => {
    const e = await missingOf(() => requiredFiscalCredentialsFor(fake(db()), { ...H, institutionId: 7 }))
    expect(e?.code).toBe('FISCAL_CODE_MISSING')
    expect(e?.missing).toEqual([{ state: 'PR', type: 'CSRT', model: '55', environment: 'H', owner: 'provider' }])
    expect(e?.message).toBe('Falta configuração fiscal exigida: CSRT (do fornecedor do software) da UF PR, modelo 55, ambiente H')
  })

  it('3 · duas institutions do PR recebem a MESMA credencial do fornecedor (uma linha só)', async () => {
    const d = db(); d.prov.push(cred())
    const a = await requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 7 })
    const b = await requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 8 })
    expect(a).toEqual(b)
    expect(d.prov).toHaveLength(1)
  })

  it('4, 5, 6 · CSC do contribuinte (regra fictícia de teste SC·65): cada ambiente e cada estabelecimento com o seu — nunca o de outro', async () => {
    const d = db()
    d.reqs.push({ state: 'SC', model: '65', environment: 'P', type: 'CSC', validFrom: '2026-01-01 00:00:00', validUntil: null, deleted: 'N' },
      { state: 'SC', model: '65', environment: 'H', type: 'CSC', validFrom: '2026-01-01 00:00:00', validUntil: null, deleted: 'N' })
    const csc = (institutionId: number, environment: string, codeValue: string): Row => ({
      institutionId, model: '65', environment, type: 'CSC', owner: 'taxpayer', validFrom: '2026-01-01 00:00:00', validUntil: null, codeId: '1', codeValue, deleted: 'N' })
    d.est.push(csc(7, 'P', 'TESTE-CSC-7-P'), csc(7, 'H', 'TESTE-CSC-7-H'), csc(8, 'P', 'TESTE-CSC-8-P'))
    const q = fake(d)
    const of = (institutionId: number, environment: string) =>
      requiredFiscalCredentialsFor(q, { state: 'SC', model: '65', environment, at: AT, institutionId })
    expect((await of(7, 'P'))[0]).toMatchObject({ type: 'CSC', owner: 'taxpayer', codeValue: 'TESTE-CSC-7-P' })
    expect((await of(7, 'H'))[0]).toMatchObject({ codeValue: 'TESTE-CSC-7-H' })
    expect((await of(8, 'P'))[0]).toMatchObject({ codeValue: 'TESTE-CSC-8-P' })
    expect((await missingOf(() => of(8, 'H')))?.missing).toEqual([{ state: 'SC', type: 'CSC', model: '65', environment: 'H', owner: 'taxpayer' }])
    expect(await establishmentFiscalCredentialOf(q, { institutionId: 9, model: '65', environment: 'P', type: 'CSC', at: AT })).toBeNull()
  })

  it('7 · P e H isolados: só a de P → em H falta; só a de H → em P falta', async () => {
    const d = db(); d.prov.push(cred({ environment: 'P' }))
    expect((await missingOf(() => requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 7 })))?.missing[0].environment).toBe('H')
    const d2 = db(); d2.prov.push(cred({ environment: 'H' }))
    expect((await missingOf(() => requiredFiscalCredentialsFor(fake(d2), { ...H, environment: 'P', institutionId: 7 })))?.missing[0].environment).toBe('P')
  })

  it('8 · a regra do 55 não se satisfaz com a credencial do 65', async () => {
    const d = db(); d.prov.push(cred({ model: '65' }))
    expect(await missingOf(() => requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 7 }))).not.toBeNull()
  })

  it('9 · encerrada = falta (a ANTERIOR não volta); apagada = falta; gravada pela peça, a nova ENCERRA a anterior — apagar a nova não a ressuscita', async () => {
    const d = db(); d.prov.push(cred({ validFrom: '2026-01-01 00:00:00' }), cred({ validFrom: '2026-06-01 00:00:00', codeId: '02', validUntil: '2026-11-01 00:00:00' }))
    expect(await providerFiscalCredentialOf(fake(d), { ...H, type: 'CSRT' })).toBeNull()
    const d3 = db(); d3.prov.push(cred({ deleted: 'S' }))
    expect(await providerFiscalCredentialOf(fake(d3), { ...H, type: 'CSRT' })).toBeNull()
    const d4 = db(); const q = fake(d4)
    const base = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeValue: NT_CSRT }
    await saveProviderFiscalCredential(q, { ...base, codeId: '01', validFrom: new Date('2026-01-01T03:00:00Z') })
    await saveProviderFiscalCredential(q, { ...base, codeId: '02', validFrom: new Date('2026-06-01T03:00:00Z') })
    expect(d4.prov.find(r => r.codeId === '01')?.validUntil).toBe('2026-06-01 03:00:00')
    expect((await providerFiscalCredentialOf(q, { ...H, type: 'CSRT' }))?.codeId).toBe('02')
    d4.prov.find(r => r.codeId === '02')!.deleted = 'S'                     // apagada por engano (à mão)
    expect(await providerFiscalCredentialOf(q, { ...H, type: 'CSRT' })).toBeNull()
  })

  it('10 · UF sem regra → lista vazia, sem erro (o documento segue sem o grupo)', async () => {
    expect(await requiredFiscalCredentialsFor(fake(db()), { state: 'SC', model: '55', environment: 'H', at: AT, institutionId: 7 })).toEqual([])
    expect(await fiscalCodeRequirementsOf(fake(db()), { state: 'PR', model: '65', environment: 'P', at: AT })).toEqual([])
  })

  it('11a · antes do início da regra, nada é exigido; a exigência encerrada também não', async () => {
    expect(await fiscalCodeRequirementsOf(fake(db()), { ...H, at: new Date('2026-01-19T02:59:59Z') })).toEqual([])
    expect(await fiscalCodeRequirementsOf(fake(db()), { ...H, at: new Date('2026-01-19T03:00:00Z') })).toEqual([{ type: 'CSRT', owner: 'provider' }])
    const d = db(); d.reqs[0].validUntil = '2026-11-01 00:00:00'
    expect(await fiscalCodeRequirementsOf(fake(d), H)).toEqual([])
  })

  it('12, 13 · o dono decide a tabela: a regra de dono provider nunca lê a do estabelecimento, e o inverso', async () => {
    const d = db()
    d.est.push({ institutionId: 7, model: '55', environment: 'H', type: 'CSRT', owner: 'taxpayer', validFrom: '2026-01-01 00:00:00', validUntil: null, codeId: '01', codeValue: 'X', deleted: 'N' })
    expect(await missingOf(() => requiredFiscalCredentialsFor(fake(d), { ...H, institutionId: 7 }))).not.toBeNull()
    const q = fake(d)
    await providerFiscalCredentialOf(q, { ...H, type: 'CSRT' })
    expect(q.query.mock.calls[0][0]).toMatch(/owner = 'provider'/)
    await establishmentFiscalCredentialOf(q, { institutionId: 7, model: '55', environment: 'H', type: 'CSRT', at: AT })
    expect(q.query.mock.calls[1][0]).toMatch(/owner = 'taxpayer'/)
  })

  it('14 · vigente determinística: com dois inícios diferentes vale o MAIOR ≤ instante; início futuro é ignorado', async () => {
    const d = db(); d.prov.push(cred({ validFrom: '2026-06-01 00:00:00', codeId: '02' }), cred({ validFrom: '2026-01-01 00:00:00', codeId: '01' }),
      cred({ validFrom: '2027-01-01 00:00:00', codeId: '03' }))
    expect((await providerFiscalCredentialOf(fake(d), { ...H, type: 'CSRT' }))?.codeId).toBe('02')
  })

  it('entrada fora do domínio EXATO nunca chega ao SQL (_ci casaria pr com PR)', async () => {
    const q = fake(db())
    for (const [k, v] of [['state', 'pr'], ['state', 'ZZ'], ['model', 'SE'], ['environment', 'h']] as const) {
      await expect(fiscalCodeRequirementsOf(q, { ...H, [k]: v })).rejects.toThrow(FiscalCodeInvalidError)
    }
    await expect(providerFiscalCredentialOf(q, { ...H, type: 'csrt' })).rejects.toThrow(FiscalCodeInvalidError)
    await expect(fiscalCodeRequirementsOf(q, { ...H, at: new Date('x') })).rejects.toThrow(FiscalCodeInvalidError)
    await expect(establishmentFiscalCredentialOf(q, { institutionId: 0, model: '65', environment: 'H', type: 'CSC', at: AT })).rejects.toThrow(FiscalCodeInvalidError)
    expect(q.query).not.toHaveBeenCalled()
  })
})

describe('FAMILIA.E5.P4.T4 — boot (D-NE223)', () => {
  it('sem habilitação 55/65 viva, nada a conferir', async () => {
    await expect(assertRequiredProviderCodesPresent(fake(db()), AT)).resolves.toBeUndefined()
  })
  it('com 55/H viva e sem o CSRT de H do PR → RECUSA dizendo UF, tipo, modelo e ambiente; com a credencial, sobe', async () => {
    const d = db(); d.issuers.push({ model: '55', environment: 'H', deleted: 'N' }, { model: 'SE', environment: 'P', deleted: 'N' })
    await expect(assertRequiredProviderCodesPresent(fake(d), AT)).rejects.toThrow('CSRT (do fornecedor do software) da UF PR, modelo 55, ambiente H')
    d.prov.push(cred())
    await expect(assertRequiredProviderCodesPresent(fake(d), AT)).resolves.toBeUndefined()
  })
  it('todas as faltas numa mensagem só (55/H e 55/P); habilitação apagada não conta; regra de dono taxpayer fica para a nota', async () => {
    const d = db()
    d.issuers.push({ model: '55', environment: 'H', deleted: 'N' }, { model: '55', environment: 'P', deleted: 'N' }, { model: '65', environment: 'P', deleted: 'S' })
    d.reqs.push({ state: 'SC', model: '55', environment: 'H', type: 'CSC', validFrom: '2026-01-01 00:00:00', validUntil: null, deleted: 'N' })
    const e = await missingOf(() => assertRequiredProviderCodesPresent(fake(d), AT))
    expect(e?.missing).toEqual([
      { state: 'PR', type: 'CSRT', model: '55', environment: 'H', owner: 'provider' },
      { state: 'PR', type: 'CSRT', model: '55', environment: 'P', owner: 'provider' },
    ])
  })
})

describe('FAMILIA.E5.P4.T4 — escrita e listagem (D-NE224, D-NE226)', () => {
  const input = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '01', codeValue: NT_CSRT, validFrom: new Date('2026-11-22T03:00:00Z') }

  it('grava pela PK e devolve tudo MENOS o valor; a leitura acha a credencial', async () => {
    const d = db(); const q = fake(d)
    const row = await saveProviderFiscalCredential(q, input)
    expect(row).toEqual({ state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '01', validFrom: '2026-11-22 03:00:00', validUntil: null, userId: null })
    expect(JSON.stringify(row)).not.toContain(NT_CSRT)
    expect((await providerFiscalCredentialOf(q, { ...H, at: new Date('2026-11-23T00:00:00Z'), type: 'CSRT' }))?.codeValue).toBe(NT_CSRT)
    const list = await listProviderFiscalCredentials(q)
    expect(list).toEqual([row])
    expect(JSON.stringify(list)).not.toContain(NT_CSRT)
  })

  it('11b · configuração inválida recusa pelo CAMPO, sem o valor na mensagem', async () => {
    const field = async (over: Record<string, unknown>) => {
      try { await saveProviderFiscalCredential(fake(db()), { ...input, ...over } as any); return 'gravou' } catch (e) {
        expect((e as Error).message).not.toContain(NT_CSRT)
        return e instanceof FiscalCodeInvalidError ? e.field : `OUTRO: ${(e as Error).message}`
      }
    }
    expect(await field({ codeId: '3' })).toBe('codeId')
    expect(await field({ codeId: '003' })).toBe('codeId')
    expect(await field({ codeId: '01234567890' })).toBe('codeId')
    expect(await field({ codeValue: '' })).toBe('codeValue')
    expect(await field({ codeValue: ` ${NT_CSRT}` })).toBe('codeValue')
    expect(await field({ codeValue: 'A'.repeat(101) })).toBe('codeValue')
    expect(await field({ codeValue: 'Ação' })).toBe('codeValue')
    expect(await field({ type: 'CSC' })).toBe('type')                   // tipo de dono contribuinte não vai à tabela do fornecedor
    expect(await field({ type: 'XYZ' })).toBe('type')
    expect(await field({ state: 'pr' })).toBe('state')
    expect(await field({ validFrom: new Date('x') })).toBe('validFrom')
    expect(await field({ validUntil: new Date('2026-11-22T03:00:00Z') })).toBe('validUntil')
    expect(await field({ userId: 0 })).toBe('userId')
  })

  it('14 · mesmo início de vigência → 1062 vira FiscalCodeConflictError (FISCAL_CODE_CONFLICT), sem o valor', async () => {
    const d = db(); d.dupOnInsert = true
    const e = await saveProviderFiscalCredential(fake(d), input).catch(x => x)
    expect(e).toBeInstanceOf(FiscalCodeConflictError)
    expect(e.code).toBe('FISCAL_CODE_CONFLICT')
    expect(e.message).not.toContain(NT_CSRT)
  })

  it('MED-1 do gate: erro do BANCO na gravação sai como FiscalCodeStoreError, SEM o SQL do driver (que leva o valor)', async () => {
    const d = db(); d.failWith = 1205
    const e = await saveProviderFiscalCredential(fake(d), input).catch(x => x)
    expect(e.code).toBe('FISCAL_CODE_STORE_FAILED')
    expect(e.errno).toBe(1205)
    expect(e.sql).toBeUndefined()
    expect(JSON.stringify(e)).not.toContain(NT_CSRT)
    expect(String(e.message) + String(e.stack)).not.toContain(NT_CSRT)
  })

  it('encerrar: a vigente deixa de valer no instante; encerrar de novo não encerra; o fim antes do início recusa', async () => {
    const d = db(); const q = fake(d)
    await saveProviderFiscalCredential(q, input)
    const key = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', validFrom: input.validFrom }
    expect(await endProviderFiscalCredential(q, key, new Date('2026-11-30T00:00:00Z'))).toBe(true)
    expect(await endProviderFiscalCredential(q, key, new Date('2026-12-30T00:00:00Z'))).toBe(false)
    expect(await providerFiscalCredentialOf(q, { ...H, at: new Date('2026-11-29T00:00:00Z'), type: 'CSRT' })).not.toBeNull()
    expect(await providerFiscalCredentialOf(q, { ...H, at: new Date('2026-11-30T00:00:00Z'), type: 'CSRT' })).toBeNull()
    await expect(endProviderFiscalCredential(q, key, new Date('2026-11-01T00:00:00Z'))).rejects.toThrow(FiscalCodeInvalidError)
  })
})

describe('FAMILIA.E5.P4.T4 — cercas', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '..', 'fiscal-code', 'fiscal-code.ts'), 'utf8')
  it('o valor nunca vai a log nem a mensagem de erro: a peça não usa o logger nem interpola codeValue/code_value em texto, e não relança o erro cru do driver', () => {
    expect(stripComments(code)).not.toMatch(/logger|console\./)
    expect(stripComments(code)).not.toMatch(/throw err/)
    expect(code).not.toMatch(/\$\{[^}]*(codeValue|code_value)[^}]*\}/)
  })
  it('sem `if (uf === …)`: nenhuma sigla de UF decide código (só a lista do domínio e as sondas do boot)', () => {
    const outside = stripComments(code).replace(/FISCAL_CODE_STATES = Object\.freeze\(\[[\s\S]*?\]/, '').replace(/STATE_OK = 'PR'/, '')
    expect(outside).not.toMatch(/===\s*'(?:AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)'/)
  })
  it('a migration 006 é a única com o valor em claro e diz a exceção nomeada (D-NE223)', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', 'sql', '006_fiscal_code.sql'), 'utf8')
    expect(sql).toMatch(/EXCEÇÃO NOMEADA \(D-NE223/)
    expect(sql).not.toMatch(/INSERT INTO `tb_(provider|establishment)_fiscal_credential`/)   // a semente nunca traz credencial
  })
  it('sai pelo barrel do núcleo', () => {
    expect(barrel.requiredFiscalCredentialsFor).toBe(requiredFiscalCredentialsFor)
    expect(barrel.assertFiscalCodeDomainsEnforced).toBeDefined()
  })
})
