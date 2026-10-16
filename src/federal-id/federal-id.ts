/**
 * INSCRIÇÃO FEDERAL — `FederalId` (frente do CNPJ alfanumérico, D-CJ2 = Q-CJ2 (a), Valdo 2026-10-15;
 * `Infra-IA/prompts/prompt_frente_cnpj_alfanumerico.md` §4.2 e §6.1).
 *
 * Conceito: a inscrição federal identifica uma pessoa perante a Receita Federal — CPF para pessoa física, CNPJ para pessoa
 * jurídica. O produto NUNCA cunha: recebe por quatro portas (digitação, certificado A1, voz do fisco, sincronizador). "Validar" =
 * forma + DV (consultar a RFB é outro conceito).
 *
 * Esta é a FONTE ÚNICA da regra (TS). O setes-api reexporta pelo `@shared/validation` (subpath `fiscal-api/federal-id`); o app tem o
 * espelho Dart em `setes_validators` — os dois lados leem o MESMO vetor de casos (`federal-id.vector.json`, aqui ao lado).
 *
 * Regras (fontes oficiais arquivadas em `Infra-IA/setes-api/integracoes/cnpj-alfanumerico/`):
 *  - CNPJ: 12 posições `[0-9A-Z]` (letras MAIÚSCULAS) + 2 DV numéricos; nenhuma letra proibida (FAQ RFB 1/38/45); CNPJ novo pode ser
 *    numérico — nenhuma regra deduz "novo ⇒ letra"; "0001" não garante matriz.
 *  - DV (Manual Serpro/RFB): cada caractere vale ASCII − 48; pesos 2…9 da direita para a esquerda, recomeçando; módulo 11; resto 0 ou 1
 *    → 0, senão 11 − resto. Para CNPJ numérico dá exatamente o cálculo de sempre.
 *  - NORMALIZAR = canonicalizar, NUNCA apagar: tira só os literais `.` `/` `-` e espaço, sobe `a–z` (só ASCII) para `A–Z`; qualquer
 *    outro caractere torna o valor inválido. (Apagar o que não é dígito era a maquete: `PC3D315K000193` virava `3315000193`.)
 *  - Comparar = igualdade exata da forma canônica. PF × PJ vem do LUGAR onde o valor mora (especialização, elemento do XML, tpInsc),
 *    nunca do comprimento depois de limpar.
 *
 * Puro: sem banco, sem I/O, sem dependência — por isso é um subpath próprio (`fiscal-api/federal-id`), como o `fiscal-api/reading`.
 */

export type FederalIdKind = 'cpf' | 'cnpj'

/** A inscrição com o tipo junto — o tipo vem do LUGAR (nunca do comprimento). */
export interface FederalId {
  readonly kind:  FederalIdKind
  /** Forma canônica: CNPJ `[0-9A-Z]{12}[0-9]{2}`, CPF `[0-9]{11}`. */
  readonly value: string
}

/** Forma canônica do CNPJ (RFB, IN 2.229/2024): 12 alfanuméricos maiúsculos + 2 DV numéricos. */
export const CNPJ_FORM = /^[0-9A-Z]{12}[0-9]{2}$/
/** Forma canônica do CPF: 11 dígitos. */
export const CPF_FORM = /^[0-9]{11}$/

/** Os ÚNICOS caracteres que a normalização remove (máscara de exibição). Qualquer outro fora de `[0-9A-Za-z]` invalida. */
export const FEDERAL_ID_MASK_LITERALS: readonly string[] = Object.freeze(['.', '/', '-', ' '])

const ACCEPTED_INPUT = /^[0-9A-Za-z./\- ]*$/

/**
 * Primitiva do módulo 11 com valor ASCII − 48 (DV do CNPJ alfanumérico e da chave de acesso da NF-e/NFC-e, que nós cunhamos):
 * pesos 2…9 da direita para a esquerda, recomeçando depois do 9; resto 0 ou 1 → 0, senão 11 − resto. Só `[0-9A-Z]`.
 * ⚠️ O DV da chave da NFS-e é do FISCO — nunca se calcula nem se confere (conhecimento negativo, parecer do guardião §4.2).
 */
export function mod11Ascii48(chars: string): number {
  if (!/^[0-9A-Z]+$/.test(chars)) throw new RangeError('mod11Ascii48: só [0-9A-Z]')
  let sum = 0
  let weight = 2
  for (let i = chars.length - 1; i >= 0; i--) {
    sum += (chars.charCodeAt(i) - 48) * weight
    weight = weight === 9 ? 2 : weight + 1
  }
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

/** Os dois DV de uma raiz+ordem de 12 posições `[0-9A-Z]`; null se as 12 posições não têm a forma. */
export function cnpjCheckDigits(base12: string): string | null {
  if (typeof base12 !== 'string' || !/^[0-9A-Z]{12}$/.test(base12)) return null
  const d1 = mod11Ascii48(base12)
  const d2 = mod11Ascii48(base12 + d1)
  return `${d1}${d2}`
}

/**
 * Canonicaliza um texto de inscrição: trim, remove só os literais da máscara, sobe a–z para A–Z. Devolve null se houver QUALQUER
 * outro caractere (acento, letra fora do ASCII, dígito de outra escrita, sublinhado…) — nunca apaga. Não confere forma nem DV
 * (serve para a pesquisa por prefixo e como 1º passo de `normalizeCnpj`/`normalizeCpf`).
 */
export function canonicalizeFederalIdText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  // o teste é sobre o texto CRU: `toUpperCase` de fora do ASCII viraria ASCII ('ı' → 'I', 'ß' → 'SS') e entraria calado
  if (!ACCEPTED_INPUT.test(trimmed)) return null
  return trimmed.replace(/[./\- ]/g, '').toUpperCase()
}

