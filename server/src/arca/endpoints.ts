import { ArcaError } from './errors.js';

/**
 * Endpoints de ARCA. Solo homologación: el sistema nunca apunta a producción (AGENTS.md).
 * Los productivos son wsaa.afip.gov.ar y servicios1.afip.gov.ar; no deben aparecer acá.
 */
export const WSAA_URL = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
export const WSFE_URL = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

/** Una llamada a ARCA (WSAA y WSFEv1) se da por fallida a los 30 s (RNF-07). */
export const ARCA_TIMEOUT_MS = 30_000;

const HOMOLOGATION_HOSTS = new Set(['wsaahomo.afip.gov.ar', 'wswhomo.afip.gov.ar']);

/** Corta antes de enviar si una URL no es de homologación. */
export function assertHomologation(url: string): void {
  if (!HOMOLOGATION_HOSTS.has(new URL(url).hostname)) {
    throw new ArcaError(`Solo se permite el ambiente de homologación de ARCA, no ${url}`);
  }
}
