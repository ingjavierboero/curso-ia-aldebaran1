import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signCms } from '../../src/arca/cms.js';
import { WSAA_URL } from '../../src/arca/endpoints.js';
import { buildLoginTicketRequest, getAccessTicket, login, toArgentinaIso } from '../../src/arca/wsaa.js';
import { type Db, openDb } from '../../src/db/index.js';
import { arcaAccessTickets } from '../../src/db/schema.js';
import { createTestCertificate, fakeArca, soapFault, wsaaLoginResponse } from './helpers.js';

let cert: ReturnType<typeof createTestCertificate>;
let db: Db;
const now = new Date('2026-10-15T14:00:00Z'); // 11:00 en Argentina

beforeAll(() => {
  cert = createTestCertificate();
});

beforeEach(() => {
  db = openDb(':memory:');
});

/** Verifica con openssl un CMS en base64 contra el certificado de prueba y devuelve el contenido firmado. */
function verifyCms(base64: string): string {
  const path = join(cert.dir, `cms-${Date.now()}-${Math.random()}.der`);
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', path, '-CAfile', cert.certPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const deps = (fetch: typeof globalThis.fetch, at = now) => ({
  certificatePem: cert.certificatePem,
  privateKeyPem: cert.privateKeyPem,
  fetch,
  now: () => at,
});

describe('pedido de acceso (TRA)', () => {
  it('usa la hora de Argentina con su offset', () => {
    expect(toArgentinaIso(now)).toBe('2026-10-15T11:00:00-03:00');
  });

  it('pide el servicio con una validez de ±10 minutos', () => {
    expect(buildLoginTicketRequest('wsfe', now)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>' +
        '<uniqueId>1792072800</uniqueId>' +
        '<generationTime>2026-10-15T10:50:00-03:00</generationTime>' +
        '<expirationTime>2026-10-15T11:10:00-03:00</expirationTime>' +
        '</header><service>wsfe</service></loginTicketRequest>',
    );
  });
});

describe('signCms', () => {
  it('genera un CMS que openssl verifica, con el contenido incluido', async () => {
    const cms = await signCms('<loginTicketRequest>ñandú</loginTicketRequest>', cert.certificatePem, cert.privateKeyPem);

    expect(verifyCms(cms)).toBe('<loginTicketRequest>ñandú</loginTicketRequest>');
  });

  it('acepta la clave en PKCS#8', async () => {
    const pkcs8 = execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', cert.keyPath], { encoding: 'utf8' });

    const cms = await signCms('hola', cert.certificatePem, pkcs8);

    expect(verifyCms(cms)).toBe('hola');
  });

  it('falla con un mensaje claro si la clave no se puede leer', async () => {
    await expect(signCms('hola', cert.certificatePem, 'no es una clave')).rejects.toThrow(
      'no se pudo leer el certificado o la clave de ARCA',
    );
  });
});

describe('login', () => {
  it('envía el TRA firmado a WSAA de homologación y lee el ticket', async () => {
    const arca = fakeArca({ loginCms: wsaaLoginResponse() });

    const ticket = await login('wsfe', deps(arca.fetch));

    expect(ticket).toEqual({ token: 'TOKEN-1', sign: 'SIGN-1', expiresAt: new Date('2026-10-16T05:00:00Z') });
    expect(arca.requests).toHaveLength(1);
    expect(arca.requests[0]!.url).toBe(WSAA_URL);
    const cms = /<wsaa:in0>([^<]+)<\/wsaa:in0>/.exec(arca.requests[0]!.body)![1]!;
    expect(verifyCms(cms)).toBe(buildLoginTicketRequest('wsfe', now));
  });

  it('explica el caso de un ticket vigente que no está guardado', async () => {
    const arca = fakeArca({
      loginCms: {
        status: 500,
        body: soapFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado'),
      },
    });

    await expect(login('wsfe', deps(arca.fetch))).rejects.toMatchObject({
      message: 'ARCA WSAA ya emitió un ticket vigente que no está guardado; hay que esperar a que venza (hasta 12 h)',
      code: 'coe.alreadyAuthenticated',
    });
  });

  it('falla si el ticket no trae token', async () => {
    const arca = fakeArca({ loginCms: wsaaLoginResponse({ token: '' }) });

    await expect(login('wsfe', deps(arca.fetch))).rejects.toThrow('ticket de acceso que no se puede leer');
  });
});

describe('getAccessTicket', () => {
  it('guarda el ticket y lo reutiliza mientras está vigente', async () => {
    const arca = fakeArca({ loginCms: wsaaLoginResponse() });

    const first = await getAccessTicket(db, 'wsfe', deps(arca.fetch));
    const second = await getAccessTicket(db, 'wsfe', deps(arca.fetch, new Date('2026-10-16T04:49:00Z')));

    expect(second).toEqual(first);
    expect(arca.requests).toHaveLength(1);
    expect(db.select().from(arcaAccessTickets).all()).toEqual([
      expect.objectContaining({ service: 'wsfe', token: 'TOKEN-1', sign: 'SIGN-1' }),
    ]);
  });

  it('pide uno nuevo cuando faltan menos de 10 minutos para que venza', async () => {
    let n = 0;
    const arca = fakeArca({
      loginCms: () => {
        n += 1;
        return wsaaLoginResponse({ token: `TOKEN-${n}`, expirationTime: `2026-10-1${5 + n}T02:00:00.000-03:00` });
      },
    });

    await getAccessTicket(db, 'wsfe', deps(arca.fetch));
    const renewed = await getAccessTicket(db, 'wsfe', deps(arca.fetch, new Date('2026-10-16T04:51:00Z')));

    expect(renewed.token).toBe('TOKEN-2');
    expect(arca.requests).toHaveLength(2);
    expect(db.select().from(arcaAccessTickets).all()).toEqual([expect.objectContaining({ token: 'TOKEN-2' })]);
  });

  it('sobrevive a un reinicio: otra conexión a la misma base reutiliza el ticket', async () => {
    const path = join(cert.dir, `db-${Date.now()}.db`);
    const arca = fakeArca({ loginCms: wsaaLoginResponse() });

    await getAccessTicket(openDb(path), 'wsfe', deps(arca.fetch));
    await getAccessTicket(openDb(path), 'wsfe', deps(arca.fetch));

    expect(arca.requests).toHaveLength(1);
  });
});
