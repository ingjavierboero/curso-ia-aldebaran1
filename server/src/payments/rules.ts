import type { CLASSIFICATIONS, INVOICE_STATUSES } from '../db/schema.js';
import { findAmountMatch } from './amount-match.js';

export type Classification = (typeof CLASSIFICATIONS)[number];
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Motivos de Revisión manual, textuales del PRD (RF-64 a RF-72). */
export const REVIEW_REASONS = {
  pendingReview: 'revisión manual pendiente',
  processingError: 'no se pudo procesar el comprobante',
  doubtful: 'clasificación dudosa',
  missingData: 'no se pudieron extraer el CUIT o el monto',
  cuitMismatch: 'CUIT no coincide',
  ambiguousMatch: 'no se pudo determinar qué facturas cancela el pago',
  amountMismatch: 'monto no coincide',
} as const;

export type ReviewReason = (typeof REVIEW_REASONS)[keyof typeof REVIEW_REASONS];

/** Resultado del procesamiento de un email con adjunto (RF-59 a RF-61, RNF-02). */
export type ProcessingResult =
  | { kind: 'error' }
  | {
      kind: 'classified';
      classification: Classification;
      /** CUIT extraído del comprobante; null si no se pudo extraer. */
      cuit: string | null;
      /** Monto pagado en centavos; null si no se pudo extraer. */
      amountCents: number | null;
    };

export interface ClientInvoice {
  id: number;
  period: string;
  totalCents: number;
  status: InvoiceStatus;
}

export type PaymentDecision =
  /** Ninguna factura cambia de estado. */
  | { action: 'none'; rule: 'RF-62' | 'RF-63' }
  | { action: 'payment_received'; rule: 'RF-69' | 'RF-70'; invoiceIds: number[] }
  | {
      action: 'manual_review';
      rule: 'RF-64' | 'RF-65' | 'RF-66' | 'RF-67' | 'RF-68' | 'RF-71' | 'RF-72';
      reason: ReviewReason;
      invoiceIds: number[];
    };

const onlyDigits = (value: string) => value.replace(/\D/g, '');

/**
 * Decide qué hacer con las facturas de un cliente ante un email con adjunto (RF-62 a RF-72).
 * Las condiciones son excluyentes y se evalúan en el orden del PRD. Recibe todas las
 * facturas del cliente; las adeudadas son las Pendientes de pago o en Revisión manual.
 * El agente nunca pasa una factura a Pagada: eso lo decide un usuario.
 */
export function decidePayment(
  result: ProcessingResult,
  clientCuit: string,
  invoices: ClientInvoice[],
): PaymentDecision {
  if (result.kind === 'classified' && result.classification === 'no') {
    return { action: 'none', rule: 'RF-62' };
  }

  const owed = invoices.filter((i) => i.status === 'pending_payment' || i.status === 'manual_review');
  if (owed.length === 0) return { action: 'none', rule: 'RF-63' };

  const owedIds = owed.map((i) => i.id);
  const review = (rule: Extract<PaymentDecision, { action: 'manual_review' }>['rule'], reason: ReviewReason) =>
    ({ action: 'manual_review', rule, reason, invoiceIds: owedIds }) as const;

  if (owed.some((i) => i.status === 'manual_review')) {
    return review('RF-64', REVIEW_REASONS.pendingReview);
  }
  if (result.kind === 'error') return review('RF-65', REVIEW_REASONS.processingError);
  if (result.classification === 'dudoso') return review('RF-66', REVIEW_REASONS.doubtful);

  const { cuit, amountCents } = result;
  if (cuit === null || onlyDigits(cuit) === '' || amountCents === null) {
    return review('RF-67', REVIEW_REASONS.missingData);
  }
  if (onlyDigits(cuit) !== onlyDigits(clientCuit)) return review('RF-68', REVIEW_REASONS.cuitMismatch);

  // Comprobante validable: el cliente no está en revisión, así que todas las adeudadas están Pendientes de pago.
  const match = findAmountMatch(owed, amountCents);
  switch (match.kind) {
    case 'none':
      return review('RF-72', REVIEW_REASONS.amountMismatch);
    case 'ambiguous':
      return review('RF-71', REVIEW_REASONS.ambiguousMatch);
    case 'match':
      return {
        action: 'payment_received',
        rule: match.multiple ? 'RF-70' : 'RF-69',
        invoiceIds: match.invoiceIds,
      };
  }
}
