export const DOLARHOY_URL = 'https://dolarhoy.com/';
export const DOLARHOY_SOURCE = 'dolarhoy.com — dólar blue venta';
/** Una llamada a dolarhoy.com se da por fallida a los 10 s (RNF-07). */
export const DOLARHOY_TIMEOUT_MS = 10_000;

export class ExchangeRateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExchangeRateError';
  }
}

/**
 * Convierte un importe en formato argentino ("$1.555", "$ 1.555,50") a centavos.
 * Devuelve null si no es un importe positivo con a lo sumo dos decimales.
 */
export function parseArsAmount(text: string): number | null {
  const match = /^\$?\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const pesos = Number(match[1]!.replaceAll('.', ''));
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  const total = pesos * 100 + cents;
  return total > 0 ? total : null;
}

/**
 * Lee la cotización del dólar blue venta de la portada de dolarhoy.com, en centavos.
 * Busca el bloque cuyo título enlaza a /cotizaciondolarblue y, dentro de él, el valor de venta.
 */
export function parseBlueSellRate(html: string): number {
  const title = html.search(/<a class="titleText" href="\/cotizaciondolarblue"/);
  if (title === -1) throw new ExchangeRateError('dolarhoy.com: no se encontró el bloque del dólar blue');

  // El bloque de valores sigue al título; se corta antes del título de la próxima cotización.
  const rest = html.slice(title + 1);
  const nextTitle = rest.search(/<a class="titleText" href="(?!\/cotizaciondolarblue)/);
  const block = nextTitle === -1 ? rest : rest.slice(0, nextTitle);

  const sell = /class="venta">\s*<div class="label">\s*Venta\s*<\/div>\s*<div class="val">([^<]*)</.exec(block);
  if (!sell) throw new ExchangeRateError('dolarhoy.com: no se encontró el valor de venta del dólar blue');

  const cents = parseArsAmount(sell[1]!);
  if (cents === null) {
    throw new ExchangeRateError(`dolarhoy.com: valor de venta del dólar blue ilegible: "${sell[1]}"`);
  }
  return cents;
}

export interface FetchRateOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Descarga la portada de dolarhoy.com y devuelve la cotización del blue venta en centavos. */
export async function fetchBlueSellRate({
  fetch = globalThis.fetch,
  timeoutMs = DOLARHOY_TIMEOUT_MS,
}: FetchRateOptions = {}): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(DOLARHOY_URL, { signal: controller.signal });
    if (!response.ok) throw new ExchangeRateError(`dolarhoy.com respondió HTTP ${response.status}`);
    return parseBlueSellRate(await response.text());
  } catch (error) {
    if (error instanceof ExchangeRateError) throw error;
    if (controller.signal.aborted) {
      throw new ExchangeRateError(`dolarhoy.com no respondió en ${timeoutMs / 1000} s`, { cause: error });
    }
    throw new ExchangeRateError(`no se pudo conectar con dolarhoy.com: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}
