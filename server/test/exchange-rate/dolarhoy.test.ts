import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOLARHOY_URL,
  ExchangeRateError,
  fetchBlueSellRate,
  parseArsAmount,
  parseBlueSellRate,
} from '../../src/exchange-rate/dolarhoy.js';

const homeHtml = readFileSync(new URL('../fixtures/dolarhoy-home.html', import.meta.url), 'utf8');

describe('parseArsAmount', () => {
  it.each([
    ['$1.555', 155_500],
    ['$ 1.555', 155_500],
    ['$1.555,5', 155_550],
    ['$1.555,50', 155_550],
    ['$980', 98_000],
    ['$1.234.567,89', 123_456_789],
    ['1555', 155_500],
  ])('%s → %i centavos', (text, cents) => {
    expect(parseArsAmount(text)).toBe(cents);
  });

  it.each(['', '$', 'abc', '$1,555.50', '$1.55', '$1.555,555', '$0', '-$1.555'])('rechaza "%s"', (text) => {
    expect(parseArsAmount(text)).toBeNull();
  });
});

describe('parseBlueSellRate', () => {
  it('lee el blue venta de la portada real de dolarhoy.com', () => {
    expect(parseBlueSellRate(homeHtml)).toBe(155_500);
  });

  it('falla si no está el bloque del dólar blue', () => {
    const html = homeHtml.replaceAll('href="/cotizaciondolarblue"', 'href="/otra"');

    expect(() => parseBlueSellRate(html)).toThrow('no se encontró el bloque del dólar blue');
  });

  it('no toma la venta de otra cotización si al blue le falta la suya', () => {
    const html = homeHtml.replace('<div class="label">Venta</div><div class="val">$1.555</div>', '');

    expect(() => parseBlueSellRate(html)).toThrow('no se encontró el valor de venta del dólar blue');
  });

  it('falla si el valor no se puede leer', () => {
    const html = homeHtml.replace('<div class="val">$1.555</div>', '<div class="val">consultar</div>');

    expect(() => parseBlueSellRate(html)).toThrow('valor de venta del dólar blue ilegible: "consultar"');
  });
});

describe('fetchBlueSellRate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pide la portada y devuelve la cotización', async () => {
    const fetch = vi.fn(async () => new Response(homeHtml, { status: 200 }));

    await expect(fetchBlueSellRate({ fetch })).resolves.toBe(155_500);
    expect(fetch).toHaveBeenCalledWith(DOLARHOY_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('falla si dolarhoy.com responde con error HTTP', async () => {
    const fetch = vi.fn(async () => new Response('caído', { status: 503 }));

    await expect(fetchBlueSellRate({ fetch })).rejects.toThrow('dolarhoy.com respondió HTTP 503');
  });

  it('falla si no hay conexión', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(fetchBlueSellRate({ fetch })).rejects.toThrow('no se pudo conectar con dolarhoy.com: fetch failed');
  });

  it('AC-136: da la llamada por fallida a los 10 s', async () => {
    vi.useFakeTimers();
    // Un servidor que nunca responde: la promesa solo termina si se aborta.
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const result = fetchBlueSellRate({ fetch });
    const settled = vi.fn();
    result.then(settled, settled);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow(new ExchangeRateError('dolarhoy.com no respondió en 10 s'));
  });
});
