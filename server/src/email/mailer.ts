import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

/** Una llamada al servidor de email se da por fallida a los 30 s (RNF-07). */
export const SMTP_TIMEOUT_MS = 30_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface SentEmail {
  /** Destinatario real (puede diferir del pedido si hay redirección). */
  to: string;
  messageId: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<SentEmail>;
}

export class EmailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailError';
  }
}

interface Transport {
  sendMail(message: Record<string, unknown>): Promise<{ messageId: string }>;
}

export function gmailTransport(config: Config): Transport {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.gmail.user, pass: config.gmail.appPassword },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

export interface MailerOptions {
  transport?: Transport;
  timeoutMs?: number;
}

/**
 * Envía emails desde la casilla del sistema (GMAIL_USER). Además de los timeouts por etapa de
 * nodemailer, corta el envío completo a los 30 s. Con EMAIL_REDIRECT_TO, todo va a esa casilla
 * y el asunto indica a quién iba dirigido.
 */
export function createMailer(config: Config, { transport, timeoutMs = SMTP_TIMEOUT_MS }: MailerOptions = {}): Mailer {
  const smtp = transport ?? gmailTransport(config);
  return {
    async send(email) {
      const to = config.emailRedirectTo ?? email.to;
      const subject = config.emailRedirectTo ? `[para ${email.to}] ${email.subject}` : email.subject;

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new EmailError(`el servidor de email no respondió en ${timeoutMs / 1000} s`)),
          timeoutMs,
        );
      });
      try {
        const info = await Promise.race([
          smtp.sendMail({
            from: config.gmail.user,
            to,
            subject,
            text: email.text,
            html: email.html,
            attachments: email.attachments,
          }),
          timeout,
        ]);
        return { to, messageId: info.messageId };
      } catch (error) {
        if (error instanceof EmailError) throw error;
        throw new EmailError(`no se pudo enviar el email a ${to}: ${(error as Error).message}`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
