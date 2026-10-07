import { existsSync } from 'node:fs';
import { openDb } from './index.js';
import { seed } from './seed.js';

for (const path of ['../.env', '.env']) {
  if (existsSync(path)) process.loadEnvFile(path);
}

const path = process.env.DATABASE_PATH?.trim() || './data/aldebaran.db';
console.log(seed(openDb(path)) ? `Datos de ejemplo cargados en ${path}` : `${path} ya tiene clientes: no se cargó nada`);
