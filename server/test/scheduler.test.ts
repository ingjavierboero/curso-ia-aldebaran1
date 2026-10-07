import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { type Db, openDb } from '../src/db/index.js';
import { jobRuns, mailboxChecks, settings } from '../src/db/schema.js';
import { Scheduler } from '../src/scheduler.js';

let db: Db;
let current: Date;
const at = (iso: string) => {
  current = new Date(iso);
};

beforeEach(() => {
  db = openDb(':memory:');
  at('2026-10-15T13:00:00Z');
});

function setup(jobs: Partial<{ billing: () => Promise<Record<string, unknown>>; mailbox: () => Promise<unknown> }> = {}) {
  const billing = vi.fn(jobs.billing ?? (async () => ({ ok: true })));
  // La revisión de la casilla real registra su inicio en mailbox_checks; el doble hace lo mismo.
  const mailbox = vi.fn(
    jobs.mailbox ??
      (async () => {
        db.insert(mailboxChecks).values({ startedAt: current, status: 'ok' }).run();
      }),
  );
  const scheduler = new Scheduler({ db, jobs: { billing, mailbox }, now: () => current, log: () => {} });
  const tick = async (iso?: string) => {
    if (iso) at(iso);
    scheduler.tick();
    await scheduler.idle();
  };
  return { scheduler, billing, mailbox, tick };
}

describe('facturación (RF-39)', () => {
  it('AC-42, AC-137: el día 15 arranca a las 11:00 de Argentina, no a las 11:00 UTC', async () => {
    const { billing, tick } = setup();

    await tick('2026-10-15T11:00:00Z'); // 08:00 en Argentina
    await tick('2026-10-15T13:59:00Z'); // 10:59
    expect(billing).not.toHaveBeenCalled();

    await tick('2026-10-15T14:00:00Z'); // 11:00
    expect(billing).toHaveBeenCalledTimes(1);
  });

  it('AC-43: con la hora de facturación en 14:00, arranca a las 14:00', async () => {
    db.update(settings).set({ billingTime: '14:00' }).run();
    const { billing, tick } = setup();

    await tick('2026-10-15T14:00:00Z'); // 11:00
    expect(billing).not.toHaveBeenCalled();

    await tick('2026-10-15T17:00:00Z'); // 14:00
    expect(billing).toHaveBeenCalledTimes(1);
  });

  it('corre una sola vez por período', async () => {
    const { billing, tick } = setup();

    await tick('2026-10-15T14:00:00Z');
    await tick('2026-10-15T14:01:00Z');
    await tick('2026-10-20T14:00:00Z');

    expect(billing).toHaveBeenCalledTimes(1);
    expect(db.select().from(jobRuns).all()).toEqual([
      expect.objectContaining({ job: 'billing', period: '2026-10', status: 'ok', summary: { ok: true } }),
    ]);
  });

  it('no factura antes del día 15', async () => {
    const { billing, tick } = setup();

    await tick('2026-10-14T20:00:00Z');
    await tick('2026-10-01T14:00:00Z');

    expect(billing).not.toHaveBeenCalled();
  });

  it('AC-172: si el servidor estuvo caído el día 15, factura al volver dentro del mismo mes, pero no en el mes siguiente', async () => {
    const { billing, tick } = setup();

    await tick('2026-10-17T12:00:00Z');
    expect(billing).toHaveBeenCalledTimes(1);
    expect(db.select({ period: jobRuns.period }).from(jobRuns).all()).toEqual([{ period: '2026-10' }]);
  });

  it('AC-172: detenido del 15/10 al 1/11, en noviembre no factura octubre', async () => {
    const { billing, tick } = setup();

    await tick('2026-11-01T14:00:00Z');

    expect(billing).not.toHaveBeenCalled();
  });

  it('factura de nuevo el mes siguiente', async () => {
    const { billing, tick } = setup();

    await tick('2026-10-15T14:00:00Z');
    await tick('2026-11-15T14:00:00Z');

    expect(db.select({ period: jobRuns.period }).from(jobRuns).all()).toEqual([{ period: '2026-10' }, { period: '2026-11' }]);
    expect(billing).toHaveBeenCalledTimes(2);
  });

  it('AC-173: retoma una ejecución que quedó cortada (por ejemplo, por un reinicio)', async () => {
    db.insert(jobRuns).values({ job: 'billing', period: '2026-10', startedAt: new Date('2026-10-15T14:00:00Z') }).run();
    const { billing, tick } = setup();

    await tick('2026-10-15T14:30:00Z');

    expect(billing).toHaveBeenCalledTimes(1);
    expect(db.select().from(jobRuns).get()).toMatchObject({ status: 'ok' });
  });

  it('no lanza otra facturación mientras la anterior sigue en curso', async () => {
    let finish!: () => void;
    const { billing, scheduler } = setup({ billing: () => new Promise((resolve) => (finish = () => resolve({}))) });

    at('2026-10-15T14:00:00Z');
    scheduler.tick();
    at('2026-10-15T14:01:00Z');
    scheduler.tick();
    finish();
    await scheduler.idle();

    expect(billing).toHaveBeenCalledTimes(1);
  });

  it('si la facturación falla de forma inesperada, lo registra y no la repite cada minuto', async () => {
    const { billing, tick } = setup({ billing: async () => Promise.reject(new Error('base bloqueada')) });

    await tick('2026-10-15T14:00:00Z');
    await tick('2026-10-15T14:01:00Z');

    expect(billing).toHaveBeenCalledTimes(1);
    expect(db.select().from(jobRuns).get()).toMatchObject({ status: 'error', summary: { error: 'base bloqueada' } });
  });
});

