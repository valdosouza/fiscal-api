/**
 * SUPERFÍCIE da inscrição federal — `fiscal-api/federal-id` (D-CJ2 = Q-CJ2 (a), frente do CNPJ alfanumérico, Valdo 2026-10-15).
 *
 * Peça PURA (sem banco, sem I/O): a regra ÚNICA de forma, DV (ASCII − 48), normalização (canonicalizar, nunca apagar), exibição e leitura
 * de fato em três estados. O setes-api importa SÓ este subpath e o `fiscal-api/reading` (cerca `ne1a-superficie.test.ts`) e reexporta
 * pelo `@shared/validation`; o espelho Dart (`setes_validators`) lê o mesmo vetor de casos (`federal-id/federal-id.vector.json`).
 */
export * from './federal-id/federal-id'
