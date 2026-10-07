import { and, eq, exists, isNull } from 'drizzle-orm';
import type { ArcaClient } from '../arca/index.js';
import type { Db } from '../db/index.js';
import { clientSystems, clients, processErrors, settings, systems } from '../db/schema.js';
import { type BillingExchangeRate, getBillingExchangeRate } from '../exchange-rate/service.js';
import { type Clock, runWithRetries, systemClock } from '../retry.js';
import { argentinaPeriod } from './dates.js';
import { ExchangeRateProvider, type GenerateResult, type Invoice, generateInvoice } from './generate.js';

export interface BillingDeps {
  db: Db;
  arca: ArcaClient;
  getExchangeRate?: () => Promise<BillingExchangeRate>;
  clock?: Clock;
}

export interface BillingSummary {
  period: string;
  generated: Invoice[];
  /** Clientes que ya tenían la factura del período (RF-105). */
  alreadyInvoiced: number[];
  failed: { clientId: number; attempts: number; error: string }[];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Clientes Activos con al menos un sistema Activo asignado (RF-39, RF-47, RF-48). */
function billableClientIds(db: Db): number[] {
  return db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.status, 'active'),
        exists(
          db
            .select({ one: clientSystems.clientId })
            .from(clientSystems)
            .innerJoin(systems, eq(systems.id, clientSystems.systemId))
            .where(and(eq(clientSystems.clientId, clients.id), eq(systems.status, 'active'))),
        ),
      ),
    )
    .orderBy(clients.id)
    .all()
    .map((c) => c.id);
}

/**
 * Registra el error de proceso de una generación que falló tras el último reintento (RF-92).
 * Si ya hay uno Pendiente para el mismo cliente y período, lo actualiza en vez de duplicarlo.
 */
export function recordGenerationError(db: Db, clientId: number, period: string, attempts: number, lastError: string) {
  const pending = db
    .select({ id: processErrors.id })
    .from(processErrors)
    .where(
      and(
        eq(processErrors.operation, 'invoice_generation'),
        eq(processErrors.status, 'pending'),
        eq(processErrors.clientId, clientId),
        eq(processErrors.period, period),
        isNull(processErrors.invoiceId),
      ),
    )
    .get();
  if (pending) {
    db.update(processErrors).set({ attempts, lastError }).where(eq(processErrors.id, pending.id)).run();
  } else {
    db.insert(processErrors)
      .values({ operation: 'invoice_generation', clientId, period, attempts, lastError })
      .run();
  }
}

/**
 * Proceso de facturación mensual (RF-39): genera la factura del período corriente de cada
 * cliente facturable, con los reintentos configurados (RF-89), y registra un error de
 * proceso por cada cliente que sigue fallando (RF-92).
 */
export async function runBilling({
  db,
  arca,
  getExchangeRate = () => getBillingExchangeRate(db),
  clock = systemClock,
}: BillingDeps): Promise<BillingSummary> {
  const config = db.select().from(settings).get()!;
  const period = argentinaPeriod(clock.now());
  const exchangeRate = new ExchangeRateProvider(getExchangeRate);
  const deps = { db, arca, exchangeRate, pointOfSale: config.pointOfSale, now: () => clock.now() };

  const results = await runWithRetries<number, GenerateResult>(
    billableClientIds(db),
    (clientId) => generateInvoice(deps, clientId, period),
    { retries: config.retryCount, waitMs: config.retryWaitMinutes * 60_000 },
    clock,
  );

  const summary: BillingSummary = { period, generated: [], alreadyInvoiced: [], failed: [] };
  for (const result of results) {
    if (!result.ok) {
      const error = errorMessage(result.error);
      recordGenerationError(db, result.item, period, result.attempts, error);
      summary.failed.push({ clientId: result.item, attempts: result.attempts, error });
    } else if (result.value.kind === 'generated') {
      summary.generated.push(result.value.invoice);
    } else if (result.value.kind === 'already_invoiced') {
      summary.alreadyInvoiced.push(result.item);
    }
  }
  return summary;
}
