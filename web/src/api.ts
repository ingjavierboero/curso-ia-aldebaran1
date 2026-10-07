import type { ReviewInvoice } from './types';

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError('No se pudo conectar con el servidor');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError((body as { error?: string } | null)?.error ?? `Error del servidor (${response.status})`);
  }
  return body as T;
}

export const api = {
  reviewInvoices: () => request<ReviewInvoice[]>('/review/invoices'),
  confirmPayment: (id: number) => request<{ id: number; status: string }>(`/invoices/${id}/confirm-payment`, { method: 'POST' }),
  rejectPayment: (id: number) => request<{ id: number; status: string }>(`/invoices/${id}/reject-payment`, { method: 'POST' }),
  attachmentUrl: (id: number) => `/api/attachments/${id}`,
  invoicePdfUrl: (id: number) => `/api/invoices/${id}/pdf`,
};
