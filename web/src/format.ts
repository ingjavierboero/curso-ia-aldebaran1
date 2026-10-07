const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 1500050 → "$ 15.000,50" */
export function formatArs(cents: number): string {
  const pesos = String(Math.trunc(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$ ${pesos},${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

/** "2026-10" → "Octubre 2026" */
export function formatPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const name = MONTHS[month - 1]!;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${year}`;
}

/** "2026-10-31" → "31/10/2026" */
export function formatDate(date: string): string {
  const [year, month, day] = date.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** Fecha y hora en Argentina: "20/10/2026 12:00". */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(iso))
    .replace(',', '');
}

export function formatInvoiceNumber(pointOfSale: number, number: number): string {
  return `${String(pointOfSale).padStart(5, '0')}-${String(number).padStart(8, '0')}`;
}

/** "30711111111" → "30-71111111-1" */
export function formatCuit(cuit: string): string {
  return cuit.length === 11 ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
