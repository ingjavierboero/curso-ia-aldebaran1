import { DEFAULT_DATABASE_PATH, loadEnvFile, resolveFromRoot } from '../config.js';
import { openDb } from './index.js';
import { seed } from './seed.js';

// No usa loadConfig: cargar datos de ejemplo no necesita las credenciales.
loadEnvFile();

const path = resolveFromRoot(process.env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH);
console.log(seed(openDb(path)) ? `Datos de ejemplo cargados en ${path}` : `${path} ya tiene clientes: no se cargó nada`);
