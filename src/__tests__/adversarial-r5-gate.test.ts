/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 5 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F154, §22.18). Alvo: núcleo `4cb74d9..de5924c` — `AUTHORIZATION_PRESUPPOSED_KINDS` no vocabulário
// e o `mapCommonView` recusando C/K sem registro.
// Convenção: `it.failing('[ACHADO R5-ADV-NN SEV] …')` = o teste descreve o comportamento CERTO e hoje falha; `it('[RESISTIU] …')` = o ataque
// foi barrado.
import fs from 'fs'
import path from 'path'
import {
  AUTHORIZATION_PRESUPPOSED_KINDS, AUTHORIZED_KINDS, FINAL_TRANSMISSION_KINDS, KIND_CLASS, LIVE_VOICE_KINDS,
} from '../voice/kinds'
import { mapCommonView } from '../voice/reading'
import { mapTransmissionView } from '../voice/families/service'

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const KEY = '41069022123456780001990000000000123202610100000123'
const RAW = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P',
  accessKey: KEY, authorityRecorded: 'S',
  lastQueriedAt: null, createdAt: '2026-10-10 12:00:00', lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null,
  lastSource: 'P', lastDh: '2026-10-10 12:00:05', lastEventAt: '2026-10-10 12:00:05',
  serie: '1', dpsNumber: 10, dpsId: 'DPS1', nfseNumber: '710', dhProc: '2026-10-10 12:00:05', nfseNotGeneratedAt: null,
  ...over,
})

describe('D-F154 — o vocabulário e o mapa comum', () => {
  it('[RESISTIU] o conjunto novo é IMUTÁVEL em execução (sem add/delete/clear; o freeze vale) — molde NE1A-06', () => {
    const s = AUTHORIZATION_PRESUPPOSED_KINDS as any
    expect(typeof s.add).toBe('undefined')
    expect(typeof s.delete).toBe('undefined')
    expect(typeof s.clear).toBe('undefined')
    expect(Object.isFrozen(s)).toBe(true)
    expect(() => { s.has = () => false }).toThrow()
    expect([...AUTHORIZATION_PRESUPPOSED_KINDS].sort()).toEqual(['C', 'K'])
  })

  it('[RESISTIU] C e K estão no vocabulário, não são "autorizadas" (o D-F136 não as cobria) e K é viva / C é final — a regra não se sobrepõe', () => {
    for (const k of AUTHORIZATION_PRESUPPOSED_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(KIND_CLASS, k)).toBe(true)
      expect(AUTHORIZED_KINDS.has(k)).toBe(false)
    }
    expect([LIVE_VOICE_KINDS.has('K'), FINAL_TRANSMISSION_KINDS.has('C')]).toEqual([true, true])
  })

  it('[RESISTIU] varredura TOTAL do vocabulário × registro: sem registro só passam as vozes que não pressupõem a autorização (S, R, F, P, sem voz); com registro passa toda voz (e D só registrada — D-NE61)', () => {
    const verdict: Record<string, [boolean, boolean]> = {}
    for (const k of [...Object.keys(KIND_CLASS), null]) {
      const ok = (rec: 'S' | 'N') => { try { mapCommonView(RAW({ lastKind: k, authorityRecorded: rec, accessKey: rec === 'S' ? KEY : null })); return true } catch { return false } }
      verdict[String(k)] = [ok('N'), ok('S')]
    }
    expect(verdict).toEqual({
      S: [true, true], A: [false, true], R: [true, true], C: [false, true], K: [false, true], F: [true, true], N: [false, true],
      P: [true, true], D: [false, true], null: [true, true],
    })
  })

  it('[RESISTIU] os fluxos LEGÍTIMOS da família de serviço sempre registram antes da voz que pressupõe a autorização: K (reserva sobre a A com chave), N depois do K, C depois do A/N, C pela consulta (a chave pousa na mesma transação) → o mapa da família lê todas', () => {
    for (const over of [{ lastKind: 'K', lastSource: 'P', lastDh: null }, { lastKind: 'N', lastSource: 'Q' }, { lastKind: 'C', lastCode: '101101' },
      { lastKind: 'C', lastCode: '105102', lastSource: 'Q' }]) {
      expect(mapTransmissionView(RAW(over)).lastKind).toBe(over.lastKind)
    }
  })

  it('[CORRIGIDO R5-ADV-06 LOW] `AUTHORIZATION_PRESUPPOSED_KINDS` é uma LISTA À MÃO (`readonlySet([\'C\', \'K\'])`) no arquivo cujo contrato diz "os conjuntos abaixo DERIVAM daqui (KIND_CLASS) — nunca uma 2ª lista" (D-NE69): um kind novo que pressupõe a autorização (o evento da NF-e — CC-e, NE-1b) entra no `KIND_CLASS` pelo `satisfies` e NÃO na regra da D-F154, calado. Correção: a classe ganha o atributo (`presupposesAuthorization`) e o conjunto deriva por `kindsWhere`', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'voice', 'kinds.ts'), 'utf8')
    expect(src).toMatch(/AUTHORIZATION_PRESUPPOSED_KINDS[^=]*=\s*readonlySet\(kindsWhere\(/)
  })
})
