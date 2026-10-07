import PDFDocument from 'pdfkit';
import type { invoiceItems, invoices } from '../db/schema.js';
import { argentinaDate } from '../billing/dates.js';
import {
  formatArs,
  formatCuit,
  formatDate,
  formatInvoiceNumber,
  formatPeriod,
  formatUsd,
  vatConditionName,
} from './format.js';

export type InvoiceRecord = typeof invoices.$inferSelect;
export type InvoiceItemRecord = typeof invoiceItems.$inferSelect;

export interface InvoicePdfData {
  invoice: InvoiceRecord;
  items: InvoiceItemRecord[];
  /** CUIT del emisor (ARCA_CUIT). */
  issuerCuit: string;
}

export interface PdfOptions {
  /** Sin compresión el texto queda legible en el archivo (lo usan los tests). */
  compress?: boolean;
}

/**
 * Genera el PDF de una factura con los datos de RF-106. Lleva una leyenda de homologación:
 * en este MVP las facturas se emiten en el ambiente de pruebas de ARCA y no tienen validez fiscal.
 */
export function renderInvoicePdf({ invoice, items, issuerCuit }: InvoicePdfData, { compress = true }: PdfOptions = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, compress, info: { Title: `Factura C ${formatInvoiceNumber(invoice.pointOfSale, invoice.number)}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 50;
  const right = doc.page.width - 50;
  const width = right - left;
  const label = (text: string, value: string) => {
    doc.font('Helvetica-Bold').text(`${text}: `, { continued: true }).font('Helvetica').text(value);
  };

  // Encabezado
  doc.font('Helvetica-Bold').fontSize(20).text('FACTURA C', left, 50);
  doc.font('Helvetica').fontSize(10).text('Código 11', left, 75);
  doc.font('Helvetica-Bold').fontSize(12).text(`N° ${formatInvoiceNumber(invoice.pointOfSale, invoice.number)}`, left, 50, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(`Fecha de emisión: ${formatDate(invoice.issueDate)}`, left, 68, { width, align: 'right' });
  doc.text(`CUIT del emisor: ${formatCuit(issuerCuit)}`, left, 82, { width, align: 'right' });

  doc.rect(left, 105, width, 22).fill('#fdecea');
  doc.fill('#b3261e').font('Helvetica-Bold').fontSize(9)
    .text('COMPROBANTE EMITIDO EN HOMOLOGACIÓN DE ARCA — SIN VALIDEZ FISCAL', left, 112, { width, align: 'center' });
  doc.fill('black').fontSize(10);

  // Cliente
  doc.y = 145;
  doc.font('Helvetica-Bold').fontSize(11).text('Cliente', left);
  doc.fontSize(10);
  label('Razón social', invoice.clientBusinessName);
  label('CUIT', formatCuit(invoice.clientCuit));
  label('Condición frente al IVA', vatConditionName(invoice.clientVatConditionId));

  // Período
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(11).text('Período', left);
  doc.fontSize(10);
  label('Período facturado', formatPeriod(invoice.period));
  label('Período de servicio', `${formatDate(invoice.serviceFrom)} al ${formatDate(invoice.serviceTo)}`);
  label('Vencimiento del pago', formatDate(invoice.paymentDueDate));

  // Detalle
  doc.moveDown();
  const amountX = right - 120;
  let y = doc.y;
  doc.font('Helvetica-Bold').text('Detalle', left, y).text('Importe', amountX, y, { width: 120, align: 'right' });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.font('Helvetica');
  for (const item of items) {
    y += 8;
    const description =
      item.currency === 'USD' ? `${item.description} — cuota mensual (${formatUsd(item.unitPriceCents)})` : `${item.description} — cuota mensual`;
    doc.text(description, left, y, { width: amountX - left - 10 });
    const rowEnd = doc.y;
    doc.text(formatArs(item.amountCents), amountX, y, { width: 120, align: 'right' });
    y = Math.max(rowEnd, doc.y);
  }
  y += 6;
  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).text('Total', left, y).text(formatArs(invoice.totalCents), amountX - 60, y, { width: 180, align: 'right' });
  doc.fontSize(10).font('Helvetica');

  if (invoice.exchangeRateCents !== null && invoice.exchangeRateAt) {
    doc.moveDown();
    doc.text(
      `Cuotas en dólares convertidas a ${formatArs(invoice.exchangeRateCents)} por dólar ` +
        `(${invoice.exchangeRateSource}, ${formatDate(argentinaDate(invoice.exchangeRateAt))}).`,
      left,
      doc.y,
      { width },
    );
  }

  // Autorización de ARCA
  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(11).text('Autorización ARCA', left);
  doc.fontSize(10);
  label('CAE', invoice.cae);
  label('Vencimiento del CAE', formatDate(invoice.caeExpiresAt));

  doc.end();
  return done;
}
