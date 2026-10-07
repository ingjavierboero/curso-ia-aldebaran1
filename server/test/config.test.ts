import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ROOT_DIR, loadConfig, resolveFromRoot } from '../src/config.js';

const validEnv = {
  ANTHROPIC_API_KEY: 'sk-test',
  GMAIL_USER: 'facturacion@example.com',
  GMAIL_APP_PASSWORD: 'app-pass',
  ARCA_CUIT: '20123456789',
  ARCA_CERT_PATH: '/certs/test.crt',
  ARCA_KEY_PATH: '/certs/test.key',
};

describe('loadConfig', () => {
  it('lee las credenciales de las variables de entorno', () => {
    const config = loadConfig(validEnv);

    expect(config.anthropicApiKey).toBe('sk-test');
    expect(config.gmail).toEqual({ user: 'facturacion@example.com', appPassword: 'app-pass' });
    expect(config.arca).toEqual({
      cuit: '20123456789',
      certPath: '/certs/test.crt',
      keyPath: '/certs/test.key',
    });
  });

  it('usa valores por defecto para puerto y base de datos', () => {
    const config = loadConfig(validEnv);

    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe(join(ROOT_DIR, 'data', 'aldebaran.db'));
  });

  it('resuelve las rutas relativas desde la raíz del monorepo, no desde donde se corre', () => {
    const config = loadConfig(
      { ...validEnv, ARCA_CERT_PATH: './certs/test.crt', ARCA_KEY_PATH: 'certs/test.key', DATABASE_PATH: './data/x.db' },
      '/repo',
    );

    expect(config.arca.certPath).toBe('/repo/certs/test.crt');
    expect(config.arca.keyPath).toBe('/repo/certs/test.key');
    expect(config.databasePath).toBe('/repo/data/x.db');
  });

  it('respeta las rutas absolutas', () => {
    expect(loadConfig(validEnv, '/repo').arca.certPath).toBe('/certs/test.crt');
  });

  it('falla listando todas las variables obligatorias que faltan', () => {
    try {
      loadConfig({ ARCA_CUIT: '20123456789' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'falta la variable ANTHROPIC_API_KEY',
        'falta la variable GMAIL_USER',
        'falta la variable GMAIL_APP_PASSWORD',
        'falta la variable ARCA_CERT_PATH',
        'falta la variable ARCA_KEY_PATH',
      ]);
    }
  });

  it('trata una variable con solo espacios como faltante', () => {
    expect(() => loadConfig({ ...validEnv, GMAIL_APP_PASSWORD: '   ' })).toThrow(
      'falta la variable GMAIL_APP_PASSWORD',
    );
  });

  it('rechaza un CUIT que no tiene 11 dígitos', () => {
    expect(() => loadConfig({ ...validEnv, ARCA_CUIT: '20-12345678-9' })).toThrow(
      'ARCA_CUIT debe tener 11 dígitos',
    );
  });

  it('la raíz del monorepo es la carpeta que contiene server/', () => {
    expect(existsSync(join(ROOT_DIR, 'server', 'package.json'))).toBe(true);
    expect(resolveFromRoot('certs/a.crt')).toBe(join(ROOT_DIR, 'certs', 'a.crt'));
  });

  it('rechaza un puerto inválido', () => {
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrow('PORT inválido');
  });
});
