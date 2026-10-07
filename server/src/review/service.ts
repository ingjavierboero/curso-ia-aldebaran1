import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clients, emailAttachments, inboundEmails, invoicePaymentEmails, invoices } from '../db/schema.js';

/** Estados que un usuario resuelve desde la interfaz de revisión (RF-75). */
const REVIEWABLE = ['payment_received', 'manual_review'] as const;

export class ReviewError extends Error {
  constructor(
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewEmail {
  id: number;
  from: string;
  subject: string;
  receivedAt: string;
  processingStatus: string;
  processingError: string | null;
  classification: string | null;
  extractedCuit: string | null;
  extractedAmountCents: number | null;
  attachments: { id: number; filename: string; contentType: string; sizeBytes: number }[];
}

export interface ReviewInvoice {
  id: number;
  status: 'payment_received' | 'manual_review';
  reviewReason: string | null;
  statusChangedAt: string;
  period: string;
  pointOfSale: number;
  number: number;
  totalCents: number;
  paymentDueDate: string;
  client: { id: number; businessName: string; cuit: string; email: string };
  /** Emails con comprobantes asociados a esta revisión, del más viejo al más nuevo. */
  emails: ReviewEmail[];
}

/** Facturas en Pago recibido o Revisión manual con sus comprobantes (RF-75, AC-90). */
export function listReviewInvoices(db: Db): ReviewInvoice[] {
  const rows = db
    .select({ invoice: invoices, client: clients })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(inArray(invoices.status, [...REVIEWABLE]))
    .orderBy(asc(clients.businessName), asc(invoices.period), asc(invoices.id))
    .all();
  if (rows.length === 0) return [];

  const links = db
    .select({ invoiceId: invoicePaymentEmails.invoiceId, email: inboundEmails })
    .from(invoicePaymentEmails)
    .innerJoin(inboundEmails, eq(inboundEmails.id, invoicePaymentEmails.emailId))
    .where(
      and(
        inArray(invoicePaymentEmails.invoiceId, rows.map((r) => r.invoice.id)),
        // Solo los comprobantes de la revisión vigente, no los ya resueltos antes.
        isNull(invoicePaymentEmails.resolvedAt),
      ),
    )
    .orderBy(asc(inboundEmails.receivedAt), asc(inboundEmails.id))
    .all();

  const emailIds = [...new Set(links.map((l) => l.email.id))];
  const attachments =
    emailIds.length === 0
      ? []
      : db
          .select({
            id: emailAttachments.id,
            emailId: emailAttachments.emailId,
            filename: emailAttachments.filename,
            contentType: emailAttachments.contentType,
            sizeBytes: emailAttachments.sizeBytes,
          })
          .from(emailAttachments)
          .where(inArray(emailAttachments.emailId, emailIds))
          .orderBy(asc(emailAttachments.id))
          .all();

  const toEmail = (email: typeof inboundEmails.$inferSelect): ReviewEmail => ({
    id: email.id,
    from: email.fromAddress,
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
    processingStatus: email.processingStatus,
    processingError: email.processingError,
    classification: email.classification,
    extractedCuit: email.extractedCuit,
    extractedAmountCents: email.extractedAmountCents,
    attachments: attachments
      .filter((a) => a.emailId === email.id)
      .map(({ emailId: _emailId, ...attachment }) => attachment),
  });

  return rows.map(({ invoice, client }) => ({
    id: invoice.id,
    status: invoice.status as ReviewInvoice['status'],
    reviewReason: invoice.reviewReason,
    statusChangedAt: invoice.statusChangedAt.toISOString(),
    period: invoice.period,
    pointOfSale: invoice.pointOfSale,
    number: invoice.number,
    totalCents: invoice.totalCents,
    paymentDueDate: invoice.paymentDueDate,
    client: { id: client.id, businessName: client.businessName, cuit: client.cuit, email: client.email },
    emails: links.filter((l) => l.invoiceId === invoice.id).map((l) => toEmail(l.email)),
  }));
}

/**
 * El usuario resuelve una factura en revisión (RF-77 a RF-80): la pasa a Pagada o la devuelve a
 * Pendiente de pago. Sale de la revisión sin motivo (RF-110) y sus comprobantes quedan
 * resueltos, así una revisión futura arranca sin ellos.
 */
export function resolveInvoice(db: Db, invoiceId: number, target: 'paid' | 'pending_payment', now: Date) {
  return db.transaction((tx) => {
    const invoice = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    if (!invoice) throw new ReviewError(404, 'La factura no existe');
    if (!(REVIEWABLE as readonly string[]).includes(invoice.status)) {
      throw new ReviewError(409, 'La factura no está en Pago recibido ni en Revisión manual');
    }
    const updated = tx
      .update(invoices)
      .set({ status: target, reviewReason: null, statusChangedAt: now })
      .where(eq(invoices.id, invoiceId))
      .returning()
      .get();
    tx.update(invoicePaymentEmails)
      .set({ resolvedAt: now })
      .where(and(eq(invoicePaymentEmails.invoiceId, invoiceId), isNull(invoicePaymentEmails.resolvedAt)))
      .run();
    return updated;
  });
}

export function getAttachment(db: Db, attachmentId: number) {
  const attachment = db.select().from(emailAttachments).where(eq(emailAttachments.id, attachmentId)).get();
  if (!attachment) throw new ReviewError(404, 'El adjunto no existe');
  return attachment;
}