/** Entrada → forma canônica do CNPJ (sem conferir o DV); null se não chega à forma. Para LEITURAS (D-CJ3); a escrita exige a canônica. */
export function normalizeCnpj(raw: unknown): string | null {
  const c = canonicalizeFederalIdText(raw)
  return c !== null && CNPJ_FORM.test(c) ? c : null
}

/** Entrada → forma canônica do CPF (sem conferir o DV); null se não chega à forma. */
export function normalizeCpf(raw: unknown): string | null {
  const c = canonicalizeFederalIdText(raw)
  return c !== null && CPF_FORM.test(c) ? c : null
}

/** CNPJ válido = JÁ na forma canônica (maiúscula, sem máscara) + DV; veta só os 14 dígitos iguais. */
export function isValidCnpj(value: unknown): boolean {
  if (typeof value !== 'string' || !CNPJ_FORM.test(value)) return false
  if (/^(\d)\1{13}$/.test(value)) return false
  return cnpjCheckDigits(value.slice(0, 12)) === value.slice(12)
}

/** CPF válido = JÁ na forma canônica (11 dígitos) + DV; veta os 11 iguais. (CPF segue numérico.) */
export function isValidCpf(value: unknown): boolean {
  if (typeof value !== 'string' || !CPF_FORM.test(value)) return false
  if (/^(\d)\1{10}$/.test(value)) return false
  const digits = value.split('').map(Number)
  for (const position of [9, 10]) {
    let sum = 0
    for (let i = 0; i < position; i++) sum += digits[i] * (position + 1 - i)
    if (((sum * 10) % 11) % 10 !== digits[position]) return false
  }
  return true
}

/** `XX.XXX.XXX/XXXX-DV` sobre um CNPJ VÁLIDO; qualquer outro valor volta como veio (exibir nunca esconde o dado). */
export function formatCnpj(value: string): string {
  if (!isValidCnpj(value)) return value
  return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`
}

/** `XXX.XXX.XXX-DV` sobre um CPF VÁLIDO; qualquer outro valor volta como veio. */
export function formatCpf(value: string): string {
  if (!isValidCpf(value)) return value
  return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`
}

/** Valida pelo tipo que o LUGAR diz. */
export function isValidFederalId(kind: FederalIdKind, value: unknown): boolean {
  return kind === 'cnpj' ? isValidCnpj(value) : isValidCpf(value)
}

/** `FederalId` só de valor VÁLIDO na forma canônica (o tipo vem de quem chama, pelo lugar); senão null. */
export function federalIdOf(kind: FederalIdKind, value: unknown): FederalId | null {
  return isValidFederalId(kind, value) ? Object.freeze({ kind, value: value as string }) : null
}

/** Exibe pelo tipo. */
export function formatFederalId(id: FederalId): string {
  return id.kind === 'cnpj' ? formatCnpj(id.value) : formatCpf(id.value)
}

/**
 * Leitura de um FATO gravado (ERP, cofre): três estados — ausente ≠ inválido ≠ válido (os diagnósticos "Estabelecimento sem CNPJ"
 * para um CNPJ que existe mas não fecha morrem — parecer do guardião §4.4). Ausente = null, vazio ou o sentinela `'0'` da coluna
 * `tb_company.cnpj` (D-CJ5). O fato gravado tem de estar na forma canônica: o valor NÃO é normalizado aqui (dado gravado com máscara
 * ou minúscula é dado errado, e a resposta é dizer isso).
 */
export type FederalIdFact =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly raw: string }
  | { readonly state: 'valid'; readonly id: FederalId }

/** É um `FederalIdFact` (pela forma, não pelo `typeof`)? Array ou objeto qualquer não é. */
export function isFederalIdFact(v: unknown): v is FederalIdFact {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const s = (v as { state?: unknown }).state
  if (s === 'absent') return true
  if (s === 'invalid') return typeof (v as { raw?: unknown }).raw === 'string'
  if (s !== 'valid') return false
  const id = (v as { id?: unknown }).id as { kind?: unknown; value?: unknown } | undefined
  return !!id && (id.kind === 'cnpj' || id.kind === 'cpf') && isValidFederalId(id.kind, id.value)
}

export function readFederalIdFact(kind: FederalIdKind, raw: unknown): FederalIdFact {
  if (raw === null || raw === undefined) return { state: 'absent' }
  // gate adversarial da onda 0 (LOW): só TEXTO (ou o que o driver devolve de uma coluna — número, Buffer) vira fato; `String(raw)` fazia de
  // ['PC3D315K000193'] e de um objeto com toString um fato VÁLIDO (confusão de tipo)
  const text = typeof raw === 'string' ? raw
    : typeof raw === 'number' || typeof raw === 'bigint' ? String(raw)
      : Buffer.isBuffer(raw) ? raw.toString('utf8') : null
  if (text === null) return { state: 'invalid', raw: Object.prototype.toString.call(raw) }
  if (text.trim() === '' || (kind === 'cnpj' && text === '0')) return { state: 'absent' }
  const id = federalIdOf(kind, text)
  return id ? { state: 'valid', id } : { state: 'invalid', raw: text }
}
