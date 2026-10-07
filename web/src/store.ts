import { create } from 'zustand';
import { api } from './api';
import type { ReviewInvoice } from './types';

export type StatusFilter = 'all' | ReviewInvoice['status'];

interface ReviewState {
  invoices: ReviewInvoice[];
  loading: boolean;
  error: string | null;
  filter: StatusFilter;
  /** Facturas con una acción en curso (para deshabilitar sus botones). */
  acting: Record<number, boolean>;
  load: () => Promise<void>;
  setFilter: (filter: StatusFilter) => void;
  /** Pasa la factura a Pagada (RF-77, RF-79). Devuelve el error para mostrarlo, o null. */
  confirmPayment: (id: number) => Promise<string | null>;
  /** Devuelve la factura a Pendiente de pago (RF-78, RF-80). */
  rejectPayment: (id: number) => Promise<string | null>;
}

export const useReviewStore = create<ReviewState>((set) => {
  const resolve = async (id: number, action: (id: number) => Promise<unknown>) => {
    set((s) => ({ acting: { ...s.acting, [id]: true } }));
    try {
      await action(id);
      // La factura sale de la revisión: se saca de la lista sin esperar a recargar.
      set((s) => ({ invoices: s.invoices.filter((i) => i.id !== id) }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      set((s) => {
        const { [id]: _done, ...acting } = s.acting;
        return { acting };
      });
    }
  };

  return {
    invoices: [],
    loading: false,
    error: null,
    filter: 'all',
    acting: {},
    async load() {
      set({ loading: true, error: null });
      try {
        set({ invoices: await api.reviewInvoices(), loading: false });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    setFilter: (filter) => set({ filter }),
    confirmPayment: (id) => resolve(id, api.confirmPayment),
    rejectPayment: (id) => resolve(id, api.rejectPayment),
  };
});

export function visibleInvoices(invoices: ReviewInvoice[], filter: StatusFilter): ReviewInvoice[] {
  return filter === 'all' ? invoices : invoices.filter((i) => i.status === filter);
}
