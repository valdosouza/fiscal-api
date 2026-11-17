import { InvoiceRef, invoiceRefFilter } from '../../ref/invoice-ref'
import { TransmissionView, assertOneInvoiceLife } from '../reading'
import type { ReadQueryable } from '../family-reader'

/**
 * VALORES DE IBS/CBS QUE O FISCO CALCULOU para a NFS-e registrada numa tentativa — o LEITOR do núcleo (fase IBS/CBS, `fiscal-api:IBS.E1.P1`;
 * D-IB10/D-IB77/D-IB78 e, do desenho de 2026-11-16, D-IB124…D-IB126 — `prompt_fase_ibs_cbs.md` §15).
 *
 * Natureza (parecer do guardião, §13.2 e §15.2): dado do FISCO gravado UMA vez, 1:1 da tentativa que detém a chave — NÃO é voz (não tem
 * kind/source, não muda estado: a voz A nunca espera estes valores — D-IB80). "Authority" no nome é obrigatório: a NFS-e tem DOIS `IBSCBS`
 * (a NOSSA declaração, em `infDPS`, e os valores do fisco, filho direto de `infNFSe`). Só a família de SERVIÇO tem o fato (na NF-e/NFC-e o
 * fisco não devolve valor calculado — RF-NFE-06): nada disto entra na projeção comum.
 *
 * Fonte: a view `vw_invoice_service_transmission_ibscbs` — AINDA NÃO EXISTE quando esta peça nasce: é da nfse-api (D-F35/D-IB124/D-IB126: a
 * família é dona da tabela e da view) e nasce no passo `nfse-api:IBS.E4.P1`, que também traz o teste do DDL dela contra
 * `SERVICE_AUTHORITY_IBSCBS_COLUMNS` e a PROVA AO VIVO da leitura pela view real. Aqui o contrato é provado contra um driver falso
 * (`ibs-valores-fisco.test.ts`); o que o motor e o pool da casa devolvem para o `CAST(<DECIMAL(17,2)> AS CHAR)` (texto, formato, charset)
 * é provado por uma sonda sem tabela na suíte ao vivo (`motor-banco.live.test.ts`, "IBS.E1.P1"). A view publica a chave da tentativa, a
 * VIDA (trazida da tentativa) e os três valores.
 *
 * Eixos OBRIGATÓRIOS: a nota INTEIRA (terminal por parâmetro — D-NE12) e a VIDA (D-F119) — os mesmos ARGUMENTOS de `readFamilyTransmissions`,
 * com validação MAIS RÍGIDA que a dele (lá a referência não é conferida): aqui uma lista vazia quer dizer "não conferido", então eixo
 * ausente ou torto é erro de quem chama, nunca "sem valores" calado. Só SELECT, sem trava.
 *
 * VALORES COMO TEXTO: `DECIMAL(17,2)` não cabe em número do JS e os pools da casa convertem DECIMAL em número (`decimalNumbers: true`) —
 * o SELECT publicado faz `CAST(… AS CHAR)` e o mapa ESTRITO só aceita o texto decimal canônico. `'0.00'` VINDO da view é valor válido (o
 * fisco calculou zero). AUSÊNCIA = lista vazia (e `null` no seletor), nunca `'0.00'` (RF-NFS-11: ausente não é zero) — e quer dizer só
 * "sem linha gravada": o fisco não devolveu o grupo, a gravação não aconteceu (D-IB80), OU o grupo veio sem `vIBSTot`/`vCBS` (a nfse-api
 * grava tudo ou nada — fato V6 do §15.1: é o caso do Simples com IBS/CBS no DAS quando o leiaute dele existir). Quem consome mostra
 * "não conferido", nunca "confere" nem "o fisco não mandou nada".
 *
 * CONTRATO PROVISÓRIO (D-IB125, Valdo 2026-11-16, "Agora, sem publicar"): a peça fica SÓ no barrel (`fiscal-api`), FORA de
 * `fiscal-api/reading` e sem GRANT, até o 1º leitor real (a conferência dos títulos no setes-api — D-IB12; `fiscal-api:IBS.E1.P3`) — e
 * também porque a pergunta do §15.5-1 (o que gravar quando falta `vIBSTot` ou `vCBS`) está ABERTA e pode mudar o tipo dos três campos:
 * conferir o §15.5 antes de publicar. Por isso NÃO é re-exportada por `voice/families/index.ts` (a superfície faz `export *` dele) nem
 * entra no catálogo `VOICE_READINGS` (catálogo de views de TENTATIVAS).
 *
 * A VIGENTE não é escolhida aqui nem na view: é a do `currentOf` (uma regra só — D-N26); `serviceAuthorityIbscbsOf` só pega a linha dela.
 * LIMITE CONHECIDO: vida com duas tentativas registradas e valores só na mais antiga → a vigente sai sem valores (a tela "No fisco" da
 * nfse-api já se comporta assim).
 *
 * Fora daqui, de propósito: tolerância de R$ 0,01, comparação com título, pendência (é do setes-api — D-IB12); filtro de ambiente
 * (`isFiscalRecord` da vigente); o ESTADO da vigente (o seletor devolve os valores também de NFS-e cancelada ou substituída — olhar a
 * última voz é de quem consome); leitura em lote (sem consumidor — D-IB77).
 */

