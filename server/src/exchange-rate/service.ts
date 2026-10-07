import { desc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { exchangeRates } from '../db/schema.js';
import { DOLARHOY_SOURCE, ExchangeRateError, fetchBlueSellRate } from './dolarhoy.js';

export type ExchangeRate = typeof exchangeRates.$inferSelect;

export type BillingExchangeRate =
  /** Cotización leída en el momento y registrada (RF-41). */
  | { kind: 'live'; rate: ExchangeRate }
  /** dolarhoy.com falló: se usa la última registrada y corresponde el banner de cotización (RF-42, RF-44). */
  | { kind: 'fallback'; rate: ExchangeRate; error: string }
  /** dolarhoy.com falló y no hay ninguna registrada: no se factura a clientes con sistemas en dólares (RF-43). */
  | { kind: 'unavailable'; error: string };

export interface ExchangeRateDeps {
  fetchRate?: () => Promise<number>;
  now?: () => Date;
}

/** Obtiene la cotización a usar para facturar en pesos los sistemas con precio en dólares. */
export async function getBillingExchangeRate(
  db: Db,
  { fetchRate = () => fetchBlueSellRate(), now = () => new Date() }: ExchangeRateDeps = {},
): Promise<BillingExchangeRate> {
  try {
    const rateCents = await fetchRate();
    const rate = db
      .insert(exchangeRates)
      .values({ rateCents, source: DOLARHOY_SOURCE, fetchedAt: now() })
      .returning()
      .get();
    return { kind: 'live', rate };
  } catch (error) {
    const message = error instanceof ExchangeRateError ? error.message : String(error);
    const last = db.select().from(exchangeRates).orderBy(desc(exchangeRates.fetchedAt), desc(exchangeRates.id)).get();
    return last ? { kind: 'fallback', rate: last, error: message } : { kind: 'unavailable', error: message };
  }
}

/**
 * Convierte una cuota en dólares a pesos, en centavos: USD (centavos) × pesos por dólar (centavos) / 100.
 * Redondea al centavo más cercano.
 */
export function usdToArsCents(usdCents: number, rateCents: number): number {
  return Math.round((usdCents * rateCents) / 100);
}
