import type { Db } from '../db/index.js';
import { INVOICE_TYPE_C } from '../db/schema.js';
import { WSFE_URL } from './endpoints.js';
import { ArcaError } from './errors.js';
import { type SoapOptions, escapeXml, postSoap } from './soap.js';
import { type WsaaDeps, getAccessTicket } from './wsaa.js';

const NAMESPACE = 'http://ar.gov.afip.dif.FEV1/';
/** Concepto 2: servicios (las cuotas mensuales de los sistemas). */
const CONCEPT_SERVICES = 2;
/** Tipo de documento 80: CUIT. */
const DOC_TYPE_CUIT = 80;
/** Error de FECompConsultar cuando el comprobante no existe. */
const NOT_FOUND_CODE = '602';

export interface ArcaMessage {
  code: string;
  message: string;
}

export interface CaeRequest {
  pointOfSale: number;
  number: number;
  /** Fechas en formato YYYY-MM-DD. */
  issueDate: string;
  serviceFrom: string;
  serviceTo: string;
  paymentDueDate: string;
  customerCuit: string;
  /** Condición frente al IVA del receptor, según la tabla de ARCA (FEParamGetCondicionIvaReceptor). */
  recipientVatConditionId: number;
  totalCents: number;
}

export interface CaeResult {
  cae: string;
  /** YYYY-MM-DD */
  caeExpiresAt: string;
  /** Observaciones de ARCA en una factura aprobada (no impiden la emisión). */
  observations: ArcaMessage[];
}

export interface IssuedInvoice {
  pointOfSale: number;
  number: number;
  customerCuit: string;
  totalCents: number;
  issueDate: string;
  serviceFrom: string | null;
  serviceTo: string | null;
  cae: string;
  caeExpiresAt: string;
}

export interface ArcaClient {
  lastAuthorizedNumber(pointOfSale: number): Promise<number>;
  requestCae(request: CaeRequest): Promise<CaeResult>;
  findInvoice(pointOfSale: number, number: number): Promise<IssuedInvoice | null>;
}

export interface ArcaClientDeps extends WsaaDeps, SoapOptions {
  db: Db;
  /** CUIT del emisor (ARCA_CUIT). */
  cuit: string;
}

// --- Conversión de formatos ---

