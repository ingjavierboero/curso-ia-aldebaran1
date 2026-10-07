import { loadConfig, loadEnvFile } from '../config.js';
import { openDb } from '../db/index.js';
import { settings } from '../db/schema.js';
import { createArcaClientFromConfig } from './index.js';

// Prueba la conexión con ARCA homologación: login en WSAA y consulta del último número de
// Factura C en el punto de venta configurado. No emite ningún comprobante.
loadEnvFile();

const config = loadConfig();
const db = openDb(config.databasePath);
const { pointOfSale } = db.select().from(settings).get()!;

try {
  const last = await createArcaClientFromConfig(db, config).lastAuthorizedNumber(pointOfSale);
  console.log(`ARCA homologación OK — CUIT ${config.arca.cuit}, punto de venta ${pointOfSale}`);
  console.log(`Última Factura C autorizada: ${last} (la próxima sería la ${last + 1})`);
} catch (error) {
  console.error(`Falló la conexión con ARCA homologación: ${(error as Error).message}`);
  process.exitCode = 1;
}
