import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Convenciones:
// - Montos en centavos (enteros) para evitar errores de redondeo.
// - Fechas como timestamp en milisegundos.
// - Estados como texto con CHECK, en inglés en la base; los textos en español son de la UI.

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

export const ACTIVE_STATUSES = ['active', 'inactive'] as const;
export const CURRENCIES = ['ARS', 'USD'] as const;
export const INVOICE_STATUSES = [
  'pending_payment', // Pendiente de pago
  'payment_received', // Pago recibido
  'manual_review', // Revisión manual
  'paid', // Pagada
] as const;
export const CLASSIFICATIONS = ['si', 'no', 'dudoso'] as const;
export const PROCESSING_STATUSES = ['pending', 'processed', 'error'] as const;
export const NOTICE_STATUSES = ['pending', 'reviewed'] as const;
export const PROCESS_OPERATIONS = [
  'invoice_generation',
  'invoice_email',
  'reminder_email',
  'mailbox_check',
] as const;
export const PROCESS_ERROR_STATUSES = ['pending', 'resolved'] as const;
export const HISTORY_EVENTS = [
  'invoice_email_sent',
  'email_received',
  'email_processed',
  'reminder_sent',
] as const;

/** Código de comprobante de ARCA para Factura C (RF-102). */
export const INVOICE_TYPE_C = 11;

/**
 * Condiciones frente al IVA que ARCA admite para el receptor de una Factura C (RF-114),
 * según FEParamGetCondicionIvaReceptor de homologación.
 */
export const VAT_CONDITIONS = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado – Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
} as const;

export type VatConditionId = keyof typeof VAT_CONDITIONS;
const VAT_CONDITION_IDS = sql.raw(Object.keys(VAT_CONDITIONS).join(', '));

/** Configuración del sistema: una sola fila (id = 1). */
export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey(),
    mailboxIntervalMinutes: integer('mailbox_interval_minutes').notNull().default(15),
    billingTime: text('billing_time').notNull().default('11:00'),
    reminderTime: text('reminder_time').notNull().default('11:00'),
    retryCount: integer('retry_count').notNull().default(3),
    retryWaitMinutes: integer('retry_wait_minutes').notNull().default(5),
    pointOfSale: integer('point_of_sale').notNull().default(1),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    check('settings_singleton', sql`${t.id} = 1`),
    check('settings_mailbox_interval', sql`${t.mailboxIntervalMinutes} BETWEEN 5 AND 60`),
    // Horas entre 00:00 y 23:39 (RF-40, RF-83).
    check(
      'settings_billing_time',
      sql`${t.billingTime} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${t.billingTime} BETWEEN '00:00' AND '23:39'`,
    ),
    check(
      'settings_reminder_time',
      sql`${t.reminderTime} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${t.reminderTime} BETWEEN '00:00' AND '23:39'`,
    ),
    check('settings_retry_count', sql`${t.retryCount} BETWEEN 0 AND 10`),
    check('settings_retry_wait', sql`${t.retryWaitMinutes} BETWEEN 1 AND 60`),
    check('settings_point_of_sale', sql`${t.pointOfSale} BETWEEN 1 AND 99999`),
  ],
);

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    businessName: text('business_name').notNull(),
    cuit: text('cuit').notNull(),
    // Casilla registrada: se guarda en minúsculas para comparar remitentes (RF-55).
    email: text('email').notNull(),
    status: text('status', { enum: ACTIVE_STATUSES }).notNull().default('active'),
    // Condición frente al IVA (RF-114). Admite null solo por los clientes cargados antes de
    // que existiera el campo: el alta la exige, y la facturación falla si falta.
    vatConditionId: integer('vat_condition_id').$type<VatConditionId>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('clients_email_unique').on(t.email),
    uniqueIndex('clients_cuit_unique').on(t.cuit),
    check('clients_cuit_format', sql`length(${t.cuit}) = 11 AND ${t.cuit} NOT GLOB '*[^0-9]*'`),
    check('clients_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('clients_status', sql`${t.status} IN ('active', 'inactive')`),
    check('clients_vat_condition', sql`${t.vatConditionId} IS NULL OR ${t.vatConditionId} IN (${VAT_CONDITION_IDS})`),
  ],
);

export const systems = sqliteTable(
  'systems',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    status: text('status', { enum: ACTIVE_STATUSES }).notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    check('systems_price', sql`${t.priceCents} > 0`),
    check('systems_currency', sql`${t.currency} IN ('ARS', 'USD')`),
    check('systems_status', sql`${t.status} IN ('active', 'inactive')`),
  ],
);