/** 150000 centavos → "1500.00" */
export function centsToAmount(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "1500", "1500.5" o "1500.50" → centavos, sin pasar por punto flotante. */
export function amountToCents(amount: string): number {
  const [pesos = '0', decimals = ''] = amount.trim().split('.');
  return Number(pesos) * 100 + Number(decimals.padEnd(2, '0').slice(0, 2));
}

/** "2026-10-15" → "20261015" */
export const toArcaDate = (date: string) => date.replaceAll('-', '');
/** "20261015" → "2026-10-15" */
export const fromArcaDate = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

const toArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function messages(container: any, key: 'Err' | 'Obs'): ArcaMessage[] {
  return toArray(container?.[key]).map((m: any) => ({ code: String(m.Code), message: String(m.Msg ?? '') }));
}

const describe = (list: ArcaMessage[]) => list.map((m) => `[${m.code}] ${m.message}`).join('; ');

function throwOnErrors(operation: string, result: any): void {
  const errors = messages(result?.Errors, 'Err');
  if (errors.length > 0) {
    throw new ArcaError(`ARCA WSFEv1 ${operation}: ${describe(errors)}`, errors[0]!.code);
  }
}

// --- Cliente ---

export function createArcaClient(deps: ArcaClientDeps): ArcaClient {
  const call = async (operation: string, inner: string) => {
    const { token, sign } = await getAccessTicket(deps.db, 'wsfe', deps);
    const auth = `<ar:Auth><ar:Token>${escapeXml(token)}</ar:Token><ar:Sign>${escapeXml(sign)}</ar:Sign><ar:Cuit>${deps.cuit}</ar:Cuit></ar:Auth>`;
    const envelope =
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NAMESPACE}">` +
      `<soap:Body><ar:${operation}>${auth}${inner}</ar:${operation}></soap:Body></soap:Envelope>`;
    const body = await postSoap('WSFEv1', WSFE_URL, `${NAMESPACE}${operation}`, envelope, deps);
    const result = body[`${operation}Response`]?.[`${operation}Result`];
    if (!result) throw new ArcaError(`ARCA WSFEv1 ${operation} devolvió una respuesta que no se puede leer`);
    return result;
  };

  return {
    async lastAuthorizedNumber(pointOfSale) {
      const result = await call(
        'FECompUltimoAutorizado',
        `<ar:PtoVta>${pointOfSale}</ar:PtoVta><ar:CbteTipo>${INVOICE_TYPE_C}</ar:CbteTipo>`,
      );
      throwOnErrors('FECompUltimoAutorizado', result);
      const number = Number(result.CbteNro);
      if (!Number.isInteger(number)) throw new ArcaError('ARCA WSFEv1 devolvió un número de comprobante inválido');
      return number;
    },

    async requestCae(request) {
      const total = centsToAmount(request.totalCents);
      // El orden de los campos es el de la secuencia del WSDL (FEDetRequest).
      const detail = [
        `<ar:Concepto>${CONCEPT_SERVICES}</ar:Concepto>`,
        `<ar:DocTipo>${DOC_TYPE_CUIT}</ar:DocTipo>`,
        `<ar:DocNro>${request.customerCuit}</ar:DocNro>`,
        `<ar:CbteDesde>${request.number}</ar:CbteDesde>`,
        `<ar:CbteHasta>${request.number}</ar:CbteHasta>`,
        `<ar:CbteFch>${toArcaDate(request.issueDate)}</ar:CbteFch>`,
        `<ar:ImpTotal>${total}</ar:ImpTotal>`,
        '<ar:ImpTotConc>0</ar:ImpTotConc>',
        // Factura C: todo el importe es neto y no se discrimina IVA.
        `<ar:ImpNeto>${total}</ar:ImpNeto>`,
        '<ar:ImpOpEx>0</ar:ImpOpEx>',
        '<ar:ImpTrib>0</ar:ImpTrib>',
        '<ar:ImpIVA>0</ar:ImpIVA>',
        `<ar:FchServDesde>${toArcaDate(request.serviceFrom)}</ar:FchServDesde>`,
        `<ar:FchServHasta>${toArcaDate(request.serviceTo)}</ar:FchServHasta>`,
        `<ar:FchVtoPago>${toArcaDate(request.paymentDueDate)}</ar:FchVtoPago>`,
        '<ar:MonId>PES</ar:MonId>',
        '<ar:MonCotiz>1</ar:MonCotiz>',
        `<ar:CondicionIVAReceptorId>${request.recipientVatConditionId}</ar:CondicionIVAReceptorId>`,
      ].join('');
      const result = await call(
        'FECAESolicitar',
        '<ar:FeCAEReq><ar:FeCabReq>' +
          `<ar:CantReg>1</ar:CantReg><ar:PtoVta>${request.pointOfSale}</ar:PtoVta><ar:CbteTipo>${INVOICE_TYPE_C}</ar:CbteTipo>` +
          `</ar:FeCabReq><ar:FeDetReq><ar:FECAEDetRequest>${detail}</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`,
      );

      const detailResponse = toArray(result.FeDetResp?.FECAEDetResponse)[0] as any;
      const observations = messages(detailResponse?.Observaciones, 'Obs');
      if (detailResponse?.Resultado === 'A' && detailResponse.CAE) {
        return { cae: String(detailResponse.CAE), caeExpiresAt: fromArcaDate(String(detailResponse.CAEFchVto)), observations };
      }
      // Rechazada: los motivos vienen en Errors (pedido inválido) o en Observaciones (comprobante rechazado).
      throwOnErrors('FECAESolicitar', result);
      if (observations.length > 0) {
        throw new ArcaError(`ARCA WSFEv1 rechazó la factura: ${describe(observations)}`, observations[0]!.code);
      }
      throw new ArcaError('ARCA WSFEv1 rechazó la factura sin informar el motivo');
    },

    async findInvoice(pointOfSale, number) {
      const result = await call(
        'FECompConsultar',
        `<ar:FeCompConsReq><ar:CbteTipo>${INVOICE_TYPE_C}</ar:CbteTipo><ar:CbteNro>${number}</ar:CbteNro>` +
          `<ar:PtoVta>${pointOfSale}</ar:PtoVta></ar:FeCompConsReq>`,
      );
      if (messages(result?.Errors, 'Err').some((e) => e.code === NOT_FOUND_CODE)) return null;
      throwOnErrors('FECompConsultar', result);

      const r = result.ResultGet;
      return {
        pointOfSale: Number(r.PtoVta),
        number: Number(r.CbteDesde),
        customerCuit: String(r.DocNro),
        totalCents: amountToCents(String(r.ImpTotal)),
        issueDate: fromArcaDate(String(r.CbteFch)),
        serviceFrom: r.FchServDesde ? fromArcaDate(String(r.FchServDesde)) : null,
        serviceTo: r.FchServHasta ? fromArcaDate(String(r.FchServHasta)) : null,
        cae: String(r.CodAutorizacion),
        caeExpiresAt: fromArcaDate(String(r.FchVto)),
      };
    },
  };
}
