import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import PDFDocument from 'pdfkit';
import { loadConfig, loadEnvFile } from '../config.js';
import { formatArs } from '../invoices/format.js';
import { type EmailToClassify, classifyEmail, createAnthropicClient } from './classifier.js';

// Prueba el clasificador contra Claude: con una ruta, clasifica ese archivo (PDF o imagen);
// sin argumentos, uno generado en el momento que simula un comprobante de transferencia.
// No escribe en la base.
loadEnvFile();
const config = loadConfig();

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function sampleReceipt(): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('Helvetica-Bold').fontSize(16).text('Banco de Prueba');
  doc.font('Helvetica').fontSize(11).moveDown().text('Comprobante de transferencia');
  doc.text('Operación N° 123456789 — 15/10/2026 12:34');
  doc.moveDown().text('Ordenante: Panadería Los Andes SRL').text('CUIT ordenante: 30-71111111-1');
  doc.moveDown().text('Destinatario: Aldebaran').text(`CUIT destinatario: ${config.arca.cuit}`);
  doc.moveDown().font('Helvetica-Bold').text('Importe: $ 15.000,50');
  doc.font('Helvetica').text('Estado: Transferencia realizada');
  doc.end();
  return done;
}

const path = process.argv[2];
const attachment = path
  ? { filename: basename(path), contentType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', content: readFileSync(path) }
  : { filename: 'comprobante-ejemplo.pdf', contentType: 'application/pdf', content: await sampleReceipt() };

const email: EmailToClassify = {
  subject: 'RE: Factura C 00001-00000010 – octubre de 2026',
  text: 'Hola, les adjunto el comprobante del pago. Saludos.',
  attachments: [attachment],
};

const started = Date.now();
const outcome = await classifyEmail({ client: createAnthropicClient(config), issuerCuit: config.arca.cuit }, email);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Adjunto: ${attachment.filename}`);
if (outcome.result.kind === 'error') {
  console.log(`Procesamiento erróneo tras ${outcome.attempts} intentos: ${outcome.error} (${elapsed} s)`);
  process.exitCode = 1;
} else {
  const { classification, cuit, amountCents } = outcome.result;
  console.log(`Clasificación: ${classification}`);
  if (classification === 'si') {
    console.log(`CUIT: ${cuit ?? 'no se pudo extraer'}`);
    console.log(`Monto: ${amountCents === null ? 'no se pudo extraer' : formatArs(amountCents)}`);
  }
  console.log(`(${outcome.attempts} intento${outcome.attempts > 1 ? 's' : ''}, ${elapsed} s)`);
}
