/// <reference types="jest" />
// Contratos do núcleo que os DOIS lados usam: leitura da voz (D-F33), JWT do produto (D-F13),
// arquivo fiscal (D-F16/Q-N38a/Q-TZ7), corte de migrations (D-F35) e a CERCA do núcleo cego (D-F10).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { currentOf, fiscalStateOf, isLiveTransmission, isAuthorized, inLife } from '../voice/reading'
// NE-1a: as regras e os códigos de evento da NFS-e moram na família de serviço (mesmos nomes na biblioteca)
import {
  localCancelPending, isSubstitutionCancel, isHumanEffectCancel, reconfirmationCandidate, reconfirmationProven,
  CANCEL_EVENT_CODES, SUBSTITUTION_CANCEL_CODE, EX_OFFICIO_CANCEL_CODE, HUMAN_EFFECT_CANCEL_CODES,
} from '../voice/families/service'
import { ProductTokenVerifier, isAdmin, isSuper } from '../auth/product-jwt'
import { FsFiscalStorage, FiscalFileKey, fiscalSerieFolder, fiscalStorageRootFromEnv } from '../storage/fiscal-storage'
import { splitStatements } from '../db/migrations'
import { erpWrites, erpWritesIn, NAMED_WRITE_EXCEPTIONS } from './fence'

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return reconfirmationProven(cc, life ?? [cc])
}

