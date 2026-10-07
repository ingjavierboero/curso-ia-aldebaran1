import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { runBilling } from '../../src/billing/run.js';
import { recordProcessError } from '../../src/process-errors.js';
import { type Db, openDb } from '../../src/db/index.js';
import {
  clientHistory,
  clientSystems,
  clients,
  invoiceItems,
  invoices,
  processErrors,
  settings,
  systems,
} from '../../src/db/schema.js';
import { DOLARHOY_SOURCE } from '../../src/exchange-rate/dolarhoy.js';
import type { BillingExchangeRate } from '../../src/exchange-rate/service.js';
import { fakeArcaClient, fakeClock, fakeMailer, issueForeignInvoice } from './fakes.js';

let db: Db;
const OCT_15 = '2026-10-15T14:00:00Z'; // 11:00 en Argentina

beforeEach(() => {
  db = openDb(':memory:');
});

let cuitSeq = 0;
/** CUIT de 11 dígitos distinto por cliente (el dígito verificador no importa en el ARCA simulado). */
const nextCuit = () => `3070000${String(++cuitSeq).padStart(4, '0')}`;

function addClient(overrides: Partial<typeof clients.$inferInsert> = {}) {
  const cuit = nextCuit();
  return db
    .insert(clients)
    .values({ businessName: `Cliente ${cuit}`, cuit, email: `c${cuit}@test.com`, vatConditionId: 1, ...overrides })
    .returning()
    .get();
}

function addSystem(name: string, priceCents: number, currency: 'ARS' | 'USD' = 'ARS', status: 'active' | 'inactive' = 'active') {
  return db.insert(systems).values({ name, priceCents, currency, status }).returning().get();
}

function assign(clientId: number, ...systemIds: number[]) {
  db.insert(clientSystems)
    .values(systemIds.map((systemId) => ({ clientId, systemId })))
    .run();
}

const liveRate = (rateCents = 1_555_00): (() => Promise<BillingExchangeRate>) => async () => ({
  kind: 'live',
  rate: { id: 1, rateCents, source: DOLARHOY_SOURCE, fetchedAt: new Date(OCT_15) },
});
const noRate: () => Promise<BillingExchangeRate> = async () => ({ kind: 'unavailable', error: 'dolarhoy.com no respondió en 10 s' });

function setup(start = OCT_15) {
  const time = fakeClock(start);
  const arca = fakeArcaClient(time.clock);
  const email = fakeMailer(time.clock);
  const run = (getExchangeRate = liveRate()) =>
    runBilling({ db, arca: arca.client, mailer: email.mailer, issuerCuit: '20311274350', getExchangeRate, clock: time.clock });
  return { ...time, arca, email, run };
}

const itemsOf = (invoiceId: number) =>
  db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).orderBy(invoiceItems.id).all();