/** Sistemas asignados a cada cliente. Desasignar es borrar la fila (RF-38). */
export const clientSystems = sqliteTable(
  'client_systems',
  {
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    systemId: integer('system_id')
      .notNull()
      .references(() => systems.id, { onDelete: 'restrict' }),
    assignedAt: integer('assigned_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.systemId] })],
);

/** Cotizaciones del dólar blue venta leídas de dolarhoy.com (RF-41, RF-42). */
export const exchangeRates = sqliteTable(
  'exchange_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Pesos por dólar, en centavos (ej.: 1450,50 → 145050).
    rateCents: integer('rate_cents').notNull(),
    source: text('source').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('exchange_rates_fetched_at').on(t.fetchedAt),
    check('exchange_rates_positive', sql`${t.rateCents} > 0`),
  ],
);

/**
 * Factura emitida en homologación de ARCA. La fila existe solo si ARCA devolvió el CAE;
 * los datos del cliente y la cotización se copian para que las facturas emitidas
 * no cambien al modificar el cliente o los sistemas (AC-30, AC-35, AC-36).
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    // Período facturado, formato YYYY-MM: define la antigüedad de la factura.
    period: text('period').notNull(),
    invoiceType: integer('invoice_type').notNull().default(INVOICE_TYPE_C),
    pointOfSale: integer('point_of_sale').notNull(),
    number: integer('number').notNull(),
    cae: text('cae').notNull(),
    caeExpiresAt: text('cae_expires_at').notNull(),
    issuedAt: integer('issued_at', { mode: 'timestamp_ms' }).notNull(),
    clientBusinessName: text('client_business_name').notNull(),
    clientCuit: text('client_cuit').notNull(),
    clientVatConditionId: integer('client_vat_condition_id').$type<VatConditionId>().notNull(),
    // Fechas fiscales en formato YYYY-MM-DD (RF-116, RF-117).
    issueDate: text('issue_date').notNull(),
    serviceFrom: text('service_from').notNull(),
    serviceTo: text('service_to').notNull(),
    paymentDueDate: text('payment_due_date').notNull(),
    totalCents: integer('total_cents').notNull(),
    // Cotización usada si algún ítem estaba en dólares (AC-45, AC-46).
    exchangeRateCents: integer('exchange_rate_cents'),
    exchangeRateSource: text('exchange_rate_source'),
    exchangeRateAt: integer('exchange_rate_at', { mode: 'timestamp_ms' }),
    exchangeRateFallback: integer('exchange_rate_fallback', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('pending_payment'),
    // Motivo de la Revisión manual (RF-73); null en los demás estados.
    reviewReason: text('review_reason'),
    statusChangedAt: integer('status_changed_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    ...timestamps,
  },
  (t) => [
    // Sin unique (cliente, período): AC-88 carga dos del mismo período a mano.
    // Que no se duplique al facturar lo garantiza el proceso de facturación.
    index('invoices_client_period').on(t.clientId, t.period),
    index('invoices_status').on(t.status),
    uniqueIndex('invoices_number_unique').on(t.invoiceType, t.pointOfSale, t.number),
    check('invoices_period_format', sql`${t.period} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check('invoices_total', sql`${t.totalCents} > 0`),
    check(
      'invoices_status',
      sql`${t.status} IN ('pending_payment', 'payment_received', 'manual_review', 'paid')`,
    ),
    check(
      'invoices_review_reason',
      sql`(${t.status} = 'manual_review') = (${t.reviewReason} IS NOT NULL)`,
    ),
  ],
);

/** Detalle de la factura: una línea por cuota mensual de sistema (RF-39). */
export const invoiceItems = sqliteTable(
  'invoice_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    systemId: integer('system_id').references(() => systems.id, { onDelete: 'set null' }),
    // Nombre y precio del sistema al momento de facturar.
    description: text('description').notNull(),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    // Importe facturado en pesos (convertido si la cuota está en dólares).
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [
    index('invoice_items_invoice').on(t.invoiceId),
    check('invoice_items_currency', sql`${t.currency} IN ('ARS', 'USD')`),
  ],
);

/**
 * Emails recibidos en la casilla. Si el remitente no coincide con ningún cliente,
 * client_id es null y el email es un aviso (RF-56).
 */
export const inboundEmails = sqliteTable(
  'inbound_emails',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Message-ID del email: evita procesar dos veces el mismo mensaje (RF-54).
    messageId: text('message_id').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull().default(''),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    clientId: integer('client_id').references(() => clients.id, { onDelete: 'set null' }),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull(),
    // Resultado del LLM (RF-59 a RF-61).
    processingStatus: text('processing_status', { enum: PROCESSING_STATUSES })
      .notNull()
      .default('pending'),
    classification: text('classification', { enum: CLASSIFICATIONS }),
    extractedCuit: text('extracted_cuit'),
    extractedAmountCents: integer('extracted_amount_cents'),
    processingError: text('processing_error'),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
    // Aviso: solo aplica cuando client_id es null (RF-56, RF-81).
    noticeStatus: text('notice_status', { enum: NOTICE_STATUSES }),
    noticeReviewedAt: integer('notice_reviewed_at', { mode: 'timestamp_ms' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('inbound_emails_message_id').on(t.messageId),
    index('inbound_emails_client').on(t.clientId),
    index('inbound_emails_notice').on(t.noticeStatus),
    check('inbound_emails_processing', sql`${t.processingStatus} IN ('pending', 'processed', 'error')`),
    check(
      'inbound_emails_classification',
      sql`${t.classification} IS NULL OR ${t.classification} IN ('si', 'no', 'dudoso')`,
    ),
    check(
      'inbound_emails_notice',
      sql`${t.noticeStatus} IS NULL OR ${t.noticeStatus} IN ('pending', 'reviewed')`,
    ),
  ],
);

export const emailAttachments = sqliteTable(
  'email_attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    emailId: integer('email_id')
      .notNull()
      .references(() => inboundEmails.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: blob('content', { mode: 'buffer' }).notNull(),
  },
  (t) => [index('email_attachments_email').on(t.emailId)],
);

/**
 * Emails (comprobantes) asociados a una factura en Pago recibido o Revisión manual
 * (RF-74, RF-75). Cuando el usuario resuelve la factura se completa resolved_at,
 * así la siguiente revisión arranca sin los comprobantes ya analizados.
 */
export const invoicePaymentEmails = sqliteTable(
  'invoice_payment_emails',
  {
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    emailId: integer('email_id')
      .notNull()
      .references(() => inboundEmails.id, { onDelete: 'cascade' }),
    linkedAt: integer('linked_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.invoiceId, t.emailId] })],
);

/** Historial del cliente: envíos y recepciones de emails (RF-57, RF-61, AC-50). */
export const clientHistory = sqliteTable(
  'client_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    event: text('event', { enum: HISTORY_EVENTS }).notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    emailId: integer('email_id').references(() => inboundEmails.id, { onDelete: 'set null' }),
    // Datos propios de cada evento (destinatario, clasificación, etc.) en JSON.
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    index('client_history_client').on(t.clientId, t.occurredAt),
    check(
      'client_history_event',
      sql`${t.event} IN ('invoice_email_sent', 'email_received', 'email_processed', 'reminder_sent')`,
    ),
  ],
);

/** Operaciones automáticas que fallaron tras el último reintento (RF-52, RF-92). */
export const processErrors = sqliteTable(
  'process_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    operation: text('operation', { enum: PROCESS_OPERATIONS }).notNull(),
    clientId: integer('client_id').references(() => clients.id, { onDelete: 'set null' }),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    period: text('period'),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error').notNull(),
    status: text('status', { enum: PROCESS_ERROR_STATUSES }).notNull().default('pending'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    index('process_errors_status').on(t.status),
    check(
      'process_errors_operation',
      sql`${t.operation} IN ('invoice_generation', 'invoice_email', 'reminder_email', 'mailbox_check')`,
    ),
    check('process_errors_status', sql`${t.status} IN ('pending', 'resolved')`),
    check('process_errors_attempts', sql`${t.attempts} >= 1`),
  ],
);

/**
 * Ticket de acceso de WSAA por servicio de ARCA. Se reutiliza hasta que vence (~12 h):
 * WSAA rechaza pedir otro mientras haya uno vigente, por eso sobrevive a un reinicio.
 */
export const arcaAccessTickets = sqliteTable('arca_access_tickets', {
  service: text('service').primaryKey(),
  token: text('token').notNull(),
  sign: text('sign').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: timestamps.createdAt,
});

/**
 * Hasta dónde se leyó la casilla (una sola fila). Los UID de IMAP crecen dentro de un mismo
 * UIDVALIDITY; si el servidor lo cambia, se vuelve a leer y Message-ID evita duplicados (RF-109).
 */
export const mailboxState = sqliteTable(
  'mailbox_state',
  {
    id: integer('id').primaryKey(),
    uidValidity: text('uid_validity').notNull(),
    lastUid: integer('last_uid').notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [check('mailbox_state_singleton', sql`${t.id} = 1`)],
);

/** Registro de cada revisión de la casilla con los emails detectados (AC-56). */
export const mailboxChecks = sqliteTable(
  'mailbox_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['running', 'ok', 'error'] }).notNull().default('running'),
    emailsDetected: integer('emails_detected').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('mailbox_checks_started').on(t.startedAt),
    check('mailbox_checks_status', sql`${t.status} IN ('running', 'ok', 'error')`),
  ],
);

/**
 * Ejecuciones de procesos programados por período (por ahora, la facturación mensual): evita
 * correrlos dos veces y permite recuperar una ejecución perdida si el servidor estuvo caído.
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    job: text('job', { enum: ['billing'] }).notNull(),
    period: text('period').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['running', 'ok', 'error'] }).notNull().default('running'),
    summary: text('summary', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('job_runs_job_period').on(t.job, t.period),
    check('job_runs_job', sql`${t.job} IN ('billing')`),
    check('job_runs_status', sql`${t.status} IN ('running', 'ok', 'error')`),
  ],
);
