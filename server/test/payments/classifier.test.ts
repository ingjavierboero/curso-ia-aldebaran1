import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  CLASSIFIER_MODEL,
  type EmailToClassify,
  buildContent,
  classifyEmail,
  createAnthropicClient,
  parseResponse,
} from '../../src/payments/classifier.js';

const ISSUER_CUIT = '20311274350';

const email: EmailToClassify = {
  subject: 'RE: Factura C 00001-00000010',
  text: 'Les adjunto el comprobante de la transferencia.',
  attachments: [{ filename: 'comprobante.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 prueba') }],
};

/** Respuesta del modelo con la salida estructurada pedida. */
function message(json: unknown, stop_reason: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: CLASSIFIER_MODEL,
    content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json), citations: null }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

const ok = message({ clasificacion: 'si', cuit: '30-71111111-1', monto: 15000.5 });
const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'api_error', message: `HTTP ${status}` } }, `HTTP ${status}`, new Headers());

/** Cliente simulado: cada llamada devuelve (o lanza) el próximo resultado de la lista. */
function fakeClient(...replies: (Anthropic.Message | Error)[]) {
  const create = vi.fn(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error('llamada inesperada');
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function fakeSleep() {
  const sleeps: number[] = [];
  return { clock: { sleep: async (ms: number) => void sleeps.push(ms) }, sleeps };
}

async function classify(...replies: (Anthropic.Message | Error)[]) {
  const { client, create } = fakeClient(...replies);
  const { clock, sleeps } = fakeSleep();
  const outcome = await classifyEmail({ client, issuerCuit: ISSUER_CUIT, clock }, email);
  return { outcome, create, sleeps };
}

describe('classifyEmail', () => {
  it('RF-59, RF-60: clasifica "si" y extrae el CUIT y el monto', async () => {
    const { outcome, create } = await classify(ok);

    expect(outcome).toEqual({
      result: { kind: 'classified', classification: 'si', cuit: '30711111111', amountCents: 1_500_050 },
      attempts: 1,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('pide salida estructurada al modelo de AGENTS.md, con el email y el adjunto', async () => {
    const { create } = await classify(ok);

    const request = (create.mock.calls[0] as unknown as [Anthropic.MessageCreateParamsNonStreaming])[0];
    expect(request.model).toBe('claude-haiku-4-5-20251001');
    expect(request.output_config?.format).toMatchObject({
      type: 'json_schema',
      schema: { required: ['clasificacion', 'cuit', 'monto'], additionalProperties: false },
    });
    expect(request.system).toContain(`Nuestro CUIT, el del beneficiario, es ${ISSUER_CUIT}`);
    expect(request.messages[0]!.content).toEqual(buildContent(email));
  });

  it.each(['no', 'dudoso'] as const)('clasifica "%s" sin CUIT ni monto', async (clasificacion) => {
    const { outcome } = await classify(message({ clasificacion, cuit: '30711111111', monto: 100 }));

    expect(outcome.result).toEqual({ kind: 'classified', classification: clasificacion, cuit: null, amountCents: null });
  });

  it('AC-70: falla dos veces y responde en el tercer intento → 3 llamadas con esperas de 2 s y 4 s', async () => {
    const { outcome, create, sleeps } = await classify(apiError(500), apiError(529), ok);

    expect(create).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(outcome).toMatchObject({ result: { classification: 'si' }, attempts: 3 });
  });

  it('AC-78: HTTP 500 en los cuatro intentos → procesamiento erróneo, con esperas de 2, 4 y 8 s', async () => {
    const { outcome, create, sleeps } = await classify(apiError(500), apiError(500), apiError(500), apiError(500));

    expect(create).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(outcome).toEqual({ result: { kind: 'error' }, attempts: 4, error: 'el LLM respondió HTTP 500: HTTP 500' });
  });

  it.each([400, 401, 403])('AC-71: HTTP %i → una sola llamada y procesamiento erróneo', async (status) => {
    const { outcome, create, sleeps } = await classify(apiError(status), ok);

    expect(create).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(outcome).toMatchObject({ result: { kind: 'error' }, attempts: 1 });
  });

  it('AC-166: tampoco reintenta otros errores 4xx que se repetirían igual (404)', async () => {
    const { create } = await classify(apiError(404), ok);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['un timeout (a)', new Anthropic.APIConnectionTimeoutError()],
    ['un error de red (b)', new Anthropic.APIConnectionError({ message: 'ECONNRESET' })],
    ['un HTTP 429 (b, AC-166)', apiError(429)],
    ['un HTTP 408', apiError(408)],
    ['una respuesta que no es JSON (c)', message('no sé')],
    ['una clasificación inválida (c)', message({ clasificacion: 'tal vez', cuit: null, monto: null })],
    ['una respuesta cortada (c)', message({ clasificacion: 'si', cuit: null, monto: null }, 'max_tokens')],
    ['un rechazo del modelo (c)', message('', 'refusal')],
  ])('RNF-02: reintenta ante %s', async (_name, failure) => {
    const { outcome, create } = await classify(failure, ok);

    expect(create).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ result: { classification: 'si' }, attempts: 2 });
  });

  it('describe el timeout en el motivo del error', async () => {
    const timeout = () => new Anthropic.APIConnectionTimeoutError();
    const { outcome } = await classify(timeout(), timeout(), timeout(), timeout());

    expect(outcome.error).toBe('el LLM no respondió en 10 s');
  });
});

describe('parseResponse (AC-167: CUIT de 11 dígitos)', () => {
  it.each([
    [{ clasificacion: 'si', cuit: '30711111111', monto: 15000 }, '30711111111', 1_500_000],
    [{ clasificacion: 'si', cuit: '30 71111111 1', monto: 0.1 }, '30711111111', 10],
    [{ clasificacion: 'si', cuit: null, monto: 15000 }, null, 1_500_000],
    [{ clasificacion: 'si', cuit: '3071111111', monto: null }, null, null],
  ])('%j → CUIT %s y %s centavos', (json, cuit, amountCents) => {
    expect(parseResponse(message(json))).toEqual({ kind: 'classified', classification: 'si', cuit, amountCents });
  });
});

describe('buildContent', () => {
  it('manda los PDF como documento y las imágenes como imagen, antes del texto', () => {
    const content = buildContent({
      subject: 'Pago',
      text: 'Adjunto',
      attachments: [
        { filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') },
        { filename: 'b.jpg', contentType: 'image/jpeg; name=b.jpg', content: Buffer.from('jpg') },
      ],
    });

    expect(content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' }, title: 'a.pdf' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'anBn' } },
      { type: 'text', text: expect.stringContaining('<asunto>Pago</asunto>') },
    ]);
  });

  it('avisa qué adjuntos no se pudieron incluir', () => {
    const [text] = buildContent({
      subject: 'Pago',
      text: 'Adjunto',
      attachments: [{ filename: 'pago.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('x') }],
    });

    expect(text).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Adjuntos que no se pudieron incluir: pago.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document).'),
    });
  });
});

describe('createAnthropicClient con el SDK real y HTTP simulado', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-valor-de-prueba',
    GMAIL_USER: 'a@b.com',
    GMAIL_APP_PASSWORD: 'x',
    ARCA_CUIT: ISSUER_CUIT,
    ARCA_CERT_PATH: '/a',
    ARCA_KEY_PATH: '/b',
  };

  it('usa timeout de 10 s y no reintenta por su cuenta', () => {
    const client = createAnthropicClient(loadConfig(env));

    expect(client.timeout).toBe(10_000);
    expect(client.maxRetries).toBe(0);
  });

  it('AC-134: la llamada usa la API key de ANTHROPIC_API_KEY', async () => {
    const fetch = vi.fn(async () => Response.json(message({ clasificacion: 'no', cuit: null, monto: null })));
    const client = new Anthropic({ apiKey: loadConfig(env).anthropicApiKey, maxRetries: 0, fetch });

    await classifyEmail({ client, issuerCuit: ISSUER_CUIT, clock: fakeSleep().clock }, email);

    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('x-api-key')).toBe('sk-ant-valor-de-prueba');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      output_config: { format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: [{ type: 'document' }, { type: 'text' }] }],
    });
  });

  it('el SDK no reintenta un 529: los reintentos los decide el clasificador', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }),
    );
    const client = new Anthropic({ apiKey: 'sk-test', maxRetries: 0, fetch });

    const { sleeps } = fakeSleep();
    const outcome = await classifyEmail({ client, issuerCuit: ISSUER_CUIT, clock: { sleep: async (ms) => void sleeps.push(ms) } }, email);

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(outcome).toMatchObject({ result: { kind: 'error' }, attempts: 4 });
  });
});