describe('revisión de la casilla (RF-50)', () => {
  it('AC-56: con el intervalo por defecto, revisa cada 15 minutos', async () => {
    const { mailbox, tick } = setup();

    await tick('2026-10-20T15:00:00Z');
    await tick('2026-10-20T15:14:00Z');
    expect(mailbox).toHaveBeenCalledTimes(1);

    await tick('2026-10-20T15:15:00Z');
    expect(mailbox).toHaveBeenCalledTimes(2);
  });

  it('el segundo del tick no corre las revisiones un minuto cada vez', async () => {
    const { mailbox, tick } = setup();

    await tick('2026-10-20T15:00:00.900Z');
    await tick('2026-10-20T15:15:00.100Z');

    expect(mailbox).toHaveBeenCalledTimes(2);
  });

  it('AC-57: con el intervalo cambiado a 5 minutos, revisa cada 5 desde la siguiente', async () => {
    const { mailbox, tick } = setup();
    await tick('2026-10-20T15:00:00Z');
    db.update(settings).set({ mailboxIntervalMinutes: 5 }).run();

    await tick('2026-10-20T15:05:00Z');
    await tick('2026-10-20T15:09:00Z');
    await tick('2026-10-20T15:10:00Z');

    expect(mailbox).toHaveBeenCalledTimes(3);
  });

  it('AC-174: no superpone revisiones: si la anterior sigue, espera', async () => {
    let finish!: () => void;
    const { mailbox, scheduler } = setup({
      mailbox: () =>
        new Promise<void>((resolve) => {
          db.insert(mailboxChecks).values({ startedAt: current }).run();
          finish = resolve;
        }),
    });

    at('2026-10-20T15:00:00Z');
    scheduler.tick();
    at('2026-10-20T15:20:00Z');
    scheduler.tick();
    finish();
    await scheduler.idle();

    expect(mailbox).toHaveBeenCalledTimes(1);
  });

  it('un error en la revisión no detiene al scheduler', async () => {
    let calls = 0;
    const { mailbox, tick } = setup({
      mailbox: async () => {
        db.insert(mailboxChecks).values({ startedAt: current }).run();
        calls += 1;
        if (calls === 1) throw new Error('falla inesperada');
      },
    });

    await tick('2026-10-20T15:00:00Z');
    await tick('2026-10-20T15:15:00Z');

    expect(mailbox).toHaveBeenCalledTimes(2);
  });
});

describe('SCHEDULER_ENABLED', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-test',
    GMAIL_USER: 'a@b.com',
    GMAIL_APP_PASSWORD: 'x',
    ARCA_CUIT: '20311274350',
    ARCA_CERT_PATH: '/a',
    ARCA_KEY_PATH: '/b',
  };

  it('los procesos automáticos están apagados salvo que se pida explícitamente', () => {
    expect(loadConfig(env).schedulerEnabled).toBe(false);
    expect(loadConfig({ ...env, SCHEDULER_ENABLED: 'true' }).schedulerEnabled).toBe(true);
    expect(loadConfig({ ...env, SCHEDULER_ENABLED: 'TRUE' }).schedulerEnabled).toBe(true);
    expect(loadConfig({ ...env, SCHEDULER_ENABLED: 'false' }).schedulerEnabled).toBe(false);
  });

  it('rechaza un valor que no es true ni false', () => {
    expect(() => loadConfig({ ...env, SCHEDULER_ENABLED: 'si' })).toThrow('SCHEDULER_ENABLED debe ser true o false');
  });
});

describe('cambio de configuración', () => {
  it('lee la configuración en cada tick', async () => {
    const { billing, tick } = setup();
    await tick('2026-10-15T13:30:00Z'); // 10:30, antes de las 11:00
    db.update(settings).set({ billingTime: '10:00' }).where(eq(settings.id, 1)).run();

    await tick('2026-10-15T13:31:00Z');

    expect(billing).toHaveBeenCalledTimes(1);
  });
});
