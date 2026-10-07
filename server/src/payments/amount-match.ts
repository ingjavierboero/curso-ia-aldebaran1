export interface MatchableInvoice {
  id: number;
  /** Período facturado, formato YYYY-MM: define la antigüedad. */
  period: string;
  totalCents: number;
}

export type AmountMatch =
  /** Ninguna factura ni combinación suma el monto (RF-72). */
  | { kind: 'none' }
  /** Hay coincidencia y se sabe qué facturas cancela: única (RF-69) o la más antigua (RF-70). */
  | { kind: 'match'; invoiceIds: number[]; multiple: boolean }
  /** Hay varias coincidencias y ninguna es la más antigua (RF-71). */
  | { kind: 'ambiguous' };

/**
 * Busca qué facturas cancela un pago: las coincidencias de monto son los subconjuntos
 * de facturas cuyo total es exactamente el monto (al centavo, RNF-13).
 *
 * La combinación más antigua se elige comparando las facturas de cada coincidencia,
 * ordenadas de la más antigua a la más reciente, por período. Se construye período a
 * período: en cada paso se toma el período más antiguo con el que todavía se puede
 * completar el monto. Si al final hay más de una forma de armar esa secuencia de
 * períodos (por ejemplo, dos facturas del mismo período y monto), o una coincidencia
 * termina donde otra sigue, no hay combinación más antigua.
 *
 * Se memoriza por (posición, resto) para no recorrer todos los subconjuntos: un cliente
 * con muchas cuotas iguales adeudadas tiene muchísimas coincidencias posibles.
 */
export function findAmountMatch(invoices: MatchableInvoice[], amountCents: number): AmountMatch {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { kind: 'none' };

  const sorted = [...invoices].sort((a, b) => a.period.localeCompare(b.period));
  const n = sorted.length;

  // Cantidad de subconjuntos de sorted[i..] que suman `rest`, tope 2 (alcanza con 0, 1 o "varios").
  const memo = new Map<string, number>();
  const countWays = (i: number, rest: number): number => {
    if (rest === 0) return 1;
    if (rest < 0 || i === n) return 0;
    const key = `${i}:${rest}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const ways = Math.min(2, countWays(i + 1, rest) + countWays(i + 1, rest - sorted[i]!.totalCents));
    memo.set(key, ways);
    return ways;
  };

  const totalWays = countWays(0, amountCents);
  if (totalWays === 0) return { kind: 'none' };

  // Cada estado es una forma de elegir las facturas de la secuencia de períodos armada hasta ahora.
  interface State {
    next: number; // primera factura que todavía se puede elegir
    rest: number; // monto que falta cubrir
    chosen: number[];
  }
  let states: State[] = [{ next: 0, rest: amountCents, chosen: [] }];

  for (;;) {
    const complete = states.filter((s) => s.rest === 0);
    const open = states.filter((s) => s.rest > 0);

    if (complete.length > 0) {
      if (complete.length > 1 || open.length > 0) return { kind: 'ambiguous' };
      return { kind: 'match', invoiceIds: complete[0]!.chosen, multiple: totalWays > 1 };
    }

    // Período más antiguo que alguna forma puede sumar sin perder la posibilidad de completar.
    let bestPeriod: string | undefined;
    let candidates: State[] = [];
    for (const state of open) {
      for (let j = state.next; j < n; j++) {
        const invoice = sorted[j]!;
        if (bestPeriod !== undefined && invoice.period > bestPeriod) break;
        const rest = state.rest - invoice.totalCents;
        if (countWays(j + 1, rest) === 0) continue;

        const candidate = { next: j + 1, rest, chosen: [...state.chosen, invoice.id] };
        if (bestPeriod === undefined || invoice.period < bestPeriod) {
          bestPeriod = invoice.period;
          candidates = [candidate];
        } else {
          candidates.push(candidate);
        }
      }
    }
    states = candidates;
  }
}
