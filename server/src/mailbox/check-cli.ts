import { loadConfig, loadEnvFile } from '../config.js';
import { openDb } from '../db/index.js';
import { classifyEmail, createAnthropicClient } from '../payments/classifier.js';
import { checkMailbox } from './check.js';
import { gmailMailbox } from './imap.js';

// Revisa una vez la casilla de Gmail y procesa los emails nuevos (clasificación con Claude y
// estado de las facturas). Mientras no haya scheduler, es la forma de probarlo de punta a punta.
loadEnvFile();
const config = loadConfig();
const db = openDb(config.databasePath);
const client = createAnthropicClient(config);

const summary = await checkMailbox({
  db,
  source: gmailMailbox(config),
  classify: (email) => classifyEmail({ client, issuerCuit: config.arca.cuit }, email),
  now: () => new Date(),
  systemAddress: config.gmail.user,
});

if (!summary.ok) {
  console.error(`Falló la revisión de la casilla: ${summary.error}`);
  process.exitCode = 1;
} else {
  console.log(`Casilla ${config.gmail.user}: ${summary.detected} email(s) nuevo(s)`);
  if (summary.skippedOwn > 0) console.log(`  ${summary.skippedOwn} enviado(s) desde la propia casilla, ignorado(s)`);
  for (const result of summary.results) {
    if (result.kind === 'notice') console.log(`  aviso #${result.emailId}: remitente que no es cliente`);
    if (result.kind === 'duplicate') console.log(`  email #${result.emailId}: ya procesado`);
    if (result.kind === 'no_attachments') console.log(`  email #${result.emailId}: del cliente #${result.clientId}, sin adjuntos`);
    if (result.kind === 'processed') {
      const { outcome, decision } = result;
      const what =
        outcome.result.kind === 'error'
          ? `procesamiento erróneo (${outcome.error})`
          : `clasificado "${outcome.result.classification}"`;
      const action =
        decision.action === 'none'
          ? 'sin cambios en facturas'
          : decision.action === 'payment_received'
            ? `facturas ${decision.invoiceIds.join(', ')} → Pago recibido`
            : `facturas ${decision.invoiceIds.join(', ')} → Revisión manual (${decision.reason})`;
      console.log(`  email #${result.emailId} del cliente #${result.clientId}: ${what}; ${decision.rule}: ${action}`);
    }
  }
}
