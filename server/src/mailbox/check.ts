import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { invoices, mailboxChecks, mailboxState, processErrors } from '../db/schema.js';
import { errorMessage } from '../process-errors.js';
import type { MailboxSource } from './imap.js';
import { parseEmail } from './parse.js';
import { type ProcessDeps, type ProcessResult, processEmail } from './process.js';

export interface CheckDeps extends ProcessDeps {
  source: MailboxSource;
  /** Casilla del sistema (GMAIL_USER): sus propios emails no se procesan. */
  systemAddress: string;
}

export type CheckSummary =
  | { ok: true; checkId: number; detected: number; results: ProcessResult[]; skippedOwn: number }
  | { ok: false; checkId: number; error: string };

/**
 * Error de proceso de la revisión de la casilla (RF-52): uno solo mientras siga Pendiente;
 * cada falla siguiente actualiza el último mensaje y la cantidad de intentos.
 */
function recordMailboxError(db: Db, error: string): void {
  const pending = db
    .select()
    .from(processErrors)
    .where(and(eq(processErrors.operation, 'mailbox_check'), eq(processErrors.status, 'pending')))
    .get();
  if (pending) {
    db.update(processErrors).set({ attempts: pending.attempts + 1, lastError: error }).where(eq(processErrors.id, pending.id)).run();
  } else {
    db.insert(processErrors).values({ operation: 'mailbox_check', attempts: 1, lastError: error }).run();
  }
}

/** RF-54: con la casilla disponible otra vez, el error de revisión pasa a Resuelto. */
function resolveMailboxError(db: Db, now: Date): void {
  db.update(processErrors)
    .set({ status: 'resolved', resolvedAt: now })
    .where(and(eq(processErrors.operation, 'mailbox_check'), eq(processErrors.status, 'pending')))
    .run();
}

/** Primera lectura: desde la primera factura emitida (antes no hay pagos que esperar). */
function initialSince(db: Db, now: Date): Date {
  const first = db.select({ issuedAt: invoices.issuedAt }).from(invoices).orderBy(asc(invoices.issuedAt)).get();
  return first?.issuedAt ?? now;
}

/**
 * Revisa la casilla una vez (RF-50): lee los mensajes nuevos, los procesa en orden y avanza
 * la posición después de cada uno, así un corte no hace perder ni repetir emails. Registra
 * la revisión con los emails detectados (AC-56).
 */
export async function checkMailbox(deps: CheckDeps): Promise<CheckSummary> {
  const { db, source } = deps;
  const check = db.insert(mailboxChecks).values({ startedAt: deps.now() }).returning().get();
  const finish = (values: Partial<typeof mailboxChecks.$inferInsert>) =>
    db.update(mailboxChecks).set({ finishedAt: deps.now(), ...values }).where(eq(mailboxChecks.id, check.id)).run();

  const state = db.select().from(mailboxState).get();
  let fetched: Awaited<ReturnType<MailboxSource['fetchNew']>>;
  try {
    fetched = await source.fetchNew(state ?? null, initialSince(db, deps.now()));
  } catch (error) {
    const message = errorMessage(error);
    recordMailboxError(db, message);
    finish({ status: 'error', error: message });
    return { ok: false, checkId: check.id, error: message };
  }

  const results: ProcessResult[] = [];
  let skippedOwn = 0;
  try {
    for (const raw of fetched.messages) {
      const parsed = await parseEmail(raw.source, `<uid-${fetched.uidValidity}-${raw.uid}@aldebaran.local>`);
      if (parsed.from === deps.systemAddress.toLowerCase()) {
        skippedOwn += 1;
      } else {
        results.push(await processEmail(deps, parsed));
      }
      db.insert(mailboxState)
        .values({ id: 1, uidValidity: fetched.uidValidity, lastUid: raw.uid })
        .onConflictDoUpdate({ target: mailboxState.id, set: { uidValidity: fetched.uidValidity, lastUid: raw.uid } })
        .run();
    }
  } catch (error) {
    // Lo ya procesado queda guardado; el resto se retoma en la próxima revisión.
    const message = `falló el procesamiento de un email: ${errorMessage(error)}`;
    recordMailboxError(db, message);
    finish({ status: 'error', error: message, emailsDetected: results.length + skippedOwn });
    return { ok: false, checkId: check.id, error: message };
  }

  resolveMailboxError(db, deps.now());
  finish({ status: 'ok', emailsDetected: fetched.messages.length });
  return { ok: true, checkId: check.id, detected: fetched.messages.length, results, skippedOwn };
}
