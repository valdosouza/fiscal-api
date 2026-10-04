/// <reference types="jest" />
// Contratos do núcleo que os DOIS lados usam: leitura da voz (D-F33), JWT do produto (D-F13),
// arquivo fiscal (D-F16/Q-N38a/Q-TZ7), corte de migrations (D-F35) e a CERCA do núcleo cego (D-F10).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import {
  currentOf, fiscalStateOf, localCancelPending, reconfirmationCandidate, reconfirmationProven, isLiveTransmission, isAuthorized, inLife,
} from '../voice/reading'
import { ProductTokenVerifier, isAdmin, isSuper } from '../auth/product-jwt'
import { FsFiscalStorage } from '../storage/fiscal-storage'
import { splitStatements } from '../db/migrations'

const t = (attempt: number, lastKind: any, over: any = {}) => ({
  attempt, lastKind, accessKey: null as string | null, lastSource: 'P' as any, environment: 'P' as any, dpsId: 'DPS1', lifeEvent: 1, ...over,
})

describe('contrato de leitura da voz (D-F33) — UMA regra para a nfse-api e o setes-api', () => {
  it('vigente = quem DETÉM a chave (D-N26), mesmo com R depois; sem chave, a última — em qualquer ordem', () => {
    expect(currentOf([t(2, 'R'), t(1, 'A', { accessKey: 'K' })])?.attempt).toBe(1)
    expect(currentOf([t(2, 'F'), t(1, 'R')])?.attempt).toBe(2)
    expect(currentOf([])).toBeNull()
  })
  it('estado derivado da última voz; viva = sem voz/S/K; autorizada = A ou N (D-N17)', () => {
    expect([null, 'S', 'A', 'N', 'R', 'F', 'C', 'K'].map(k => fiscalStateOf(k === null ? { lastKind: null } : { lastKind: k as any })))
      .toEqual(['in_flight', 'in_flight', 'authorized', 'authorized', 'rejected', 'failed', 'cancelled', 'cancel_in_flight'])
    expect(fiscalStateOf(null)).toBe('none')
    expect([isLiveTransmission(t(1, null)), isLiveTransmission(t(1, 'K')), isLiveTransmission(t(1, 'A'))]).toEqual([true, true, false])
    expect([isAuthorized(t(1, 'N')), isAuthorized(t(1, 'K'))]).toEqual([true, false])
    expect(inLife([t(1, 'A', { lifeEvent: 1 }), t(2, 'R', { lifeEvent: 3 })], 3).map(x => x.attempt)).toEqual([2])
    expect(inLife([t(1, 'A')], null)).toEqual([])
  })
  it('pendência DERIVADA (D-F28): voz C × nota ainda não-C no ERP; nada gravado', () => {
    expect(localCancelPending({ lastKind: 'C' }, 'E')).toBe(true)
    expect(localCancelPending({ lastKind: 'C' }, 'C')).toBe(false)
    expect(localCancelPending({ lastKind: 'A' }, 'E')).toBe(false)
    expect(localCancelPending(null, 'E')).toBe(false)
  })
  it('reconfirmação (Q-ADV2a/D-F29): TODA tentativa da vida conta; H não prende; com chave não há o que provar; prova = olhou DEPOIS do F', () => {
    const life = [t(1, 'F', { lastSource: 'Q' }), t(2, 'R')]
    expect(reconfirmationCandidate(life)?.attempt).toBe(1)
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'Q', environment: 'H' })])).toBeNull()
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'P' })])).toBeNull()
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'Q' }), t(2, 'A', { accessKey: 'K' })])).toBeNull()
    expect(reconfirmationProven({ lastEventAt: '2026-10-01 10:00:00', lastQueriedAt: '2026-10-01 10:00:00' })).toBe(false)   // a consulta que GEROU o F
    expect(reconfirmationProven({ lastEventAt: '2026-10-01 10:00:00', lastQueriedAt: '2026-10-01 10:05:00' })).toBe(true)
    expect(reconfirmationProven({ lastEventAt: '2026-10-01 10:00:00', lastQueriedAt: null })).toBe(false)
  })
})

