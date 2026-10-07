import { describe, expect, it, vi } from 'vitest';
import { runWithRetries } from '../src/retry.js';
import { fakeClock } from './billing/fakes.js';

const MIN = 60_000;

describe('runWithRetries', () => {
  it('no reintenta lo que sale bien', async () => {
    const { clock, sleeps } = fakeClock('2026-10-15T14:00:00Z');
    const operation = vi.fn(async (n: number) => n * 2);

    const results = await runWithRetries([1, 2], operation, { retries: 3, waitMs: 5 * MIN }, clock);

    expect(results).toEqual([
      { item: 1, ok: true, value: 2, attempts: 1 },
      { item: 2, ok: true, value: 4, attempts: 1 },
    ]);
    expect(sleeps).toEqual([]);
  });

  it('AC-108: reintenta 5 minutos después de la falla y no frena a los demás', async () => {
    const { clock } = fakeClock('2026-10-15T14:00:00Z');
    const calls: string[] = [];
    let failedOnce = false;
    const operation = async (item: string) => {
      calls.push(`${item}@${clock.now().toISOString().slice(11, 16)}`);
      if (item === 'A' && !failedOnce) {
        failedOnce = true;
        throw new Error('falla');
      }
      return item;
    };

    const results = await runWithRetries(['A', 'B'], operation, { retries: 3, waitMs: 5 * MIN }, clock);

    expect(calls).toEqual(['A@14:00', 'B@14:00', 'A@14:05']);
    expect(results[0]).toEqual({ item: 'A', ok: true, value: 'A', attempts: 2 });
  });

  it('AC-109: con 3 reintentos hace 4 intentos y devuelve el último error', async () => {
    const { clock, sleeps } = fakeClock('2026-10-15T14:00:00Z');
    let n = 0;
    const operation = async () => {
      n += 1;
      throw new Error(`falla ${n}`);
    };

    const [result] = await runWithRetries(['A'], operation, { retries: 3, waitMs: 5 * MIN }, clock);

    expect(result).toMatchObject({ ok: false, attempts: 4, error: new Error('falla 4') });
    expect(sleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN]);
  });

  it('AC-112: con 0 reintentos hace un solo intento', async () => {
    const { clock } = fakeClock('2026-10-15T14:00:00Z');
    const operation = vi.fn(async () => {
      throw new Error('falla');
    });

    const [result] = await runWithRetries(['A'], operation, { retries: 0, waitMs: 5 * MIN }, clock);

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('AC-114: con espera de 10 minutos, el siguiente intento es 10 minutos después', async () => {
    const { clock } = fakeClock('2026-10-15T14:00:00Z');
    const times: string[] = [];
    const operation = async () => {
      times.push(clock.now().toISOString().slice(11, 16));
      throw new Error('falla');
    };

    await runWithRetries(['A'], operation, { retries: 1, waitMs: 10 * MIN }, clock);

    expect(times).toEqual(['14:00', '14:10']);
  });

  it('cuenta la espera desde que terminó el intento fallido', async () => {
    const { clock, advance } = fakeClock('2026-10-15T14:00:00Z');
    const times: string[] = [];
    let first = true;
    const operation = async () => {
      times.push(clock.now().toISOString().slice(11, 16));
      advance(MIN); // el intento tarda un minuto
      if (first) {
        first = false;
        throw new Error('falla');
      }
    };

    await runWithRetries(['A'], operation, { retries: 1, waitMs: 5 * MIN }, clock);

    expect(times).toEqual(['14:00', '14:06']);
  });
});