// O nome da view e a lista de colunas que o SELECT usa são PRIVADOS (gate adversarial, L2): as exportações abaixo são apelidos — trocar a
// ligação exportada (por caminho interno do pacote) nunca muda o SELECT publicado.
const VIEW = 'vw_invoice_service_transmission_ibscbs'

/** A view publicada dos valores do fisco (nasce na nfse-api — `nfse-api:IBS.E4.P1`). */
export const SERVICE_AUTHORITY_IBSCBS_VIEW = VIEW

/** Os valores que o fisco calculou para a NFS-e de UMA tentativa, como a view os publica. Os três valores são TEXTO decimal (2 casas). */
export interface ServiceAuthorityIbscbs {
  readonly institutionId:     number
  readonly invoiceId:         number
  readonly terminal:          number
  readonly attempt:           number
  /** Vida da nota (evento E que a abriu — D-N27), trazida da tentativa. */
  readonly lifeEvent:         number
  /** vTotNF — `infNFSe/IBSCBS/totCIBS/vTotNF`. */
  readonly totalInvoiceValue: string
  /** vIBSTot — `infNFSe/IBSCBS/totCIBS/gIBS/vIBSTot`. */
  readonly ibsTotalValue:     string
  /** vCBS — `infNFSe/IBSCBS/totCIBS/gCBS/vCBS`. */
  readonly cbsValue:          string
}

/**
 * Coluna publicada: [coluna da view, campo do objeto, 'decimal'?] — a marca 'decimal' diz que a coluna é DECIMAL(17,2) e sai como TEXTO
 * (`CAST … AS CHAR`). NÃO é um `ViewColumn` da voz (lá o 3º elemento é um booleano de INSTANTE): a marca é texto de propósito, para a
 * lista não compilar onde se espera `ViewColumn` (o `familyViewSelect` aplicaria `DATE_FORMAT` nos valores).
 */
export type ServiceAuthorityIbscbsColumn = readonly [column: string, field: keyof ServiceAuthorityIbscbs, kind?: 'decimal']

/**
 * O CONTRATO da view — UMA lista, que monta o SELECT publicado (o teste da família, em `nfse-api:IBS.E4.P1`, confere as colunas da
 * migration dela contra esta lista). Congelada em profundidade.
 */
const COLUMNS: readonly ServiceAuthorityIbscbsColumn[] = Object.freeze(([
  ['tb_institution_id', 'institutionId'], ['tb_invoice_id', 'invoiceId'], ['terminal', 'terminal'], ['attempt', 'attempt'],
  ['life_event', 'lifeEvent'], ['total_invoice_value', 'totalInvoiceValue', 'decimal'], ['ibs_total_value', 'ibsTotalValue', 'decimal'],
  ['cbs_value', 'cbsValue', 'decimal'],
] as const).map(c => Object.freeze(c)))
export const SERVICE_AUTHORITY_IBSCBS_COLUMNS: readonly ServiceAuthorityIbscbsColumn[] = COLUMNS

