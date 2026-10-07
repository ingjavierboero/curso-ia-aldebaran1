import { describe, expect, it } from 'vitest';
import { argentinaDate, argentinaPeriod, invoiceDates, lastDayOfPeriod } from '../../src/billing/dates.js';

describe('fechas en hora de Argentina (RNF-12)', () => {
  it('el 31/10 a las 23:30 en Argentina ya es 1/11 en UTC, pero sigue siendo octubre', () => {
    const at = new Date('2026-11-01T02:30:00Z');

    expect(argentinaDate(at)).toBe('2026-10-31');
    expect(argentinaPeriod(at)).toBe('2026-10');
  });

  it.each([
    ['2026-02', '2026-02-28'],
    ['2028-02', '2028-02-29'],
    ['2026-04', '2026-04-30'],
    ['2026-12', '2026-12-31'],
  ])('último día de %s: %s', (period, last) => {
    expect(lastDayOfPeriod(period)).toBe(last);
  });
});

describe('invoiceDates', () => {
  it('AC-157: factura del 15/10 → servicio del 1 al 31/10 y vencimiento el 31/10', () => {
    expect(invoiceDates('2026-10', new Date('2026-10-15T14:00:00Z'))).toEqual({
      issueDate: '2026-10-15',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
      paymentDueDate: '2026-10-31',
    });
  });

  it('AC-158: factura de octubre generada el 03/11 → vence el día de emisión', () => {
    expect(invoiceDates('2026-10', new Date('2026-11-03T15:00:00Z'))).toEqual({
      issueDate: '2026-11-03',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
      paymentDueDate: '2026-11-03',
    });
  });

  it('generada el último día del mes vence ese mismo día', () => {
    expect(invoiceDates('2026-10', new Date('2026-10-31T20:00:00Z')).paymentDueDate).toBe('2026-10-31');
  });
});
