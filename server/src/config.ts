import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Zona horaria que rige todas las fechas y horarios del sistema (RNF-12). */
export const TIMEZONE = 'America/Argentina/Buenos_Aires';

/** Raíz del monorepo: las rutas relativas del .env se resuelven desde acá, se corra desde donde se corra. */
export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

export const DEFAULT_DATABASE_PATH = './data/aldebaran.db';

/** Resuelve una ruta del .env: si es relativa, desde la raíz del monorepo. */
export function resolveFromRoot(path: string, rootDir = ROOT_DIR): string {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

/** Carga el .env de la raíz del monorepo, si existe. No pisa variables ya definidas. */
export function loadEnvFile(rootDir = ROOT_DIR): void {
  const path = resolve(rootDir, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

export interface Config {
  port: number;
  databasePath: string;
  anthropicApiKey: string;
  gmail: {
    user: string;
    appPassword: string;
  };
  /** Solo desarrollo: si está definida, todos los emails salientes van a esta casilla. */
  emailRedirectTo: string | null;
  arca: {
    cuit: string;
    certPath: string;
    keyPath: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuración inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const REQUIRED = [
  'ANTHROPIC_API_KEY',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'ARCA_CUIT',
  'ARCA_CERT_PATH',
  'ARCA_KEY_PATH',
] as const;

/**
 * Arma la configuración a partir de las variables de entorno (RNF-08, RNF-11).
 * Las credenciales nunca tienen valor por defecto: si falta alguna, falla.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = ROOT_DIR): Config {
  const problems: string[] = [];
  const value = (name: string) => env[name]?.trim() ?? '';

  for (const name of REQUIRED) {
    if (!value(name)) problems.push(`falta la variable ${name}`);
  }

  const cuit = value('ARCA_CUIT');
  if (cuit && !/^\d{11}$/.test(cuit)) {
    problems.push('ARCA_CUIT debe tener 11 dígitos, sin guiones');
  }

  const rawPort = value('PORT') || '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT inválido: "${rawPort}"`);
  }

  const redirect = value('EMAIL_REDIRECT_TO');
  if (redirect && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(redirect)) {
    problems.push(`EMAIL_REDIRECT_TO no es un email válido: "${redirect}"`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    databasePath: resolveFromRoot(value('DATABASE_PATH') || DEFAULT_DATABASE_PATH, rootDir),
    anthropicApiKey: value('ANTHROPIC_API_KEY'),
    gmail: {
      user: value('GMAIL_USER'),
      appPassword: value('GMAIL_APP_PASSWORD'),
    },
    emailRedirectTo: redirect || null,
    arca: {
      cuit,
      certPath: resolveFromRoot(value('ARCA_CERT_PATH'), rootDir),
      keyPath: resolveFromRoot(value('ARCA_KEY_PATH'), rootDir),
    },
  };
}