/** A nota e a vida PEDIDAS — o que cada linha devolvida tem de ser. */
export interface ServiceAuthorityIbscbsAsked {
  readonly ref:       InvoiceRef
  readonly lifeEvent: number
}

const IDENT = /^[a-z][a-z0-9_]*$/
/** Texto decimal canônico de um DECIMAL(17,2) não negativo: até 15 dígitos inteiros sem zero à esquerda, ponto, 2 casas. */
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]{0,14})\.[0-9]{2}$/
/** Teto das colunas INT(11) da chave (um id acima disto nunca existe no banco — iria e voltaria "sem valores"). */
const INT_MAX = 2_147_483_647
const WHO = 'Leitura dos valores do fisco (IBS/CBS)'

/** Eixo de quem CHAMA: número inteiro (nunca texto) entre [min] e o teto do INT. */
function axis(v: unknown, what: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > INT_MAX) {
    throw new Error(`${WHO}: ${what} inválido: ${JSON.stringify(v)} (inteiro entre ${min} e ${INT_MAX})`)
  }
  return v === 0 ? 0 : v                                                   // -0 nunca segue adiante
}

/**
 * Os eixos OBRIGATÓRIOS: nota inteira (estabelecimento e nota ≥ 1; terminal ≥ 0 — o da web é 0) e vida ≥ 1 (D-F119: sem a vida o filtro
 * sumiria — nunca "todas as vidas"). Devolve uma CÓPIA congelada: o que foi conferido é o que vai ao banco e ao mapa.
 */
function assertAsked(ref: InvoiceRef, lifeEvent: number): ServiceAuthorityIbscbsAsked {
  const checked: InvoiceRef = Object.freeze({
    institutionId: axis(ref?.institutionId, 'estabelecimento', 1),
    invoiceId:     axis(ref?.invoiceId, 'nota', 1),
    terminal:      axis(ref?.terminal, 'terminal', 0),
  })
  return Object.freeze({ ref: checked, lifeEvent: axis(lifeEvent, 'vida da nota', 1) })
}

