/// <reference types="jest" />
// fiscal-api:DEPLOY.E1.P4 (PM-4; ficha `projetos/fiscal-api/SUBJECT/DEPLOY/ficha-pacote-2-0-0.md`, prompt_apis_fiscais_isoladas.md §23.13,
// §23.15 e §23.19): T1 — o CORS por ambiente (D-F236); T2 — a licença sem usuário `access.licensedKeys` (D-F240 + D-F247).
import { HttpError } from '../errors/http-error'
import { assertCorsOrigins } from '../http/http'
import { isProductionEnv } from '../util/environment'
import { fiscalStorageRootFromEnv } from '../storage/fiscal-storage'
import { licensedKeys } from '../access/access'
import * as accessSurface from '../access'
import fs from 'fs'
import { setesApiPath } from './setes-api-dir'

describe('CORS por ambiente — D-F236 (assertCorsOrigins com o NODE_ENV)', () => {
  const recusa = (o: string, env: string | undefined) => {
    try { assertCorsOrigins([o], env); return null } catch (e) { return (e as Error).message }
  }

  it('em produção passa https:// de host público', () => {
    expect(assertCorsOrigins(['https://app.x.com.br', 'https://app.setes.com.br'], 'production'))
      .toBe('https://app.x.com.br, https://app.setes.com.br')
  })

  it('em produção recusa http:// e qualquer localhost (127.0.0.1 e *.localhost contam), citando a D-F236', () => {
    for (const o of ['http://localhost:5051', 'https://localhost:5051', 'https://127.0.0.1', 'http://127.0.0.1:8080',
      'https://app.localhost', 'https://localhost', 'https://127.0.0.2', 'https://127.255.255.254', 'https://0.0.0.0']) {
      expect([o, recusa(o, 'production')]).toEqual([o, expect.stringMatching(/D-F236/)])
    }
    expect(recusa('http://app.x.com.br', 'production')).toMatch(/D-F146/)
    expect(recusa('https://127.1', 'production')).toMatch(/D-F146/)          // IPv4 abreviado: fora da forma canônica (o navegador manda 127.0.0.1)   // http público: a D-F146 já recusava, em qualquer ambiente
  })

  it('em produção um item ruim recusa a lista inteira', () => {
    expect(recusa('https://app.x.com.br', 'production')).toBeNull()
    expect(() => assertCorsOrigins(['https://app.x.com.br', 'http://localhost:5051'], 'production')).toThrow(/localhost em produção.*D-F236/)
  })

  it('fora de produção segue a D-F146 como antes: localhost http passa, http público recusa', () => {
    for (const env of ['development', undefined, 'test', '', 'staging']) {
      expect(assertCorsOrigins(['http://localhost:5051', 'https://app.x.com.br'], env)).toBe('http://localhost:5051, https://app.x.com.br')
      expect(recusa('http://app.x.com.br', env)).toMatch(/D-F146/)
    }
  })

  it('as regras da forma canônica (D-F146) valem também em produção e vêm antes', () => {
    expect(recusa('*', 'production')).toMatch(/curinga.*D-F146/)
    expect(recusa('HTTPS://APP.X.COM.BR', 'production')).toMatch(/forma canônica.*D-F146/)
    expect(() => assertCorsOrigins([], 'production')).toThrow(/vazia.*D-F146/)
  })

  it('produção pelo critério ÚNICO do núcleo — o mesmo do storage (maiúscula e espaço contam)', () => {
    for (const env of ['production', 'Production', ' PRODUCTION ', 'production\n']) {
      expect([env, isProductionEnv(env)]).toEqual([env, true])
      expect(recusa('http://localhost:5051', env)).toMatch(/D-F236/)
      expect(() => fiscalStorageRootFromEnv({ NODE_ENV: env } as NodeJS.ProcessEnv, '/app')).toThrow(/STORAGE_PATH ausente em produção/)
    }
    for (const env of [undefined, '', 'prod', 'development', 'productionx']) expect([env, isProductionEnv(env)]).toEqual([env, false])
  })
})

type Call = { sql: string; params: any[] }
function fakeDb(answer: (sql: string, params: any[]) => any[]) {
  const calls: Call[] = []
  const q = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      return [answer(sql, params), []]
    }),
  }
  return { q: q as any, calls }
}

