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

export type Attempted<R> = { ok: true; value: R; attempts: number } | { ok: false; error: unknown; attempts: number };

export type RetryResult<T, R> = Attempted<R> & { item: T };

interface Task {
  operation: (attempt: number) => Promise<unknown>;
  onSettled: (result: Attempted<unknown>) => void | Promise<void>;
  attempt: number;
  dueAt: number;
  order: number;
}

/**
 * Cola de operaciones que se ejecutan de a una, reintentando las que fallan.
 * Una operación que falla se reprograma para `waitMs` después de su falla y mientras tanto
 * se ejecutan las demás, así que no las demora. Al terminar una operación (bien o tras el
 * último reintento) se llama a su `onSettled`, que puede encolar otras: por ejemplo, el
 * envío del email de una factura recién generada (RF-46).
 */
export class RetryQueue {
  private readonly tasks: Task[] = [];
  private order = 0;

  constructor(
    private readonly policy: RetryPolicy,
    private readonly clock: Clock,
  ) {}

  add<R>(operation: (attempt: number) => Promise<R>, onSettled: (result: Attempted<R>) => void | Promise<void>): void {
    this.tasks.push({
      operation,
      onSettled: onSettled as Task['onSettled'],
      attempt: 1,
      dueAt: 0,
      order: this.order++,
    });
  }

  async run(): Promise<void> {
    while (this.tasks.length > 0) {
      this.tasks.sort((a, b) => a.dueAt - b.dueAt || a.order - b.order);
      const task = this.tasks.shift()!;
      const wait = task.dueAt - this.clock.now().getTime();
      if (wait > 0) await this.clock.sleep(wait);

      try {
        const value = await task.operation(task.attempt);
        await task.onSettled({ ok: true, value, attempts: task.attempt });
      } catch (error) {
        if (task.attempt <= this.policy.retries) {
          this.tasks.push({ ...task, attempt: task.attempt + 1, dueAt: this.clock.now().getTime() + this.policy.waitMs });
        } else {
          await task.onSettled({ ok: false, error, attempts: task.attempt });
        }
      }
    }
  }
}

/** Ejecuta una operación por ítem con reintentos y devuelve los resultados en el orden de los ítems. */
export async function runWithRetries<T, R>(
  items: T[],
  operation: (item: T, attempt: number) => Promise<R>,
  policy: RetryPolicy,
  clock: Clock,
): Promise<RetryResult<T, R>[]> {
  const results = new Array<RetryResult<T, R>>(items.length);
  const queue = new RetryQueue(policy, clock);
  items.forEach((item, index) => {
    queue.add(
      (attempt) => operation(item, attempt),
      (result) => {
        results[index] = { ...result, item };
      },
    );
  });
  await queue.run();
  return results;
}
