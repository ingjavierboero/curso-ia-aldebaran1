import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { EmailError, SMTP_TIMEOUT_MS, createMailer, gmailTransport } from '../../src/email/mailer.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-test',
  GMAIL_USER: 'facturacion@empresa.com',
  GMAIL_APP_PASSWORD: 'app-pass',
  ARCA_CUIT: '20311274350',
  ARCA_CERT_PATH: '/certs/test.crt',
  ARCA_KEY_PATH: '/certs/test.key',
};
const email = { to: 'cliente@empresa.com', subject: 'Factura', text: 'hola', html: '<p>hola</p>' };

afterEach(() => {
  vi.useRealTimers();
});

describe('createMailer', () => {
  it('envía desde la casilla del sistema al destinatario', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<1@gmail>' }));

    const sent = await createMailer(loadConfig(env), { transport: { sendMail } }).send(email);

    expect(sent).toEqual({ to: 'cliente@empresa.com', messageId: '<1@gmail>' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'facturacion@empresa.com', to: 'cliente@empresa.com', subject: 'Factura' }),
    );
  });

  it('con EMAIL_REDIRECT_TO manda todo a esa casilla e indica el destinatario original', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<1@gmail>' }));
    const config = loadConfig({ ...env, EMAIL_REDIRECT_TO: 'yo@empresa.com' });

    const sent = await createMailer(config, { transport: { sendMail } }).send(email);

    expect(sent.to).toBe('yo@empresa.com');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'yo@empresa.com', subject: '[para cliente@empresa.com] Factura' }),
    );
  });

  it('informa un rechazo del servidor como EmailError', async () => {
    const sendMail = vi.fn(async () => {
      throw new Error('550 5.1.1 The email account that you tried to reach does not exist');
    });

    await expect(createMailer(loadConfig(env), { transport: { sendMail } }).send(email)).rejects.toThrow(
      new EmailError('no se pudo enviar el email a cliente@empresa.com: 550 5.1.1 The email account that you tried to reach does not exist'),
    );
  });

  it('AC-136: da el envío por fallido a los 30 s', async () => {
    vi.useFakeTimers();
    const sendMail = vi.fn(() => new Promise<{ messageId: string }>(() => {}));
    const result = createMailer(loadConfig(env), { transport: { sendMail } }).send(email);
    const settled = vi.fn();
    result.then(settled, settled);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow('el servidor de email no respondió en 30 s');
  });
});

describe('gmailTransport', () => {
  it('AC-135, AC-136: usa GMAIL_USER y GMAIL_APP_PASSWORD, con timeouts de 30 s', () => {
    const transport = gmailTransport(loadConfig(env)) as unknown as { options: Record<string, any> };

    expect(transport.options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'facturacion@empresa.com', pass: 'app-pass' },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  });
});

describe('EMAIL_REDIRECT_TO', () => {
  it('es opcional', () => {
    expect(loadConfig(env).emailRedirectTo).toBeNull();
  });

  it('rechaza un valor que no es un email', () => {
    expect(() => loadConfig({ ...env, EMAIL_REDIRECT_TO: 'yo' })).toThrow('EMAIL_REDIRECT_TO no es un email válido');
  });
});
