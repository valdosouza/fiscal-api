import { readonlySet } from '../util/readonly-set'

/**
 * Vocabulário da VOZ do fisco — fonte ÚNICA (L5 do gate socrático da Onda 3). Só importa a peça do conjunto imutável.
 *
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha explícita ·
 * N pedido de cancelamento NÃO consta no fisco (D-N17 — segue autorizada).
 *
 * CONHECIMENTO NEGATIVO (D-F102 = Q-F108 (a), Valdo 2026-10-11): S ("enviado") NÃO tem produtor hoje e NÃO tem SAÍDA — a D-F51 só
 * fecha tentativa SEM voz, e por DOIS portões: o predicado `isInterruptedInFlight` E a reconferência sob a trava, que recusa tentativa
 * com voz (`recordInterruptedFailure` na nfse-api, `reconcileInterrupted` no setes-api — R21-03). Quem criar produtor de S abre OS DOIS,
 * NA MESMA ENTREGA (idade da voz S ≥ IN_FLIGHT_MINUTES + o veredito conclusivo do fisco da família → F); senão a prova da reconferência
 * (D-F101) fica falsa para sempre e o transmitir em 409. A CERCA (`nfse-api/src/__tests__/voice-kind-fence.ts`, por AST) pega o literal
 * S ao lado de `kind` em QUALQUER grafia e o SQL de escrita na voz, em todo lugar que escreve na voz da NFS-e — NÃO pega produtor
 * SEMÂNTICO (constante nomeada, shorthand, mapa, parâmetro): esse o TIPO do escritor pega — D-F106 (= Q-F112 (b)): o escritor da NFS-e
 * aceita só a lista POSITIVA da família (`ServiceVoiceWriteKind` = A/R/C/K/F/N, na nfse-api e no setes-api); os kinds que a NE-1a trouxer
 * para ESTE tipo comum (P da NF-e — viva, em processamento; D — FINAL, denegada) não entram lá. D-F105 (= Q-F111 (a)): a D-F102 vale SÓ
 * para a família NFS-e — a NF-e PODE produzir S; quem o produzir dá a saída na mesma entrega (consulta pela NOSSA chave — §3.2/D-NE7 do
 * prompt da NF-e; o P sai pela consulta do recibo — D-NE33); no núcleo a cerca só olha SQL na tabela da NFS-e.
 * D-F103/D-F107 (executadas na A1 da F2a, 2026-10-12): na tabela da NFS-e o domínio de `kind` é FATO DO BANCO — CHECK BINÁRIO com a lista
 * da FAMÍLIA (A/R/C/K/F/N — não este tipo comum), migration 005 da nfse-api, conferido no boot (`assertServiceVoiceDomainsEnforced` — 'S' e
 * 'f' recusados); `source` e `environment` também (D-F120). A cópia do `migrate:setes` (`INSERT IGNORE … SELECT`, que REBAIXARIA a violação
 * do CHECK a aviso — F2A1-08) confere o domínio da ORIGEM antes de copiar. NUNCA gravar voz por fora do código; nunca desligar o CHECK na
 * sessão (`check_constraint_checks` — D-F122). Quando a máquina vier para cá (NE-1a), a lista de escrita
 * vai no DESCRITOR da família (`VoiceFamily<K>`) e o escritor comum é genérico nela, com o funil em execução (D-F108 — nota no
 * `prompt_onda_nfe_sefaz.md` §12.8): nunca um escritor do núcleo tipado por `TransmissionEventKind`.
 *
 * NE-1a (D-NE14, Valdo 2026-10-10; Rodada 1 da NE-1a — D-NE56/D-NE59, 2026-10-11): o vocabulário COMUM ganha P (NF-e: lote/recibo em
 * PROCESSAMENTO — VIVA) e D (NF-e: uso DENEGADO — FINAL e NÃO autorizada; o número queima — D-E7). A NFS-e nunca grava P nem D (lista
 * positiva da família — D-F106). Os códigos de evento de cancelamento da NFS-e saíram daqui para `families/service.ts` (eram política
 * da família no vocabulário comum — parecer do guardião da NE-1a); os nomes seguem exportados pela biblioteca.
 * CONHECIMENTO NEGATIVO (D-NE62 = Q-NE62 (a), gates da NE-1a parte 1): a família de serviço LÊ a tabela dela pelo vocabulário COMUM — uma
 * voz P/D gravada POR FORA do código numa tabela da NFS-e (D-F103: sem CHECK até a F2a) mudou de leitura com a NE-1a: P era "em voo" e
 * vira "processing"; D era VIVA (desconhecida) e vira FINAL "denied" (a barreira da NFS-e `isLive || isAuthorized` deixaria nova
 * tentativa passar e o DELETE do A1 também); 'd' minúsculo diverge entre o SQL (_ci, final) e o código (desconhecido, viva). Nenhum
 * escritor tipado produz P/D na NFS-e (lista positiva — D-F106) e a OpenAPI da NFS-e segue com os 7 estados dela; quem fecha a porta é o
 * CHECK binário da F2a (D-F107). NUNCA gravar voz por fora do código.
 */
