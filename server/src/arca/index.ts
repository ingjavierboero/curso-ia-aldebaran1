import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ArcaError } from './errors.js';
import type { SoapOptions } from './soap.js';
import { type ArcaClient, createArcaClient } from './wsfe.js';

export { ArcaError } from './errors.js';
export type { ArcaClient, CaeRequest, CaeResult, IssuedInvoice } from './wsfe.js';

function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ArcaError(`no se pudo leer ${what} de ARCA en ${path}: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
}

/** Arma el cliente de ARCA con el CUIT, el certificado y la clave de las variables de entorno (RNF-11). */
export function createArcaClientFromConfig(db: Db, config: Config, options: SoapOptions = {}): ArcaClient {
  return createArcaClient({
    db,
    cuit: config.arca.cuit,
    certificatePem: readPem(config.arca.certPath, 'el certificado'),
    privateKeyPem: readPem(config.arca.keyPath, 'la clave privada'),
    ...options,
  });
}