// NE-1a (D-NE56): na NFS-e o registro É a chave (a mesma definição da view 004) — a fixture deriva um do outro, salvo quando o teste o fixa
const t = (attempt: number, lastKind: any, over: any = {}) => ({
  attempt, lastKind, accessKey: null as string | null, lastSource: 'P' as any, environment: 'P' as any, dpsId: 'DPS1', lifeEvent: 1,
  authorityRecorded: over.accessKey != null, ...over,
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
    expect(localCancelPending({ lastKind: 'C', lastCode: '101101' }, 'E')).toBe(true)
    expect(localCancelPending({ lastKind: 'C', lastCode: null }, 'E')).toBe(true)        // voz anterior à D-F68 = cancelamento comum
    expect(localCancelPending({ lastKind: 'C', lastCode: '101101' }, 'C')).toBe(false)
    expect(localCancelPending({ lastKind: 'A', lastCode: null }, 'E')).toBe(false)
    expect(localCancelPending(null, 'E')).toBe(false)
  })
  it('D-F68 (= Q-F75 (a)): a SUBSTITUIÇÃO (e105102) nunca manda o app aplicar o C local — é decisão humana (D-F64/D-F67)', () => {
    expect(localCancelPending({ lastKind: 'C', lastCode: '105102' }, 'E')).toBe(false)
    expect(isSubstitutionCancel({ lastKind: 'C', lastCode: '105102' })).toBe(true)
    for (const code of ['101101', '105104', '305101', null]) expect(isSubstitutionCancel({ lastKind: 'C', lastCode: code })).toBe(false)
    expect(isSubstitutionCancel({ lastKind: 'R', lastCode: '105102' })).toBe(false)    // só a voz C
    expect([...CANCEL_EVENT_CODES]).toEqual(['101101', '105102', '105104', '305101'])
    expect(SUBSTITUTION_CANCEL_CODE).toBe('105102')
  })
  it('D-F82 (= Q-F89): o cancelamento DE OFÍCIO (e305101) também espera o humano; 101101 e 105104 seguem automáticos', () => {
    expect(localCancelPending({ lastKind: 'C', lastCode: '305101' }, 'E')).toBe(false)
    expect(localCancelPending({ lastKind: 'C', lastCode: '105104' }, 'E')).toBe(true)
    expect([...HUMAN_EFFECT_CANCEL_CODES].sort()).toEqual(['105102', '305101'])
    expect(EX_OFFICIO_CANCEL_CODE).toBe('305101')
    for (const code of ['105102', '305101']) expect(isHumanEffectCancel({ lastKind: 'C', lastCode: code })).toBe(true)
    for (const code of ['101101', '105104', null]) expect(isHumanEffectCancel({ lastKind: 'C', lastCode: code })).toBe(false)
    expect(isHumanEffectCancel({ lastKind: 'K', lastCode: '305101' })).toBe(false)
  })
  it('reconfirmação (Q-ADV2a/D-F29): TODA tentativa da vida conta; H não prende; com chave não há o que provar; prova = olhou DEPOIS do F', () => {
    const life = [t(1, 'F', { lastSource: 'Q' }), t(2, 'R')]
    expect(reconfirmationCandidate(life)?.attempt).toBe(1)
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'Q', environment: 'H' })])).toBeNull()
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'P' })])).toBeNull()
    expect(reconfirmationCandidate([t(1, 'F', { lastSource: 'Q' }), t(2, 'A', { accessKey: 'K' })])).toBeNull()
    // D-F90 (= Q-F96 (c)): a prova é o E2404 EXPLÍCITO posterior ao F (`nfseNotGeneratedAt`), nunca o carimbo do rodízio
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-01 10:00:00' })).toBe(false)   // a consulta que GEROU o F
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-01 10:05:00' })).toBe(true)
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: null })).toBe(false)
    // D-F97 (= Q-F103 (b)): a vida reapresenta o MESMO Id — o E2404 tem de ser posterior à ÚLTIMA apresentação em qualquer tentativa
    const cand = { lastEventAt: '2026-10-01 10:00:00', createdAt: '2026-10-01 09:59:00', dpsId: 'DPS1', environment: 'P' as const, lastKind: 'F' as const, nfseNotGeneratedAt: '2026-10-02 10:00:00' }
    const reapresentada = { lastEventAt: '2026-10-03 10:00:05', createdAt: '2026-10-03 10:00:00', dpsId: 'DPS1', environment: 'P' as const, lastKind: 'R' as const }
    expect(reconfirmationProven(cand, [cand, reapresentada])).toBe(false)                               // nova apresentação DEPOIS do E2404
    expect(reconfirmationProven({ ...cand, nfseNotGeneratedAt: '2026-10-03 11:00:00' }, [cand, reapresentada])).toBe(true)
    expect(reconfirmationProven(cand, [cand, { ...reapresentada, environment: 'H' as const }])).toBe(true)   // outro ambiente não conta
    expect(reconfirmationProven(cand, [cand, { ...reapresentada, dpsId: 'DPS2' }])).toBe(true)               // outro Id (outra vida) não conta
    // D-F101 (= Q-F107 (b)): irmã da mesma identidade VIVA (voz S/K, ou sem `lastKind`) derruba a prova — o mesmo predicado do plano
    expect(reconfirmationProven({ ...cand, nfseNotGeneratedAt: '2026-10-03 11:00:00' }, [cand, { ...reapresentada, lastKind: 'S' as const }])).toBe(false)
    expect(reconfirmationProven({ ...cand, nfseNotGeneratedAt: '2026-10-03 11:00:00' }, [cand, { ...reapresentada, lastKind: undefined } as any])).toBe(false)   // ausente à força (o tipo exige — R20-02)
    // D-F92 (conhecimento negativo): a prova não tem prazo — um E2404 semanas depois do F (a revisita de 24 h, D-F52) ainda prova
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-25 09:00:00' })).toBe(true)
    // o carimbo do rodízio (inclusive o de um 502 ambíguo persistente) não entra na prova
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: null, lastQueriedAt: '2026-10-01 10:05:00' } as any)).toBe(false)
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
    expect(() => verifier.verify(jwt.sign({ userId: 7, institutions: [1, 2] }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' }))).toThrow(/identidade/)
    expect(() => verifier.verify(jwt.sign({ ...claims, schemaName: 'fiscal_api' }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' }))).toThrow(/identidade/)
    // D-F165 (= Q-F173 (a)): sem exp e sem kid também são 401 (como no setes-api)
    expect(() => verifier.verify(jwt.sign(claims, privPem, { algorithm: 'RS256', keyid: 'k1' }))).toThrow(/sem validade/)
    expect(() => verifier.verify(jwt.sign(claims, privPem, { algorithm: 'RS256', expiresIn: '1h' }))).toThrow(/sem kid/)
  })
})

describe('arquivo fiscal (FsFiscalStorage) — layout da D-F241: <cnpj>/[H/]<tipo>/<série>/<ano>/<mês>/<dia>', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-storage-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const st = new FsFiscalStorage(root)
  const C = '12345678000199'
  const key = (o: Partial<FiscalFileKey> = {}): FiscalFileKey => ({ cnpj: C, kind: 'nfse', serie: 1, environment: 'P', zone: 'America/Sao_Paulo', ...o })

  it('produção em <cnpj>/<tipo>/<série>/<ano>/<mês>/<dia>; homologação em <cnpj>/H/… (Q-N38a); dia na ZONA (Q-TZ7)', () => {
    const when = new Date('2026-10-01T02:30:00Z')                 // 30/09 23:30 em São Paulo
    const p = st.save(key(), 'X-nfse.xml', '<a/>', when)
    expect(p).toBe(path.join(root, C, 'nfse', '1', '2026', '09', '30', 'X-nfse.xml'))
    const h = st.save(key({ environment: 'H', zone: 'UTC' }), 'Y-nfse.xml', '<b/>', when)
    expect(h).toBe(path.join(root, C, 'H', 'nfse', '1', '2026', '10', '01', 'Y-nfse.xml'))
    expect(st.find(key(), 'X-nfse.xml', ['2026-10-01 02:30:00'])).toBe(p)                       // pela dica
    expect(st.find(key({ environment: 'H', zone: 'UTC' }), 'Y-nfse.xml', [])).toBe(h)            // varredura
    expect(st.find(key({ zone: 'UTC' }), 'Y-nfse.xml', [])).toBeNull()                          // produção nunca olha dentro de H
    expect(st.find(key({ environment: 'H' }), 'X-nfse.xml', [])).toBe(p)                         // homologação enxerga a produção
    expect(st.find(key(), '../../etc', [])).toBeNull()
    expect(() => st.save(key(), '../x', '<c/>', when)).toThrow()
    expect(st.read(p)).toBe('<a/>')
  })
  it('tipo e série separam as pastas; a série é a forma canônica (sem zeros à esquerda) e a busca sem série varre todas', () => {
    const when = new Date('2026-11-15T15:00:00Z')
    const a = st.save(key({ kind: 'nfe', serie: '001' }), 'A-nfe.xml', '<a/>', when)
    const b = st.save(key({ kind: 'nfce', serie: 1 }), 'B-nfce.xml', '<b/>', when)
    const c = st.save(key({ kind: 'nfe', serie: 0 }), 'C-nfe.xml', '<c/>', when)
    expect(a).toBe(path.join(root, C, 'nfe', '1', '2026', '11', '15', 'A-nfe.xml'))
    expect(b).toBe(path.join(root, C, 'nfce', '1', '2026', '11', '15', 'B-nfce.xml'))
    expect(c).toBe(path.join(root, C, 'nfe', '0', '2026', '11', '15', 'C-nfe.xml'))
    expect(st.find(key({ kind: 'nfe', serie: 1 }), 'A-nfe.xml', ['2026-11-15 15:00:00'])).toBe(a)
    expect(st.find({ ...key({ kind: 'nfe' }), serie: null }, 'C-nfe.xml', [])).toBe(c)               // sem série: varre as séries do tipo
    expect(st.find(key({ kind: 'nfse' }), 'A-nfe.xml', [])).toBeNull()                         // outro tipo, outra pasta
    expect(st.find(key({ kind: 'nfe', serie: 2 }), 'A-nfe.xml', [])).toBeNull()                // outra série, outra pasta
    for (const bad of ['', 'A', '1a', '-1', '123456', ' 1', '1.0'] as const) {
      expect(() => st.save(key({ serie: bad }), 'D-nfse.xml', '<d/>', when)).toThrow(/Série inválida para o arquivo fiscal/)
    }
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => fiscalSerieFolder(bad)).toThrow(/Série inválida/)
    expect(() => st.save(key({ kind: 'cte' as never }), 'E.xml', '<e/>', when)).toThrow(/Tipo de documento inválido/)
    expect(() => st.save(key({ environment: 'X' as never }), 'E.xml', '<e/>', when)).toThrow(/Ambiente inválido/)
    expect(fiscalSerieFolder('00000')).toBe('0')
    expect(fiscalSerieFolder(99999)).toBe('99999')
  })
  it('D-CJ2: a pasta é a FORMA CANÔNICA do CNPJ — alfanumérico como está; máscara/minúscula/curto recusados (nunca mutilados)', () => {
    const when = new Date('2026-10-01T12:00:00Z')
    const K = key({ cnpj: 'PC3D315K000193', zone: 'UTC' })
    const where = path.join(root, 'PC3D315K000193', 'nfse', '1', '2026', '10', '01', 'A-nfse.xml')
    expect(st.save(K, 'A-nfse.xml', '<a/>', when)).toBe(where)
    expect(st.find(K, 'A-nfse.xml', [])).toBe(where)
    for (const bad of ['12.345.678/0001-99', 'pc3d315k000193', '3315000193', 'PC3D315K00019Z', '']) {
      expect(() => st.save(key({ cnpj: bad }), 'B-nfse.xml', '<b/>', when)).toThrow(/CNPJ inválido para o arquivo fiscal/)
    }
  })
  it('probe grava, lê e apaga de verdade (sem deixar sonda); raiz que não grava = false', () => {
    expect(st.probe()).toBe(true)
    expect(fs.readdirSync(root).filter(n => n.startsWith('.probe-'))).toEqual([])
    const blocked = path.join(root, 'arquivo-no-lugar-da-pasta')
    fs.writeFileSync(blocked, 'x')
    expect(new FsFiscalStorage(path.join(blocked, 'raiz')).probe()).toBe(false)
  })
  it('a raiz é sempre absoluta; em produção STORAGE_PATH é obrigatório e absoluto (P-DEP-2)', () => {
    expect(() => new FsFiscalStorage('storage')).toThrow(/absoluta/)
    const abs = path.resolve(root, 'xml')
    expect(fiscalStorageRootFromEnv({ NODE_ENV: 'production', STORAGE_PATH: abs }, '/app')).toBe(path.normalize(abs))
    expect(() => fiscalStorageRootFromEnv({ NODE_ENV: 'production' }, '/app')).toThrow(/STORAGE_PATH ausente em produção/)
    expect(() => fiscalStorageRootFromEnv({ NODE_ENV: 'production', STORAGE_PATH: '  ' }, '/app')).toThrow(/ausente/)
    expect(() => fiscalStorageRootFromEnv({ NODE_ENV: 'production', STORAGE_PATH: 'storage' }, '/app')).toThrow(/relativo em produção/)
    expect(fiscalStorageRootFromEnv({ NODE_ENV: 'development' }, root)).toBe(path.join(root, 'storage'))
    expect(fiscalStorageRootFromEnv({ STORAGE_PATH: 'xml' }, root)).toBe(path.join(root, 'xml'))
  })
})

