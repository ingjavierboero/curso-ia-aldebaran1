import { eq } from 'drizzle-orm';
import { clientSystems, clients, systems } from './schema.js';
import type { Db } from './index.js';

/** Clientes de ejemplo: CUIT con dígito verificador válido (ARCA lo valida) y condición de IVA. */
const EXAMPLE_CLIENTS = [
  { businessName: 'Panadería Los Andes SRL', cuit: '30711111111', email: 'pagos@losandes.test', vatConditionId: 1 },
  { businessName: 'Estudio Contable Ruiz', cuit: '20222222223', email: 'admin@estudioruiz.test', vatConditionId: 6 },
  { businessName: 'Ferretería El Tornillo', cuit: '30733333339', email: 'cobranzas@eltornillo.test', vatConditionId: 1 },
  {
    businessName: 'Kiosco Cerrado SA',
    cuit: '30744444442',
    email: 'info@kioscocerrado.test',
    vatConditionId: 4,
    status: 'inactive',
  },
] as const;

export type SeedResult = 'created' | 'updated' | 'unchanged';

/**
 * Carga clientes y sistemas de ejemplo mientras no haya ABMs. Si ya hay clientes, solo
 * actualiza el CUIT y la condición de IVA de los clientes de ejemplo (identificados por su
 * email) que los tengan desactualizados; no toca ningún otro cliente.
 */
export function seed(db: Db): SeedResult {
  if (db.select({ id: clients.id }).from(clients).limit(1).all().length > 0) return updateExamples(db);

  db.transaction((tx) => {
    const [crm, erp, soporte] = tx
      .insert(systems)
      .values([
        { name: 'CRM', priceCents: 15_000_00, currency: 'ARS' },
        { name: 'ERP', priceCents: 120_00, currency: 'USD' },
        { name: 'Soporte', priceCents: 8_500_00, currency: 'ARS', status: 'inactive' },
      ])
      .returning()
      .all();

    const [pesos, dolares, sinSistemas, inactivo] = tx.insert(clients).values([...EXAMPLE_CLIENTS]).returning().all();

    tx.insert(clientSystems)
      .values([
        { clientId: pesos!.id, systemId: crm!.id },
        { clientId: dolares!.id, systemId: crm!.id },
        { clientId: dolares!.id, systemId: erp!.id },
        { clientId: sinSistemas!.id, systemId: soporte!.id },
        { clientId: inactivo!.id, systemId: crm!.id },
      ])
      .run();
  });
  return 'created';
}

function updateExamples(db: Db): SeedResult {
  let updated = false;
  for (const example of EXAMPLE_CLIENTS) {
    const current = db.select().from(clients).where(eq(clients.email, example.email)).get();
    if (current && (current.cuit !== example.cuit || current.vatConditionId !== example.vatConditionId)) {
      db.update(clients)
        .set({ cuit: example.cuit, vatConditionId: example.vatConditionId })
        .where(eq(clients.id, current.id))
        .run();
      updated = true;
    }
  }
  return updated ? 'updated' : 'unchanged';
}
