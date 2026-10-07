import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/db/index.js';
import {
  clientHistory,
  clients,
  emailAttachments,
  inboundEmails,
  invoicePaymentEmails,
  invoices,
} from '../../src/db/schema.js';
import { parseEmail } from '../../src/mailbox/parse.js';
import { processEmail } from '../../src/mailbox/process.js';
import type { ClassificationOutcome } from '../../src/payments/classifier.js';
import { classified, erroneous, fakeClassifier, rawEmail, receipt } from './fakes.js';

let db: Db;
const CUIT = '30711111111';
const now = () => new Date('2026-10-20T15:01:00Z');

beforeEach(() => {
  db = openDb(':memory:');
});

function addClient(email = 'pagos@losandes.com') {
  return db.insert(clients).values({ businessName: 'Panadería Los Andes', cuit: CUIT, email, vatConditionId: 1 }).returning().get();
}

let number = 0;
function addInvoice(clientId: number, period: string, totalCents: number, overrides: Partial<typeof invoices.$inferInsert> = {}) {
  number += 1;
  return db
    .insert(invoices)
    .values({
      clientId,
      period,
      pointOfSale: 1,
      number,
      cae: `CAE${number}`,
      caeExpiresAt: `${period}-25`,
      issuedAt: new Date(`${period}-15T14:00:00Z`),
      clientBusinessName: 'Panadería Los Andes',
      clientCuit: CUIT,
      clientVatConditionId: 1,
      issueDate: `${period}-15`,
      serviceFrom: `${period}-01`,
      serviceTo: `${period}-28`,
      paymentDueDate: `${period}-28`,
      totalCents,
      ...overrides,
    })
    .returning()
    .get();
}

async function receive(options: Parameters<typeof rawEmail>[0], ...outcomes: ClassificationOutcome[]) {
  const classify = fakeClassifier(...outcomes);
  const parsed = await parseEmail(await rawEmail(options), '<fallback@test>');
  const result = await processEmail({ db, classify, now }, parsed);
  return { result, classify, parsed };
}

const invoiceRow = (id: number) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const linkedEmails = (invoiceId: number) =>
  db.select().from(invoicePaymentEmails).where(eq(invoicePaymentEmails.invoiceId, invoiceId)).all().map((l) => l.emailId);

describe('remitente', () => {
  it('AC-62: un remitente que no es cliente queda como aviso Pendiente, sin LLM ni cambios', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const { result, classify } = await receive({ from: 'desconocido@otro.com', attachments: [receipt()] });

    expect(result.kind).toBe('notice');
    expect(classify).not.toHaveBeenCalled();
    expect(db.select().from(inboundEmails).get()).toMatchObject({
      fromAddress: 'desconocido@otro.com',
      clientId: null,
      noticeStatus: 'pending',
      hasAttachments: true,
    });
    expect(db.select().from(emailAttachments).all()).toHaveLength(1);
    expect(invoiceRow(invoice.id).status).toBe('pending_payment');
  });

  it('AC-146: reconoce al cliente aunque el remitente use mayúsculas', async () => {
    addClient();

    const { result } = await receive({ from: 'Panadería <Pagos@LosAndes.com>' });

    expect(result.kind).toBe('no_attachments');
  });

  it('AC-29: con el email del cliente cambiado, la dirección anterior ya no es del cliente', async () => {
    const client = addClient();
    db.update(clients).set({ email: 'nuevo@losandes.com' }).where(eq(clients.id, client.id)).run();

    const { result } = await receive({ from: 'pagos@losandes.com', attachments: [receipt()] });

    expect(result.kind).toBe('notice');
  });
});

