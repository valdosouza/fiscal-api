/**
 * SUPERFÍCIE da fórmula do vNF — `fiscal-api/merchandise-total` (D-NE215 = Q-NE215 (a), Valdo 2026-11-21; `fiscal-api:FAMILIA.E5.P4.T2`).
 *
 * Peça PURA (sem banco, sem I/O): a regra ÚNICA da W16-10, datada pelo fato. O ERP (setes-api, que cunha o vNF) e a nfe-api (que confere)
 * importam este subpath; o vetor de casos é `merchandise-total/merchandise-total.vector.json` (cópia neutra no Vault:
 * `projetos/fiscal-api/SUBJECT/VETORES_TESTE/nfe-totais.json`).
 */
export * from './merchandise-total/merchandise-total'
