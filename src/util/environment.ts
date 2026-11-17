/**
 * O critério ÚNICO de "estamos em produção" do núcleo (`NODE_ENV=production`): o storage (P-DEP-2) e o CORS (D-F236) decidem pelo MESMO
 * teste — um `NODE_ENV=Production` com maiúscula ou espaço não pode valer como produção para um e como dev para o outro.
 */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? '').trim().toLowerCase() === 'production'
}
