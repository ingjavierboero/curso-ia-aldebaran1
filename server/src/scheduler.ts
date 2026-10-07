import cron, { type ScheduledTask } from 'node-cron';
import { and, desc, eq } from 'drizzle-orm';
import { argentinaDate, argentinaPeriod, argentinaTime } from './billing/dates.js';
import { TIMEZONE } from './config.js';
import type { Db } from './db/index.js';
import { jobRuns, mailboxChecks, settings } from './db/schema.js';

/** Día del mes en que se factura (RF-39). */
export const BILLING_DAY = 15;
/** Margen para que una revisión cada N minutos no se corra un minuto por el tick de cron. */
const INTERVAL_TOLERANCE_MS = 30_000;

export interface SchedulerJobs {
  /** Proceso de facturación mensual del período corriente (devuelve un resumen para registrar). */
  billing: () => Promise<Record<string, unknown>>;
  /** Una revisión de la casilla. */
  mailbox: () => Promise<unknown>;
}

export interface SchedulerDeps {
  db: Db;
  jobs: SchedulerJobs;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Decide cada minuto qué procesos corresponde ejecutar, con la hora de Argentina (RNF-12) y la
 * configuración vigente en ese momento (un cambio rige desde la ejecución siguiente).
 *
 * - Facturación (RF-39): el día 15 desde la hora de facturación, una vez por período. Si el
 *   servidor estuvo caído a esa hora, se ejecuta al volver, dentro del mismo mes; si una
 *   ejecución quedó a medias, se retoma (la facturación no duplica facturas).
 * - Casilla (RF-50): cada N minutos desde el inicio de la revisión anterior, sin superponerse.
 */
export class Scheduler {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly running = new Map<'billing' | 'mailbox', Promise<void>>();
  private task: ScheduledTask | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((message) => console.log(`[scheduler] ${message}`));
  }

  /** Revisa qué corresponde ejecutar y lo lanza sin esperar a que termine. */
  tick(): void {
    const at = this.now();
    if (!this.running.has('billing') && this.billingDue(at)) this.launch('billing', () => this.runBilling(at));
    if (!this.running.has('mailbox') && this.mailboxDue(at)) this.launch('mailbox', () => this.runMailbox());
  }

  /** Espera a que terminen los procesos en curso (tests y apagado ordenado). */
  async idle(): Promise<void> {
    await Promise.all(this.running.values());
  }

  start(): void {
    this.task = cron.schedule('* * * * *', () => this.tick(), { timezone: TIMEZONE, name: 'aldebaran' });
    this.log(`activo (zona horaria ${TIMEZONE})`);
    this.tick();
  }

  async stop(): Promise<void> {
    await this.task?.stop();
    await this.idle();
  }

  private billingDue(at: Date): boolean {
    const day = Number(argentinaDate(at).slice(8, 10));
    if (day < BILLING_DAY) return false;
    const { billingTime } = this.deps.db.select({ billingTime: settings.billingTime }).from(settings).get()!;
    if (day === BILLING_DAY && argentinaTime(at) < billingTime) return false;

    const run = this.deps.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, 'billing'), eq(jobRuns.period, argentinaPeriod(at))))
      .get();
    // Una ejecución que figura "en curso" sin estar corriendo quedó cortada: se retoma.
    return !run || run.status === 'running';
  }

  private mailboxDue(at: Date): boolean {
    const { mailboxIntervalMinutes } = this.deps.db
      .select({ mailboxIntervalMinutes: settings.mailboxIntervalMinutes })
      .from(settings)
      .get()!;
    const last = this.deps.db
      .select({ startedAt: mailboxChecks.startedAt })
      .from(mailboxChecks)
      .orderBy(desc(mailboxChecks.startedAt))
      .get();
    return !last || at.getTime() - last.startedAt.getTime() >= mailboxIntervalMinutes * 60_000 - INTERVAL_TOLERANCE_MS;
  }

  private launch(job: 'billing' | 'mailbox', work: () => Promise<void>): void {
    const promise = work()
      .catch((error) => this.log(`falló ${job}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.running.delete(job));
    this.running.set(job, promise);
  }

  private async runBilling(at: Date): Promise<void> {
    const { db } = this.deps;
    const period = argentinaPeriod(at);
    db.insert(jobRuns)
      .values({ job: 'billing', period, startedAt: at })
      .onConflictDoUpdate({ target: [jobRuns.job, jobRuns.period], set: { startedAt: at, status: 'running' } })
      .run();
    this.log(`facturación del período ${period}: inicio`);
    const finish = (status: 'ok' | 'error', summary: Record<string, unknown>) =>
      db.update(jobRuns)
        .set({ status, finishedAt: this.now(), summary })
        .where(and(eq(jobRuns.job, 'billing'), eq(jobRuns.period, period)))
        .run();
    try {
      const summary = await this.deps.jobs.billing();
      finish('ok', summary);
      this.log(`facturación del período ${period}: fin`);
    } catch (error) {
      finish('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async runMailbox(): Promise<void> {
    await this.deps.jobs.mailbox();
  }
}
