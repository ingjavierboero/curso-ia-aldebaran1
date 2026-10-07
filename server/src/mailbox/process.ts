import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clientHistory, clients, emailAttachments, inboundEmails, invoicePaymentEmails, invoices } from '../db/schema.js';
import { type ClassificationOutcome, type EmailToClassify } from '../payments/classifier.js';
import { type PaymentDecision, type ProcessingResult, decidePayment } from '../payments/rules.js';
import type { ParsedEmail } from './parse.js';

export interface ProcessDeps {
  db: Db;
  classify: (email: EmailToClassify) => Promise<ClassificationOutcome>;
  now: () => Date;
}

export type ProcessResult =
  /** RF-109: ya se había procesado. */
  | { kind: 'duplicate'; emailId: number }
  /** RF-56: el remitente no es ningún cliente. */
  | { kind: 'notice'; emailId: number }
  /** RF-58: email de un cliente sin adjuntos. */
  | { kind: 'no_attachments'; emailId: number; clientId: number }
  | { kind: 'processed'; emailId: number; clientId: number; outcome: ClassificationOutcome; decision: PaymentDecision };

type InboundEmail = typeof inboundEmails.$inferSelect;

/** Registra el email recibido con sus adjuntos y, si es de un cliente, en su historial (RF-57). */
function register(db: Db, email: ParsedEmail, clientId: number | null, now: Date): InboundEmail {
  return db.transaction((tx) => {
    const created = tx
      .insert(inboundEmails)
      .values({
        messageId: email.messageId,
        fromAddress: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        clientId,
        hasAttachments: email.attachments.length > 0,
        // Sin adjunto no hay nada que clasificar (RF-58).
        processingStatus: clientId !== null && email.attachments.length > 0 ? 'pending' : 'processed',
        noticeStatus: clientId === null ? 'pending' : null,
      })
      .returning()
      .get();
    if (email.attachments.length > 0) {
      tx.insert(emailAttachments)
        .values(
          email.attachments.map((a) => ({
            emailId: created.id,
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.content.length,
            content: a.content,
          })),
        )
        .run();
    }
    if (clientId !== null) {
      tx.insert(clientHistory)
        .values({
          clientId,
          event: 'email_received',
          occurredAt: now,
          emailId: created.id,
          detail: {
            from: email.from,
            subject: email.subject,
            receivedAt: email.receivedAt.toISOString(),
            attachments: email.attachments.map((a) => a.filename),
          },
        })
        .run();
    }
    return created;
  });
}

/** Aplica la decisión del motor de reglas (RF-62 a RF-74) y registra el resultado (RF-61). */
function applyResult(
  db: Db,
  email: InboundEmail,
  clientId: number,
  outcome: ClassificationOutcome,
  now: Date,
): PaymentDecision {
  return db.transaction((tx) => {
    const client = tx.select().from(clients).where(eq(clients.id, clientId)).get()!;
    const clientInvoices = tx
      .select({ id: invoices.id, period: invoices.period, totalCents: invoices.totalCents, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.clientId, clientId))
      .all();
    const decision = decidePayment(outcome.result, client.cuit, clientInvoices);

    const result: ProcessingResult = outcome.result;
    tx.update(inboundEmails)
      .set({
        processingStatus: result.kind === 'error' ? 'error' : 'processed',
        classification: result.kind === 'classified' ? result.classification : null,
        extractedCuit: result.kind === 'classified' ? result.cuit : null,
        extractedAmountCents: result.kind === 'classified' ? result.amountCents : null,
        processingError: outcome.error ?? null,
        processedAt: now,
      })
      .where(eq(inboundEmails.id, email.id))
      .run();

    if (decision.action !== 'none') {
      // El agente nunca pasa una factura a Pagada: solo a Pago recibido o Revisión manual.
      tx.update(invoices)
        .set(
          decision.action === 'payment_received'
            ? { status: 'payment_received', reviewReason: null, statusChangedAt: now }
            : { status: 'manual_review', reviewReason: decision.reason, statusChangedAt: now },
        )
        .where(inArray(invoices.id, decision.invoiceIds))
        .run();
      // El email queda asociado a las facturas que tocó, para la interfaz de revisión (RF-74, RF-75).
      tx.insert(invoicePaymentEmails)
        .values(decision.invoiceIds.map((invoiceId) => ({ invoiceId, emailId: email.id, linkedAt: now })))
        .onConflictDoNothing()
        .run();
    }

    tx.insert(clientHistory)
      .values({
        clientId,
        event: 'email_processed',
        occurredAt: now,
        emailId: email.id,
        detail:
          result.kind === 'error'
            ? { erroneous: true, error: outcome.error, attempts: outcome.attempts, rule: decision.rule }
            : {
                classification: result.classification,
                cuit: result.cuit,
                amountCents: result.amountCents,
                attempts: outcome.attempts,
                rule: decision.rule,
                action: decision.action,
                ...(decision.action === 'manual_review' ? { reason: decision.reason } : {}),
                ...(decision.action !== 'none' ? { invoiceIds: decision.invoiceIds } : {}),
              },
      })
      .run();
    return decision;
  });
}

async function classifyAndApply(deps: ProcessDeps, email: InboundEmail, clientId: number, parsed: ParsedEmail) {
  const outcome = await deps.classify({ subject: parsed.subject, text: parsed.text, attachments: parsed.attachments });
  const decision = applyResult(deps.db, email, clientId, outcome, deps.now());
  return { kind: 'processed' as const, emailId: email.id, clientId, outcome, decision };
}

/**
 * Procesa un email recibido: aviso si el remitente no es cliente (RF-55, RF-56), historial
 * (RF-57), y si tiene adjunto, clasificación con el LLM y decisión sobre las facturas
 * (RF-58 a RF-74). Cada email se procesa una sola vez por su Message-ID (RF-109); uno que
 * quedó registrado sin clasificar (por ejemplo, por un corte) se retoma.
 */
export async function processEmail(deps: ProcessDeps, parsed: ParsedEmail): Promise<ProcessResult> {
  const { db } = deps;
  const existing = db.select().from(inboundEmails).where(eq(inboundEmails.messageId, parsed.messageId)).get();
  if (existing) {
    if (existing.processingStatus === 'pending' && existing.clientId !== null) {
      return classifyAndApply(deps, existing, existing.clientId, parsed);
    }
    return { kind: 'duplicate', emailId: existing.id };
  }

  // La casilla registrada se guarda en minúsculas; el remitente también (RF-108).
  const client = db.select().from(clients).where(eq(clients.email, parsed.from)).get();
  const email = register(db, parsed, client?.id ?? null, deps.now());

  if (!client) return { kind: 'notice', emailId: email.id };
  if (parsed.attachments.length === 0) return { kind: 'no_attachments', emailId: email.id, clientId: client.id };
  return classifyAndApply(deps, email, client.id, parsed);
}
