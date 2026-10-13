/// <reference types="jest" />
// Gate do delta da Rodada 4 da F2a (`prompt_apis_fiscais_isoladas.md` §22.16) — o que veio para o NÚCLEO:
// (1) F2AR4-ADV-05: na família de serviço o registro VEM COM a chave — "registrada sem chave" falha ALTO no MAPA da família (no setes-api
//     isso cai DENTRO da porta do leitor → 503 tipado da D-F130; antes estourava depois, no `fiscalRecordKey` → 500). O inverso (chave sem
//     registro) segue a D-NE68 (b) — as regras leem o fato.
// (2) F2AR4-SOC-07/ADV-09: a regra de CORS da D-F146 mora aqui (a nfe-api herda): só origem CANÔNICA (a que o navegador manda — a
//     comparação é por igualdade), `http://` só em localhost, nada de `*`; `corsFor` recusa na montagem.
import { mapTransmissionView } from '../voice/families/service'
import { assertCorsOrigins, corsFor, corsOriginProblem } from '../http/http'

const RAW = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P',
  accessKey: '41069022123456780001990000000000123202610100000123', authorityRecorded: 'S',
  lastQueriedAt: null, createdAt: '2026-10-10 12:00:00', lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null,
  lastSource: 'P', lastDh: '2026-10-10 12:00:05', lastEventAt: '2026-10-10 12:00:05',
  serie: '1', dpsNumber: 10, dpsId: 'DPS1', nfseNumber: '710', dhProc: '2026-10-10 12:00:05', nfseNotGeneratedAt: null,
  ...over,
})

describe('F2AR4-ADV-05 — família de serviço: registro ⇒ chave', () => {
  it('registrada SEM chave (nula, vazia, só espaço) → o mapa da família falha ALTO, em qualquer kind', () => {
    for (const accessKey of [null, undefined, '', '   ']) {
      for (const lastKind of ['A', 'C', 'K', 'R', null]) {
        expect(() => mapTransmissionView(RAW({ accessKey, lastKind }))).toThrow(/REGISTRADA sem chave.*F2AR4-ADV-05/)
      }
    }
  })
  it('registrada COM chave passa; chave SEM registro não é recusada aqui (D-NE68 (b) — o fato decide)', () => {
    expect(mapTransmissionView(RAW()).authorityRecorded).toBe(true)
    expect(mapTransmissionView(RAW({ authorityRecorded: 'N', lastKind: 'R' })).authorityRecorded).toBe(false)
  })
})

describe('F2AR4-SOC-07/ADV-09 — CORS da D-F146 no núcleo', () => {
  it('origens canônicas passam: https em qualquer host, http só em localhost/127.0.0.1', () => {
    for (const o of ['https://app.setes.com.br', 'https://app.setes.com.br:8443', 'http://localhost:5051', 'http://127.0.0.1:8080']) {
      expect([o, corsOriginProblem(o)]).toEqual([o, null])
    }
  })
  it('recusa o que o navegador nunca manda (a comparação é por igualdade): maiúsculas, porta padrão explícita, porta impossível, caminho, barra final, curinga, http fora de localhost, outro esquema', () => {
    for (const o of ['*', 'HTTP://LOCALHOST:5051', 'https://App.setes.com.br', 'https://app.setes.com.br:443', 'http://localhost:80',
      'http://localhost:99999', 'https://app.setes.com.br/', 'https://app.setes.com.br/app', 'http://app.setes.com.br', 'ftp://x.com',
      'app.setes.com.br', 'http://evil.localhost.com:5051', 'http://[::1]:5051', 'https://*.setes.com.br', 'https://a_b.setes.com.br']) {
      expect([o, corsOriginProblem(o)]).not.toEqual([o, null])
    }
  })
  it('assertCorsOrigins: vazia recusa; um item ruim recusa nomeando o motivo; boa devolve a lista', () => {
    expect(() => assertCorsOrigins([])).toThrow(/vazia.*D-F146/)
    expect(() => assertCorsOrigins(['http://localhost:5051', '*'])).toThrow(/\* \(curinga/)
    expect(() => assertCorsOrigins(['HTTP://LOCALHOST:5051'])).toThrow(/forma canônica/)
    expect(assertCorsOrigins(['http://localhost:5051', 'https://app.setes.com.br'])).toBe('http://localhost:5051, https://app.setes.com.br')
  })
  it('corsFor recusa na MONTAGEM o curinga e a origem torta (a nfe-api não precisa lembrar); a lista boa responde só à origem exata', () => {
    expect(() => corsFor(['*'])).toThrow(/D-F146/)
    expect(() => corsFor(['https://app.setes.com.br/'])).toThrow(/D-F146/)
    const mw = corsFor(['http://localhost:5051'])
    const preflight = (origin: string) => {
      const headers: Record<string, string> = {}
      let status = 0
      const res: any = { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v }, status: (s: number) => { status = s; return res }, end: () => res }
      mw({ method: 'OPTIONS', headers: { origin } } as any, res, () => undefined)
      return [status, headers['access-control-allow-origin']]
    }
    expect([preflight('http://localhost:5051'), preflight('http://localhost:5052')]).toEqual([[204, 'http://localhost:5051'], [204, undefined]])
    expect(() => corsFor([])).not.toThrow()                   // servidor-a-servidor (testes): sem origem de navegador
  })
})
