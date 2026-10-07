import { describe, expect, it } from 'vitest';
import { formatArs, formatCuit, formatDate, formatDateTime, formatInvoiceNumber, formatPeriod, formatSize } from '../src/format';

describe('formatos', () => {
  it('formatea importes, fechas y números como en el PDF', () => {
    expect(formatArs(1_500_050)).toBe('$ 15.000,50');
    expect(formatArs(5)).toBe('$ 0,05');
    expect(formatPeriod('2026-10')).toBe('Octubre 2026');
    expect(formatDate('2026-10-31')).toBe('31/10/2026');
    expect(formatInvoiceNumber(1, 10)).toBe('00001-00000010');
    expect(formatCuit('30711111111')).toBe('30-71111111-1');
    expect(formatSize(20)).toBe('20 B');
    expect(formatSize(150_000)).toBe('146 KB');
    expect(formatSize(2_500_000)).toBe('2,4 MB');
  });

  it('muestra fecha y hora en Argentina', () => {
    expect(formatDateTime('2026-10-20T15:00:00.000Z')).toBe('20/10/2026 12:00');
  });
});
