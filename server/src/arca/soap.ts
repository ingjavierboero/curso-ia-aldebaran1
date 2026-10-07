import { XMLParser } from 'fast-xml-parser';
import { ARCA_TIMEOUT_MS, assertHomologation } from './endpoints.js';
import { ArcaError } from './errors.js';

// Sin prefijos de namespace y todos los valores como texto (el CAE y el token no son números).
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

export function parseXml(xml: string): Record<string, any> {
  return parser.parse(xml);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export interface SoapOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Envía un sobre SOAP 1.1 y devuelve el contenido del Body ya parseado.
 * Un SOAP Fault, un error HTTP, la falta de conexión o el timeout salen como ArcaError.
 */
export async function postSoap(
  service: string,
  url: string,
  action: string,
  envelope: string,
  { fetch = globalThis.fetch, timeoutMs = ARCA_TIMEOUT_MS }: SoapOptions = {},
): Promise<Record<string, any>> {
  assertHomologation(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
      body: envelope,
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ArcaError(`ARCA ${service} no respondió en ${timeoutMs / 1000} s`, undefined, { cause: error });
    }
    throw new ArcaError(`no se pudo conectar con ARCA ${service}: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, any> | undefined;
  try {
    body = parseXml(text).Envelope?.Body;
  } catch {
    body = undefined;
  }

  const fault = body?.Fault;
  if (fault) {
    const code = String(fault.faultcode ?? '').replace(/^.*:/, '') || undefined;
    throw new ArcaError(`ARCA ${service}: ${String(fault.faultstring ?? 'error SOAP').trim()}`, code);
  }
  if (status < 200 || status >= 300) throw new ArcaError(`ARCA ${service} respondió HTTP ${status}`);
  if (!body) throw new ArcaError(`ARCA ${service} devolvió una respuesta que no se puede leer`);
  return body;
}
