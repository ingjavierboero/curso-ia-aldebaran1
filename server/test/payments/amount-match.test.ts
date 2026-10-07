import { describe, expect, it } from 'vitest';
import { type MatchableInvoice, findAmountMatch } from '../../src/payments/amount-match.js';

const inv = (id: number, period: string, totalCents: number): MatchableInvoice => ({ id, period, totalCents });

/** Facturas mensuales consecutivas desde enero de 2024, todas del mismo monto. */
const monthly = (count: number, totalCents: number) =>
  Array.from({ length: count }, (_, i) => {
    const year = 2024 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, '0');
    return inv(i + 1, `${year}-${month}`, totalCents);
  });

describe('findAmountMatch', () => {
  it('sin facturas no hay coincidencia', () => {
    expect(findAmountMatch([], 100)).toEqual({ kind: 'none' });
  });

  it.each([0, -100, 10.5])('un monto %s no coincide con nada', (amount) => {
    expect(findAmountMatch([inv(1, '2026-09', 100)], amount)).toEqual({ kind: 'none' });
  });

  it('con una sola coincidencia, multiple es false', () => {
    expect(findAmountMatch([inv(1, '2026-08', 100), inv(2, '2026-09', 200)], 300)).toEqual({
      kind: 'match',
      invoiceIds: [1, 2],
      multiple: false,
    });
  });

  it('prefiere la que contiene la factura más antigua aunque tenga más facturas', () => {
    // [ene, feb, mar] = 600 y [abr] = 600: gana la que arranca en enero.
    const invoices = [inv(1, '2026-01', 100), inv(2, '2026-02', 200), inv(3, '2026-03', 300), inv(4, '2026-04', 600)];

    expect(findAmountMatch(invoices, 600)).toEqual({ kind: 'match', invoiceIds: [1, 2, 3], multiple: true });
  });

  it('desempata por la segunda factura más antigua', () => {
    // ene + mar = 100 + 400 y ene + feb + abr = 100 + 150 + 250: empatan en enero, gana febrero.
    const invoices = [inv(1, '2026-01', 100), inv(2, '2026-02', 150), inv(3, '2026-03', 400), inv(4, '2026-04', 250)];

    expect(findAmountMatch(invoices, 500)).toEqual({ kind: 'match', invoiceIds: [1, 2, 4], multiple: true });
  });

  it('compara por período, no por el orden en que llegan las facturas', () => {
    const invoices = [inv(10, '2026-09', 100), inv(20, '2025-12', 100), inv(30, '2026-03', 100)];

    expect(findAmountMatch(invoices, 200)).toEqual({ kind: 'match', invoiceIds: [20, 30], multiple: true });
  });

  it('es ambigua si la más antigua se puede armar con facturas distintas del mismo período', () => {
    // La secuencia ene-mar sale de dos formas: ene(A 100) + mar(400) y ene(B 200) + mar(300).
    const invoices = [inv(1, '2026-01', 100), inv(2, '2026-01', 200), inv(3, '2026-03', 400), inv(4, '2026-03', 300)];

    expect(findAmountMatch(invoices, 500)).toEqual({ kind: 'ambiguous' });
  });

  it('no es ambigua si las facturas del mismo período llevan a secuencias distintas', () => {
    // ene(A 100) + feb(400) = 500 y ene(B 200) + mar(300) = 500: gana ene-feb, que es única.
    const invoices = [inv(1, '2026-01', 100), inv(2, '2026-01', 200), inv(3, '2026-02', 400), inv(4, '2026-03', 300)];

    expect(findAmountMatch(invoices, 500)).toEqual({ kind: 'match', invoiceIds: [1, 3], multiple: true });
  });

  it('es ambigua si una coincidencia termina donde otra sigue', () => {
    // ene(A 300) = 300 y ene(B 100) + feb(200) = 300: la comparación se queda sin facturas.
    const invoices = [inv(1, '2026-01', 300), inv(2, '2026-01', 100), inv(3, '2026-02', 200)];

    expect(findAmountMatch(invoices, 300)).toEqual({ kind: 'ambiguous' });
  });

  describe('coincide con una búsqueda por fuerza bruta', () => {
    /** Recorre todos los subconjuntos y aplica la definición del PRD tal cual. */
    function bruteForce(invoices: MatchableInvoice[], amount: number) {
      const matches: MatchableInvoice[][] = [];
      for (let mask = 1; mask < 1 << invoices.length; mask++) {
        const subset = invoices.filter((_, i) => mask & (1 << i));
        if (subset.reduce((sum, i) => sum + i.totalCents, 0) === amount) {
          matches.push(subset.sort((a, b) => a.period.localeCompare(b.period)));
        }
      }
      if (matches.length === 0) return { kind: 'none' };
      if (matches.length === 1) return { kind: 'match', ids: matches[0]!.map((i) => i.id).sort() };

      // Compara posición a posición; si una se queda sin facturas, la comparación no decide.
      const compare = (a: MatchableInvoice[], b: MatchableInvoice[]) => {
        for (let k = 0; k < Math.min(a.length, b.length); k++) {
          const diff = a[k]!.period.localeCompare(b[k]!.period);
          if (diff !== 0) return diff;
        }
        return 0;
      };
      const best = matches.reduce((acc, m) => (compare(m, acc) < 0 ? m : acc));
      const tied = matches.filter((m) => compare(m, best) === 0);
      if (tied.length > 1) return { kind: 'ambiguous' };
      return { kind: 'match', ids: best.map((i) => i.id).sort() };
    }

    // Generador determinístico para que una falla sea reproducible.
    let seed = 42;
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.floor((seed / 2 ** 31) * max);
    };

    it('en 2000 casos aleatorios', () => {
      for (let round = 0; round < 2000; round++) {
        const invoices = Array.from({ length: 1 + random(8) }, (_, i) =>
          inv(i + 1, `2026-0${1 + random(6)}`, 100 * (1 + random(5))),
        );
        // Casi siempre el monto es la suma de algunas facturas, para que haya coincidencias.
        const amount =
          random(4) === 0
            ? 100 * (1 + random(15))
            : invoices.reduce((sum, i) => sum + (random(2) ? i.totalCents : 0), 0) || invoices[0]!.totalCents;

        const result = findAmountMatch(invoices, amount);
        const simplified =
          result.kind === 'match' ? { kind: 'match', ids: [...result.invoiceIds].sort() } : result;

        expect(simplified, JSON.stringify({ invoices, amount })).toEqual(bruteForce(invoices, amount));
      }
    });
  });

  describe('muchas cuotas iguales adeudadas', () => {
    it('elige las más antiguas sin recorrer todas las combinaciones', () => {
      const invoices = monthly(40, 15_000_00);
      const start = performance.now();

      const result = findAmountMatch(invoices, 20 * 15_000_00);

      expect(result).toEqual({
        kind: 'match',
        invoiceIds: Array.from({ length: 20 }, (_, i) => i + 1),
        multiple: true,
      });
      expect(performance.now() - start).toBeLessThan(500);
    });

    it('detecta rápido que no hay coincidencia', () => {
      const start = performance.now();

      expect(findAmountMatch(monthly(40, 15_000_00), 15_000_00 * 20 + 1)).toEqual({ kind: 'none' });
      expect(performance.now() - start).toBeLessThan(500);
    });
  });
});
