/** Zona horaria que rige todas las fechas y horarios del sistema (RNF-12). */
export const TIMEZONE = 'America/Argentina/Buenos_Aires';

export interface Config {
  port: number;
  databasePath: string;
  anthropicApiKey: string;
  gmail: {
    user: string;
    appPassword: string;
  };
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    databasePath: value('DATABASE_PATH') || './data/aldebaran.db',
    anthropicApiKey: value('ANTHROPIC_API_KEY'),
    gmail: {
      user: value('GMAIL_USER'),
      appPassword: value('GMAIL_APP_PASSWORD'),
    },
    arca: {
      cuit,
      certPath: value('ARCA_CERT_PATH'),
      keyPath: value('ARCA_KEY_PATH'),
    },
  };
}
