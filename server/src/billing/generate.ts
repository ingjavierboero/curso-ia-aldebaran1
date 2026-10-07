import { and, asc, eq } from 'drizzle-orm';
import type { ArcaClient } from '../arca/index.js';
import type { Db } from '../db/index.js';
import { INVOICE_TYPE_C, clientSystems, clients, invoiceItems, invoices, systems } from '../db/schema.js';
import type { BillingExchangeRate } from '../exchange-rate/service.js';
import { usdToArsCents } from '../exchange-rate/service.js';
import { invoiceDates } from './dates.js';

export type Client = typeof clients.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;

export class BillingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BillingError';
  }
}

/**
 * Da la cotización para facturar sistemas en dólares, pidiéndola solo si hace falta.
 * Una cotización obtenida (del momento o de respaldo) se reutiliza en todo el proceso;
 * si no hubo ninguna disponible, se vuelve a intentar en el próximo pedido (RF-43, RF-89).
 */
export class ExchangeRateProvider {
  private cached: Exclude<BillingExchangeRate, { kind: 'unavailable' }> | undefined;

  constructor(private readonly fetch: () => Promise<BillingExchangeRate>) {}

  async get(): Promise<BillingExchangeRate> {
    if (this.cached) return this.cached;
    const result = await this.fetch();
    if (result.kind !== 'unavailable') this.cached = result;
    return result;
  }
}

export interface GenerateDeps {
  db: Db;
  arca: ArcaClient;
  exchangeRate: ExchangeRateProvider;
  pointOfSale: number;
  now: () => Date;
}

export type GenerateResult =
  | { kind: 'generated'; invoice: Invoice; recovered: boolean }
  /** RF-105: el cliente ya tiene factura de ese período. */
  | { kind: 'already_invoiced'; invoice: Invoice }
  /** RF-47: el cliente no tiene ningún sistema Activo asignado. */
  | { kind: 'no_active_systems' };

function activeSystemsOf(db: Db, clientId: number) {
  return db
    .select({ id: systems.id, name: systems.name, priceCents: systems.priceCents, currency: systems.currency })
    .from(clientSystems)
    .innerJoin(systems, eq(systems.id, clientSystems.systemId))
    .where(and(eq(clientSystems.clientId, clientId), eq(systems.status, 'active')))
    .orderBy(asc(systems.name), asc(systems.id))
    .all();
}

export function findInvoiceForPeriod(db: Db, clientId: number, period: string): Invoice | undefined {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), eq(invoices.period, period)))
    .get();
}

/**
 * Genera en ARCA homologación la factura de un cliente para un período y la registra en
 * Pendiente de pago (RF-39). Falla con un error si ARCA o la cotización fallan; quien la
 * llama decide los reintentos.
 */
export async function generateInvoice(deps: GenerateDeps, clientId: number, period: string): Promise<GenerateResult> {
  const { db, arca, pointOfSale } = deps;

  const existing = findInvoiceForPeriod(db, clientId, period);
  if (existing) return { kind: 'already_invoiced', invoice: existing };

  const client = db.select().from(clients).where(eq(clients.id, clientId)).get();
  if (!client) throw new BillingError(`no existe el cliente ${clientId}`);
  if (client.vatConditionId === null) {
    throw new BillingError('el cliente no tiene cargada la condición frente al IVA');
  }

  const assigned = activeSystemsOf(db, clientId);
  if (assigned.length === 0) return { kind: 'no_active_systems' };

  // Cotización solo si hay sistemas en dólares (AC-48: los clientes en pesos no dependen de ella).
  let rate: Exclude<BillingExchangeRate, { kind: 'unavailable' }> | undefined;
  if (assigned.some((s) => s.currency === 'USD')) {
    const result = await deps.exchangeRate.get();
    if (result.kind === 'unavailable') {
      throw new BillingError(`no hay cotización del dólar para facturar sistemas en dólares (${result.error})`);
    }
    rate = result;
  }

  const items = assigned.map((s) => ({
    systemId: s.id,
    description: s.name,
    currency: s.currency,
    unitPriceCents: s.priceCents,
    amountCents: s.currency === 'USD' ? usdToArsCents(s.priceCents, rate!.rate.rateCents) : s.priceCents,
  }));
  const totalCents = items.reduce((sum, i) => sum + i.amountCents, 0);
  const dates = invoiceDates(period, deps.now());

  // Si el último comprobante de ARCA no está registrado y es esta misma factura, ARCA la
  // autorizó pero la respuesta se perdió (por ejemplo, un timeout): se recupera en vez de
  // emitir otra, que sería un duplicado.
  const last = await arca.lastAuthorizedNumber(pointOfSale);
  let authorized: { number: number; cae: string; caeExpiresAt: string; issueDate: string } | undefined;
  let recovered = false;
  if (last > 0 && !isRegistered(db, pointOfSale, last)) {
    const issued = await arca.findInvoice(pointOfSale, last);
    if (
      issued &&
      issued.customerCuit === client.cuit &&
      issued.serviceFrom === dates.serviceFrom &&
      issued.totalCents === totalCents
    ) {
      authorized = { number: last, cae: issued.cae, caeExpiresAt: issued.caeExpiresAt, issueDate: issued.issueDate };
      recovered = true;
    }
  }
  if (!authorized) {
    const number = last + 1;
    const result = await arca.requestCae({
      pointOfSale,
      number,
      ...dates,
      customerCuit: client.cuit,
      recipientVatConditionId: client.vatConditionId,
      totalCents,
    });
    authorized = { number, cae: result.cae, caeExpiresAt: result.caeExpiresAt, issueDate: dates.issueDate };
  }

  const invoice = db.transaction((tx) => {
    const created = tx
      .insert(invoices)
      .values({
        clientId,
        period,
        invoiceType: INVOICE_TYPE_C,
        pointOfSale,
        number: authorized.number,
        cae: authorized.cae,
        caeExpiresAt: authorized.caeExpiresAt,
        issuedAt: deps.now(),
        clientBusinessName: client.businessName,
        clientCuit: client.cuit,
        clientVatConditionId: client.vatConditionId!,
        ...dates,
        issueDate: authorized.issueDate,
        totalCents,
        exchangeRateCents: rate?.rate.rateCents ?? null,
        exchangeRateSource: rate?.rate.source ?? null,
        exchangeRateAt: rate?.rate.fetchedAt ?? null,
        exchangeRateFallback: rate?.kind === 'fallback',
      })
      .returning()
      .get();
    tx.insert(invoiceItems)
      .values(items.map((i) => ({ ...i, invoiceId: created.id })))
      .run();
    return created;
  });
  return { kind: 'generated', invoice, recovered };
}

function isRegistered(db: Db, pointOfSale: number, number: number): boolean {
  return !!db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(eq(invoices.invoiceType, INVOICE_TYPE_C), eq(invoices.pointOfSale, pointOfSale), eq(invoices.number, number)),
    )
    .get();
}
