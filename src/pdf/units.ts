/**
 * BASE DE PDF (NE-1b — D-NE20/D-NE121): a régua das normas. MOC 7.00 Anexo II e NT Conjunta 2025.001 medem em CENTÍMETROS; o PDF desenha em
 * PONTOS (1 pt = 1/72 pol; 1 pol = 2,54 cm). Peça pura.
 */
export const PT_PER_CM = 72 / 2.54

export const cmToPt = (cm: number): number => cm * PT_PER_CM
export const ptToCm = (pt: number): number => pt / PT_PER_CM

/**
 * Maior coordenada/medida aceita pela base: 14.400 pt (200 polegadas) = o limite de implementação dos LEITORES de PDF (o pdfkit formata números
 * até 1e21, mas leitor nenhum honra página maior). Cobre com folga todo papel admitido pelo MOC (A4 a Ofício II).
 */
export const MAX_COORDINATE_PT = 14400