describe('emails del cliente', () => {
  it('AC-63: registra el email en el historial con fecha, asunto y adjuntos', async () => {
    const client = addClient();

    await receive({ from: 'pagos@losandes.com', subject: 'Pago octubre', attachments: [receipt('pago.pdf')] }, classified('no'));

    expect(db.select().from(clientHistory).where(eq(clientHistory.event, 'email_received')).all()).toEqual([
      expect.objectContaining({
        clientId: client.id,
        detail: {
          from: 'pagos@losandes.com',
          subject: 'Pago octubre',
          receivedAt: '2026-10-20T15:00:00.000Z',
          attachments: ['pago.pdf'],
        },
      }),
    ]);
  });

  it('AC-64: un email sin adjunto no va al LLM ni cambia facturas', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const { result, classify } = await receive({ from: 'pagos@losandes.com', text: 'Ya les pagué' });

    expect(result.kind).toBe('no_attachments');
    expect(classify).not.toHaveBeenCalled();
    expect(invoiceRow(invoice.id).status).toBe('pending_payment');
    expect(db.select().from(inboundEmails).get()).toMatchObject({ hasAttachments: false, processingStatus: 'processed' });
  });

  it('AC-169: una imagen embebida en el cuerpo (por ejemplo, el logo de la firma) no cuenta como adjunto', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const { result } = await receive({
      from: 'pagos@losandes.com',
      html: '<p>Saludos</p><img src="cid:logo@firma">',
      attachments: [{ filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'logo@firma' }],
    });

    expect(result.kind).toBe('no_attachments');
    expect(invoiceRow(invoice.id).status).toBe('pending_payment');
  });

  it('manda al clasificador el asunto, el texto y los adjuntos', async () => {
    addClient();

    const { classify } = await receive(
      { from: 'pagos@losandes.com', subject: 'Pago', text: 'Va el comprobante', attachments: [receipt()] },
      classified('no'),
    );

    expect(classify).toHaveBeenCalledWith({
      subject: 'Pago',
      text: 'Va el comprobante',
      attachments: [{ filename: 'comprobante.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 comprobante') }],
    });
  });

  it('AC-147: un email ya procesado no se vuelve a procesar', async () => {
    const client = addClient();
    addInvoice(client.id, '2026-10', 15_000_00);
    const raw = await rawEmail({ from: 'pagos@losandes.com', attachments: [receipt()] });
    const classify = fakeClassifier(classified('si', CUIT, 15_000_00));

    await processEmail({ db, classify, now }, await parseEmail(raw, '<x>'));
    const second = await processEmail({ db, classify, now }, await parseEmail(raw, '<x>'));

    expect(second.kind).toBe('duplicate');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(db.select().from(clientHistory).all()).toHaveLength(2); // recibido + procesado, una sola vez
  });

  it('retoma la clasificación de un email que quedó registrado sin clasificar', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    const raw = await rawEmail({ from: 'pagos@losandes.com', attachments: [receipt()] });
    const failing = fakeClassifier(); // simula un corte durante la clasificación
    await expect(processEmail({ db, classify: failing, now }, await parseEmail(raw, '<x>'))).rejects.toThrow();

    const result = await processEmail(
      { db, classify: fakeClassifier(classified('si', CUIT, 15_000_00)), now },
      await parseEmail(raw, '<x>'),
    );

    expect(result.kind).toBe('processed');
    expect(invoiceRow(invoice.id).status).toBe('payment_received');
    expect(db.select().from(inboundEmails).all()).toHaveLength(1);
  });
});

describe('resultado del procesamiento (RF-61)', () => {
  it('AC-68: registra la clasificación, el CUIT y el monto en el historial', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 15_000_00));

    expect(db.select().from(inboundEmails).get()).toMatchObject({
      processingStatus: 'processed',
      classification: 'si',
      extractedCuit: CUIT,
      extractedAmountCents: 15_000_00,
      processedAt: now(),
    });
    expect(db.select().from(clientHistory).where(eq(clientHistory.event, 'email_processed')).get()!.detail).toEqual({
      classification: 'si',
      cuit: CUIT,
      amountCents: 15_000_00,
      attempts: 1,
      rule: 'RF-69',
      action: 'payment_received',
      invoiceIds: [invoice.id],
    });
  });

  it('AC-69, AC-78: registra la marca de procesamiento erróneo y pasa las adeudadas a Revisión manual', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, erroneous);

    expect(db.select().from(inboundEmails).get()).toMatchObject({
      processingStatus: 'error',
      classification: null,
      processingError: 'el LLM respondió HTTP 500: Internal server error',
    });
    expect(db.select().from(clientHistory).where(eq(clientHistory.event, 'email_processed')).get()!.detail).toMatchObject({
      erroneous: true,
      attempts: 4,
    });
    expect(invoiceRow(invoice.id)).toMatchObject({ status: 'manual_review', reviewReason: 'no se pudo procesar el comprobante' });
  });
});

