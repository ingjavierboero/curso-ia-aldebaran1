import { loadConfig, loadEnvFile } from '../config.js';
import { buildInvoiceEmail } from '../invoices/email.js';
import { type InvoiceItemRecord, type InvoiceRecord, renderInvoicePdf } from '../invoices/pdf.js';
import { createMailer } from './mailer.js';

// Prueba el envío por Gmail: manda a la propia casilla del sistema (o a EMAIL_REDIRECT_TO) un
// email de factura con un PDF de ejemplo. No emite nada en ARCA ni escribe en la base.
loadEnvFile();
const config = loadConfig();
const to = config.emailRedirectTo ?? config.gmail.user;

const at = new Date();
const invoice: InvoiceRecord = {
  id: 0,
  clientId: 0,
  period: '2026-10',
  invoiceType: 11,
  pointOfSale: 1,
  number: 0,
  cae: '00000000000000',
  caeExpiresAt: '2026-10-25',
  issuedAt: at,
  clientBusinessName: 'Cliente de prueba',
  clientCuit: '20222222223',
  clientVatConditionId: 6,
  issueDate: '2026-10-15',
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-31',
  paymentDueDate: '2026-10-31',
  totalCents: 201_600_00,
  exchangeRateCents: 1_555_00,
  exchangeRateSource: 'dolarhoy.com — dólar blue venta',
  exchangeRateAt: at,
  exchangeRateFallback: false,
  status: 'pending_payment',
  reviewReason: null,
  statusChangedAt: at,
  createdAt: at,
  updatedAt: at,
};
const items: InvoiceItemRecord[] = [
  { id: 1, invoiceId: 0, systemId: null, description: 'CRM', currency: 'ARS', unitPriceCents: 15_000_00, amountCents: 15_000_00 },
  { id: 2, invoiceId: 0, systemId: null, description: 'ERP', currency: 'USD', unitPriceCents: 120_00, amountCents: 186_600_00 },
];

try {
  const pdf = await renderInvoicePdf({ invoice, items, issuerCuit: config.arca.cuit });
  const email = buildInvoiceEmail(invoice, invoice.totalCents);
  const sent = await createMailer(config).send({
    ...email,
    subject: `[PRUEBA] ${email.subject}`,
    to,
    attachments: [{ filename: 'Factura-C-prueba.pdf', content: pdf, contentType: 'application/pdf' }],
  });
  console.log(`Email de prueba enviado a ${sent.to} (Message-ID ${sent.messageId})`);
} catch (error) {
  console.error(`Falló el envío por Gmail: ${(error as Error).message}`);
  process.exitCode = 1;
}