describe('licensedKeys — a licença do ESTABELECIMENTO sem usuário (D-F240 + D-F247)', () => {
  const WHO = { institutionId: 7, schemaName: 'setes_acme' }

  it('UMA leitura: ramo de licença da vw_user_reach (não delegável × linha viva) com o estabelecimento vivo deste schema', async () => {
    const { q, calls } = fakeDb(() => [{ k: 'orders' }])
    expect(await licensedKeys(q, WHO, ['orders', 'service-orders'])).toEqual(['orders'])
    expect(calls).toHaveLength(1)
    const { sql, params } = calls[0]
    expect(sql).toMatch(/FROM setes_central\.tb_institution i JOIN setes_central\.vw_interface_catalog c ON c\.delegable = 'N'/)
    expect(sql).toMatch(/JOIN `setes_acme`\.tb_institution_has_interface ihi ON ihi\.tb_institution_id = i\.id AND ihi\.tb_interface_id = c\.tb_interface_id AND ihi\.active = 'S' AND ihi\.deleted = 'N'/)
    expect(sql).toMatch(/WHERE i\.id = \? AND i\.schema_name = \? AND i\.active = 'S' AND i\.deleted = 'N' AND c\.interface_key IN \(\?\)$/)
    expect(sql).not.toMatch(/tb_user|vw_user_|profile|vendor/)            // sem usuário: nem o ramo do super nem o da delegável
    expect(params).toEqual([7, 'setes_acme', ['orders', 'service-orders']])
  })

  it('devolve na ordem de quem pediu, só chaves pedidas (nunca o que a leitura trouxer a mais)', async () => {
    const { q } = fakeDb(() => [{ k: 'service-orders' }, { k: 'customers' }, { k: 'orders' }])
    expect(await licensedKeys(q, WHO, ['orders', 'order-returns', 'service-orders'])).toEqual(['orders', 'service-orders'])
  })

  it('leitura vazia (o filtro do estabelecimento vivo é do SQL — ver o 1º teste) = nenhum ramo', async () => {
    const { q } = fakeDb(() => [])
    expect(await licensedKeys(q, WHO, ['orders'])).toEqual([])
  })

  it('lista vazia, chaves fora da forma canônica e repetidas não vão ao banco (ou vão uma vez)', async () => {
    const { q, calls } = fakeDb(() => [{ k: 'orders' }])
    expect(await licensedKeys(q, WHO, [])).toEqual([])
    expect(await licensedKeys(q, WHO, ['Orders', 'orders ', '', 'x--y'])).toEqual([])
    expect(calls).toHaveLength(0)
    expect(await licensedKeys(q, WHO, ['orders', 'orders'])).toEqual(['orders'])
    expect(calls[0].params[2]).toEqual(['orders'])
  })

  it('schema inválido lança HttpError 400 e institution não inteira positiva lança Error — os dois antes do banco', async () => {
    const { q, calls } = fakeDb(() => [])
    await expect(licensedKeys(q, { institutionId: 7, schemaName: 'acme`; DROP' }, ['orders'])).rejects.toBeInstanceOf(HttpError)
    await expect(licensedKeys(q, { institutionId: 7, schemaName: 'acme`; DROP' }, ['orders'])).rejects.toMatchObject({ statusCode: 400 })
    for (const id of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '7' as any, null as any]) {
      await expect(licensedKeys(q, { institutionId: id, schemaName: 'setes_acme' }, ['orders'])).rejects.toThrow(/institutionId inválido/)
    }
    expect(calls).toHaveLength(0)
  })

  it('CANÁRIO: o ramo de licença da `vw_user_reach` (migration 075 do setes-api) segue o que o leitor copia — mudou lá, revise aqui', () => {
    const sql = fs.readFileSync(setesApiPath('src', 'migrations', 'sql', '075_user_access_views.sql'), 'utf8').replace(/\s+/g, ' ')
    const reach = sql.slice(sql.indexOf('VIEW `vw_user_reach`'), sql.indexOf('VIEW `vw_user_access`'))
    expect(reach.length).toBeGreaterThan(100)
    // a licença: linha viva do estabelecimento × interface do catálogo
    expect(reach).toContain("LEFT JOIN `tb_institution_has_interface` ihi ON ihi.`tb_institution_id` = l.`tb_institution_id` "
      + "AND ihi.`tb_interface_id` = c.`tb_interface_id` AND ihi.`active` = 'S' AND ihi.`deleted` = 'N'")
    // o ramo de licença: só interface NÃO delegável, com a linha presente
    expect(reach).toContain("OR (c.`delegable` = 'N' AND ihi.`tb_interface_id` IS NOT NULL);")
    expect(reach).toContain('CROSS JOIN `setes_central`.`vw_interface_catalog` c')
  })

  it('sai pelo subpath `fiscal-api/access`', () => {
    expect(accessSurface.licensedKeys).toBe(licensedKeys)
  })
})
