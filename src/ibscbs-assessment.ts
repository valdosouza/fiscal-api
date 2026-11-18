/**
 * SUPERFÍCIE da opção de apuração do IBS/CBS do Simples — `fiscal-api/ibscbs-assessment` (D-IB128/D-IB129, fase IBS/CBS, Valdo 2026-11-18).
 *
 * Peça PURA (sem banco, sem I/O): a regra ÚNICA de leitura da opção vigente e o contrato da view `vw_establishment_ibscbs_assessment`. O
 * setes-api importa este subpath (a peça `@shared/ibscbs-assessment` e o teste DDL da view — cerca da F2a em `ne1a-superficie.test.ts`); o
 * leitor da view no núcleo (`erp/establishment-ibscbs-assessment.ts`) usa a mesma regra.
 */
export * from './ibscbs-assessment/ibscbs-assessment'
