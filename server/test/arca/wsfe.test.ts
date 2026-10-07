import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createArcaClientFromConfig } from '../../src/arca/index.js';
import { WSFE_URL } from '../../src/arca/endpoints.js';
import { type CaeRequest, amountToCents, centsToAmount, createArcaClient } from '../../src/arca/wsfe.js';
import { loadConfig } from '../../src/config.js';
import { type Db, openDb } from '../../src/db/index.js';
import { createTestCertificate, fakeArca, wsaaLoginResponse, wsfeResponse } from './helpers.js';

let cert: ReturnType<typeof createTestCertificate>;
let db: Db;

beforeAll(() => {
  cert = createTestCertificate();
});

beforeEach(() => {
  db = openDb(':memory:');
});

const now = () => new Date('2026-10-15T14:00:00Z');

function client(replies: Parameters<typeof fakeArca>[0]) {
  const arca = fakeArca({ loginCms: wsaaLoginResponse(), ...replies });
  const arcaClient = createArcaClient({
    db,
    cuit: '20123456789',
    certificatePem: cert.certificatePem,
    privateKeyPem: cert.privateKeyPem,
    fetch: arca.fetch,
    now,
  });
  return { arca, client: arcaClient, wsfeRequests: () => arca.requests.filter((r) => r.action !== '') };
}

const request: CaeRequest = {
  pointOfSale: 3,
  number: 42,
  issueDate: '2026-10-15',
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-31',
  paymentDueDate: '2026-10-31',
  customerCuit: '30711111118',
  recipientVatConditionId: 1,
  totalCents: 201_600_00,
};

const approved = (observations = '') =>
  wsfeResponse(
    'FECAESolicitar',
    '<FeCabResp><Cuit>20123456789</Cuit><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><FchProceso>20261015110000</FchProceso>' +
      '<CantReg>1</CantReg><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp>' +
      '<FeDetResp><FECAEDetResponse><Concepto>2</Concepto><DocTipo>80</DocTipo><DocNro>30711111118</DocNro>' +
      '<CbteDesde>42</CbteDesde><CbteHasta>42</CbteHasta><CbteFch>20261015</CbteFch><Resultado>A</Resultado>' +
      `${observations}<CAE>76412345678901</CAE><CAEFchVto>20261025</CAEFchVto></FECAEDetResponse></FeDetResp>`,
  );

describe('conversión de formatos', () => {
  it.each([
    [201_600_00, '201600.00'],
    [15_56, '15.56'],
    [5, '0.05'],
  ])('%i centavos → "%s"', (cents, amount) => {
    expect(centsToAmount(cents)).toBe(amount);
  });

  it.each([
    ['201600', 201_600_00],
    ['201600.5', 201_600_50],
    ['15.56', 15_56],
    ['0.05', 5],
  ])('"%s" → %i centavos', (amount, cents) => {
    expect(amountToCents(amount)).toBe(cents);
  });
});

describe('lastAuthorizedNumber', () => {
  it('consulta el último número de Factura C en el punto de venta, autenticado con el ticket de WSAA', async () => {
    const { client: arcaClient, wsfeRequests } = client({
      FECompUltimoAutorizado: wsfeResponse('FECompUltimoAutorizado', '<PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>41</CbteNro>'),
    });

    await expect(arcaClient.lastAuthorizedNumber(3)).resolves.toBe(41);

    const [sent] = wsfeRequests();
    expect(sent!.url).toBe(WSFE_URL);
    expect(sent!.body).toContain(
      '<ar:Auth><ar:Token>TOKEN-1</ar:Token><ar:Sign>SIGN-1</ar:Sign><ar:Cuit>20123456789</ar:Cuit></ar:Auth>',
    );
    expect(sent!.body).toContain('<ar:PtoVta>3</ar:PtoVta><ar:CbteTipo>11</ar:CbteTipo>');
  });

  it('pide un solo ticket a WSAA para varias operaciones', async () => {
    const { client: arcaClient, arca } = client({
      FECompUltimoAutorizado: wsfeResponse('FECompUltimoAutorizado', '<CbteNro>0</CbteNro>'),
    });

    await arcaClient.lastAuthorizedNumber(1);
    await arcaClient.lastAuthorizedNumber(2);

    expect(arca.requests.map((r) => r.action)).toEqual(['', 'FECompUltimoAutorizado', 'FECompUltimoAutorizado']);
  });

  it('informa los errores de ARCA con su código', async () => {
    const { client: arcaClient } = client({
      FECompUltimoAutorizado: wsfeResponse(
        'FECompUltimoAutorizado',
        '<PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>0</CbteNro><Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones</Msg></Err></Errors>',
      ),
    });

    await expect(arcaClient.lastAuthorizedNumber(3)).rejects.toMatchObject({
      message: 'ARCA WSFEv1 FECompUltimoAutorizado: [600] ValidacionDeToken: No aparecio CUIT en lista de relaciones',
      code: '600',
    });
  });
});

