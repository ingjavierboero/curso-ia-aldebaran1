import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clientHistory, clients, invoiceItems, invoices } from '../db/schema.js';
import type { Mailer, OutgoingEmail } from '../email/mailer.js';
import { formatArs, formatDate, formatInvoiceNumber, formatPeriod } from './format.js';
import { type InvoiceRecord, renderInvoicePdf } from './pdf.js';

export interface InvoiceEmailDeps {
  db: Db;
  mailer: Mailer;
  /** CUIT del emisor (ARCA_CUIT), para el PDF. */
  issuerCuit: string;
  now: () => Date;
}

export type InvoiceEmailResult =
  | { kind: 'sent'; to: string; messageId: string }
  /** RF-49: a un cliente Inactivo no se le envía ningún email. */
  | { kind: 'client_inactive' };

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Deuda vigente del cliente: total de sus facturas en Pendiente de pago o Revisión manual. */
function owedTotal(db: Db, clientId: number): number {
  return db
    .select({ total: invoices.totalCents })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), inArray(invoices.status, ['pending_payment', 'manual_review'])))
    .all()
    .reduce((sum, i) => sum + i.total, 0);
}

/** Email de la factura (RF-46): informa la deuda pendiente y pide responder con el comprobante. */
export function buildInvoiceEmail(invoice: InvoiceRecord, owedCents: number): Omit<OutgoingEmail, 'to' | 'attachments'> {
  const number = formatInvoiceNumber(invoice.pointOfSale, invoice.number);
  const period = formatPeriod(invoice.period);
  const amount = formatArs(invoice.totalCents);
  const due = formatDate(invoice.paymentDueDate);
  const owed = formatArs(owedCents);
  const previous = owedCents > invoice.totalCents ? ', que incluye facturas anteriores' : '';

  const paragraphs = [
    `Hola, ${invoice.clientBusinessName}:`,
    `Te enviamos adjunta la Factura C N° ${number} correspondiente a ${period}, por ${amount}, con vencimiento el ${due}.`,
    `Tenés una deuda pendiente de ${owed}${previous}.`,
    'Cuando realices el pago, respondé este email adjuntando el comprobante (transferencia o depósito) para que podamos registrarlo.',
    'Comprobante emitido en el ambiente de homologación de ARCA, sin validez fiscal.',
  ];
  return {
    subject: `Factura C ${number} – ${period}`,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n'),
  };
}

/**
 * Envía por email la factura en PDF a la casilla registrada del cliente (RF-46, RF-106) y
 * registra el envío en su historial (AC-50). Falla con un error si el envío falla; quien la
 * llama decide los reintentos.
 */
export async function sendInvoiceEmail(deps: InvoiceEmailDeps, invoiceId: number): Promise<InvoiceEmailResult> {
  const { db } = deps;
  const invoice = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw new Error(`no existe la factura ${invoiceId}`);
  const client = db.select().from(clients).where(eq(clients.id, invoice.clientId)).get()!;
  if (client.status !== 'active') return { kind: 'client_inactive' };

  const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).orderBy(invoiceItems.id).all();
  const pdf = await renderInvoicePdf({ invoice, items, issuerCuit: deps.issuerCuit });
  const email = buildInvoiceEmail(invoice, owedTotal(db, client.id));
  const filename = `Factura-C-${formatInvoiceNumber(invoice.pointOfSale, invoice.number)}.pdf`;

  const sent = await deps.mailer.send({
    ...email,
    to: client.email,
    attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
  });

  db.insert(clientHistory)
    .values({
      clientId: client.id,
      event: 'invoice_email_sent',
      occurredAt: deps.now(),
      invoiceId,
      detail: { to: sent.to, subject: email.subject, messageId: sent.messageId, attachment: filename },
    })
    .run();
  return { kind: 'sent', ...sent };
}