/** SELECT pronto da view dos valores do fisco ([db] = banco fiscal) — os três valores como TEXTO. */
export function serviceAuthorityIbscbsSelect(db: string, alias = 'v'): string {
  if (typeof db !== 'string' || !/^[a-z0-9_]+$/.test(db)) throw new Error(`Banco fiscal inválido: ${db}`)
  if (typeof alias !== 'string' || !IDENT.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  const col = ([column, field, kind]: ServiceAuthorityIbscbsColumn) => kind === 'decimal'
    ? `CAST(${alias}.${column} AS CHAR) AS ${field}`
    : `${alias}.${column} AS ${field}`
  return `SELECT ${COLUMNS.map(col).join(', ')}
    FROM \`${db}\`.${VIEW} ${alias}`
}

/** A consulta dos valores de UMA nota na vida pedida, em ordem de tentativa — a referência inteira e a vida por parâmetro. */
export function serviceAuthorityIbscbsQuery(db: string, ref: InvoiceRef, lifeEvent: number, alias = 'v'): { sql: string; params: number[] } {
  const select = serviceAuthorityIbscbsSelect(db, alias)
  return queryOf(select, assertAsked(ref, lifeEvent), alias)
}

/** A consulta a partir dos eixos JÁ conferidos (o mesmo objeto que o mapa vai usar). */
function queryOf(select: string, asked: ServiceAuthorityIbscbsAsked, alias: string): { sql: string; params: number[] } {
  const f = invoiceRefFilter(asked.ref, alias)
  return {
    sql: `${select} WHERE ${f.sql} AND ${alias}.life_event = ? ORDER BY ${alias}.attempt`,
    params: [...f.params, asked.lifeEvent],
  }
}

function mapChecked(r: any, asked: ServiceAuthorityIbscbsAsked): ServiceAuthorityIbscbs {
  if (r === null || typeof r !== 'object') throw new Error(`Linha da view dos valores do fisco inválida (${JSON.stringify(r)})`)
  // inteiro do driver: número, ou texto decimal canônico ('1e3', '0x10', ' 5 ' e '01' não são o que o banco devolve)
  const int = (v: unknown, what: string, min: number): number => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/.test(v) ? Number(v) : NaN)
    if (!Number.isInteger(n) || n < min || n > INT_MAX) throw new Error(`Linha da view dos valores do fisco com ${what} inválido (${JSON.stringify(v)})`)
    return n
  }
  const decimal = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !DECIMAL_TEXT.test(v)) {
      throw new Error(`Linha da view dos valores do fisco com ${what} fora do texto decimal canônico (${JSON.stringify(v)}) — a view é lida pelo SELECT publicado (CAST … AS CHAR)?`)
    }
    return v
  }
  const row: ServiceAuthorityIbscbs = {
    institutionId: int(r.institutionId, 'estabelecimento', 1), invoiceId: int(r.invoiceId, 'nota', 1), terminal: int(r.terminal, 'terminal', 0),
    attempt: int(r.attempt, 'tentativa', 1), lifeEvent: int(r.lifeEvent, 'vida', 1),
    totalInvoiceValue: decimal(r.totalInvoiceValue, 'vTotNF'), ibsTotalValue: decimal(r.ibsTotalValue, 'vIBSTot'), cbsValue: decimal(r.cbsValue, 'vCBS'),
  }
  const { ref, lifeEvent } = asked
  if (row.institutionId !== ref.institutionId || row.invoiceId !== ref.invoiceId || row.terminal !== ref.terminal || row.lifeEvent !== lifeEvent) {
    throw new Error(`Linha da view dos valores do fisco fora da nota/vida pedida (${row.institutionId}/${row.invoiceId}/${row.terminal}, vida ${row.lifeEvent})`)
  }
  return Object.freeze(row)
}

/**
 * Mapa ESTRITO de uma linha da view: inteiro só como número ou texto decimal canônico; valor só como TEXTO decimal canônico (número do JS,
 * `'1e3'`, espaço, zero à esquerda, sinal, 3 casas ou 16 dígitos inteiros falham ALTO — view sem o CAST, ou torta, nunca entra numa
 * conferência de título); linha fora da nota ou da vida pedidas falha ALTO. Cada campo da linha é lido UMA vez.
 */
export function mapServiceAuthorityIbscbs(r: any, asked: ServiceAuthorityIbscbsAsked): ServiceAuthorityIbscbs {
  return mapChecked(r, assertAsked(asked?.ref, asked?.lifeEvent))
}

/**
 * Os valores do fisco da nota na VIDA pedida, MAPEADOS — de zero a n linhas (uma por tentativa que os tem), na ordem em que o banco as
 * devolve (o SELECT pede a ordem de tentativa). Lista vazia = sem linha gravada (ver "AUSÊNCIA" no cabeçalho) — nunca zero.
 */
export async function readServiceAuthorityIbscbs(q: ReadQueryable, db: string, ref: InvoiceRef, lifeEvent: number): Promise<ServiceAuthorityIbscbs[]> {
  const select = serviceAuthorityIbscbsSelect(db)
  const asked = assertAsked(ref, lifeEvent)                                // conferido UMA vez: o mesmo objeto vai ao banco e ao mapa
  const { sql, params } = queryOf(select, asked, 'v')
  const [rows] = await q.query(sql, params)
  if (!Array.isArray(rows)) throw new Error(`${WHO}: o driver não devolveu linhas`)
  const out = rows.map(r => mapChecked(r, asked))
  // os valores são 1:1 da tentativa (PK da tabela): tentativa repetida = view torta (JOIN que multiplica) — falha ALTO, nunca "a primeira"
  for (let i = 1; i < out.length; i++) {
    for (let j = 0; j < i; j++) {
      if (out[j].attempt === out[i].attempt) throw new Error(`${WHO}: a view devolveu a tentativa ${out[i].attempt} mais de uma vez`)
    }
  }
  return out
}

