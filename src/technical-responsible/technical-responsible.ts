/**
 * RESPONSÁVEL TÉCNICO da instância — os dados PÚBLICOS do grupo `infRespTec` (CNPJ da Setes, contato, e-mail, fone), lidos e conferidos no
 * BOOT pela família que os usa (`fiscal-api:FAMILIA.E5.P4.T3`; D-NE217 = Q-NE217 (b), Valdo 2026-11-21, `prompt_onda_nfe_sefaz.md` §22.5:
 * "variáveis do env no fiscal-api … para, se preciso for, ser usado por NF-e/NFC-e/NFS-e, por isso fica no núcleo").
 *
 * Molde dos `…FromEnv` do núcleo (`fiscalStorageRootFromEnv`, `dbConfigFromEnv`, `MasterKeyRing.fromEnv`): TUDO ou NADA — variável que
 * falta ou fora da forma derruba o boot com o NOME da variável; nunca um objeto parcial.
 *
 * Formas (RF-NFE-30; XSD PL_010f v1.04 `leiauteNFe_v4.00.xsd:7351-7418`): CNPJ `TCnpjOpc` 14 posições (o alfanumérico é admitido), DV certo,
 * nunca zeros (rej. 973) — só a forma CANÔNICA (configuração é escrita, não leitura: máscara ou minúscula recusa); xContato `TString` 2-60;
 * email `TString` 6-60 e com `@` (escolha da ficha — o XSD só pede o `TString`); fone `[0-9]{6,14}` (DDD + número, sem máscara).
 *
 * FORA, de propósito: o CSRT e o `idCSRT` (segredo do fornecedor por UF — moram na estrutura `fiscal-code`, D-NE221/D-NE223; trazê-los
 * para cá os poria de volta no `.env`, que a D-NE221 descartou). Quem chama no boot é a FAMÍLIA (a nfe-api na NFE.E5.P3), não o núcleo.
 */
import { isValidCnpj } from '../federal-id/federal-id'
import { isXsdTString } from '../xml/writer'

export interface TechnicalResponsible {
  readonly cnpj:        string
  readonly contactName: string
  readonly email:       string
  readonly phone:       string
}

export const TECHNICAL_RESPONSIBLE_ENV = Object.freeze({
  cnpj:        'FISCAL_TECH_RESPONSIBLE_CNPJ',
  contactName: 'FISCAL_TECH_RESPONSIBLE_CONTACT',
  email:       'FISCAL_TECH_RESPONSIBLE_EMAIL',
  phone:       'FISCAL_TECH_RESPONSIBLE_PHONE',
} as const)

const PHONE = /^[0-9]{6,14}$/

export function technicalResponsibleFromEnv(env: NodeJS.ProcessEnv = process.env): TechnicalResponsible {
  const problems: string[] = []
  const read = (name: string, ok: (v: string) => boolean, rule: string): string => {
    const v = env[name]
    if (v === undefined || v === '') { problems.push(`${name} ausente`); return '' }
    if (!ok(v)) problems.push(`${name} fora da forma (${rule})`)
    return v
  }
  const cnpj = read(TECHNICAL_RESPONSIBLE_ENV.cnpj, isValidCnpj, 'CNPJ de 14 posições na forma canônica, DV certo — sem máscara')
  const contactName = read(TECHNICAL_RESPONSIBLE_ENV.contactName, v => isXsdTString(v, 2, 60), 'texto de 2 a 60, U+0020-U+00FF, sem espaço nas pontas')
  const email = read(TECHNICAL_RESPONSIBLE_ENV.email, v => isXsdTString(v, 6, 60) && v.includes('@'), 'texto de 6 a 60 com @, U+0020-U+00FF, sem espaço nas pontas')
  const phone = read(TECHNICAL_RESPONSIBLE_ENV.phone, v => PHONE.test(v), 'só dígitos, 6 a 14, DDD + número')
  if (problems.length) {
    throw new Error(`Responsável técnico (infRespTec — D-NE217) inválido na configuração: ${problems.join('; ')}`)
  }
  return Object.freeze({ cnpj, contactName, email, phone })
}
