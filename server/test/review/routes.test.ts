import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { type Db, openDb } from '../../src/db/index.js';
import {
  clients,
  emailAttachments,
  inboundEmails,
  invoiceItems,
  invoicePaymentEmails,
  invoices,
} from '../../src/db/schema.js';
import { parseEmail } from '../../src/mailbox/parse.js';
import { processEmail } from '../../src/mailbox/process.js';
import type { ReviewInvoice } from '../../src/review/service.js';
import { classified, fakeClassifier, rawEmail, receipt } from '../mailbox/fakes.js';

let db: Db;
let server: Server;
let base: string;
const now = new Date('2026-10-21T13:00:00Z');

beforeEach(async () => {
  db = openDb(':memory:');
  server = createApp({ db, issuerCuit: '20311274350', now: () => now }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => {
  server.close();
});

const CUIT = '30711111111';
let number = 0;

function addClient() {
  return db.insert(clients).values({ businessName: 'Panadería Los Andes', cuit: CUIT, email: 'pagos@losandes.com', vatConditionId: 1 }).returning().get();
}

function addInvoice(clientId: number, period: string, totalCents: number, overrides: Partial<typeof invoices.$inferInsert> = {}) {
  number += 1;
  const invoice = db
    .insert(invoices)
    .values({
      clientId, period, pointOfSale: 1, number, cae: `CAE${number}`, caeExpiresAt: `${period}-25`,
      issuedAt: new Date(`${period}-15T14:00:00Z`), clientBusinessName: 'Panadería Los Andes', clientCuit: CUIT,
      clientVatConditionId: 1, issueDate: `${period}-15`, serviceFrom: `${period}-01`, serviceTo: `${period}-28`,
      paymentDueDate: `${period}-28`, totalCents, ...overrides,
    })
    .returning()
    .get();
  db.insert(invoiceItems).values({ invoiceId: invoice.id, description: 'CRM', currency: 'ARS', unitPriceCents: totalCents, amountCents: totalCents }).run();
  return invoice;
}

/** Simula la llegada de un comprobante por la casilla, con el procesamiento real del paso 9. */
async function receivePayment(amountCents: number, subject = 'Pago') {
  const parsed = await parseEmail(await rawEmail({ from: 'pagos@losandes.com', subject, attachments: [receipt()] }), '<x>');
  return processEmail({ db, classify: fakeClassifier(classified('si', CUIT, amountCents)), now: () => now }, parsed);
}

const get = (path: string) => fetch(`${base}${path}`);
const reviewList = async () => (await (await get('/review/invoices')).json()) as ReviewInvoice[];
const post = (path: string) => fetch(`${base}${path}`, { method: 'POST' });
const status = (id: number) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;

describe('GET /api/review/invoices', () => {
  it('AC-90: lista las facturas en Pago recibido y Revisión manual con email, adjunto, clasificación, CUIT, monto y motivo', async () => {
    const client = addClient();
    const received = addInvoice(client.id, '2026-09', 15_000_00);
    addInvoice(client.id, '2026-08', 99_00, { status: 'paid' });
    await receivePayment(15_000_00, 'Pago septiembre');
    const pending = addInvoice(client.id, '2026-10', 20_000_00);
    await receivePayment(5_000_00, 'Pago parcial');

    const list = await reviewList();

    expect(list.map((i) => i.id)).toEqual([received.id, pending.id]);
    expect(list[0]).toMatchObject({
      status: 'payment_received',
      reviewReason: null,
      period: '2026-09',
      number: received.number,
      totalCents: 15_000_00,
      client: { businessName: 'Panadería Los Andes', cuit: CUIT, email: 'pagos@losandes.com' },
      emails: [
        {
          from: 'pagos@losandes.com',
          subject: 'Pago septiembre',
          classification: 'si',
          extractedCuit: CUIT,
          extractedAmountCents: 15_000_00,
          attachments: [{ filename: 'comprobante.pdf', contentType: 'application/pdf', sizeBytes: 20 }],
        },
      ],
    });
    expect(list[1]).toMatchObject({
      status: 'manual_review',
      reviewReason: 'monto no coincide',
      emails: [{ subject: 'Pago parcial', extractedAmountCents: 5_000_00 }],
    });
  });

  it('no muestra facturas en otros estados', async () => {
    const client = addClient();
    addInvoice(client.id, '2026-10', 100, { status: 'paid' });
    addInvoice(client.id, '2026-09', 100);

    expect(await (await get('/review/invoices')).json()).toEqual([]);
  });
});

describe('resolver una factura', () => {
  it('AC-92: confirmar el pago de una factura en Pago recibido la pasa a Pagada', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(15_000_00);

    const res = await post(`/invoices/${invoice.id}/confirm-payment`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: invoice.id, status: 'paid' });
    expect(status(invoice.id)).toMatchObject({ status: 'paid', statusChangedAt: now });
    expect(await (await get('/review/invoices')).json()).toEqual([]);
  });

  it('AC-93: indicar que el pago no se realizó devuelve la factura a Pendiente de pago', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(15_000_00);

    await post(`/invoices/${invoice.id}/reject-payment`);

    expect(status(invoice.id).status).toBe('pending_payment');
  });

  it('AC-94, AC-148: confirmar una factura en Revisión manual la pasa a Pagada y deja de mostrar el motivo', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(5_000_00);
    expect(status(invoice.id).reviewReason).toBe('monto no coincide');

    await post(`/invoices/${invoice.id}/confirm-payment`);

    expect(status(invoice.id)).toMatchObject({ status: 'paid', reviewReason: null });
  });

  it('AC-95, AC-148: devolver una factura en Revisión manual la pasa a Pendiente de pago sin motivo', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(5_000_00);

    await post(`/invoices/${invoice.id}/reject-payment`);

    expect(status(invoice.id)).toMatchObject({ status: 'pending_payment', reviewReason: null });
  });

  it('AC-96: una factura devuelta a Pendiente se vuelve a validar con un comprobante nuevo, que aparece solo', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(15_000_00, 'Primer comprobante');
    await post(`/invoices/${invoice.id}/reject-payment`);

    await receivePayment(15_000_00, 'Segundo comprobante');

    expect(status(invoice.id).status).toBe('payment_received');
    const [listed] = await reviewList();
    expect(listed!.emails.map((e) => e.subject)).toEqual(['Segundo comprobante']);
    expect(db.select().from(invoicePaymentEmails).all()).toHaveLength(2);
  });

  it('rechaza resolver una factura que no está en revisión', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const res = await post(`/invoices/${invoice.id}/confirm-payment`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'La factura no está en Pago recibido ni en Revisión manual' });
    expect(status(invoice.id).status).toBe('pending_payment');
  });

  it('responde 404 si la factura no existe', async () => {
    expect((await post('/invoices/999/confirm-payment')).status).toBe(404);
    expect((await post('/invoices/abc/reject-payment')).status).toBe(404);
  });
});

describe('archivos', () => {
  it('sirve un adjunto PDF para verlo en el navegador', async () => {
    const client = addClient();
    addInvoice(client.id, '2026-10', 15_000_00);
    await receivePayment(15_000_00);
    const attachment = db.select().from(emailAttachments).get()!;

    const res = await get(`/attachments/${attachment.id}`);

    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="comprobante.pdf"/);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4 comprobante');
  });

  it('un adjunto que no es PDF ni imagen se descarga, nunca se muestra (viene de un tercero)', async () => {
    const email = db
      .insert(inboundEmails)
      .values({ messageId: '<h>', fromAddress: 'x@y.com', receivedAt: now, hasAttachments: true })
      .returning()
      .get();
    const attachment = db
      .insert(emailAttachments)
      .values({ emailId: email.id, filename: 'pago.html', contentType: 'text/html', sizeBytes: 30, content: Buffer.from('<script>alert(1)</script>') })
      .returning()
      .get();

    const res = await get(`/attachments/${attachment.id}`);

    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('genera el PDF de una factura', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id, '2026-10', 15_000_00);

    const res = await get(`/invoices/${invoice.id}/pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('responde 404 en JSON para rutas de la API que no existen', async () => {
    const res = await get('/no-existe');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No existe' });
  });
});
