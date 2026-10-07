import { type AddressObject, simpleParser } from 'mailparser';

export interface ParsedEmail {
  messageId: string;
  /** Dirección del remitente en minúsculas. */
  from: string;
  subject: string;
  text: string;
  receivedAt: Date;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

function firstAddress(from: AddressObject | AddressObject[] | undefined): string {
  const list = Array.isArray(from) ? from : from ? [from] : [];
  for (const group of list) {
    for (const entry of group.value) if (entry.address) return entry.address.trim().toLowerCase();
  }
  return '';
}

/**
 * Interpreta un email crudo. Son adjuntos los archivos del email, no las imágenes embebidas
 * en el cuerpo HTML (logos de firmas, por ejemplo), que el cuerpo referencia por cid.
 */
export async function parseEmail(source: Buffer, fallbackId: string): Promise<ParsedEmail> {
  const mail = await simpleParser(source);
  return {
    messageId: mail.messageId?.trim() || fallbackId,
    from: firstAddress(mail.from),
    subject: mail.subject ?? '',
    text: mail.text ?? '',
    receivedAt: mail.date ?? new Date(),
    attachments: mail.attachments
      .filter((a) => !a.related)
      .map((a, i) => ({
        filename: a.filename ?? `adjunto-${i + 1}`,
        contentType: a.contentType,
        content: a.content,
      })),
  };
}
