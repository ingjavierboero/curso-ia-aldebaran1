import { ImapFlow } from 'imapflow';
import type { Config } from '../config.js';

/** Una llamada al servidor de email se da por fallida a los 30 s (RNF-07). */
export const IMAP_TIMEOUT_MS = 30_000;

export interface RawMessage {
  uid: number;
  source: Buffer;
}

export interface MailboxPosition {
  uidValidity: string;
  lastUid: number;
}

export interface MailboxSource {
  /**
   * Mensajes nuevos de la bandeja de entrada: los de UID mayor a `position.lastUid` si el
   * UIDVALIDITY no cambió; si no hay posición o cambió, los recibidos desde `since`.
   */
  fetchNew(position: MailboxPosition | null, since: Date): Promise<{ uidValidity: string; messages: RawMessage[] }>;
}

export class MailboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailboxError';
  }
}

/** Lee la casilla de Gmail por IMAP con la contraseña de aplicación. No modifica los mensajes. */
export function gmailMailbox(config: Config): MailboxSource {
  return {
    async fetchNew(position, since) {
      const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: config.gmail.user, pass: config.gmail.appPassword },
        logger: false,
        connectionTimeout: IMAP_TIMEOUT_MS,
        greetingTimeout: IMAP_TIMEOUT_MS,
        socketTimeout: IMAP_TIMEOUT_MS,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX', { readOnly: true });
        try {
          const mailbox = client.mailbox;
          if (!mailbox) throw new MailboxError('no se pudo abrir la bandeja de entrada');
          const uidValidity = String(mailbox.uidValidity);

          let range: string;
          if (position && position.uidValidity === uidValidity) {
            range = `${position.lastUid + 1}:*`;
          } else {
            const uids = await client.search({ since }, { uid: true });
            if (!uids || uids.length === 0) return { uidValidity, messages: [] };
            range = uids.join(',');
          }

          const fetched = await client.fetchAll(range, { uid: true, source: true }, { uid: true });
          const messages = fetched
            // En IMAP, "N:*" devuelve al menos el último mensaje aunque su UID sea menor que N.
            .filter((m) => m.source && (!position || position.uidValidity !== uidValidity || m.uid > position.lastUid))
            .map((m) => ({ uid: m.uid, source: m.source! }))
            .sort((a, b) => a.uid - b.uid);
          return { uidValidity, messages };
        } finally {
          lock.release();
        }
      } catch (error) {
        if (error instanceof MailboxError) throw error;
        throw new MailboxError(`no se pudo leer la casilla: ${(error as Error).message}`, { cause: error });
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}
