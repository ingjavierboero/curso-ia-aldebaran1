import { clientSystems, clients, systems } from './schema.js';
import type { Db } from './index.js';

/**
 * Carga clientes y sistemas de ejemplo mientras no haya ABMs.
 * Solo actúa si no hay clientes, así que se puede correr varias veces.
 */
export function seed(db: Db): boolean {
  if (db.select({ id: clients.id }).from(clients).limit(1).all().length > 0) return false;

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

    const [pesos, dolares, sinSistemas, inactivo] = tx
      .insert(clients)
      .values([
        { businessName: 'Panadería Los Andes SRL', cuit: '30711111118', email: 'pagos@losandes.test' },
        { businessName: 'Estudio Contable Ruiz', cuit: '20222222223', email: 'admin@estudioruiz.test' },
        { businessName: 'Ferretería El Tornillo', cuit: '30733333338', email: 'cobranzas@eltornillo.test' },
        {
          businessName: 'Kiosco Cerrado SA',
          cuit: '30744444448',
          email: 'info@kioscocerrado.test',
          status: 'inactive',
        },
      ])
      .returning()
      .all();

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
  return true;
}
