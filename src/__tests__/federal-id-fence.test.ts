/// <reference types="jest" />
// CERCA da inscrição federal (D-CJ12 = Q-CJ12, frente do CNPJ alfanumérico, Valdo 2026-10-15 — molde time-zone-fence/voice-kind-fence):
// "tirar o que não é dígito" (ou "tirar as letras") NUNCA sobre inscrição federal (CPF/CNPJ) nem chave de acesso — aplicado a um CNPJ
// alfanumérico dá OUTRO número (ou vira CPF: com 3 letras sobram 11 dígitos). A peça FederalId (`src/federal-id/federal-id.ts`)
// canonicaliza: tira só a máscara, nunca apaga. O PREDICADO mora no arquivo gêmeo `federal-id-fence.ts` (idêntico nos 3 repositórios;
// alargado no gate adversarial da onda 0 — regex em qualquer posição, RegExp construído, coleta de dígitos, remoção de letras, filtro por
// caractere). Lista BRANCA = os usos legítimos, cada um com o MOTIVO; alarme NOVO fora dela quebra a cerca; entrada que SUMIU também quebra.
import path from 'path'
import { repoStrippingHits, strippingHitsIn, FENCE_PROBES_CAUGHT, FENCE_PROBES_CLEAN } from './federal-id-fence'


const ROOT = path.resolve(__dirname, '..', '..')

/** `arquivo: texto do alarme` (espaços colapsados) → motivo. */
const ALLOWED: Record<string, string> = {
  "src/auth/product-jwt.ts: k.replace(/[^A-Za-z0-9._-]/g, '?')":
    'kid do JWT saneado para o LOG (troca por "?", não apaga; não é inscrição)',
  "src/erp/facts.ts: String(v ?? '').replace(/\\D/g, '')":
    'digitsOf do código IBGE da cidade (7 dígitos) — o CNPJ do estabelecimento é lido pela peça (establishmentCnpjFact)',
  // NE-1b (D-NE118, 2026-10-17): o Code-128 da chave ESCOLHE o conjunto pelo caractere (pares de dígitos em C, letra em A) — nada é tirado: a
  // chave alfanumérica inteira vira símbolo e volta inteira no leitor (`pdf-code128.test.ts`, 3000 chaves)
  "src/pdf/barcode/code128.ts: c >= '0'":
    'Code-128 da chave: o teste de dígito só escolhe o conjunto C × A da NT Conjunta 2025.001 §6 — nenhum caractere é removido',
  "src/pdf/barcode/code128.ts: c <= '9'":
    'Code-128 da chave: o teste de dígito só escolhe o conjunto C × A da NT Conjunta 2025.001 §6 — nenhum caractere é removido',
}

describe('D-CJ12 — cerca: nunca "tirar o que não é dígito" de inscrição federal ou chave de acesso', () => {
  const hits = repoStrippingHits(ROOT)
  it('todo alarme está na lista branca (com o motivo)', () => {
    expect(hits.filter(h => !(h in ALLOWED))).toEqual([])
  })
  it('a lista branca não apodrece: toda entrada ainda existe no código', () => {
    expect(Object.keys(ALLOWED).filter(k => !hits.includes(k))).toEqual([])
  })
  it('a cerca enxerga o que deve (sonda — inclui as 9 formas que escapavam da 1ª versão)', () => {
    for (const code of FENCE_PROBES_CAUGHT) expect([code, strippingHitsIn(code).length > 0]).toEqual([code, true])
    for (const code of FENCE_PROBES_CLEAN) expect([code, strippingHitsIn(code)]).toEqual([code, []])
  })
})
