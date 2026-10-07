import { describe, expect, it } from 'vitest';
import {
  type ClientInvoice,
  type ProcessingResult,
  REVIEW_REASONS,
  decidePayment,
} from '../../src/payments/rules.js';

const CUIT = '30711111118';

const invoice = (id: number, period: string, totalCents: number, status: ClientInvoice['status'] = 'pending_payment') =>
  ({ id, period, totalCents, status }) satisfies ClientInvoice;

const si = (amountCents: number | null, cuit: string | null = CUIT): ProcessingResult => ({
  kind: 'classified',
  classification: 'si',
  cuit,
  amountCents,
});
const dudoso: ProcessingResult = { kind: 'classified', classification: 'dudoso', cuit: null, amountCents: null };
const no: ProcessingResult = { kind: 'classified', classification: 'no', cuit: null, amountCents: null };
const error: ProcessingResult = { kind: 'error' };

describe('decidePayment', () => {
  describe('sin cambios de estado', () => {
    it('AC-72: clasificación "no" no cambia ninguna factura, aunque haya deuda', () => {
      expect(decidePayment(no, CUIT, [invoice(1, '2026-09', 100)])).toEqual({ action: 'none', rule: 'RF-62' });
    });

    it('AC-73: cliente sin deuda vigente que manda un comprobante "si"', () => {
      const invoices = [invoice(1, '2026-08', 100, 'paid'), invoice(2, '2026-09', 100, 'payment_received')];

      expect(decidePayment(si(100), CUIT, invoices)).toEqual({ action: 'none', rule: 'RF-63' });
    });

    it('AC-74: cliente sin deuda vigente que manda un email "dudoso"', () => {
      expect(decidePayment(dudoso, CUIT, [])).toEqual({ action: 'none', rule: 'RF-63' });
    });

    it('RF-63: procesamiento erróneo de un cliente sin deuda vigente', () => {
      expect(decidePayment(error, CUIT, [invoice(1, '2026-09', 100, 'paid')])).toEqual({
        action: 'none',
        rule: 'RF-63',
      });
    });
  });

  describe('cliente en revisión (RF-64)', () => {
    const invoices = [invoice(1, '2026-08', 500, 'manual_review'), invoice(2, '2026-09', 300)];

    it('AC-75: un "si" con monto exacto de la Pendiente no se valida y todas pasan a Revisión manual', () => {
      // El motivo se aplica a todas, incluida la que ya estaba en revisión (reemplaza el anterior).
      expect(decidePayment(si(300), CUIT, invoices)).toEqual({
        action: 'manual_review',
        rule: 'RF-64',
        reason: REVIEW_REASONS.pendingReview,
        invoiceIds: [1, 2],
      });
    });

    it('AC-76: un procesamiento erróneo también pasa todas a Revisión manual pendiente', () => {
      expect(decidePayment(error, CUIT, invoices)).toMatchObject({
        rule: 'RF-64',
        reason: 'revisión manual pendiente',
        invoiceIds: [1, 2],
      });
    });

    it('un "dudoso" también pasa todas a Revisión manual pendiente', () => {
      expect(decidePayment(dudoso, CUIT, invoices)).toMatchObject({ rule: 'RF-64' });
    });

    it('no incluye facturas que no están adeudadas', () => {
      const withPaid = [...invoices, invoice(3, '2026-07', 300, 'paid'), invoice(4, '2026-06', 300, 'payment_received')];

      expect(decidePayment(si(300), CUIT, withPaid)).toMatchObject({ invoiceIds: [1, 2] });
    });
  });

  describe('cliente con deuda vigente que no está en revisión', () => {
    const owed = [invoice(1, '2026-08', 500), invoice(2, '2026-09', 300)];

    it('AC-78: procesamiento erróneo → "no se pudo procesar el comprobante"', () => {
      expect(decidePayment(error, CUIT, owed)).toEqual({
        action: 'manual_review',
        rule: 'RF-65',
        reason: 'no se pudo procesar el comprobante',
        invoiceIds: [1, 2],
      });
    });

    it('AC-79: clasificación "dudoso" → "clasificación dudosa"', () => {
      expect(decidePayment(dudoso, CUIT, owed)).toMatchObject({
        rule: 'RF-66',
        reason: 'clasificación dudosa',
        invoiceIds: [1, 2],
      });
    });

    it('AC-80: "si" sin CUIT → "no se pudieron extraer el CUIT o el monto"', () => {
      expect(decidePayment(si(300, null), CUIT, owed)).toMatchObject({
        rule: 'RF-67',
        reason: 'no se pudieron extraer el CUIT o el monto',
      });
    });

    it('AC-81: "si" con CUIT pero sin monto → "no se pudieron extraer el CUIT o el monto"', () => {
      expect(decidePayment(si(null), CUIT, owed)).toMatchObject({ rule: 'RF-67' });
    });

    it('trata un CUIT vacío como no extraído', () => {
      expect(decidePayment(si(300, '  '), CUIT, owed)).toMatchObject({ rule: 'RF-67' });
    });

    it('AC-82: "si" con otro CUIT → "CUIT no coincide"', () => {
      expect(decidePayment(si(300, '20222222223'), CUIT, owed)).toMatchObject({
        action: 'manual_review',
        rule: 'RF-68',
        reason: 'CUIT no coincide',
        invoiceIds: [1, 2],
      });
    });

    it('AC-31: después de cambiar el CUIT del cliente, el CUIT anterior no coincide', () => {
      expect(decidePayment(si(300, CUIT), '30799999990', owed)).toMatchObject({ rule: 'RF-68' });
    });

    it('AC-150: compara el CUIT solo por sus dígitos', () => {
      expect(decidePayment(si(300, '30-71111111-8'), CUIT, owed)).toMatchObject({
        action: 'payment_received',
        invoiceIds: [2],
      });
    });
  });

  describe('comprobante validable', () => {
    it('AC-83: una sola factura y monto exacto → Pago recibido', () => {
      expect(decidePayment(si(15_000_00), CUIT, [invoice(1, '2026-09', 15_000_00)])).toEqual({
        action: 'payment_received',
        rule: 'RF-69',
        invoiceIds: [1],
      });
    });

    it('AC-84: A + C → pasan A y C, B sigue Pendiente', () => {
      const invoices = [invoice(1, '2026-07', 100_00), invoice(2, '2026-08', 250_00), invoice(3, '2026-09', 400_00)];

      expect(decidePayment(si(500_00), CUIT, invoices)).toEqual({
        action: 'payment_received',
        rule: 'RF-69',
        invoiceIds: [1, 3],
      });
    });

    it('AC-85: la suma de todas → pasan todas', () => {
      const invoices = [invoice(1, '2026-07', 100_00), invoice(2, '2026-08', 250_00), invoice(3, '2026-09', 400_00)];

      expect(decidePayment(si(750_00), CUIT, invoices)).toMatchObject({
        action: 'payment_received',
        invoiceIds: [1, 2, 3],
      });
    });

    it('AC-86: dos facturas del mismo monto → pasa la más antigua', () => {
      const invoices = [invoice(2, '2026-09', 300_00), invoice(1, '2026-08', 300_00)];

      expect(decidePayment(si(300_00), CUIT, invoices)).toEqual({
        action: 'payment_received',
        rule: 'RF-70',
        invoiceIds: [1],
      });
    });

    it('AC-87: enero + abril y febrero + marzo suman lo mismo → pasan enero y abril', () => {
      const invoices = [
        invoice(1, '2026-01', 100_00),
        invoice(2, '2026-02', 200_00),
        invoice(3, '2026-03', 300_00),
        invoice(4, '2026-04', 400_00),
      ];

      expect(decidePayment(si(500_00), CUIT, invoices)).toEqual({
        action: 'payment_received',
        rule: 'RF-70',
        invoiceIds: [1, 4],
      });
    });

    it('AC-88: dos facturas del mismo período y monto → "no se pudo determinar qué facturas cancela el pago"', () => {
      const invoices = [invoice(1, '2026-09', 300_00), invoice(2, '2026-09', 300_00)];

      expect(decidePayment(si(300_00), CUIT, invoices)).toEqual({
        action: 'manual_review',
        rule: 'RF-71',
        reason: 'no se pudo determinar qué facturas cancela el pago',
        invoiceIds: [1, 2],
      });
    });

    it('AC-151: una coincidencia que se queda sin facturas para comparar → no hay combinación más antigua', () => {
      const invoices = [invoice(1, '2026-01', 300_00), invoice(2, '2026-01', 100_00), invoice(3, '2026-02', 200_00)];

      expect(decidePayment(si(300_00), CUIT, invoices)).toMatchObject({
        rule: 'RF-71',
        reason: 'no se pudo determinar qué facturas cancela el pago',
        invoiceIds: [1, 2, 3],
      });
    });

    it('AC-89: pago parcial → "monto no coincide"', () => {
      const invoices = [invoice(1, '2026-08', 300_00), invoice(2, '2026-09', 300_00)];

      expect(decidePayment(si(150_00), CUIT, invoices)).toEqual({
        action: 'manual_review',
        rule: 'RF-72',
        reason: 'monto no coincide',
        invoiceIds: [1, 2],
      });
    });

    it('AC-149: un centavo de diferencia → "monto no coincide"', () => {
      expect(decidePayment(si(15_000_01), CUIT, [invoice(1, '2026-09', 15_000_00)])).toMatchObject({
        rule: 'RF-72',
        reason: 'monto no coincide',
      });
    });

    it('AC-152: un monto de $0 → "monto no coincide"', () => {
      expect(decidePayment(si(0), CUIT, [invoice(1, '2026-09', 15_000_00)])).toMatchObject({
        rule: 'RF-72',
        reason: 'monto no coincide',
      });
    });

    it('AC-96: una factura devuelta a Pendiente de pago se vuelve a validar', () => {
      const invoices = [invoice(1, '2026-08', 300_00, 'paid'), invoice(2, '2026-09', 300_00)];

      expect(decidePayment(si(300_00), CUIT, invoices)).toEqual({
        action: 'payment_received',
        rule: 'RF-69',
        invoiceIds: [2],
      });
    });

    it('ignora las facturas en Pago recibido al buscar coincidencias', () => {
      const invoices = [invoice(1, '2026-08', 300_00, 'payment_received'), invoice(2, '2026-09', 300_00)];

      expect(decidePayment(si(600_00), CUIT, invoices)).toMatchObject({ rule: 'RF-72' });
    });
  });
});
