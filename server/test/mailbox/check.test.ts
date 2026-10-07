import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/db/index.js';
import { clients, inboundEmails, invoices, mailboxChecks, mailboxState, processErrors } from '../../src/db/schema.js';
import { checkMailbox } from '../../src/mailbox/check.js';
import { classified, fakeClassifier, fakeMailbox, receipt } from './fakes.js';

let db: Db;
let clock = new Date('2026-10-20T15:00:00Z').getTime();
const now = () => new Date(clock);

beforeEach(() => {
  db = openDb(':memory:');
  db.insert(clients).values({ businessName: 'Los Andes', cuit: '30711111111', email: 'pagos@losandes.com', vatConditionId: 1 }).run();
});

function setup() {
  const mailbox = fakeMailbox();
  const classify = fakeClassifier(...Array.from({ length: 10 }, () => classified('no')));
  const check = () => {
    clock += 15 * 60_000;
    return checkMailbox({ db, source: mailbox.source, classify, now, systemAddress: 'facturacion@aldebaran.com' });
  };
  return { mailbox, classify, check };
}

describe('checkMailbox', () => {
  it('AC-56: registra la revisión con los emails detectados', async () => {
    const { mailbox, check } = setup();
    await mailbox.deliver({ from: 'pagos@losandes.com', attachments: [receipt()] });
    await mailbox.deliver({ from: 'otro@desconocido.com' });

    const summary = await check();

    expect(summary).toMatchObject({ ok: true, detected: 2 });
    expect(db.select().from(mailboxChecks).all()).toEqual([
      expect.objectContaining({ status: 'ok', emailsDetected: 2, error: null, finishedAt: expect.any(Date) }),
    ]);
  });

  it('avanza la posición y no vuelve a leer lo procesado', async () => {
    const { mailbox, check } = setup();
    await mailbox.deliver({ from: 'pagos@losandes.com' });
    await check();
    await mailbox.deliver({ from: 'pagos@losandes.com' });

    const second = await check();

    expect(second).toMatchObject({ ok: true, detected: 1 });
    expect(db.select().from(mailboxState).get()).toMatchObject({ uidValidity: '1001', lastUid: 2 });
    expect(db.select().from(inboundEmails).all()).toHaveLength(2);
  });

  it('si el servidor cambia el UIDVALIDITY, vuelve a leer sin duplicar emails (RF-109)', async () => {
    const { mailbox, check } = setup();
    await mailbox.deliver({ from: 'pagos@losandes.com' });
    await check();
    mailbox.state.uidValidity = '2002';

    const summary = await check();

    expect(summary).toMatchObject({ ok: true, detected: 1, results: [{ kind: 'duplicate' }] });
    expect(db.select().from(inboundEmails).all()).toHaveLength(1);
  });

  it('AC-168: no procesa los emails enviados desde la propia casilla del sistema', async () => {
    const { mailbox, check, classify } = setup();
    await mailbox.deliver({ from: 'Aldebaran <facturacion@aldebaran.com>', attachments: [receipt()] });

    const summary = await check();

    expect(summary).toMatchObject({ ok: true, detected: 1, results: [], skippedOwn: 1 });
    expect(classify).not.toHaveBeenCalled();
    expect(db.select().from(inboundEmails).all()).toEqual([]);
  });

  it('AC-171: la primera revisión toma los emails desde el día de la primera factura; después, solo los nuevos', async () => {
    const { mailbox, check } = setup();
    db.insert(invoices)
      .values({
        clientId: 1, period: '2026-10', pointOfSale: 1, number: 1, cae: 'x', caeExpiresAt: '2026-10-25',
        issuedAt: new Date('2026-10-15T14:00:00Z'), clientBusinessName: 'Los Andes', clientCuit: '30711111111',
        clientVatConditionId: 1, issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31',
        paymentDueDate: '2026-10-31', totalCents: 100,
      })
      .run();
    await mailbox.deliver({ from: 'pagos@losandes.com', subject: 'Viejo', date: new Date('2026-10-14T20:00:00Z') });
    await mailbox.deliver({ from: 'pagos@losandes.com', subject: 'Del día', date: new Date('2026-10-15T09:00:00Z') });
    await mailbox.deliver({ from: 'pagos@losandes.com', subject: 'Posterior', date: new Date('2026-10-18T10:00:00Z') });

    await check();
    await mailbox.deliver({ from: 'pagos@losandes.com', subject: 'Nuevo', date: new Date('2026-10-01T10:00:00Z') });
    await check();

    expect(db.select({ subject: inboundEmails.subject }).from(inboundEmails).all().map((e) => e.subject)).toEqual([
      'Del día',
      'Posterior',
      'Nuevo',
    ]);
  });

  it('AC-59: si la casilla no responde, registra un error de proceso Pendiente de revisión de la casilla', async () => {
    const { mailbox, check } = setup();
    mailbox.state.failing = true;

    const summary = await check();

    expect(summary).toEqual({ ok: false, checkId: 1, error: 'no se pudo leer la casilla: Timed out after 30000ms' });
    expect(db.select().from(processErrors).all()).toEqual([
      expect.objectContaining({ operation: 'mailbox_check', status: 'pending', attempts: 1, clientId: null }),
    ]);
    expect(db.select().from(mailboxChecks).get()).toMatchObject({ status: 'error' });
  });

  it('AC-60: tres revisiones fallidas seguidas → un intento por revisión y un único error Pendiente', async () => {
    const { mailbox, check } = setup();
    mailbox.state.failing = true;

    await check();
    await check();
    await check();

    expect(mailbox.state.calls).toBe(3);
    expect(db.select().from(processErrors).all()).toEqual([
      expect.objectContaining({ operation: 'mailbox_check', status: 'pending', attempts: 3 }),
    ]);
  });

  it('AC-61: cuando la casilla vuelve, procesa los emails llegados durante la falla y resuelve el error', async () => {
    const { mailbox, check, classify } = setup();
    mailbox.state.failing = true;
    await check();
    await mailbox.deliver({ from: 'pagos@losandes.com', attachments: [receipt()] });
    await mailbox.deliver({ from: 'pagos@losandes.com', attachments: [receipt()] });
    mailbox.state.failing = false;

    const summary = await check();

    expect(summary).toMatchObject({ ok: true, detected: 2 });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(db.select().from(processErrors).get()).toMatchObject({ status: 'resolved', resolvedAt: now() });
  });

  it('si falla el procesamiento de un email, conserva lo ya procesado y lo retoma en la próxima revisión', async () => {
    const mailbox = fakeMailbox();
    await mailbox.deliver({ from: 'pagos@losandes.com', attachments: [receipt()] });
    await mailbox.deliver({ from: 'pagos@losandes.com', attachments: [receipt()] });
    const classify = fakeClassifier(classified('no')); // la segunda clasificación falla
    const run = () => checkMailbox({ db, source: mailbox.source, classify, now, systemAddress: 'facturacion@aldebaran.com' });

    const first = await run();
    expect(first).toMatchObject({ ok: false });
    expect(db.select().from(mailboxState).get()).toMatchObject({ lastUid: 1 });

    classify.mockResolvedValueOnce(classified('no'));
    const second = await run();

    expect(second).toMatchObject({ ok: true, detected: 1, results: [{ kind: 'processed' }] });
    expect(db.select().from(inboundEmails).all().map((e) => e.processingStatus)).toEqual(['processed', 'processed']);
    expect(db.select().from(processErrors).get()).toMatchObject({ status: 'resolved' });
  });
});
