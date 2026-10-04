/**
 * Tempo da casa (PADROES_BANCO §10 — Q-TZ1/Q-TZ2/Q-TZ7, cópia fiel das funções PURAS do
 * `@shared/time-zone` do setes-api): INSTANTE em UTC no banco; data de negócio e hora de parede na
 * ZONA DO ESTABELECIMENTO. A zona em si é FATO do ERP (config `time_zone` da interface
 * establishment) — quem a lê é a fonte de fatos (`erp/facts.ts`), nunca este módulo.
 * Conversões por Intl (ICU do Node) — nenhuma lib.
 */

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'

/** Zona IANA válida para o Intl? (config corrompida nunca derruba a leitura) */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Offset (ms) da zona no instante [utcMs]: horaLocal − horaUTC. */
function offsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

/**
 * Agora (ou [d]) como ISO com o offset DA ZONA: 'YYYY-MM-DDThh:mm:ss±hh:mm'.
 * Q-TZ2: dhEmi/dhEvento são a hora do ESTABELECIMENTO — nunca o fuso do processo Node.
 */
export function nowIsoIn(zone: string, d: Date = new Date()): string {
  const ms = Math.floor(d.getTime() / 1000) * 1000
  const off = offsetMs(zone, ms)
  const wall = new Date(ms + off).toISOString().slice(0, 19)
  const mins = Math.round(off / 60000)
  const sign = mins >= 0 ? '+' : '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${wall}${sign}${p(Math.floor(Math.abs(mins) / 60))}:${p(Math.abs(mins) % 60)}`
}

/** 'YYYY-MM-DD' de hoje na zona. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Ano-mês ('YYYY-MM') de [d] na zona — pastas fiscais por mês contábil (Q-TZ7). */
export function monthIn(zone: string, d: Date = new Date()): string {
  return todayIn(zone, d).slice(0, 7)
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/** Instante UTC do banco → hora de parede NA ZONA ('YYYY-MM-DD HH:MM:SS'). Só na fronteira HTTP. */
export function toZoneWall(utc: string | Date | null | undefined, zone: string): string | null {
  if (utc === null || utc === undefined || utc === '') return null
  if (!(utc instanceof Date) && !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(String(utc))) return null
  const ms = utc instanceof Date ? utc.getTime() : Date.parse(`${String(utc).replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) return null
  return new Date(ms + offsetMs(zone, ms)).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Data/hora COM offset (voz do fisco: '2026-09-30T22:00:00-03:00', 'Z') → instante UTC para gravar
 * ('YYYY-MM-DD HH:MM:SS'). Sem offset, a hora é lida como parede de [zone]. Inválido = null.
 */
export function toUtcDb(value: string | null | undefined, zone: string = DEFAULT_TIME_ZONE): string | null {
  if (!value) return null
  const v = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m
  const daysIn = new Date(Date.UTC(+y, +mo, 0)).getUTCDate()
  if (+y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || +d > daysIn) return null
  if (+mi > 59 || +se > 59 || +h > 24 || (+h === 24 && (+mi > 0 || +se > 0))) return null
  if (tz && tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '')
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59) return null
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)
  let utc: number
  if (tz) {
    const sign = tz === 'Z' ? 0 : tz[0] === '-' ? -1 : 1
    const digits = tz === 'Z' ? '0000' : tz.slice(1).replace(':', '')
    utc = wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
  } else {
    utc = wall - offsetMs(zone, wall)
    utc = wall - offsetMs(zone, utc)
  }
  const dt = new Date(utc)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
}

/** Apresentação (Q-TZ1): campos-INSTANTE [keys] de [row] convertidos para a parede da zona. */
export function withZoneWall<T extends object>(row: T, keys: readonly (keyof T)[], zone: string): T {
  const out = { ...row }
  for (const k of keys) {
    const v = out[k] as unknown
    if (typeof v === 'string' || v instanceof Date) (out as any)[k] = toZoneWall(v, zone)
  }
  return out
}

/** Fim da janela de TRANSIÇÃO (Q-TZ3): voz gravada antes disto está em hora de parede de Brasília. */
export const TZ_CUTOVER_WALL = '2026-10-01 00:00:00'

/** Forma ANTIGA (parede de Brasília) do instante UTC [dt], só se anterior ao corte; senão null. */
export function legacyWallBeforeCutover(dt: string | null): string | null {
  const wall = toZoneWall(dt, DEFAULT_TIME_ZONE)
  return wall !== null && wall < TZ_CUTOVER_WALL ? wall : null
}

/** Voz do fisco ('…T13:45:10-03:00', 'Z' ou só a data) → instante UTC; sem offset = hora de Brasília. */
export function toDbDateTime(v: string | null | undefined): string | null {
  return toUtcDb(v, DEFAULT_TIME_ZONE)
}
