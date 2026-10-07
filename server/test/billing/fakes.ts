import type { ArcaClient, CaeRequest, IssuedInvoice } from '../../src/arca/index.js';
import { ArcaError } from '../../src/arca/index.js';
import { EmailError, type Mailer, type OutgoingEmail } from '../../src/email/mailer.js';
import type { Clock } from '../../src/retry.js';

/** Reloj simulado: `sleep` avanza el tiempo al instante y queda registrado. */
export function fakeClock(start: string) {
  let now = new Date(start).getTime();
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => new Date(now),
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return {
    clock,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * ARCA en memoria: numera por punto de venta y autoriza con un CAE ficticio.
 * `failures` hace fallar las próximas N llamadas a requestCae; `loseResponses` autoriza
 * pero simula que la respuesta se perdió (timeout).
 */
export function fakeArcaClient(clock?: Clock) {
  const issued = new Map<string, IssuedInvoice>();
  const requests: CaeRequest[] = [];
  const attemptTimes: Date[] = [];
  const state = { failures: 0, loseResponses: 0, failWith: 'ARCA WSFEv1 no respondió en 30 s' };

  const last = (pointOfSale: number) =>
    Math.max(0, ...[...issued.values()].filter((i) => i.pointOfSale === pointOfSale).map((i) => i.number));

  const client: ArcaClient = {
    async lastAuthorizedNumber(pointOfSale) {
      return last(pointOfSale);
    },
    async requestCae(request) {
      requests.push(request);
      if (clock) attemptTimes.push(clock.now());
      if (state.failures > 0) {
        state.failures -= 1;
        throw new ArcaError(state.failWith);
      }
      if (request.number !== last(request.pointOfSale) + 1) {
        throw new ArcaError('ARCA WSFEv1 rechazó la factura: [10016] número no correlativo', '10016');
      }
      const cae = `7641234567${String(request.number).padStart(4, '0')}`;
      issued.set(`${request.pointOfSale}-${request.number}`, {
        pointOfSale: request.pointOfSale,
        number: request.number,
        customerCuit: request.customerCuit,
        totalCents: request.totalCents,
        issueDate: request.issueDate,
        serviceFrom: request.serviceFrom,
        serviceTo: request.serviceTo,
        cae,
        caeExpiresAt: '2026-10-25',
      });
      if (state.loseResponses > 0) {
        state.loseResponses -= 1;
        throw new ArcaError('ARCA WSFEv1 no respondió en 30 s');
      }
      return { cae, caeExpiresAt: '2026-10-25', observations: [] };
    },
    async findInvoice(pointOfSale, number) {
      return issued.get(`${pointOfSale}-${number}`) ?? null;
    },
  };
  return { client, issued, requests, attemptTimes, state };
}

/** Emite en el ARCA simulado un comprobante que no es de este sistema (por ejemplo, de pruebas manuales). */
export function issueForeignInvoice(arca: ReturnType<typeof fakeArcaClient>, pointOfSale: number, number: number) {
  arca.issued.set(`${pointOfSale}-${number}`, {
    pointOfSale,
    number,
    customerCuit: '20999999995',
    totalCents: 1_00,
    issueDate: '2026-10-01',
    serviceFrom: '2026-10-01',
    serviceTo: '2026-10-31',
    cae: 'AJENO',
    caeExpiresAt: '2026-10-11',
  });
}

/** Mailer simulado: guarda los emails en vez de enviarlos. `failures` hace fallar los próximos N envíos. */
export function fakeMailer(clock?: Clock) {
  const sent: OutgoingEmail[] = [];
  const attemptTimes: Date[] = [];
  const state = { failures: 0, failWith: 'no se pudo enviar el email: 550 rechazado' };
  const mailer: Mailer = {
    async send(email) {
      if (clock) attemptTimes.push(clock.now());
      if (state.failures > 0) {
        state.failures -= 1;
        throw new EmailError(state.failWith);
      }
      sent.push(email);
      return { to: email.to, messageId: `<msg-${sent.length}@test>` };
    },
  };
  return { mailer, sent, attemptTimes, state };
}