describe('requestCae', () => {
  it('AC-141: pide una Factura C (código 11) en el punto de venta indicado', async () => {
    const { client: arcaClient, wsfeRequests } = client({ FECAESolicitar: approved() });

    await arcaClient.requestCae(request);

    expect(wsfeRequests()[0]!.body).toContain(
      '<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>3</ar:PtoVta><ar:CbteTipo>11</ar:CbteTipo></ar:FeCabReq>',
    );
  });

  it('arma el detalle en el orden del WSDL: servicios, CUIT, sin IVA discriminado, en pesos', async () => {
    const { client: arcaClient, wsfeRequests } = client({ FECAESolicitar: approved() });

    await arcaClient.requestCae(request);

    expect(wsfeRequests()[0]!.body).toContain(
      '<ar:FECAEDetRequest>' +
        '<ar:Concepto>2</ar:Concepto><ar:DocTipo>80</ar:DocTipo><ar:DocNro>30711111118</ar:DocNro>' +
        '<ar:CbteDesde>42</ar:CbteDesde><ar:CbteHasta>42</ar:CbteHasta><ar:CbteFch>20261015</ar:CbteFch>' +
        '<ar:ImpTotal>201600.00</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc><ar:ImpNeto>201600.00</ar:ImpNeto>' +
        '<ar:ImpOpEx>0</ar:ImpOpEx><ar:ImpTrib>0</ar:ImpTrib><ar:ImpIVA>0</ar:ImpIVA>' +
        '<ar:FchServDesde>20261001</ar:FchServDesde><ar:FchServHasta>20261031</ar:FchServHasta>' +
        '<ar:FchVtoPago>20261031</ar:FchVtoPago><ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>' +
        '<ar:CondicionIVAReceptorId>1</ar:CondicionIVAReceptorId>' +
        '</ar:FECAEDetRequest>',
    );
  });

  it('devuelve el CAE y su vencimiento cuando ARCA aprueba', async () => {
    const { client: arcaClient } = client({ FECAESolicitar: approved() });

    await expect(arcaClient.requestCae(request)).resolves.toEqual({
      cae: '76412345678901',
      caeExpiresAt: '2026-10-25',
      observations: [],
    });
  });

  it('devuelve las observaciones de una factura aprobada', async () => {
    const { client: arcaClient } = client({
      FECAESolicitar: approved('<Observaciones><Obs><Code>10217</Code><Msg>Observación informativa</Msg></Obs></Observaciones>'),
    });

    await expect(arcaClient.requestCae(request)).resolves.toMatchObject({
      observations: [{ code: '10217', message: 'Observación informativa' }],
    });
  });

  it('falla con las observaciones si ARCA rechaza el comprobante', async () => {
    const { client: arcaClient } = client({
      FECAESolicitar: wsfeResponse(
        'FECAESolicitar',
        '<FeCabResp><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>R</Resultado>' +
          '<Observaciones><Obs><Code>10016</Code><Msg>El numero o fecha del comprobante no se corresponde con el proximo a autorizar.</Msg></Obs>' +
          '<Obs><Code>10048</Code><Msg>Otra observación</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp>',
      ),
    });

    await expect(arcaClient.requestCae(request)).rejects.toMatchObject({
      message:
        'ARCA WSFEv1 rechazó la factura: [10016] El numero o fecha del comprobante no se corresponde con el proximo a autorizar.; [10048] Otra observación',
      code: '10016',
    });
  });

  it('falla con los errores si el pedido es inválido', async () => {
    const { client: arcaClient } = client({
      FECAESolicitar: wsfeResponse(
        'FECAESolicitar',
        '<FeCabResp><Resultado>R</Resultado></FeCabResp><Errors><Err><Code>10242</Code><Msg>El campo Condicion Frente al IVA del receptor es obligatorio</Msg></Err></Errors>',
      ),
    });

    await expect(arcaClient.requestCae(request)).rejects.toMatchObject({ code: '10242' });
  });
});

