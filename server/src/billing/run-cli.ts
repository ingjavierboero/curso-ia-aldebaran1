import { eq } from 'drizzle-orm';
import { createArcaClientFromConfig } from '../arca/index.js';
import { loadConfig, loadEnvFile } from '../config.js';
import { openDb } from '../db/index.js';
import { clients, invoiceItems } from '../db/schema.js';
import { runBilling } from './run.js';

// Ejecuta a mano el proceso de facturación del período corriente contra ARCA homologación,
// con la configuración de la base (punto de venta, reintentos). Mientras no haya scheduler,
// es la forma de probarlo de punta a punta.
loadEnvFile();
const config = loadConfig();
const db = openDb(config.databasePath);

const pesos = (cents: number) =>
  (cents / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });

const summary = await runBilling({ db, arca: createArcaClientFromConfig(db, config) });
const nameOf = (id: number) => db.select().from(clients).where(eq(clients.id, id)).get()?.businessName ?? `#${id}`;

console.log(`Facturación del período ${summary.period}`);
for (const invoice of summary.generated) {
  console.log(
    `  ✔ ${invoice.clientBusinessName}: Factura C ${String(invoice.pointOfSale).padStart(5, '0')}-${String(invoice.number).padStart(8, '0')}` +
      ` por ${pesos(invoice.totalCents)}, CAE ${invoice.cae} (vence ${invoice.caeExpiresAt})`,
  );
  for (const item of db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoice.id)).all()) {
    const original = item.currency === 'USD' ? ` (USD ${(item.unitPriceCents / 100).toFixed(2)})` : '';
    console.log(`      ${item.description}: ${pesos(item.amountCents)}${original}`);
  }
}
for (const clientId of summary.alreadyInvoiced) console.log(`  = ${nameOf(clientId)}: ya tenía la factura del período`);
for (const failure of summary.failed) {
  console.log(`  ✘ ${nameOf(failure.clientId)}: ${failure.error} (${failure.attempts} intentos)`);
}
if (summary.failed.length > 0) process.exitCode = 1;
