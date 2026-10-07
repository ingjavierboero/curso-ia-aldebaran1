import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { arcaAccessTickets } from '../db/schema.js';
import { signCms } from './cms.js';
import { WSAA_URL } from './endpoints.js';
import { ArcaError } from './errors.js';
import { type SoapOptions, escapeXml, parseXml, postSoap } from './soap.js';

export interface AccessTicket {
  token: string;
  sign: string;
  expiresAt: Date;
}

export interface WsaaDeps extends SoapOptions {
  certificatePem: string;
  privateKeyPem: string;
  now?: () => Date;
}

/** Se pide un ticket nuevo si al vigente le quedan menos de 10 minutos. */
const RENEW_MARGIN_MS = 10 * 60_000;

/** Fecha ISO con el offset de Argentina (-03:00, sin horario de verano), como la espera WSAA. */
export function toArgentinaIso(date: Date): string {
  return `${new Date(date.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
}

/** Pedido de acceso (TRA) para un servicio, válido entre 10 minutos antes y 10 minutos después de `now`. */
export function buildLoginTicketRequest(service: string, now: Date): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<loginTicketRequest version="1.0">',
    '<header>',
    `<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>`,
    `<generationTime>${toArgentinaIso(new Date(now.getTime() - 10 * 60_000))}</generationTime>`,
    `<expirationTime>${toArgentinaIso(new Date(now.getTime() + 10 * 60_000))}</expirationTime>`,
    '</header>',
    `<service>${escapeXml(service)}</service>`,
    '</loginTicketRequest>',
  ].join('');
}

/** Pide a WSAA un ticket de acceso nuevo para el servicio. */
export async function login(service: string, deps: WsaaDeps): Promise<AccessTicket> {
  const now = deps.now?.() ?? new Date();
  const cms = await signCms(buildLoginTicketRequest(service, now), deps.certificatePem, deps.privateKeyPem);
  const envelope =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
    `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>` +
    '</soapenv:Envelope>';

  let body: Record<string, any>;
  try {
    body = await postSoap('WSAA', WSAA_URL, '', envelope, deps);
  } catch (error) {
    if (error instanceof ArcaError && error.code === 'coe.alreadyAuthenticated') {
      throw new ArcaError(
        'ARCA WSAA ya emitió un ticket vigente que no está guardado; hay que esperar a que venza (hasta 12 h)',
        error.code,
        { cause: error },
      );
    }
    throw error;
  }

  // loginCmsReturn trae el loginTicketResponse como XML escapado dentro del sobre.
  const ticketXml = body.loginCmsResponse?.loginCmsReturn;
  const ticket = typeof ticketXml === 'string' ? parseXml(ticketXml).loginTicketResponse : undefined;
  const token = ticket?.credentials?.token;
  const sign = ticket?.credentials?.sign;
  const expiresAt = new Date(ticket?.header?.expirationTime);
  if (!token || !sign || Number.isNaN(expiresAt.getTime())) {
    throw new ArcaError('ARCA WSAA devolvió un ticket de acceso que no se puede leer');
  }
  return { token, sign, expiresAt };
}

/** Devuelve el ticket guardado si sigue vigente; si no, pide uno nuevo y lo guarda. */
export async function getAccessTicket(db: Db, service: string, deps: WsaaDeps): Promise<AccessTicket> {
  const now = deps.now?.() ?? new Date();
  const cached = db.select().from(arcaAccessTickets).where(eq(arcaAccessTickets.service, service)).get();
  if (cached && cached.expiresAt.getTime() - now.getTime() > RENEW_MARGIN_MS) {
    return { token: cached.token, sign: cached.sign, expiresAt: cached.expiresAt };
  }

  const ticket = await login(service, deps);
  db.insert(arcaAccessTickets)
    .values({ service, ...ticket })
    .onConflictDoUpdate({ target: arcaAccessTickets.service, set: { ...ticket, createdAt: now } })
    .run();
  return ticket;
}
