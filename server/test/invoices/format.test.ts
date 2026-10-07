import { describe, expect, it } from 'vitest';
import { formatArs, formatCuit, formatDate, formatInvoiceNumber, formatPeriod, formatUsd, vatConditionName } from '../../src/invoices/format.js';

describe('formatos', () => {
  it.each([
    [0, '$ 0,00'],
    [5, '$ 0,05'],
    [15_000_00, '$ 15.000,00'],
    [1_234_567_89, '$ 1.234.567,89'],
  ])('formatArs(%i) = %s', (cents, text) => {
    expect(formatArs(cents)).toBe(text);
  });

  it('formatea dólares, fechas, períodos, números y CUIT', () => {
    expect(formatUsd(120_00)).toBe('USD 120,00');
    expect(formatDate('2026-10-31')).toBe('31/10/2026');
    expect(formatPeriod('2026-01')).toBe('enero de 2026');
    expect(formatPeriod('2026-12')).toBe('diciembre de 2026');
    expect(formatInvoiceNumber(1, 10)).toBe('00001-00000010');
    expect(formatCuit('30711111111')).toBe('30-71111111-1');
    expect(vatConditionName(1)).toBe('IVA Responsable Inscripto');
  });
});