export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N' | 'P' | 'D'
/** P resposta direta ao nosso pedido · Q consulta. */
export type TransmissionSource = 'P' | 'Q'
export type TransmissionEnvironment = 'H' | 'P'

/**
 * Classificação TOTAL do vocabulário (NE-1a): todo kind diz se ENCERRA a tentativa (final) e se deixa o documento AUTORIZADO e
 * vigente. Kind novo sem classe não compila (`satisfies Record<…>`); os conjuntos abaixo DERIVAM daqui — nunca uma 2ª lista.
 * Autorizado implica final (conferido em teste).
 */
const kindClass = <F extends boolean, A extends boolean>(final: F, authorized: A) => Object.freeze({ final, authorized })
// congelado em PROFUNDIDADE (gate NE-1a, NE1A-06): `as const` é só tipo — sem o freeze um módulo do processo trocava a classe
export const KIND_CLASS = Object.freeze({
  S: kindClass(false, false),   // enviado (sem produtor na NFS-e — D-F102)
  A: kindClass(true,  true),    // autorizada
  R: kindClass(true,  false),   // rejeitada
  C: kindClass(true,  false),   // cancelada
  K: kindClass(false, false),   // cancelamento em voo
  F: kindClass(true,  false),   // falha explícita
  N: kindClass(true,  true),    // pedido de cancelamento NÃO consta — segue autorizada (D-N17)
  P: kindClass(false, false),   // NF-e: em processamento (consulta do recibo — D-NE33)
  D: kindClass(true,  false),   // NF-e: uso denegado
} satisfies Record<TransmissionEventKind, { readonly final: boolean; readonly authorized: boolean }>)

const kindsWhere = (pick: (c: { final: boolean; authorized: boolean }) => boolean): string[] =>
  Object.entries(KIND_CLASS).filter(([, c]) => pick(c)).map(([k]) => k)

/** Tentativa ENCERRADA: o fisco não vai dizer mais nada útil sobre ela sozinho. Imutável em execução (NE1A-06). */
export const FINAL_TRANSMISSION_KINDS: ReadonlySet<string> = readonlySet(kindsWhere(c => c.final))
/** Documento AUTORIZADO e vigente (A, ou N depois de um K — D-N17). Imutável em execução (NE1A-06). */
export const AUTHORIZED_KINDS: ReadonlySet<string> = readonlySet(kindsWhere(c => c.authorized))
/**
 * Vozes que PRESSUPÕEM a autorização do fisco — C (cancelada) e K (cancelamento em voo): só se cancela no fisco o que ele autorizou =
 * registrou. D-F154 (= Q-F159 (a), Valdo 2026-10-13): o mapa comum recusa estas vozes sem registro (como a D-F136 com A/N).
 */
export const AUTHORIZATION_PRESUPPOSED_KINDS: ReadonlySet<string> = readonlySet(['C', 'K'])
/**
 * Tentativa VIVA COM voz: a última voz não encerra (S, K, P). A viva SEM voz (reserva em voo — `kind IS NULL`) é o outro caso, dito
 * por quem pergunta. D-NE69 (= Q-NE69 (a), gates da NE-1a parte 1): o SQL da família deriva daqui, nunca de uma lista à mão.
 */
export const LIVE_VOICE_KINDS: ReadonlySet<string> = readonlySet(kindsWhere(c => !c.final))

/**
 * Lista LITERAL para SQL (`'A','N'`) de kinds do VOCABULÁRIO (D-NE69): as CLASSES vêm dos conjuntos derivados acima; as letras que
 * nomeiam UM fato (C fora do rodízio — D-F28; F da revisita — D-F52) o chamador acrescenta pelo nome. Recusa o que não é kind (nunca
 * placeholder: o otimizador precisa da lista no texto, e nada de fora do vocabulário entra no SQL).
 */
export function sqlKindList(kinds: Iterable<string>): string {
  const list = [...kinds]
  if (!list.length) throw new Error('sqlKindList: lista vazia')
  for (const k of list) if (!Object.prototype.hasOwnProperty.call(KIND_CLASS, k)) throw new Error(`sqlKindList: fora do vocabulário (${JSON.stringify(k)})`)
  return list.map(k => `'${k}'`).join(',')
}
