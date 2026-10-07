import { TIMEZONE } from '../config.js';

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha calendario en Argentina (RNF-12), formato YYYY-MM-DD. */
export function argentinaDate(at: Date): string {
  return dateFormat.format(at);
}

/** Período (mes facturado) de una fecha en Argentina, formato YYYY-MM. */
export function argentinaPeriod(at: Date): string {
  return argentinaDate(at).slice(0, 7);
}

export function lastDayOfPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

export interface InvoiceDates {
  issueDate: string;
  serviceFrom: string;
  serviceTo: string;
  paymentDueDate: string;
}

/**
 * Fechas fiscales de la factura de un período (RF-116, RF-117): emisión el día en que se
 * genera, servicio del 1 al último día del mes y vencimiento el último día del mes, o la
 * emisión si es posterior (ARCA no admite un vencimiento anterior a la emisión).
 */
export function invoiceDates(period: string, generatedAt: Date): InvoiceDates {
  const issueDate = argentinaDate(generatedAt);
  const serviceTo = lastDayOfPeriod(period);
  return {
    issueDate,
    serviceFrom: `${period}-01`,
    serviceTo,
    paymentDueDate: issueDate > serviceTo ? issueDate : serviceTo,
  };
}
