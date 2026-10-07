import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { escapeXml } from '../../src/arca/soap.js';

/**
 * Genera con openssl un certificado autofirmado y su clave (PKCS#1, como `openssl genrsa`)
 * en una carpeta temporal: el repo nunca tiene claves, ni siquiera de prueba.
 */
export function createTestCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'aldebaran-arca-'));
  const keyPath = join(dir, 'test.key');
  const certPath = join(dir, 'test.crt');
  execFileSync('openssl', ['genrsa', '-traditional', '-out', keyPath, '2048'], { stdio: 'ignore' });
  execFileSync(
    'openssl',
    ['req', '-new', '-x509', '-key', keyPath, '-subj', '/C=AR/O=Aldebaran Test/CN=test', '-days', '1', '-out', certPath],
    { stdio: 'ignore' },
  );
  return {
    dir,
    keyPath,
    certPath,
    privateKeyPem: readFileSync(keyPath, 'utf8'),
    certificatePem: readFileSync(certPath, 'utf8'),
  };
}

export function soapEnvelope(body: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

export function soapFault(code: string, message: string): string {
  return soapEnvelope(
    `<soap:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:${code}</faultcode>` +
      `<faultstring>${message}</faultstring></soap:Fault>`,
  );
}

export function wsaaLoginResponse({ token = 'TOKEN-1', sign = 'SIGN-1', expirationTime = '2026-10-16T02:00:00.000-03:00' } = {}) {
  const ticket =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<loginTicketResponse version="1.0"><header><source>CN=wsaahomo, O=AFIP, C=AR</source>' +
    `<uniqueId>123</uniqueId><generationTime>2026-10-15T13:50:00.000-03:00</generationTime>` +
    `<expirationTime>${expirationTime}</expirationTime></header>` +
    `<credentials><token>${token}</token><sign>${sign}</sign></credentials></loginTicketResponse>`;
  return soapEnvelope(
    `<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${escapeXml(ticket)}</loginCmsReturn></loginCmsResponse>`,
  );
}

export function wsfeResponse(operation: string, result: string): string {
  return soapEnvelope(
    `<${operation}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${operation}Result>${result}</${operation}Result></${operation}Response>`,
  );
}

export interface RecordedRequest {
  url: string;
  action: string;
  body: string;
}

type Reply = string | { status: number; body: string };

/**
 * ARCA simulado: responde según el SOAPAction ("" es WSAA; en WSFEv1, el nombre de la operación).
 * Registra cada pedido para poder inspeccionarlo.
 */
export function fakeArca(replies: Record<string, Reply | ((request: RecordedRequest) => Reply)>) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const action = (headers.get('SOAPAction') ?? '').replaceAll('"', '').replace('http://ar.gov.afip.dif.FEV1/', '');
    const request = { url: String(url), action, body: String(init?.body) };
    requests.push(request);

    const handler = replies[action === '' ? 'loginCms' : action];
    if (!handler) throw new Error(`ARCA simulado: operación inesperada "${action}"`);
    const reply = typeof handler === 'function' ? handler(request) : handler;
    return typeof reply === 'string'
      ? new Response(reply, { status: 200 })
      : new Response(reply.body, { status: reply.status });
  });
  return { fetch, requests };
}
