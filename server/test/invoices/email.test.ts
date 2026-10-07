import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/db/index.js';
import { clientHistory, clients, invoiceItems, invoices } from '../../src/db/schema.js';
import { buildInvoiceEmail, sendInvoiceEmail } from '../../src/invoices/email.js';
import { fakeMailer } from '../billing/fakes.js';
import { sampleInvoice, sampleItems } from './pdf.test.js';

let db: Db;
const now = () => new Date('2026-10-15T14:01:00Z');

beforeEach(() => {
  db = openDb(':memory:');
});

function insertInvoice(overrides: Partial<typeof invoices.$inferInsert> = {}) {
  const client =
    db.select().from(clients).get() ??
    db.insert(clients).values({ businessName: 'Estudio Contable Ruiz', cuit: '20222222223', email: 'admin@estudioruiz.com', vatConditionId: 6 }).returning().get();
  const { id: _id, ...base } = sampleInvoice;
  const invoice = db.insert(invoices).values({ ...base, clientId: client.id, ...overrides }).returning().get();
  db.insert(invoiceItems)
    .values(sampleItems.map(({ id: _itemId, ...item }) => ({ ...item, systemId: null, invoiceId: invoice.id })))
    .run();
  return { client, invoice };
}

describe('buildInvoiceEmail', () => {
  it('RF-46, RF-122, AC-164: informa la factura y la deuda pendiente, pide el comprobante y aclara que es homologación', () => {
    const email = buildInvoiceEmail(sampleInvoice, 201_600_00);

    expect(email.subject).toBe('Factura C 00001-00000010 – octubre de 2026');
    expect(email.text).toBe(
      [
        'Hola, Estudio Contable Ruiz:',
        'Te enviamos adjunta la Factura C N° 00001-00000010 correspondiente a octubre de 2026, por $ 201.600,00, con vencimiento el 31/10/2026.',
        'Tenés una deuda pendiente de $ 201.600,00.',
        'Cuando realices el pago, respondé este email adjuntando el comprobante (transferencia o depósito) para que podamos registrarlo.',
        'Comprobante emitido en el ambiente de homologación de ARCA, sin validez fiscal.',
      ].join('\n\n'),
    );
  });

  it('aclara cuando la deuda incluye facturas anteriores', () => {
    expect(buildInvoiceEmail(sampleInvoice, 216_600_00).text).toContain(
      'Tenés una deuda pendiente de $ 216.600,00, que incluye facturas anteriores.',
    );
  });

  it('escapa el HTML de la razón social', () => {
    const email = buildInvoiceEmail({ ...sampleInvoice, clientBusinessName: 'Pérez & <Hijos>' }, 100);

    expect(email.html).toContain('<p>Hola, Pérez &amp; &lt;Hijos&gt;:</p>');
  });
});

describe('sendInvoiceEmail', () => {
  it('AC-50, AC-145: envía la factura en PDF a la casilla del cliente y registra el envío en su historial', async () => {
    const { client, invoice } = insertInvoice();
    const email = fakeMailer();

    const result = await sendInvoiceEmail({ db, mailer: email.mailer, issuerCuit: '20311274350', now }, invoice.id);

    expect(result).toEqual({ kind: 'sent', to: 'admin@estudioruiz.com', messageId: '<msg-1@test>' });
    const [sent] = email.sent;
    expect(sent).toMatchObject({ to: 'admin@estudioruiz.com', subject: 'Factura C 00001-00000010 – octubre de 2026' });
    expect(sent!.attachments).toEqual([
      { filename: 'Factura-C-00001-00000010.pdf', content: expect.any(Buffer), contentType: 'application/pdf' },
    ]);
    expect(sent!.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(db.select().from(clientHistory).all()).toEqual([
      expect.objectContaining({
        clientId: client.id,
        event: 'invoice_email_sent',
        invoiceId: invoice.id,
        occurredAt: now(),
        detail: {
          to: 'admin@estudioruiz.com',
          subject: 'Factura C 00001-00000010 – octubre de 2026',
          messageId: '<msg-1@test>',
          attachment: 'Factura-C-00001-00000010.pdf',
        },
      }),
    ]);
  });

  it('RF-49: no envía nada a un cliente Inactivo', async () => {
    const { client, invoice } = insertInvoice();
    db.update(clients).set({ status: 'inactive' }).where(eq(clients.id, client.id)).run();
    const email = fakeMailer();

    const result = await sendInvoiceEmail({ db, mailer: email.mailer, issuerCuit: '20311274350', now }, invoice.id);

    expect(result).toEqual({ kind: 'client_inactive' });
    expect(email.sent).toEqual([]);
    expect(db.select().from(clientHistory).all()).toEqual([]);
  });

  it('AC-29: después de cambiar el email del cliente, la factura va a la dirección nueva', async () => {
    const { client, invoice } = insertInvoice();
    db.update(clients).set({ email: 'nuevo@estudioruiz.com' }).where(eq(clients.id, client.id)).run();
    const email = fakeMailer();

    await sendInvoiceEmail({ db, mailer: email.mailer, issuerCuit: '20311274350', now }, invoice.id);

    expect(email.sent[0]!.to).toBe('nuevo@estudioruiz.com');
  });

  it('AC-163: la deuda pendiente suma las facturas adeudadas del cliente', async () => {
    insertInvoice({ period: '2026-09', number: 9, totalCents: 15_000_00, status: 'manual_review', reviewReason: 'monto no coincide' });
    insertInvoice({ period: '2026-08', number: 8, totalCents: 99_000_00, status: 'paid' });
    const { invoice } = insertInvoice();
    const email = fakeMailer();

    await sendInvoiceEmail({ db, mailer: email.mailer, issuerCuit: '20311274350', now }, invoice.id);

    expect(email.sent[0]!.text).toContain('Tenés una deuda pendiente de $ 216.600,00, que incluye facturas anteriores.');
  });

  it('si el envío falla, no registra nada en el historial', async () => {
    const { invoice } = insertInvoice();
    const email = fakeMailer();
    email.state.failures = 1;

    await expect(sendInvoiceEmail({ db, mailer: email.mailer, issuerCuit: '20311274350', now }, invoice.id)).rejects.toThrow(
      'no se pudo enviar el email: 550 rechazado',
    );
    expect(db.select().from(clientHistory).all()).toEqual([]);
  });
});