describe('arquivo fiscal — achados dos gates (socrático 0,72 · adversarial 0,78)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-storage-gate-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const st = new FsFiscalStorage(root)
  const C = '12345678000199'
  const key = (o: Partial<FiscalFileKey> = {}): FiscalFileKey => ({ cnpj: C, kind: 'nfse', serie: 1, environment: 'P', zone: 'America/Sao_Paulo', ...o })
  const when = new Date('2026-10-01T02:30:00Z')                   // 30/09 em São Paulo, 01/10 em UTC

  it('ADV M1: raiz ausente (volume desmontado) — probe false SEM criar a pasta, e o save recusa', () => {
    const missing = path.join(root, 'nao-montado')
    const off = new FsFiscalStorage(missing)
    expect(off.probe()).toBe(false)
    expect(fs.existsSync(missing)).toBe(false)
    expect(() => off.save(key(), 'A-nfse.xml', '<a/>', when)).toThrow(/Raiz do arquivo fiscal não existe/)
    expect(fs.existsSync(missing)).toBe(false)
  })
  it('ADV M2: "." e ".." nunca são nome de arquivo; pasta com nome de arquivo não é "achada"', () => {
    for (const n of ['.', '..', '...']) {
      expect(() => st.save(key(), n, '<a/>', when)).toThrow(/Nome de arquivo fiscal inválido/)
      expect(st.find(key(), n, ['2026-10-01 02:30:00'])).toBeNull()
    }
    fs.mkdirSync(path.join(root, C, 'nfse', '1', '2026', '09', '30', 'D-nfse.xml'), { recursive: true })
    expect(st.find(key(), 'D-nfse.xml', ['2026-10-01 02:30:00'])).toBeNull()
    expect(st.find(key(), 'D-nfse.xml', [])).toBeNull()
  })
  it('ADV LOW4/LOW5: ambiente e zona inválidos são erro também na busca (um comportamento só)', () => {
    expect(() => st.find(key({ environment: 'h' as never }), 'A-nfse.xml', [])).toThrow(/Ambiente inválido/)
    expect(() => st.find(key({ zone: 'Lua/Base' }), 'A-nfse.xml', [])).toThrow(/Zona inválida/)
    expect(() => st.find(key({ zone: 'Lua/Base' }), 'A-nfse.xml', ['2026-10-01 02:30:00'])).toThrow(/Zona inválida/)
    expect(() => st.save(key({ zone: 'Lua/Base' }), 'A-nfse.xml', '<a/>', when)).toThrow(/Zona inválida/)
  })
  it('ADV LOW6: dica como Date e como ISO com fuso acha pelo dia certo; dica ilegível cai na varredura', () => {
    const p = st.save(key(), 'E-nfse.xml', '<e/>', when)
    expect(st.find(key(), 'E-nfse.xml', [when])).toBe(p)
    expect(st.find(key(), 'E-nfse.xml', ['2026-09-30T23:30:00-03:00'])).toBe(p)
    expect(st.find(key(), 'E-nfse.xml', ['2026-10-01T02:30:00Z'])).toBe(p)
    expect(st.find(key(), 'E-nfse.xml', ['lixo', new Date(Number.NaN), null])).toBe(p)
  })
  it('SOC 6: zona do estabelecimento ≠ padrão cai na data da hora oficial; série nula acha pela dica; H cai para P com série nula', () => {
    // gravado no dia de São Paulo (30/09); procurado com a zona UTC (01/10) — acha pela 2ª tentativa (zona padrão)
    const p = st.save(key(), 'F-nfse.xml', '<f/>', when)
    expect(st.find(key({ zone: 'UTC' }), 'F-nfse.xml', ['2026-10-01 02:30:00'])).toBe(p)
    expect(st.find({ ...key(), serie: null }, 'F-nfse.xml', ['2026-10-01 02:30:00'])).toBe(p)
    expect(st.find({ ...key({ environment: 'H' }), serie: undefined }, 'F-nfse.xml', [])).toBe(p)
  })
  it('a varredura vai do mais novo ao mais antigo; NODE_ENV com caixa ou espaço ainda é produção', () => {
    const old = st.save(key(), 'G-nfse.xml', '<velho/>', new Date('2024-01-10T12:00:00Z'))
    const recent = st.save(key(), 'G-nfse.xml', '<novo/>', new Date('2026-11-10T12:00:00Z'))
    expect(old).not.toBe(recent)
    expect(st.find(key(), 'G-nfse.xml', [])).toBe(recent)
    for (const NODE_ENV of ['Production', ' production ', 'PRODUCTION']) {
      expect(() => fiscalStorageRootFromEnv({ NODE_ENV, STORAGE_PATH: 'storage' }, root)).toThrow(/relativo em produção/)
    }
  })
  it('sonda e temporário com nome aleatório: probes seguidos não colidem e não deixam rastro', () => {
    for (let i = 0; i < 20; i++) expect(st.probe()).toBe(true)
    expect(fs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
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

  // Gate do delta da Rodada 6 (L6): a cerca D-F31 vivia só na nfse-api — o NÚCLEO (que a nfe-api vai compartilhar, e onde
  // mora a fonte de fatos) não tinha cerca de ESCRITA no ERP. As tabelas do `fiscal_api` são do banco da conexão (sem
  // qualificador): escrita QUALIFICADA pelo schema do cliente (`${…}`.) ou pelo central (setes_*.) = escrita no ERP.
  it('CERCA D-F31 no núcleo: NENHUMA escrita no ERP em src/ (a única do produto é o ato da virada, nos scripts da nfse-api)', () => {
    // gate adversarial r8 (ADV-R8-06): LISTA BRANCA — todo alvo de escrita é nome simples de tabela (peça `./fence`)
    const writes = files(srcRoot).flatMap(f => erpWritesIn(path.relative(srcRoot, f), fs.readFileSync(f, 'utf8')).map(m => `${path.relative(srcRoot, f)}: ${m}`))
    expect(writes).toEqual([])
    // NE-1a parte 2: a ÚNICA exceção nomeada é o escritor genérico da voz, e ela EXISTE (o alvo nomeado está mesmo lá — exceção morta sai)
    expect(NAMED_WRITE_EXCEPTIONS.map(e => [e.file, e.target])).toEqual([['voice/event-table.ts', '${table}']])
    for (const e of NAMED_WRITE_EXCEPTIONS) expect(erpWrites(fs.readFileSync(path.join(srcRoot, e.file), 'utf8')).length).toBeGreaterThan(0)
    // a exceção é do ALVO exato naquele arquivo — outro alvo com substituição no MESMO arquivo, ou o mesmo alvo em OUTRO arquivo, segue violação
    expect(erpWritesIn('voice/event-table.ts', 'q.query(`INSERT INTO ${other} (a) VALUES (1)`)')).toHaveLength(1)
    // gates da parte 2: o VERBO (a voz é append-only — socrático) e a LIGAÇÃO (NE1A2-08) fazem parte da exceção
    const realTable = fs.readFileSync(path.join(srcRoot, 'voice', 'event-table.ts'), 'utf8')
    expect(erpWritesIn('voice/event-table.ts', realTable + '\nq.query(`UPDATE ${table} SET message = ?`, [m])\nq.query(`DELETE FROM ${table} WHERE attempt = ?`, [a])')).toHaveLength(2)
    expect(erpWritesIn('voice/event-table.ts', realTable.replace('const table = d.eventTable', 'const table = d.eventTable as string || other'))).not.toEqual([])
    expect(erpWritesIn('voice/event-table.ts', 'q.query(`UPDATE \\`${s}\\`.tb_invoice SET x = 1`)')).toHaveLength(1)
    expect(erpWritesIn('voice/reading.ts', 'q.query(`INSERT INTO ${table} (a) VALUES (1)`)')).toHaveLength(1)
    // a cerca não é cega (senão passaria sempre) — e não acusa a escrita LEGÍTIMA no `fiscal_api` nem o `FOR UPDATE`
    expect(erpWrites('q.query(`UPDATE \\`${s}\\`.tb_invoice SET x = 1`)')).toHaveLength(1)
    expect(erpWrites('q.query(`DELETE FROM setes_central.tb_entity`)')).toHaveLength(1)
    expect(erpWrites('q.query(`UPDATE tb_establishment_issuer SET x = 1 WHERE id = ? FOR UPDATE`); q.query(`INSERT INTO tb_x (a) SELECT a FROM \\`${s}\\`.tb_y`)')).toEqual([])
  })

  // Gate adversarial da NE-1a (NE1A-07): a cerca via só o genérico EXPLÍCITO — `new Map()` e `new Set([…])` escapavam. Agora pega as duas
  // formas; a LISTA BRANCA nomeia cada arquivo que guarda DADO declarado ou um Map/Set LOCAL de função (nunca estado de controle).
  const DATA_HOLDERS: Record<string, string> = {
    'erp/facts.ts': 'caches de DADO declarados (fuso, schema, id da interface) + mapa local do lote de vidas',
    'transport/https-json.ts': 'constantes de códigos do Node/OpenSSL (TLS/credencial local)',
    'errors/ambiguous-cause.ts': 'constante: as causas fechadas do ambíguo',
    'util/readonly-set.ts': 'a peça do conjunto IMUTÁVEL (o Set interno não sai dela)',
    'db/migrations.ts': 'local: versões já aplicadas no executor',
    'http/http.ts': 'local: origens permitidas do CORS',
    'secret/cipher.ts': 'local: anel de chaves-mestras do processo',
    'auth/product-jwt.ts': 'local: chaves públicas do verificador',
    'erp/invoice-tx.ts': 'D-NE81 (Valdo, gates da parte 2): WeakSet dos InvoiceTx EMITIDOS e abertos — identidade, não controle (a trava é o FOR UPDATE no banco)',
  }
  it('nenhum Map/Set (nem WeakMap/WeakSet) de CONTROLE em memória fora dos detentores de DADO declarados (com e sem genérico explícito)', () => {
    expect(['new WeakSet<object>()', 'new WeakMap()', 'new Set([1])', 'new Map<string, number>()'].every(s => /new (?:Weak)?(Map|Set)\s*[<(]/.test(s))).toBe(true)
    const offenders = files(srcRoot)
      .map(f => path.relative(srcRoot, f).replace(/\\/g, '/'))
      .filter(f => /new (?:Weak)?(Map|Set)\s*[<(]/.test(fs.readFileSync(path.join(srcRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
      .filter(f => !(f in DATA_HOLDERS))
    expect(offenders).toEqual([])
  })
})
