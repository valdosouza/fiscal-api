/**
 * Vocabulário COMUM do transporte fiscal (núcleo). O dialeto de cada autoridade (ADN hoje, SEFAZ
 * amanhã) vive na FAMÍLIA — aqui só o que as duas compartilham: ambiente e o par PEM da chamada.
 */

/** H = homologação / produção restrita · P = produção (D-N6). */
export type AuthorityEnvironment = 'H' | 'P'

/** Contexto de UMA chamada ao fisco: o par PEM do A1, decifrado só para ela (nunca sai do processo). */
export interface AuthorityContext {
  environment: AuthorityEnvironment
  cert: Buffer
  key:  Buffer
}
