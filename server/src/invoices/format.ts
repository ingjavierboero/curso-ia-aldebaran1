import { VAT_CONDITIONS, type VatConditionId } from '../db/schema.js';

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** 1500050 → "$ 15.000,50" (sin depender de los datos de locale de Node). */
export function formatArs(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const pesos = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}$ ${pesos},${String(abs % 100).padStart(2, '0')}`;
}

/** 12000 → "USD 120,00" */
export function formatUsd(cents: number): string {
  return formatArs(cents).replace('$', 'USD');
}

/** "2026-10-31" → "31/10/2026" */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** "2026-10" → "octubre de 2026" */
export function formatPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return `${MONTHS[month - 1]} de ${year}`;
}

/** (1, 10) → "00001-00000010" */
export function formatInvoiceNumber(pointOfSale: number, number: number): string {
  return `${String(pointOfSale).padStart(5, '0')}-${String(number).padStart(8, '0')}`;
}

/** "30711111111" → "30-71111111-1" */
export function formatCuit(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

export function vatConditionName(id: number): string {
  return VAT_CONDITIONS[id as VatConditionId] ?? `Condición ${id}`;
}
