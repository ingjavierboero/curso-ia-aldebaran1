import { createArcaClientFromConfig } from './arca/index.js';
import { runBilling } from './billing/run.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { createMailer } from './email/mailer.js';
import { checkMailbox } from './mailbox/check.js';
import { gmailMailbox } from './mailbox/imap.js';
import { classifyEmail, createAnthropicClient } from './payments/classifier.js';
import type { SchedulerJobs } from './scheduler.js';

/** Procesos reales que ejecuta el scheduler, con los servicios externos de la configuración. */
export function createJobs(db: Db, config: Config): SchedulerJobs {
  const arca = createArcaClientFromConfig(db, config);
  const mailer = createMailer(config);
  const anthropic = createAnthropicClient(config);
  const source = gmailMailbox(config);

  return {
    async billing() {
      const summary = await runBilling({ db, arca, mailer, issuerCuit: config.arca.cuit });
      return {
        period: summary.period,
        generated: summary.generated.map((i) => i.id),
        alreadyInvoiced: summary.alreadyInvoiced,
        failed: summary.failed,
        emailed: summary.emailed.map((e) => e.invoiceId),
        emailFailed: summary.emailFailed,
      };
    },
    mailbox: () =>
      checkMailbox({
        db,
        source,
        classify: (email) => classifyEmail({ client: anthropic, issuerCuit: config.arca.cuit }, email),
        now: () => new Date(),
        systemAddress: config.gmail.user,
      }),
  };
}
