import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewStore, visibleInvoices } from '../src/store';
import type { ReviewInvoice } from '../src/types';

const invoice = (id: number, status: ReviewInvoice['status']): ReviewInvoice => ({
  id,
  status,
  reviewReason: status === 'manual_review' ? 'monto no coincide' : null,
  statusChangedAt: '2026-10-20T15:00:00.000Z',
  period: '2026-10',
  pointOfSale: 1,
  number: id,
  totalCents: 15_000_00,
  paymentDueDate: '2026-10-31',
  client: { id: 1, businessName: 'Los Andes', cuit: '30711111111', email: 'pagos@losandes.com' },
  emails: [],
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  useReviewStore.setState({ invoices: [], loading: false, error: null, filter: 'all', acting: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReviewStore', () => {
  it('carga las facturas en revisión', async () => {
    fetchMock.mockResolvedValue(json([invoice(1, 'payment_received'), invoice(2, 'manual_review')]));

    await useReviewStore.getState().load();

    expect(fetchMock).toHaveBeenCalledWith('/api/review/invoices', undefined);
    expect(useReviewStore.getState()).toMatchObject({ loading: false, error: null });
    expect(useReviewStore.getState().invoices.map((i) => i.id)).toEqual([1, 2]);
  });

  it('informa si el servidor no responde', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await useReviewStore.getState().load();

    expect(useReviewStore.getState()).toMatchObject({ loading: false, error: 'No se pudo conectar con el servidor' });
  });

  it('RF-77: confirmar el pago llama a la API y saca la factura de la lista', async () => {
    useReviewStore.setState({ invoices: [invoice(1, 'payment_received'), invoice(2, 'manual_review')] });
    fetchMock.mockResolvedValue(json({ id: 1, status: 'paid' }));

    const error = await useReviewStore.getState().confirmPayment(1);

    expect(error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/invoices/1/confirm-payment', { method: 'POST' });
    expect(useReviewStore.getState().invoices.map((i) => i.id)).toEqual([2]);
    expect(useReviewStore.getState().acting).toEqual({});
  });

  it('RF-80: devolver a pendiente llama a la API y saca la factura de la lista', async () => {
    useReviewStore.setState({ invoices: [invoice(2, 'manual_review')] });
    fetchMock.mockResolvedValue(json({ id: 2, status: 'pending_payment' }));

    await useReviewStore.getState().rejectPayment(2);

    expect(fetchMock).toHaveBeenCalledWith('/api/invoices/2/reject-payment', { method: 'POST' });
    expect(useReviewStore.getState().invoices).toEqual([]);
  });

  it('RF-100: si la acción falla, devuelve el mensaje del servidor y conserva la factura', async () => {
    useReviewStore.setState({ invoices: [invoice(1, 'payment_received')] });
    fetchMock.mockResolvedValue(json({ error: 'La factura no está en Pago recibido ni en Revisión manual' }, 409));

    const error = await useReviewStore.getState().confirmPayment(1);

    expect(error).toBe('La factura no está en Pago recibido ni en Revisión manual');
    expect(useReviewStore.getState().invoices).toHaveLength(1);
    expect(useReviewStore.getState().acting).toEqual({});
  });

  it('marca la factura como "en curso" mientras dura la acción', async () => {
    useReviewStore.setState({ invoices: [invoice(1, 'payment_received')] });
    let respond!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => (respond = resolve)));

    const pending = useReviewStore.getState().confirmPayment(1);
    expect(useReviewStore.getState().acting).toEqual({ 1: true });
    respond(json({ id: 1, status: 'paid' }));
    await pending;

    expect(useReviewStore.getState().acting).toEqual({});
  });
});

describe('visibleInvoices', () => {
  it('filtra por estado', () => {
    const all = [invoice(1, 'payment_received'), invoice(2, 'manual_review')];

    expect(visibleInvoices(all, 'all')).toHaveLength(2);
    expect(visibleInvoices(all, 'manual_review').map((i) => i.id)).toEqual([2]);
  });
});
