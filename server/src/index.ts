import { createApp } from './app.js';
import { ConfigError, TIMEZONE, loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db/index.js';
import { createJobs } from './jobs.js';
import { Scheduler } from './scheduler.js';

process.env.TZ = TIMEZONE;

loadEnvFile();

try {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  // Solo localhost: el login (RF-01) está fuera de esta etapa, así que la API no se expone a la red.
  const server = createApp({ db, issuerCuit: config.arca.cuit }).listen(config.port, '127.0.0.1', () => {
    console.log(`Aldebaran server escuchando en http://localhost:${config.port}`);
  });

  const scheduler = config.schedulerEnabled ? new Scheduler({ db, jobs: createJobs(db, config) }) : undefined;
  if (scheduler) scheduler.start();
  else console.log('Procesos automáticos apagados (SCHEDULER_ENABLED no es true)');

  // Apagado ordenado: deja terminar la facturación o la revisión de la casilla en curso.
  const shutdown = async () => {
    server.close();
    await scheduler?.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