describe('JWT do produto (D-F13) — RS256 só com a chave PÚBLICA', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const verifier = ProductTokenVerifier.of({ k1: pubPem })
  const claims = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

  it('token RS256 válido → payload; papel admin/super pela mesma regra do setes-api', () => {
    const p = verifier.verify(jwt.sign(claims, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' }))
    expect(p).toEqual(claims)
    expect(isAdmin(p)).toBe(true)
    expect(isSuper({ ...p, role: 'super' })).toBe(true)
    expect(isSuper({ ...p, institutionId: 2, role: 'super' })).toBe(false)
  })
  it('ataque de confusão de algoritmo: HS256 assinado COM a chave pública como segredo → 401', () => {
    const forged = jwt.sign(claims, pubPem, { algorithm: 'HS256', keyid: 'k1' })
    expect(() => verifier.verify(forged)).toThrow(expect.objectContaining({ statusCode: 401 }))
  })
  it('expirado / kid desconhecido / outra chave / sem identidade (token de seleção) / schema fora do padrão → 401', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    expect(() => verifier.verify(jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, privPem, { algorithm: 'RS256', keyid: 'k1' }))).toThrow(/expirado/)
    expect(() => verifier.verify(jwt.sign(claims, privPem, { algorithm: 'RS256', keyid: 'kX' }))).toThrow(/chave desconhecida/)
    expect(() => verifier.verify(jwt.sign(claims, other, { algorithm: 'RS256', keyid: 'k1' }))).toThrow(/inválido/)
    expect(() => verifier.verify(jwt.sign({ userId: 7, institutions: [1, 2] }, privPem, { algorithm: 'RS256', keyid: 'k1' }))).toThrow(/identidade/)
    expect(() => verifier.verify(jwt.sign({ ...claims, schemaName: 'fiscal_api' }, privPem, { algorithm: 'RS256', keyid: 'k1' }))).toThrow(/identidade/)
  })
})

describe('arquivo fiscal (FsFiscalStorage) — layout herdado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-storage-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const st = new FsFiscalStorage(root)

  it('produção em <cnpj>/<ano>/<mês>; homologação em <cnpj>/H/… (Q-N38a); mês na ZONA (Q-TZ7)', () => {
    const when = new Date('2026-10-01T02:30:00Z')                 // 30/09 23:30 em São Paulo
    const p = st.save('12.345.678/0001-99', 'X-nfse.xml', '<a/>', when, 'P', 'America/Sao_Paulo')
    expect(p).toBe(path.join(root, '12345678000199', '2026', '09', 'X-nfse.xml'))
    const h = st.save('12345678000199', 'Y-nfse.xml', '<b/>', when, 'H', 'UTC')
    expect(h).toBe(path.join(root, '12345678000199', 'H', '2026', '10', 'Y-nfse.xml'))
    expect(st.find('12345678000199', 'X-nfse.xml', ['2026-10-01 02:30:00'], 'P', 'America/Sao_Paulo')).toBe(p)
    expect(st.find('12345678000199', 'Y-nfse.xml', [], 'H', 'UTC')).toBe(h)            // varredura
    expect(st.find('12345678000199', 'Y-nfse.xml', [], 'P', 'UTC')).toBeNull()        // produção nunca olha dentro de H
    expect(st.find('12345678000199', '../../etc', [], 'P', 'UTC')).toBeNull()
    expect(() => st.save('12345678000199', '../x', '<c/>', when, 'P', 'UTC')).toThrow()
    expect(st.read(p)).toBe('<a/>')
    expect(st.probe()).toBe(true)
  })
})

describe('executor de migrations (D-F35) — corte de comando = o do setes-api', () => {
  it('";" dentro de COMMENT não corta; comentário de linha some; corta só em linha que termina com ";"', () => {
    const sql = "-- cabeçalho; com ponto e vírgula\nCREATE TABLE a (\n  x INT COMMENT 'um; dois'\n);\nCREATE OR REPLACE VIEW v AS\nSELECT 1;\n"
    expect(splitStatements(sql)).toEqual(["CREATE TABLE a (\n  x INT COMMENT 'um; dois'\n)", 'CREATE OR REPLACE VIEW v AS\nSELECT 1'])
  })
})

describe('CERCA do núcleo cego (D-F10 / critério §12.8-1)', () => {
  const srcRoot = path.resolve(__dirname, '..')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])

  // TABELA do ERP (a coluna de referência `tb_invoice_id` das tabelas fiscais não é tabela do ERP)
  const ERP_TABLE = /\btb_(invoice|order|entity)(?!_id\b)\w*/

  it('nenhum tb_invoice / tb_order / tb_entity* fora de src/erp/ (a fonte de fatos)', () => {
    const offenders = files(srcRoot)
      .filter(f => !f.includes(`${path.sep}erp${path.sep}`))
      .filter(f => ERP_TABLE.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
      .map(f => path.relative(srcRoot, f))
    expect(offenders).toEqual([])
  })

  it('nenhum Map/Set de CONTROLE em memória fora dos caches de dado declarados (erp/facts.ts)', () => {
    const offenders = files(srcRoot)
      .filter(f => !f.endsWith(`erp${path.sep}facts.ts`))
      .filter(f => /new (Map|Set)\s*</.test(fs.readFileSync(f, 'utf8')) && !/voice[\\/]kinds\.ts$/.test(f) && !/secret[\\/]cipher\.ts$/.test(f) && !/auth[\\/]product-jwt\.ts$/.test(f))
      .map(f => path.relative(srcRoot, f))
    expect(offenders).toEqual([])
  })
})
