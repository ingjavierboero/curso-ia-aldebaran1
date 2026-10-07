export interface RetryPolicy {
  /** Reintentos después del primer intento (RF-89, RF-90). */
  retries: number;
  /** Espera entre el fin de un intento fallido y el siguiente (RF-91). */
  waitMs: number;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type RetryResult<T, R> =
  | { item: T; ok: true; value: R; attempts: number }
  | { item: T; ok: false; error: unknown; attempts: number };

/**
 * Ejecuta una operación por ítem, de a una por vez, reintentando las que fallan.
 * Un ítem que falla no frena a los demás: se reprograma para `waitMs` después de su falla
 * y mientras tanto se procesan los otros. Devuelve los resultados en el orden de los ítems.
 */
export async function runWithRetries<T, R>(
  items: T[],
  operation: (item: T, attempt: number) => Promise<R>,
  policy: RetryPolicy,
  clock: Clock,
): Promise<RetryResult<T, R>[]> {
  const results = new Array<RetryResult<T, R>>(items.length);
  const queue = items.map((item, index) => ({ item, index, attempt: 1, dueAt: 0 }));

  while (queue.length > 0) {
    queue.sort((a, b) => a.dueAt - b.dueAt || a.index - b.index);
    const next = queue.shift()!;
    const wait = next.dueAt - clock.now().getTime();
    if (wait > 0) await clock.sleep(wait);

    try {
      const value = await operation(next.item, next.attempt);
      results[next.index] = { item: next.item, ok: true, value, attempts: next.attempt };
    } catch (error) {
      if (next.attempt <= policy.retries) {
        queue.push({ ...next, attempt: next.attempt + 1, dueAt: clock.now().getTime() + policy.waitMs });
      } else {
        results[next.index] = { item: next.item, ok: false, error, attempts: next.attempt };
      }
    }
  }
  return results;
}