describe('findInvoice', () => {
  it('devuelve un comprobante emitido', async () => {
    const { client: arcaClient, wsfeRequests } = client({
      FECompConsultar: wsfeResponse(
        'FECompConsultar',
        '<ResultGet><Concepto>2</Concepto><DocTipo>80</DocTipo><DocNro>30711111118</DocNro><CbteDesde>42</CbteDesde>' +
          '<CbteHasta>42</CbteHasta><CbteFch>20261015</CbteFch><ImpTotal>201600</ImpTotal><FchServDesde>20261001</FchServDesde>' +
          '<FchServHasta>20261031</FchServHasta><FchVtoPago>20261031</FchVtoPago><MonId>PES</MonId><MonCotiz>1</MonCotiz>' +
          '<Resultado>A</Resultado><CodAutorizacion>76412345678901</CodAutorizacion><EmisionTipo>CAE</EmisionTipo>' +
          '<FchVto>20261025</FchVto><FchProceso>20261015110000</FchProceso><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo></ResultGet>',
      ),
    });

    await expect(arcaClient.findInvoice(3, 42)).resolves.toEqual({
      pointOfSale: 3,
      number: 42,
      customerCuit: '30711111118',
      totalCents: 201_600_00,
      issueDate: '2026-10-15',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
      cae: '76412345678901',
      caeExpiresAt: '2026-10-25',
    });
    expect(wsfeRequests()[0]!.body).toContain(
      '<ar:FeCompConsReq><ar:CbteTipo>11</ar:CbteTipo><ar:CbteNro>42</ar:CbteNro><ar:PtoVta>3</ar:PtoVta></ar:FeCompConsReq>',
    );
  });

  it('devuelve null si el comprobante no existe', async () => {
    const { client: arcaClient } = client({
      FECompConsultar: wsfeResponse(
        'FECompConsultar',
        '<Errors><Err><Code>602</Code><Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors>',
      ),
    });

    await expect(arcaClient.findInvoice(3, 99)).resolves.toBeNull();
  });
});

describe('createArcaClientFromConfig', () => {
  const env = (overrides: Record<string, string> = {}) => ({
    ANTHROPIC_API_KEY: 'sk-test',
    GMAIL_USER: 'facturacion@example.com',
    GMAIL_APP_PASSWORD: 'app-pass',
    ARCA_CUIT: '27999999993',
    ARCA_CERT_PATH: cert.certPath,
    ARCA_KEY_PATH: cert.keyPath,
    ...overrides,
  });

  it('AC-135: usa el CUIT, el certificado y la clave de las variables de entorno', async () => {
    const arca = fakeArca({
      loginCms: wsaaLoginResponse(),
      FECompUltimoAutorizado: wsfeResponse('FECompUltimoAutorizado', '<CbteNro>0</CbteNro>'),
    });

    await createArcaClientFromConfig(db, loadConfig(env()), { fetch: arca.fetch }).lastAuthorizedNumber(1);

    expect(arca.requests[1]!.body).toContain('<ar:Cuit>27999999993</ar:Cuit>');
    // El CMS enviado a WSAA lleva el certificado del archivo indicado en ARCA_CERT_PATH.
    const certBase64 = cert.certificatePem.replace(/-----[^-]+-----|\s/g, '');
    const cms = Buffer.from(/<wsaa:in0>([^<]+)</.exec(arca.requests[0]!.body)![1]!, 'base64');
    expect(cms.includes(Buffer.from(certBase64, 'base64'))).toBe(true);
  });

  it('falla con un mensaje claro si no encuentra el certificado', () => {
    expect(() => createArcaClientFromConfig(db, loadConfig(env({ ARCA_CERT_PATH: '/no/existe.crt' })))).toThrow(
      'no se pudo leer el certificado de ARCA en /no/existe.crt',
    );
  });
});
