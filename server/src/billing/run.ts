import { and, eq, exists } from 'drizzle-orm';
import type { ArcaClient } from '../arca/index.js';
import type { Db } from '../db/index.js';
import { clientSystems, clients, settings, systems } from '../db/schema.js';
import type { Mailer } from '../email/mailer.js';
import { type BillingExchangeRate, getBillingExchangeRate } from '../exchange-rate/service.js';
import { type InvoiceEmailResult, sendInvoiceEmail } from '../invoices/email.js';
import { errorMessage, recordProcessError } from '../process-errors.js';
import { type Clock, RetryQueue, systemClock } from '../retry.js';
import { argentinaPeriod } from './dates.js';
import { ExchangeRateProvider, type GenerateResult, type Invoice, generateInvoice } from './generate.js';

export interface BillingDeps {
  db: Db;
  arca: ArcaClient;
  mailer: Mailer;
  /** CUIT del emisor (ARCA_CUIT), para el PDF. */
  issuerCuit: string;
  getExchangeRate?: () => Promise<BillingExchangeRate>;
  clock?: Clock;
}

export interface BillingSummary {
  period: string;
  generated: Invoice[];
  /** Clientes que ya tenían la factura del período (RF-105). */
  alreadyInvoiced: number[];
  failed: { clientId: number; attempts: number; error: string }[];
  /** Facturas cuyo email se envió. */
  emailed: { invoiceId: number; to: string }[];
  emailFailed: { invoiceId: number; attempts: number; error: string }[];
}

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
 * Proceso de facturación mensual (RF-39): genera la factura del período corriente de cada
 * cliente facturable y, apenas se genera, la envía por email (RF-46). Generación y envío
 * tienen cada uno los reintentos configurados (RF-89); lo que sigue fallando queda como
 * error de proceso (RF-92). Un cliente que falla no demora a los demás.
 */
export async function runBilling({
  db,
  arca,
  mailer,
  issuerCuit,
  getExchangeRate = () => getBillingExchangeRate(db),
  clock = systemClock,
}: BillingDeps): Promise<BillingSummary> {
  const config = db.select().from(settings).get()!;
  const period = argentinaPeriod(clock.now());
  const now = () => clock.now();
  const generateDeps = {
    db,
    arca,
    exchangeRate: new ExchangeRateProvider(getExchangeRate),
    pointOfSale: config.pointOfSale,
    now,
  };
  const emailDeps = { db, mailer, issuerCuit, now };

  const summary: BillingSummary = { period, generated: [], alreadyInvoiced: [], failed: [], emailed: [], emailFailed: [] };
  const queue = new RetryQueue({ retries: config.retryCount, waitMs: config.retryWaitMinutes * 60_000 }, clock);

  const sendEmail = (invoice: Invoice) =>
    queue.add<InvoiceEmailResult>(
      () => sendInvoiceEmail(emailDeps, invoice.id),
      (result) => {
        if (!result.ok) {
          const error = errorMessage(result.error);
          recordProcessError(
            db,
            { operation: 'invoice_email', clientId: invoice.clientId, invoiceId: invoice.id, period },
            result.attempts,
            error,
          );
          summary.emailFailed.push({ invoiceId: invoice.id, attempts: result.attempts, error });
        } else if (result.value.kind === 'sent') {
          summary.emailed.push({ invoiceId: invoice.id, to: result.value.to });
        }
      },
    );

  for (const clientId of billableClientIds(db)) {
    queue.add<GenerateResult>(
      () => generateInvoice(generateDeps, clientId, period),
      (result) => {
        if (!result.ok) {
          const error = errorMessage(result.error);
          recordProcessError(db, { operation: 'invoice_generation', clientId, period }, result.attempts, error);
          summary.failed.push({ clientId, attempts: result.attempts, error });
        } else if (result.value.kind === 'generated') {
          summary.generated.push(result.value.invoice);
          sendEmail(result.value.invoice);
        } else if (result.value.kind === 'already_invoiced') {
          summary.alreadyInvoiced.push(clientId);
        }
      },
    );
  }

  await queue.run();
  return summary;
}
