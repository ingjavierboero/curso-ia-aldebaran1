import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSAA_URL, WSFE_URL, assertHomologation } from '../../src/arca/endpoints.js';
import { ArcaError } from '../../src/arca/errors.js';
import { escapeXml, postSoap } from '../../src/arca/soap.js';
import { soapEnvelope, soapFault } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('solo homologación', () => {
  it('los endpoints configurados son los de homologación', () => {
    expect(() => assertHomologation(WSAA_URL)).not.toThrow();
    expect(() => assertHomologation(WSFE_URL)).not.toThrow();
  });

  it.each([
    'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    'https://wswhomo.afip.gov.ar.example.com/wsfev1/service.asmx',
  ])('rechaza %s sin llegar a enviar nada', async (url) => {
    const fetch = vi.fn();

    await expect(postSoap('WSFEv1', url, 'X', '<x/>', { fetch })).rejects.toThrow(
      'Solo se permite el ambiente de homologación de ARCA',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('postSoap', () => {
  it('envía el sobre con SOAPAction y devuelve el Body sin prefijos', async () => {
    const fetch = vi.fn(async () => new Response(soapEnvelope('<ns:Respuesta xmlns:ns="x"><ns:Valor>007</ns:Valor></ns:Respuesta>')));

    const body = await postSoap('WSFEv1', WSFE_URL, 'http://ar.gov.afip.dif.FEV1/FEDummy', '<sobre/>', { fetch });

    expect(body).toEqual({ Respuesta: { Valor: '007' } });
    expect(fetch).toHaveBeenCalledWith(
      WSFE_URL,
      expect.objectContaining({
        method: 'POST',
        body: '<sobre/>',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://ar.gov.afip.dif.FEV1/FEDummy"' },
      }),
    );
  });

  it('convierte un SOAP Fault en ArcaError con el código, aunque venga con HTTP 500', async () => {
    const fetch = vi.fn(async () => new Response(soapFault('cms.bad', 'Firma inválida'), { status: 500 }));

    const error = await postSoap('WSAA', WSAA_URL, '', '<x/>', { fetch }).catch((e) => e);

    expect(error).toBeInstanceOf(ArcaError);
    expect(error).toMatchObject({ message: 'ARCA WSAA: Firma inválida', code: 'cms.bad' });
  });

  it('falla con un error HTTP sin Fault', async () => {
    const fetch = vi.fn(async () => new Response('<html>Service Unavailable</html>', { status: 503 }));

    await expect(postSoap('WSFEv1', WSFE_URL, 'X', '<x/>', { fetch })).rejects.toThrow('ARCA WSFEv1 respondió HTTP 503');
  });

  it('falla si la respuesta no es un sobre SOAP', async () => {
    const fetch = vi.fn(async () => new Response('hola'));

    await expect(postSoap('WSFEv1', WSFE_URL, 'X', '<x/>', { fetch })).rejects.toThrow(
      'ARCA WSFEv1 devolvió una respuesta que no se puede leer',
    );
  });

  it('falla si no hay conexión', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(postSoap('WSAA', WSAA_URL, '', '<x/>', { fetch })).rejects.toThrow(
      'no se pudo conectar con ARCA WSAA: fetch failed',
    );
  });

  it('AC-136: da la llamada por fallida a los 30 s', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const result = postSoap('WSFEv1', WSFE_URL, 'X', '<x/>', { fetch });
    const settled = vi.fn();
    result.then(settled, settled);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow('ARCA WSFEv1 no respondió en 30 s');
  });
});

describe('escapeXml', () => {
  it('escapa los caracteres especiales', () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  });
});
