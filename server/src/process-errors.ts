import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { type PROCESS_OPERATIONS, processErrors } from './db/schema.js';

export interface ProcessErrorSubject {
  operation: (typeof PROCESS_OPERATIONS)[number];
  clientId?: number | null;
  invoiceId?: number | null;
  period?: string | null;
}

const matches = <T>(column: Parameters<typeof eq>[0], value: T | null | undefined) =>
  value === null || value === undefined ? isNull(column) : eq(column, value);

/**
 * Registra una operación automática que falló tras el último reintento (RF-92). Si ya hay un
 * error Pendiente para la misma operación, cliente, factura y período, lo actualiza en vez de
 * duplicarlo.
 */
export function recordProcessError(db: Db, subject: ProcessErrorSubject, attempts: number, lastError: string): void {
  const pending = db
    .select({ id: processErrors.id })
    .from(processErrors)
    .where(
      and(
        eq(processErrors.operation, subject.operation),
        eq(processErrors.status, 'pending'),
        matches(processErrors.clientId, subject.clientId),
        matches(processErrors.invoiceId, subject.invoiceId),
        matches(processErrors.period, subject.period),
      ),
    )
    .get();
  if (pending) {
    db.update(processErrors).set({ attempts, lastError }).where(eq(processErrors.id, pending.id)).run();
  } else {
    db.insert(processErrors)
      .values({
        operation: subject.operation,
        clientId: subject.clientId ?? null,
        invoiceId: subject.invoiceId ?? null,
        period: subject.period ?? null,
        attempts,
        lastError,
      })
      .run();
  }
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
