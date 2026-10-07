/** Respuesta de GET /api/review/invoices (server/src/review/service.ts). */
export interface ReviewEmail {
  id: number;
  from: string;
  subject: string;
  receivedAt: string;
  processingStatus: 'pending' | 'processed' | 'error';
  processingError: string | null;
  classification: 'si' | 'no' | 'dudoso' | null;
  extractedCuit: string | null;
  extractedAmountCents: number | null;
  attachments: { id: number; filename: string; contentType: string; sizeBytes: number }[];
}

export interface ReviewInvoice {
  id: number;
  status: 'payment_received' | 'manual_review';
  reviewReason: string | null;
  statusChangedAt: string;
  period: string;
  pointOfSale: number;
  number: number;
  totalCents: number;
  paymentDueDate: string;
  client: { id: number; businessName: string; cuit: string; email: string };
  emails: ReviewEmail[];
}
