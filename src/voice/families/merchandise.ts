import { TransmissionView, ViewColumn, VoiceFamilyReading, frozenColumns, mapCommonView } from '../reading'

/**
 * LEITURA PUBLICADA da família de MERCADORIA (NF-e 55 / NFC-e 65, ramo `merchandise`) — NE-2 (Rodada 15 da nfe-api, Valdo 2026-10-20;
 * `Infra-IA/prompts/prompt_onda_nfe_sefaz.md` §15.8). A família é dona do DDL (migration 001 da nfe-api — D-F35); o núcleo publica a
 * FORMA da leitura para quem lê o `fiscal_api` (D-F33).
 *
 * D-NE158 (= Q-NE158 (b)): esta leitura NASCE FORA do catálogo `VOICE_READINGS` e FORA da superfície `fiscal-api/reading` — só no barrel
 * `fiscal-api`. Entrar no catálogo é ato PUBLICADOR com três consumidores (o emitter do núcleo conta as vivas por ele; o boot da nfse-api e
 * do setes-api conferem cada view do catálogo — D-F113; o setes-api tem a cerca `KNOWN_FAMILIES` do plano de cancelamento): acontece na
 * JANELA da NE-6, antes da 1ª tentativa possível, com a 001 aplicada e o GRANT ao `setes_api`. Até lá: a nfe-api confere a PRÓPRIA view no
 * boot passando esta leitura a `assertFamilyViewsReadable`; o emitter conta 0 para a família (ramo sem leitura no catálogo = família sem
 * tentativa possível — a NE-5 confere que a nfe-api não monta a reserva sem a família no catálogo).
 *
 * D-NE160 (= Q-NE160 (a)): coluna PRÓPRIA publicada só `dh_emission` (D-NE21 — a data FISCAL deriva do dhEmi assinado; nunca espelhada no
 * ERP). `protocol`/`authorizer`/`receipt`/`dh_recbto`/`digest_value` são INTERNOS da nfe-api até haver leitor (regra da D-IB78). Sem `model`
 * até a F5: na F4 só existe o 55 (D-NE2); quando o 65 chegar, o modelo sai da CHAVE (posições 21-22) e, se o emitter precisar filtrar por
 * modelo, vira coluna da PROJEÇÃO COMUM (a NFS-e publicaria 'SE') — nunca coluna só desta família. `voiceView` saiu do contrato publicado
 * e a view de vozes desta família não nasce (sem consumidor em família nenhuma).
 *
 * REGISTRO pelo fisco (D-NE56): na NF-e a chave de acesso é NOSSA e existe desde a reserva (D-NE7) — "tem chave" NUNCA é registro; a view
 * publica `authority_recorded = (protocol IS NOT NULL)` (protocolo da autorização OU da denegação). Invariantes que o mapa COMUM já impõe
 * (falha ALTO dentro da porta do leitor): D (denegada) sempre registrada (D-NE61 — o número queimou, a barreira de nova tentativa segue só
 * pelo fato), A/N registradas (D-F136), C/K registradas (D-F154). O escritor da família grava o protocolo na MESMA transação da voz.
 */

/** Linha de `vw_invoice_merchandise_transmission`: projeção comum + o dhEmi assinado (UTC). */
export interface MerchandiseTransmissionView extends TransmissionView {
  /** dhEmi assinado — instante UTC ('YYYY-MM-DD HH:MM:SS'); a data fiscal da nota deriva daqui (D-NE21). */
  dhEmission: string | null
}

/** Colunas PRÓPRIAS da view da NF-e (a projeção comum vem do contrato comum) — só `dh_emission` (D-NE160). */
const MERCHANDISE_COLUMNS: readonly ViewColumn[] = frozenColumns([['dh_emission', 'dhEmission', true]])

export function mapMerchandiseTransmissionView(r: any): MerchandiseTransmissionView {
  const common = mapCommonView(r)
  // INVARIANTE DA FAMÍLIA (D-NE7): a chave é NOSSA e nasce na reserva — toda linha da view tem chave (coluna NOT NULL + CHECK do formato na
  // 001). Linha sem chave é família inconsistente e falha ALTO AQUI, dentro da porta do leitor (molde do F2AR4-ADV-05 da NFS-e) — nunca
  // depois, onde o `fiscalRecordKey` do ERP a leria como "sem chave". O registro NÃO se lê pela chave (D-NE56): só pelo fato publicado.
  if (typeof common.accessKey !== 'string' || common.accessKey.trim() === '') {
    throw new Error('Linha da view da NF-e SEM chave de acesso — na família de mercadoria a chave é nossa e existe desde a reserva (D-NE7)')
  }
  return { ...common, dhEmission: r.dhEmission ?? null }
}

/**
 * D-NE159 (= Q-NE159 (a), Valdo 2026-10-20): a NF-e NÃO tem cancelamento de efeito HUMANO — SEMPRE `false`.
 * CONHECIMENTO NEGATIVO (não "ainda não decidido"): o 110111 — único evento da F4 (D-NE106) — é SEMPRE pedido do EMITENTE; o efeito no
 * ERP é AUTOMÁTICO, inclusive quando o cancelamento veio do portal ou de outro sistema com o MESMO A1 e pousou aqui por consulta (molde
 * do 101101 da NFS-e lido por consulta). Não existe o par da NFS-e (105102 substituição com substituta desconhecida; 305101 de ofício —
 * `families/service.ts`): a SEFAZ não cancela NF-e de ofício por evento do contribuinte, e o 110112 (cancelamento por SUBSTITUIÇÃO da
 * NFC-e) é substituição feita pelo PRÓPRIO PDV, que conhece a substituta — a F5 decide o dele; criar aqui um conjunto vazio "para a F5"
 * copiaria "substituição = humano" da NFS-e sem o fato gerador (maquete). O predicado é por família e NÃO decide a nota CONJUGADA
 * (serviço + mercadoria — D-NE22): o plano de cancelamento da NE-6 compõe as duas leituras.
 */
export function isMerchandiseHumanEffectCancel(_current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null): boolean {
  return false
}

/** A leitura PUBLICADA da família de mercadoria (view 4.1 da migration 001 da nfe-api — D-F35). FORA de `VOICE_READINGS` (D-NE158). */
export const MERCHANDISE_VOICE_READING: VoiceFamilyReading<MerchandiseTransmissionView> = Object.freeze({
  branch:            'merchandise' as const,
  transmissionView:  'vw_invoice_merchandise_transmission',
  ownColumns:        MERCHANDISE_COLUMNS,
  map:               mapMerchandiseTransmissionView,
  humanEffectCancel: isMerchandiseHumanEffectCancel,
})
