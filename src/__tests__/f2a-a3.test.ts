/// <reference types="jest" />
// F2a, etapa A3 — D-F126 (= Q-F136 (a), Valdo 2026-10-12; gates da A2, F2A2-ADV-02 provado no MariaDB 10.4.20): a TRAVA da nota do
// núcleo (`erp.lockInvoice`) exige UMA linha da view de vida — a leitura travante da view só é fresca nas tabelas do JOIN; com o retrato
// aberto antes da trava, os NOT EXISTS da view devolvem linhas velhas junto (PADROES_BANCO §11 regra 13). Mesma regra do setes-api.
import { lockInvoice } from '../erp/facts'
import { invoiceRef } from '../ref/invoice-ref'

const ref = invoiceRef(1, 7400, 0)
const connOf = (lifeRows: any[]) => ({ query: jest.fn().mockResolvedValueOnce([[{ deleted: 'N' }], []]).mockResolvedValueOnce([lifeRows, []]) })

describe('D-F126 — erp.lockInvoice: vida por view travante exige UMA linha', () => {
  it('1 linha → a vida e o último evento dela; a trava da nota vem ANTES da leitura da view (FOR UPDATE → LOCK IN SHARE MODE)', async () => {
    const c = connOf([{ lifeEvent: 3, lastEvent: 3, lastKind: 'E' }])
    expect(await lockInvoice(c as any, 'setes_x', ref)).toEqual({ alive: true, lifeEvent: 3, lastEvent: 3, lastKind: 'E' })
    expect(String(c.query.mock.calls[0][0])).toMatch(/FROM `setes_x`\.tb_invoice WHERE[\s\S]*FOR UPDATE/)
    expect(String(c.query.mock.calls[1][0])).toMatch(/FROM `setes_x`\.vw_invoice_life[\s\S]*LOCK IN SHARE MODE/)
  })
  it('VÁRIAS linhas (o retrato velho do REPEATABLE READ) → 409 RESOURCE_BUSY — nunca "a primeira"', async () => {
    const stale = [{ lifeEvent: 1, lastEvent: 2, lastKind: 'C' }, { lifeEvent: 1, lastEvent: 3, lastKind: 'E' },
      { lifeEvent: 3, lastEvent: 2, lastKind: 'C' }, { lifeEvent: 3, lastEvent: 3, lastKind: 'E' }]
    await expect(lockInvoice(connOf(stale) as any, 'setes_x', ref)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
  })
  it('nota sem evento (sincronizada) → vida nula; nota inexistente → null', async () => {
    expect(await lockInvoice(connOf([]) as any, 'setes_x', ref)).toEqual({ alive: true, lifeEvent: null, lastEvent: null, lastKind: null })
    const none = { query: jest.fn().mockResolvedValueOnce([[], []]) }
    expect(await lockInvoice(none as any, 'setes_x', ref)).toBeNull()
  })
})
