import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../src/db/index.js';
import {
  clientSystems,
  clients,
  inboundEmails,
  invoiceItems,
  invoices,
  settings,
  systems,
} from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function insertClient(overrides: Partial<typeof clients.$inferInsert> = {}) {
  return db
    .insert(clients)
    .values({ businessName: 'Cliente', cuit: '20123456789', email: 'cliente@test.com', ...overrides })
    .returning()
    .get();
}

function insertInvoice(clientId: number, overrides: Partial<typeof invoices.$inferInsert> = {}) {
  return db
    .insert(invoices)
    .values({
      clientId,
      period: '2026-09',
      pointOfSale: 1,
      number: 1,
      cae: '76123456789012',
      caeExpiresAt: '2026-09-25',
      issuedAt: new Date(),
      clientBusinessName: 'Cliente',
      clientCuit: '20123456789',
      totalCents: 15_000_00,
      ...overrides,
    })
    .returning()
    .get();
}

describe('configuración', () => {
  it('crea la fila única con los valores por defecto del PRD', () => {
    expect(db.select().from(settings).all()).toEqual([
      expect.objectContaining({
        id: 1,
        mailboxIntervalMinutes: 15,
        billingTime: '11:00',
        reminderTime: '11:00',
        retryCount: 3,
        retryWaitMinutes: 5,
        pointOfSale: 1,
      }),
    ]);
  });

  it('no permite una segunda fila', () => {
    expect(() => db.insert(settings).values({ id: 2 }).run()).toThrow(/CHECK/);
  });

  it.each([
    ['intervalo de la casilla 4', { mailboxIntervalMinutes: 4 }],
    ['intervalo de la casilla 61', { mailboxIntervalMinutes: 61 }],
    ['hora de facturación 23:40', { billingTime: '23:40' }],
    ['hora de facturación sin formato', { billingTime: '9:00' }],
    ['hora de recordatorios 23:40', { reminderTime: '23:40' }],
    ['reintentos 11', { retryCount: 11 }],
    ['reintentos -1', { retryCount: -1 }],
    ['espera 0', { retryWaitMinutes: 0 }],
    ['espera 61', { retryWaitMinutes: 61 }],
    ['punto de venta 0', { pointOfSale: 0 }],
    ['punto de venta 100000', { pointOfSale: 100_000 }],
  ])('rechaza %s', (_name, values) => {
    expect(() => db.update(settings).set(values).where(eq(settings.id, 1)).run()).toThrow(/CHECK/);
  });

  it.each([
    ['los mínimos', { mailboxIntervalMinutes: 5, billingTime: '00:00', retryCount: 0, retryWaitMinutes: 1, pointOfSale: 1 }],
    ['los máximos', { mailboxIntervalMinutes: 60, billingTime: '23:39', retryCount: 10, retryWaitMinutes: 60, pointOfSale: 99_999 }],
  ])('acepta %s', (_name, values) => {
    db.update(settings).set(values).where(eq(settings.id, 1)).run();

    expect(db.select().from(settings).get()).toMatchObject(values);
  });
});

describe('clientes', () => {
  it('nace Activo', () => {
    expect(insertClient().status).toBe('active');
  });

  it('rechaza un CUIT que no tiene 11 dígitos', () => {
    expect(() => insertClient({ cuit: '20-12345678-9' })).toThrow(/CHECK/);
  });

  it('exige la casilla en minúsculas para poder comparar remitentes', () => {
    expect(() => insertClient({ email: 'Cliente@Test.com' })).toThrow(/CHECK/);
  });

  it('no permite dos clientes con la misma casilla', () => {
    insertClient();

    expect(() => insertClient({ cuit: '20987654321' })).toThrow(/UNIQUE/);
  });
});

describe('facturas', () => {
  it('nace como Factura C en Pendiente de pago', () => {
    const invoice = insertInvoice(insertClient().id);

    expect(invoice).toMatchObject({ invoiceType: 11, status: 'pending_payment', reviewReason: null });
  });

  it('exige el motivo solo en Revisión manual', () => {
    const client = insertClient();

    expect(() => insertInvoice(client.id, { status: 'manual_review' })).toThrow(/CHECK/);
    expect(() => insertInvoice(client.id, { reviewReason: 'monto no coincide' })).toThrow(/CHECK/);
    expect(
      insertInvoice(client.id, { status: 'manual_review', reviewReason: 'monto no coincide' }).status,
    ).toBe('manual_review');
  });

  it('rechaza un estado desconocido', () => {
    // @ts-expect-error estado inválido a propósito
    expect(() => insertInvoice(insertClient().id, { status: 'cancelada' })).toThrow(/CHECK/);
  });

  it('permite dos facturas del mismo cliente y período (AC-88)', () => {
    const client = insertClient();
    insertInvoice(client.id, { number: 1 });
    insertInvoice(client.id, { number: 2 });

    expect(db.select().from(invoices).where(eq(invoices.clientId, client.id)).all()).toHaveLength(2);
  });

  it('no permite repetir el número en el mismo punto de venta', () => {
    const client = insertClient();
    insertInvoice(client.id, { number: 7 });

    expect(() => insertInvoice(client.id, { number: 7, period: '2026-10' })).toThrow(/UNIQUE/);
    expect(insertInvoice(client.id, { number: 7, pointOfSale: 2 }).number).toBe(7);
  });

  it('borra los ítems con la factura y no permite borrar un cliente con facturas', () => {
    const client = insertClient();
    const invoice = insertInvoice(client.id);
    db.insert(invoiceItems)
      .values({ invoiceId: invoice.id, description: 'CRM', currency: 'ARS', unitPriceCents: 100, amountCents: 100 })
      .run();

    expect(() => db.delete(clients).where(eq(clients.id, client.id)).run()).toThrow(/FOREIGN KEY/);

    db.delete(invoices).where(eq(invoices.id, invoice.id)).run();
    expect(db.select().from(invoiceItems).all()).toHaveLength(0);
  });
});

describe('emails recibidos', () => {
  it('no registra dos veces el mismo Message-ID', () => {
    const email = { messageId: '<abc@mail>', fromAddress: 'x@test.com', receivedAt: new Date(), hasAttachments: false };
    db.insert(inboundEmails).values(email).run();

    expect(() => db.insert(inboundEmails).values(email).run()).toThrow(/UNIQUE/);
  });
});

describe('seed', () => {
  it('carga clientes, sistemas y asignaciones de ejemplo una sola vez', () => {
    expect(seed(db)).toBe(true);
    expect(seed(db)).toBe(false);

    expect(db.select().from(clients).all()).toHaveLength(4);
    expect(db.select().from(systems).all()).toHaveLength(3);
    expect(db.select().from(clientSystems).all()).toHaveLength(5);
  });
});
