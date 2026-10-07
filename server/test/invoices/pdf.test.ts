import { describe, expect, it } from 'vitest';
import { type InvoiceItemRecord, type InvoiceRecord, renderInvoicePdf } from '../../src/invoices/pdf.js';
import { pdfText } from './pdf-text.js';

export const sampleInvoice: InvoiceRecord = {
  id: 1,
  clientId: 1,
  period: '2026-10',
  invoiceType: 11,
  pointOfSale: 1,
  number: 10,
  cae: '86400964342761',
  caeExpiresAt: '2026-10-25',
  issuedAt: new Date('2026-10-15T14:00:00Z'),
  clientBusinessName: 'Estudio Contable Ruiz',
  clientCuit: '20222222223',
  clientVatConditionId: 6,
  issueDate: '2026-10-15',
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-31',
  paymentDueDate: '2026-10-31',
  totalCents: 201_600_00,
  exchangeRateCents: 1_555_00,
  exchangeRateSource: 'dolarhoy.com — dólar blue venta',
  exchangeRateAt: new Date('2026-10-15T14:00:00Z'),
  exchangeRateFallback: false,
  status: 'pending_payment',
  reviewReason: null,
  statusChangedAt: new Date('2026-10-15T14:00:00Z'),
  createdAt: new Date('2026-10-15T14:00:00Z'),
  updatedAt: new Date('2026-10-15T14:00:00Z'),
};

export const sampleItems: InvoiceItemRecord[] = [
  { id: 1, invoiceId: 1, systemId: 1, description: 'CRM', currency: 'ARS', unitPriceCents: 15_000_00, amountCents: 15_000_00 },
  { id: 2, invoiceId: 1, systemId: 2, description: 'ERP', currency: 'USD', unitPriceCents: 120_00, amountCents: 186_600_00 },
];

const render = (invoice = sampleInvoice, items = sampleItems) =>
  renderInvoicePdf({ invoice, items, issuerCuit: '20311274350' }, { compress: false });

describe('renderInvoicePdf', () => {
  it('genera un PDF', async () => {
    const pdf = await renderInvoicePdf({ invoice: sampleInvoice, items: sampleItems, issuerCuit: '20311274350' });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('AC-145: incluye todos los datos de RF-106', async () => {
    const text = pdfText(await render());

    for (const expected of [
      'FACTURA C',
      'Código 11',
      'N° 00001-00000010',
      'Fecha de emisión: 15/10/2026',
      'Estudio Contable Ruiz',
      '20-22222222-3',
      'Responsable Monotributo',
      'octubre de 2026',
      '01/10/2026 al 31/10/2026',
      'Vencimiento del pago: ',
      'CRM — cuota mensual',
      '$ 15.000,00',
      'ERP — cuota mensual (USD 120,00)',
      '$ 186.600,00',
      'Total',
      '$ 201.600,00',
      'Cuotas en dólares convertidas a $ 1.555,00 por dólar (dolarhoy.com — dólar blue venta, 15/10/2026).',
      '86400964342761',
      'Vencimiento del CAE: ',
      '25/10/2026',
      'CUIT del emisor: 20-31127435-0',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('AC-164: avisa que el comprobante es de homologación y no tiene validez fiscal', async () => {
    expect(pdfText(await render())).toContain('COMPROBANTE EMITIDO EN HOMOLOGACIÓN DE ARCA — SIN VALIDEZ FISCAL');
  });

  it('no menciona cotización si todas las cuotas son en pesos', async () => {
    const invoice = { ...sampleInvoice, totalCents: 15_000_00, exchangeRateCents: null, exchangeRateSource: null, exchangeRateAt: null };

    const text = pdfText(await render(invoice, [sampleItems[0]!]));

    expect(text).not.toContain('Cuotas en dólares');
    expect(text).not.toContain('USD');
  });
});
