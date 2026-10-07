import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { vi } from 'vitest';
import { MailboxError, type MailboxSource, type RawMessage } from '../../src/mailbox/imap.js';
import type { ClassificationOutcome } from '../../src/payments/classifier.js';

let seq = 0;

/** Arma un email crudo (RFC 822) como lo recibiría el servidor IMAP. */
export async function rawEmail(options: Mail.Options): Promise<Buffer> {
  seq += 1;
  return new MailComposer({
    to: 'facturacion@aldebaran.com',
    subject: `Respuesta ${seq}`,
    text: 'Adjunto el comprobante.',
    messageId: `<mensaje-${seq}@cliente.test>`,
    date: new Date('2026-10-20T15:00:00Z'),
    ...options,
  })
    .compile()
    .build();
}

export const receipt = (name = 'comprobante.pdf') => ({
  filename: name,
  content: Buffer.from('%PDF-1.4 comprobante'),
  contentType: 'application/pdf',
});

/**
 * Casilla en memoria: entrega los mensajes según la posición, como el servidor IMAP real. Sin
 * posición filtra por fecha con granularidad de día, como SEARCH SINCE.
 */
export function fakeMailbox() {
  const messages: (RawMessage & { date: Date })[] = [];
  const state = { uidValidity: '1001', failing: false, calls: 0 };
  const source: MailboxSource = {
    async fetchNew(position, since) {
      state.calls += 1;
      if (state.failing) throw new MailboxError('no se pudo leer la casilla: Timed out after 30000ms');
      const known = position && position.uidValidity === state.uidValidity;
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const selected = known
        ? messages.filter((m) => m.uid > position.lastUid)
        : messages.filter((m) => day(m.date) >= day(since));
      return { uidValidity: state.uidValidity, messages: selected.map(({ uid, source }) => ({ uid, source })) };
    },
  };
  return {
    source,
    state,
    async deliver(options: Mail.Options) {
      const raw = await rawEmail(options);
      const date = options.date ? new Date(options.date) : new Date('2026-10-20T15:00:00Z');
      messages.push({ uid: messages.length + 1, source: raw, date });
      return raw;
    },
  };
}

export const classified = (
  classification: 'si' | 'no' | 'dudoso',
  cuit: string | null = null,
  amountCents: number | null = null,
): ClassificationOutcome => ({ result: { kind: 'classified', classification, cuit, amountCents }, attempts: 1 });

export const erroneous: ClassificationOutcome = {
  result: { kind: 'error' },
  attempts: 4,
  error: 'el LLM respondió HTTP 500: Internal server error',
};

/** Clasificador simulado: devuelve los resultados indicados en orden. */
export function fakeClassifier(...outcomes: ClassificationOutcome[]) {
  return vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) throw new Error('clasificación inesperada');
    return next;
  });
}