describe('estado de las facturas', () => {
  it('AC-72: clasificación "no" → ninguna factura cambia y no se envía nada', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('no'));

    expect(invoiceRow(invoice.id).status).toBe('pending_payment');
    expect(linkedEmails(invoice.id)).toEqual([]);
  });

  it('AC-83: comprobante validable por el monto exacto → Pago recibido, con el email asociado', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const { result } = await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 15_000_00));

    expect(invoiceRow(invoice.id)).toMatchObject({ status: 'payment_received', reviewReason: null, statusChangedAt: now() });
    expect(linkedEmails(invoice.id)).toEqual([result.emailId]);
  });

  it('AC-84: A + C → pasan A y C, B sigue Pendiente', async () => {
    const client = addClient();
    const a = addInvoice(client.id, '2026-07', 100_00);
    const b = addInvoice(client.id, '2026-08', 250_00);
    const c = addInvoice(client.id, '2026-09', 400_00);

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 500_00));

    expect([a, b, c].map((i) => invoiceRow(i.id).status)).toEqual(['payment_received', 'pending_payment', 'payment_received']);
  });

  it('AC-89: pago parcial → Revisión manual con el motivo "monto no coincide"', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const { result } = await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 5_000_00));

    expect(invoiceRow(invoice.id)).toMatchObject({ status: 'manual_review', reviewReason: 'monto no coincide' });
    expect(linkedEmails(invoice.id)).toEqual([result.emailId]);
  });

  it('AC-75, AC-77: cliente en revisión → todo a Revisión manual y la revisión junta los dos comprobantes', async () => {
    const client = addClient();
    const september = addInvoice(client.id, '2026-09', 500_00);
    const october = addInvoice(client.id, '2026-10', 300_00);
    const first = await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 100_00));
    expect(invoiceRow(september.id).status).toBe('manual_review');

    const second = await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 300_00));

    for (const invoice of [september, october]) {
      expect(invoiceRow(invoice.id)).toMatchObject({ status: 'manual_review', reviewReason: 'revisión manual pendiente' });
      expect(linkedEmails(invoice.id)).toEqual([first.result.emailId, second.result.emailId]);
    }
  });

  it('AC-73: cliente sin deuda vigente → el comprobante queda en el historial y nada cambia', async () => {
    const client = addClient();
    const paid = addInvoice(client.id, '2026-10', 15_000_00, { status: 'paid' });

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 15_000_00));

    expect(invoiceRow(paid.id).status).toBe('paid');
    expect(db.select().from(clientHistory).where(eq(clientHistory.event, 'email_processed')).get()!.detail).toMatchObject({
      rule: 'RF-63',
      action: 'none',
    });
  });

  it('AC-170: procesa el comprobante de un cliente Inactivo con deuda', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    db.update(clients).set({ status: 'inactive' }).where(eq(clients.id, client.id)).run();

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 15_000_00));

    expect(invoiceRow(invoice.id).status).toBe('payment_received');
  });

  it('el agente nunca pasa una factura a Pagada', async () => {
    const client = addClient();
    addInvoice(client.id, '2026-10', 15_000_00);

    await receive({ from: 'pagos@losandes.com', attachments: [receipt()] }, classified('si', CUIT, 15_000_00));

    expect(db.select().from(invoices).where(eq(invoices.status, 'paid')).all()).toEqual([]);
  });
});
