import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, openDb } from '../../src/db/index.js';
import { exchangeRates } from '../../src/db/schema.js';
import { DOLARHOY_SOURCE, ExchangeRateError } from '../../src/exchange-rate/dolarhoy.js';
import { getBillingExchangeRate, usdToArsCents } from '../../src/exchange-rate/service.js';

let db: Db;
const now = () => new Date('2026-10-15T14:00:00Z');
const failing = () => Promise.reject(new ExchangeRateError('dolarhoy.com no respondió en 10 s'));

beforeEach(() => {
  db = openDb(':memory:');
});

describe('getBillingExchangeRate', () => {
  it('AC-45, AC-154: usa la cotización del momento y la registra con su valor, fuente y fecha', async () => {
    const result = await getBillingExchangeRate(db, { fetchRate: async () => 155_500, now });

    expect(result).toEqual({
      kind: 'live',
      rate: { id: 1, rateCents: 155_500, source: DOLARHOY_SOURCE, fetchedAt: now() },
    });
    expect(db.select().from(exchangeRates).all()).toEqual([result.kind === 'live' && result.rate]);
  });

  it('AC-46, AC-154: si dolarhoy.com no responde, usa la de fecha de lectura más reciente', async () => {
    // Se cargan desordenadas para que no gane la última insertada.
    db.insert(exchangeRates)
      .values([
        { rateCents: 1_500_00, source: DOLARHOY_SOURCE, fetchedAt: new Date('2026-09-15T14:00:00Z') },
        { rateCents: 1_520_00, source: DOLARHOY_SOURCE, fetchedAt: new Date('2026-09-20T14:00:00Z') },
        { rateCents: 1_490_00, source: DOLARHOY_SOURCE, fetchedAt: new Date('2026-08-15T14:00:00Z') },
      ])
      .run();

    const result = await getBillingExchangeRate(db, { fetchRate: failing, now });

    expect(result).toEqual({
      kind: 'fallback',
      rate: expect.objectContaining({ rateCents: 1_520_00, fetchedAt: new Date('2026-09-20T14:00:00Z') }),
      error: 'dolarhoy.com no respondió en 10 s',
    });
    expect(db.select().from(exchangeRates).all()).toHaveLength(3);
  });

  it('AC-47: si dolarhoy.com no responde y no hay cotizaciones, no hay cotización disponible', async () => {
    await expect(getBillingExchangeRate(db, { fetchRate: failing, now })).resolves.toEqual({
      kind: 'unavailable',
      error: 'dolarhoy.com no respondió en 10 s',
    });
  });

  it('trata como falla un error inesperado del scraper', async () => {
    const fetchRate = vi.fn(() => Promise.reject(new Error('algo raro')));

    await expect(getBillingExchangeRate(db, { fetchRate, now })).resolves.toMatchObject({
      kind: 'unavailable',
      error: 'Error: algo raro',
    });
  });
});

describe('usdToArsCents', () => {
  it('convierte una cuota de USD 120 a $1.555 por dólar', () => {
    expect(usdToArsCents(120_00, 1_555_00)).toBe(186_600_00);
  });

  it('AC-153: USD 0,01 a $1.555,50 → $15,555 redondeado a $15,56', () => {
    expect(usdToArsCents(1, 1_555_50)).toBe(15_56);
  });

  it('redondea hacia abajo cuando corresponde', () => {
    // USD 0,33 × $1.555,55 = $513,3315 → $513,33
    expect(usdToArsCents(33, 1_555_55)).toBe(513_33);
  });
});
