import { createApp } from './app.js';
import { ConfigError, TIMEZONE, loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db/index.js';

process.env.TZ = TIMEZONE;

loadEnvFile();

try {
  const config = loadConfig();
  openDb(config.databasePath);
  createApp().listen(config.port, () => {
    console.log(`Aldebaran server escuchando en http://localhost:${config.port}`);
  });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
