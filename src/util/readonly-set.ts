/**
 * Conjunto IMUTÁVEL em execução (gate adversarial da NE-1a, NE1A-06 — mesma classe do R22-02): o `ReadonlySet` do TypeScript é só
 * TIPO; um `Set` exportado aceita `.add` e muda a classificação do processo inteiro (a nfse-api interpola o conteúdo de um deles no
 * texto do SQL). Esta vista não tem `add`/`delete`/`clear` e é congelada; o conjunto interno não sai daqui.
 */
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const inner = new Set(values)
  const view: ReadonlySet<T> = {
    get size() { return inner.size },
    has: (value: T) => inner.has(value),
    forEach: (fn: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => inner.forEach(v => fn.call(thisArg, v, v, view)),
    entries: () => inner.entries(),
    keys: () => inner.keys(),
    values: () => inner.values(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
  }
  return Object.freeze(view)
}
