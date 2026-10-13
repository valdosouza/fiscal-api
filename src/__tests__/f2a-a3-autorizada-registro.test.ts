/// <reference types="jest" />
// D-F136 (= Q-F144 (a), Valdo 2026-10-13 — gate adversarial da A3 da F2a, F2A3-ADV-01; `prompt_apis_fiscais_isoladas.md` §22.16): o MESMO
// invariante da D-NE61 para a AUTORIZADA — toda voz A/N é publicada REGISTRADA. A linha A/N sem registro (view torta, escrita por fora)
// falha ALTO no mapa: nunca chega à barreira do cancelamento local do ERP, que só barra a autorizada COM registro fiscal (Q-CA5b) — e
// liberaria o soft-delete e o número de uma NFS-e autorizada em produção.
import { mapCommonView, isAuthorized, isFiscalRecord } from '../voice/reading'
import { mapTransmissionView } from '../voice/families/service'

const RAW = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P',
  accessKey: '41069022123456780001990000000000123202610100000123', authorityRecorded: 'S',
  lastQueriedAt: null, createdAt: '2026-10-10 12:00:00', lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null,
  lastSource: 'P', lastDh: '2026-10-10 12:00:05', lastEventAt: '2026-10-10 12:00:05',
  serie: '1', dpsNumber: 10, dpsId: 'DPS1', nfseNumber: '710', dhProc: '2026-10-10 12:00:05', nfseNotGeneratedAt: null,
  ...over,
})

describe('D-F136 — voz A/N ⇒ registro (invariante comum, como a D-NE61)', () => {
  it('A ou N SEM registro → o mapa comum e o da família falham ALTO (nunca "autorizada sem registro fiscal" chegando à barreira)', () => {
    for (const kind of ['A', 'N']) {
      const raw = RAW({ lastKind: kind, authorityRecorded: 'N', accessKey: null })
      expect(() => mapCommonView(raw)).toThrow(/autorizada\) SEM registro.*D-F136/)
      expect(() => mapTransmissionView(raw)).toThrow(/D-F136/)
    }
  })
  it('A/N COM registro passa (produção = registro fiscal; homologação registrada não é registro fiscal); os outros kinds sem registro seguem livres', () => {
    for (const kind of ['A', 'N']) {
      const p = mapTransmissionView(RAW({ lastKind: kind }))
      expect([isAuthorized(p), isFiscalRecord(p)]).toEqual([true, true])
      const h = mapTransmissionView(RAW({ lastKind: kind, environment: 'H' }))
      expect([isAuthorized(h), isFiscalRecord(h)]).toEqual([true, false])
    }
    for (const kind of ['R', 'F', 'S', 'K', null]) {
      expect(() => mapTransmissionView(RAW({ lastKind: kind, authorityRecorded: 'N', accessKey: null, nfseNumber: null, dhProc: null }))).not.toThrow()
    }
  })
})