/**
 * Os valores do fisco da tentativa VIGENTE ([current] = o `currentOf` das tentativas da MESMA nota e vida) — ou `null`.
 * `null` tem três causas que o retorno NÃO distingue: não há vigente; não há nenhuma linha de valores; a vigente não tem a linha dela
 * (as três são "não conferido"). A vigente e as linhas têm de ser da mesma nota e vida: mistura é erro de quem chama e falha ALTO (nunca
 * os valores de outra nota que por acaso tem o mesmo número de tentativa) — mas com a lista VAZIA não há com o que comparar a vigente.
 * Não olha o estado da vigente (cancelada, substituída) nem o ambiente: é de quem consome.
 */
export function serviceAuthorityIbscbsOf(
  current: Pick<TransmissionView, 'institutionId' | 'invoiceId' | 'terminal' | 'lifeEvent' | 'attempt'> | null,
  rows: readonly ServiceAuthorityIbscbs[],
): ServiceAuthorityIbscbs | null {
  if (!Array.isArray(rows)) throw new Error('serviceAuthorityIbscbsOf: lista de valores inválida')
  if (current === null) return null
  if (current === undefined || typeof current !== 'object') throw new Error(`serviceAuthorityIbscbsOf: vigente inválida (${JSON.stringify(current)})`)
  const attempt = current.attempt
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`serviceAuthorityIbscbsOf: tentativa da vigente inválida: ${JSON.stringify(attempt)} (inteiro ≥ 1)`)
  }
  // a chave tem de EXISTIR na vigente, mesmo com a lista vazia (campo ausente dos dois lados — undefined === undefined — nunca conta como
  // "a mesma nota"; gate adversarial, M2): com a vigente numérica, linha sem chave cai por desigualdade
  for (const key of ['institutionId', 'invoiceId', 'terminal', 'lifeEvent'] as const) {
    if (typeof current[key] !== 'number' || !Number.isInteger(current[key])) {
      throw new Error(`serviceAuthorityIbscbsOf: vigente com ${key} inválido (${JSON.stringify(current[key])})`)
    }
  }
  if (!rows.length) return null
  for (const r of rows) {
    // as linhas são as do leitor (mapeadas): tentativa em texto ou ausente nunca vira "sem valores" calado
    if (r === null || typeof r !== 'object' || typeof r.attempt !== 'number') throw new Error('serviceAuthorityIbscbsOf: linha de valores que não passou pelo leitor')
  }
  assertOneInvoiceLife([current, ...rows], 'serviceAuthorityIbscbsOf')
  const found = rows.filter(r => r.attempt === attempt)
  if (found.length > 1) throw new Error(`serviceAuthorityIbscbsOf: a tentativa ${attempt} aparece mais de uma vez nos valores`)
  return found[0] ?? null
}

/**
 * Boot de quem lê os valores (a nfse-api, dona da view, a partir do passo `nfse-api:IBS.E4.P1`; o setes-api quando virar leitor —
 * D-IB125): a view responde ao SELECT publicado com TODAS as colunas. Falta de view, coluna ou GRANT = falha ALTO no boot, nunca 500 na
 * 1ª leitura (molde da D-F113). Nenhum boot chama isto sozinho: quem lê é quem confere.
 */
export async function assertServiceAuthorityIbscbsViewReadable(q: ReadQueryable, db: string): Promise<void> {
  const select = serviceAuthorityIbscbsSelect(db)                          // banco inválido é erro de quem chama, com a mensagem dele
  try {
    await q.query(`${select} WHERE 1 = 0`)
  } catch (err: any) {
    // só o código do erro entra na mensagem (nunca o texto do banco nem o SQL); a causa original segue em `cause` para o log de quem sobe
    throw Object.assign(new Error(`A view dos valores de IBS/CBS do fisco (${db}.${VIEW}) não responde ao SELECT publicado `
      + `(${err?.code || err?.errno || 'erro'}) — a migration da view (nfse-api) não foi aplicada, falta coluna ou falta GRANT (D-IB126)`), { cause: err })
  }
}
