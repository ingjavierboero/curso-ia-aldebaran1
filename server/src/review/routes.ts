import { eq } from 'drizzle-orm';
import { type NextFunction, type Request, type Response, Router } from 'express';
import type { Db } from '../db/index.js';
import { invoiceItems, invoices } from '../db/schema.js';
import { formatInvoiceNumber } from '../invoices/format.js';
import { renderInvoicePdf } from '../invoices/pdf.js';
import { ReviewError, getAttachment, listReviewInvoices, resolveInvoice } from './service.js';

export interface ReviewRoutesDeps {
  db: Db;
  issuerCuit: string;
  now?: () => Date;
}

/** Tipos que se muestran en el navegador; el resto se descarga (vienen de remitentes externos). */
const INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ReviewError(404, 'No existe');
  return id;
}

const contentDisposition = (type: 'inline' | 'attachment', filename: string) =>
  `${type}; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

export function reviewRoutes({ db, issuerCuit, now = () => new Date() }: ReviewRoutesDeps): Router {
  const router = Router();

  router.get('/review/invoices', (_req, res) => {
    res.json(listReviewInvoices(db));
  });

  router.post('/invoices/:id/confirm-payment', (req, res) => {
    const invoice = resolveInvoice(db, idParam(req), 'paid', now());
    res.json({ id: invoice.id, status: invoice.status });
  });

  router.post('/invoices/:id/reject-payment', (req, res) => {
    const invoice = resolveInvoice(db, idParam(req), 'pending_payment', now());
    res.json({ id: invoice.id, status: invoice.status });
  });

  router.get('/attachments/:id', (req, res) => {
    const attachment = getAttachment(db, idParam(req));
    const type = attachment.contentType.toLowerCase();
    res.set({
      'Content-Type': INLINE_TYPES.has(type) ? type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(INLINE_TYPES.has(type) ? 'inline' : 'attachment', attachment.filename),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    res.send(attachment.content);
  });

  router.get('/invoices/:id/pdf', async (req, res) => {
    const invoiceId = idParam(req);
    const invoice = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    if (!invoice) throw new ReviewError(404, 'La factura no existe');
    const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).orderBy(invoiceItems.id).all();
    const pdf = await renderInvoicePdf({ invoice, items, issuerCuit });
    const filename = `Factura-C-${formatInvoiceNumber(invoice.pointOfSale, invoice.number)}.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('inline', filename) });
    res.send(pdf);
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ReviewError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  });

  return router;
}