describe('runBilling', () => {
  describe('a quién se factura', () => {
    it('AC-41: una Factura C en Pendiente de pago por cliente Activo con sistemas Activos, con el detalle de cada cuota', async () => {
      const crm = addSystem('CRM', 15_000_00);
      const soporte = addSystem('Soporte', 8_500_00);
      const client = addClient();
      assign(client.id, crm.id, soporte.id);
      const { run, arca } = setup();

      const summary = await run();

      expect(summary.period).toBe('2026-10');
      expect(summary.generated).toHaveLength(1);
      expect(summary.generated[0]).toMatchObject({
        clientId: client.id,
        period: '2026-10',
        invoiceType: 11,
        number: 1,
        status: 'pending_payment',
        totalCents: 23_500_00,
        cae: '76412345670001',
      });
      expect(itemsOf(summary.generated[0]!.id).map((i) => [i.description, i.amountCents])).toEqual([
        ['CRM', 15_000_00],
        ['Soporte', 8_500_00],
      ]);
      expect(arca.requests[0]).toMatchObject({ customerCuit: client.cuit, totalCents: 23_500_00 });
    });

    it('AC-51: no factura a un cliente sin sistemas asignados', async () => {
      addClient();
      const { run, arca } = setup();

      expect((await run()).generated).toEqual([]);
      expect(arca.requests).toEqual([]);
    });

    it('AC-52: no factura a un cliente cuyo único sistema está Inactivo', async () => {
      const client = addClient();
      assign(client.id, addSystem('Viejo', 100_00, 'ARS', 'inactive').id);
      const { run } = setup();

      expect((await run()).generated).toEqual([]);
      expect(db.select().from(invoices).all()).toEqual([]);
    });

    it('AC-53: no factura a un cliente Inactivo', async () => {
      const client = addClient({ status: 'inactive' });
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run } = setup();

      expect((await run()).generated).toEqual([]);
    });

    it('AC-37: no incluye en la factura un sistema desactivado', async () => {
      const client = addClient();
      const crm = addSystem('CRM', 100_00);
      const viejo = addSystem('Viejo', 50_00, 'ARS', 'inactive');
      assign(client.id, crm.id, viejo.id);
      const { run } = setup();

      const [invoice] = (await run()).generated;

      expect(itemsOf(invoice!.id).map((i) => i.description)).toEqual(['CRM']);
      expect(invoice!.totalCents).toBe(100_00);
    });

    it('AC-144: si el proceso se vuelve a ejecutar en el mes, no genera otra factura', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();

      await run();
      const second = await run();

      expect(second.generated).toEqual([]);
      expect(second.alreadyInvoiced).toEqual([client.id]);
      expect(db.select().from(invoices).all()).toHaveLength(1);
      expect(arca.requests).toHaveLength(1);
    });

    it('AC-33: un cliente reactivado recibe una única factura, solo del período corriente', async () => {
      const client = addClient({ status: 'inactive' });
      assign(client.id, addSystem('CRM', 100_00).id);
      db.update(clients).set({ status: 'active' }).where(eq(clients.id, client.id)).run();
      const { run } = setup();

      await run();

      expect(db.select({ period: invoices.period }).from(invoices).all()).toEqual([{ period: '2026-10' }]);
    });

    it('RNF-12: el período es el mes en Argentina, no en UTC', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      // 31/10 23:30 en Argentina = 1/11 02:30 UTC.
      const { run } = setup('2026-11-01T02:30:00Z');

      expect((await run()).generated[0]).toMatchObject({ period: '2026-10', issueDate: '2026-10-31' });
    });
  });

  describe('datos de la factura', () => {
    it('AC-141: usa el punto de venta configurado', async () => {
      db.update(settings).set({ pointOfSale: 3 }).run();
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();

      const [invoice] = (await run()).generated;

      expect(arca.requests[0]!.pointOfSale).toBe(3);
      expect(invoice).toMatchObject({ invoiceType: 11, pointOfSale: 3 });
    });

    it('AC-157: fecha de emisión, período de servicio y vencimiento', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();

      const [invoice] = (await run()).generated;

      const dates = { issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31' };
      expect(invoice).toMatchObject(dates);
      expect(arca.requests[0]).toMatchObject(dates);
    });

    it('AC-156: informa y registra la condición de IVA del cliente; las facturas emitidas la conservan', async () => {
      const client = addClient({ vatConditionId: 6 });
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca, advance } = setup();
      const [october] = (await run()).generated;

      db.update(clients).set({ vatConditionId: 1 }).where(eq(clients.id, client.id)).run();
      advance(31 * 24 * 3_600_000); // 15 de noviembre
      const [november] = (await run()).generated;

      expect(arca.requests.map((r) => r.recipientVatConditionId)).toEqual([6, 1]);
      expect(november).toMatchObject({ period: '2026-11', clientVatConditionId: 1 });
      expect(db.select().from(invoices).where(eq(invoices.id, october!.id)).get()!.clientVatConditionId).toBe(6);
    });

    it('AC-161: no factura a un cliente sin condición de IVA y registra el error de proceso', async () => {
      db.update(settings).set({ retryCount: 0 }).run();
      const client = addClient({ vatConditionId: null });
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();

      expect((await run()).failed).toEqual([
        { clientId: client.id, attempts: 1, error: 'el cliente no tiene cargada la condición frente al IVA' },
      ]);
      expect(arca.requests).toEqual([]);
      expect(db.select().from(processErrors).get()).toMatchObject({
        operation: 'invoice_generation',
        clientId: client.id,
        status: 'pending',
        lastError: 'el cliente no tiene cargada la condición frente al IVA',
      });
    });

    it('AC-30, AC-35, AC-36, AC-40: los cambios en cliente y sistemas no alteran facturas emitidas', async () => {
      const client = addClient({ businessName: 'Razón Vieja' });
      const crm = addSystem('CRM', 100_00);
      const erp = addSystem('ERP', 200_00);
      assign(client.id, crm.id, erp.id);
      const { run } = setup();
      const [invoice] = (await run()).generated;

      db.update(clients).set({ businessName: 'Razón Nueva' }).where(eq(clients.id, client.id)).run();
      db.update(systems).set({ name: 'CRM Pro', priceCents: 150_00 }).where(eq(systems.id, crm.id)).run();
      db.delete(clientSystems).where(eq(clientSystems.systemId, erp.id)).run();

      const stored = db.select().from(invoices).where(eq(invoices.id, invoice!.id)).get()!;
      expect(stored).toMatchObject({ clientBusinessName: 'Razón Vieja', totalCents: 300_00 });
      expect(itemsOf(invoice!.id).map((i) => [i.description, i.unitPriceCents])).toEqual([
        ['CRM', 100_00],
        ['ERP', 200_00],
      ]);
    });
  });

  describe('sistemas en dólares', () => {
    it('AC-39, AC-45: convierte las cuotas en dólares con la cotización y la registra en la factura', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 15_000_00).id, addSystem('ERP', 120_00, 'USD').id);
      const { run } = setup();

      const [invoice] = (await run(liveRate(1_555_00))).generated;

      expect(invoice).toMatchObject({
        totalCents: 15_000_00 + 186_600_00,
        exchangeRateCents: 1_555_00,
        exchangeRateSource: DOLARHOY_SOURCE,
        exchangeRateFallback: false,
      });
      expect(itemsOf(invoice!.id).find((i) => i.description === 'ERP')).toMatchObject({
        currency: 'USD',
        unitPriceCents: 120_00,
        amountCents: 186_600_00,
      });
    });

    it('AC-46: marca la factura cuando se usó la cotización de respaldo', async () => {
      const client = addClient();
      assign(client.id, addSystem('ERP', 100_00, 'USD').id);
      const { run } = setup();
      const fallback = async (): Promise<BillingExchangeRate> => ({
        kind: 'fallback',
        rate: { id: 7, rateCents: 1_520_00, source: DOLARHOY_SOURCE, fetchedAt: new Date('2026-09-20T14:00:00Z') },
        error: 'dolarhoy.com no respondió en 10 s',
      });

      const [invoice] = (await run(fallback)).generated;

      expect(invoice).toMatchObject({
        exchangeRateCents: 1_520_00,
        exchangeRateAt: new Date('2026-09-20T14:00:00Z'),
        exchangeRateFallback: true,
      });
    });

    it('no registra cotización en una factura solo en pesos', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run } = setup();

      expect((await run()).generated[0]).toMatchObject({ exchangeRateCents: null, exchangeRateFallback: false });
    });

    it('AC-47, AC-48: sin cotización no factura al cliente en dólares, pero sí al de pesos', async () => {
      db.update(settings).set({ retryCount: 0 }).run();
      const enPesos = addClient();
      assign(enPesos.id, addSystem('CRM', 100_00).id);
      const enDolares = addClient();
      assign(enDolares.id, addSystem('ERP', 100_00, 'USD').id);
      const { run } = setup();

      const summary = await run(noRate);

      expect(summary.generated.map((i) => i.clientId)).toEqual([enPesos.id]);
      expect(db.select().from(processErrors).all()).toEqual([
        expect.objectContaining({
          operation: 'invoice_generation',
          clientId: enDolares.id,
          period: '2026-10',
          attempts: 1,
          status: 'pending',
          lastError: 'no hay cotización del dólar para facturar sistemas en dólares (dolarhoy.com no respondió en 10 s)',
        }),
      ]);
    });

    it('vuelve a pedir la cotización en el reintento si no había ninguna', async () => {
      db.update(settings).set({ retryCount: 1 }).run();
      const client = addClient();
      assign(client.id, addSystem('ERP', 100_00, 'USD').id);
      const { run } = setup();
      let calls = 0;
      const rate = async (): Promise<BillingExchangeRate> => (++calls === 1 ? noRate() : liveRate()());

      expect((await run(rate)).generated).toHaveLength(1);
      expect(calls).toBe(2);
    });
  });

  describe('reintentos y errores de proceso', () => {
    function oneClient() {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      return client;
    }

    it('AC-108: ARCA falla en el primer intento y responde en el segundo, 5 minutos después', async () => {
      oneClient();
      const { run, arca } = setup();
      arca.state.failures = 1;

      const summary = await run();

      expect(summary.generated).toHaveLength(1);
      expect(arca.attemptTimes.map((t) => t.toISOString())).toEqual(['2026-10-15T14:00:00.000Z', '2026-10-15T14:05:00.000Z']);
      expect(db.select().from(processErrors).all()).toEqual([]);
    });

    it('AC-109: ARCA no responde en ningún intento → 4 intentos, sin factura y con error de proceso', async () => {
      const client = oneClient();
      const { run, arca } = setup();
      arca.state.failures = 99;

      const summary = await run();

      expect(arca.requests).toHaveLength(4);
      expect(summary.generated).toEqual([]);
      expect(db.select().from(invoices).all()).toEqual([]);
      expect(db.select().from(processErrors).all()).toEqual([
        expect.objectContaining({
          operation: 'invoice_generation',
          clientId: client.id,
          period: '2026-10',
          attempts: 4,
          lastError: 'ARCA WSFEv1 no respondió en 30 s',
          status: 'pending',
        }),
      ]);
    });

    it('AC-112: con 0 reintentos hace un solo intento y registra el error', async () => {
      db.update(settings).set({ retryCount: 0 }).run();
      oneClient();
      const { run, arca } = setup();
      arca.state.failures = 99;

      await run();

      expect(arca.requests).toHaveLength(1);
      expect(db.select().from(processErrors).get()).toMatchObject({ attempts: 1 });
    });

    it('AC-114: con espera de 10 minutos, el reintento es 10 minutos después', async () => {
      db.update(settings).set({ retryWaitMinutes: 10 }).run();
      oneClient();
      const { run, arca } = setup();
      arca.state.failures = 1;

      await run();

      expect(arca.attemptTimes.map((t) => t.toISOString().slice(11, 16))).toEqual(['14:00', '14:10']);
    });

    it('un cliente que falla no demora a los demás', async () => {
      const first = oneClient();
      const second = oneClient();
      const { run, arca } = setup();
      arca.state.failures = 1;

      const summary = await run();

      expect(arca.requests.map((r) => [r.customerCuit, r.issueDate])).toEqual([
        [first.cuit, '2026-10-15'],
        [second.cuit, '2026-10-15'],
        [first.cuit, '2026-10-15'],
      ]);
      // En orden de generación: el segundo cliente se factura mientras el primero espera su reintento.
      expect(summary.generated.map((i) => [i.clientId, i.number])).toEqual([
        [second.id, 1],
        [first.id, 2],
      ]);
    });

    it('no duplica el error de proceso si el cliente vuelve a fallar en el mismo período', () => {
      const client = oneClient();

      const subject = { operation: 'invoice_generation', clientId: client.id, period: '2026-10' } as const;
      recordProcessError(db, subject, 4, 'primer error');
      recordProcessError(db, subject, 4, 'segundo error');

      expect(db.select().from(processErrors).all()).toEqual([
        expect.objectContaining({ attempts: 4, lastError: 'segundo error' }),
      ]);
    });
  });

  describe('email de la factura', () => {
    it('AC-50: envía cada factura generada a la casilla del cliente y lo registra en el historial', async () => {
      const client = addClient({ email: 'pagos@cliente.com' });
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, email } = setup();

      const summary = await run();

      expect(email.sent.map((e) => [e.to, e.attachments?.[0]?.filename])).toEqual([
        ['pagos@cliente.com', 'Factura-C-00001-00000001.pdf'],
      ]);
      expect(summary.emailed).toEqual([{ invoiceId: summary.generated[0]!.id, to: 'pagos@cliente.com' }]);
      expect(db.select().from(clientHistory).all()).toEqual([
        expect.objectContaining({ clientId: client.id, event: 'invoice_email_sent', invoiceId: summary.generated[0]!.id }),
      ]);
    });

    it('AC-162: envía el email apenas se genera la factura, sin esperar los reintentos de otros clientes', async () => {
      const first = addClient();
      assign(first.id, addSystem('CRM', 100_00).id);
      const second = addClient();
      assign(second.id, addSystem('ERP', 100_00).id);
      const { run, arca, email } = setup();
      arca.state.failures = 1;

      await run();

      // El segundo cliente recibe su email a las 14:00; el primero, recién tras su reintento.
      expect(email.attemptTimes.map((t) => t.toISOString().slice(11, 16))).toEqual(['14:00', '14:05']);
      expect(email.sent.map((e) => e.to)).toEqual([second.email, first.email]);
    });

    it('AC-51, AC-109: no envía email si no se generó la factura', async () => {
      db.update(settings).set({ retryCount: 0 }).run();
      addClient();
      const failing = addClient();
      assign(failing.id, addSystem('CRM', 100_00).id);
      const { run, arca, email } = setup();
      arca.state.failures = 1;

      await run();

      expect(email.sent).toEqual([]);
    });

    it('AC-144: no reenvía el email si el proceso se vuelve a ejecutar', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, email } = setup();

      await run();
      await run();

      expect(email.sent).toHaveLength(1);
    });

    it('AC-110: si el servidor rechaza todos los envíos, 4 intentos, la factura sigue Pendiente y hay error de proceso', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, email } = setup();
      email.state.failures = 99;

      const summary = await run();
      const invoice = summary.generated[0]!;

      expect(email.attemptTimes.map((t) => t.toISOString().slice(11, 16))).toEqual(['14:00', '14:05', '14:10', '14:15']);
      expect(db.select().from(invoices).get()).toMatchObject({ id: invoice.id, status: 'pending_payment' });
      expect(summary.emailFailed).toEqual([{ invoiceId: invoice.id, attempts: 4, error: 'no se pudo enviar el email: 550 rechazado' }]);
      expect(db.select().from(processErrors).all()).toEqual([
        expect.objectContaining({
          operation: 'invoice_email',
          clientId: client.id,
          invoiceId: invoice.id,
          period: '2026-10',
          attempts: 4,
          status: 'pending',
          lastError: 'no se pudo enviar el email: 550 rechazado',
        }),
      ]);
      expect(db.select().from(clientHistory).all()).toEqual([]);
    });

    it('si el email falla y después sale bien, no queda error de proceso', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, email } = setup();
      email.state.failures = 2;

      const summary = await run();

      expect(summary.emailed).toHaveLength(1);
      expect(db.select().from(processErrors).all()).toEqual([]);
    });
  });

  describe('numeración y respuestas perdidas', () => {
    it('continúa la numeración de comprobantes que ya existen en ARCA', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();
      for (let n = 1; n <= 9; n++) issueForeignInvoice(arca, 1, n);

      expect((await run()).generated[0]!.number).toBe(10);
    });

    it('AC-159: si ARCA autorizó la factura pero la respuesta se perdió, la recupera en vez de emitir otra', async () => {
      const client = addClient();
      assign(client.id, addSystem('CRM', 100_00).id);
      const { run, arca } = setup();
      arca.state.loseResponses = 1;

      const summary = await run();

      expect(arca.requests).toHaveLength(1);
      expect(arca.issued.size).toBe(1);
      expect(summary.generated).toEqual([
        expect.objectContaining({ clientId: client.id, number: 1, cae: '76412345670001' }),
      ]);
    });
  });
});
