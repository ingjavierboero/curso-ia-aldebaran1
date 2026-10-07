import { DEFAULT_DATABASE_PATH, loadEnvFile, resolveFromRoot } from '../config.js';
import { openDb } from './index.js';
import { seed } from './seed.js';

// No usa loadConfig: cargar datos de ejemplo no necesita las credenciales.
loadEnvFile();

const path = resolveFromRoot(process.env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH);
const messages = {
  created: `Datos de ejemplo cargados en ${path}`,
  updated: `${path} ya tenía clientes: se actualizaron el CUIT y la condición de IVA de los clientes de ejemplo`,
  unchanged: `${path} ya tiene clientes: no se cargó nada`,
};
console.log(messages[seed(openDb(path))]);
