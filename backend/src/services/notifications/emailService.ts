import type { Alert } from '@prisma/client';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '../../utils/logger.js';
import { severityRank, type Severity } from '../monitoring/types.js';
import type { EnrichmentReason } from '../ai/enrichmentQueue.js';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  to: string;
  minSeverity: Severity;
  dashboardUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Optional anomaly e-mail reports (assignment §7.4). Failures are logged and never affect ingestion. */
export class EmailService {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: EmailConfig,
    private readonly logger: Logger,
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
      });
  }

  shouldNotify(alert: Pick<Alert, 'severity'>, reason: EnrichmentReason): boolean {
    return reason !== 'manual' && severityRank(alert.severity) >= severityRank(this.config.minSeverity);
  }

  buildMessage(alert: Alert, reason: EnrichmentReason) {
    const causes = asStringList(alert.possibleCauses);
    const actions = asStringList(alert.recommendedActions);
    const prefix = reason === 'escalated' ? 'ESCALATED' : 'NEW';
    const subject = `[${alert.severity}] ${prefix}: ${alert.title}`;
    const source = alert.generationSource === 'AI' ? `AI-generated (${alert.aiModel ?? 'LLM'})` : 'Rule-based fallback text';
    const link = `${this.config.dashboardUrl}/?alert=${alert.id}`;

    const text = [
      subject,
      '',
      alert.summary,
      '',
      'Possible causes (hypotheses, not verified):',
      ...causes.map((c) => `  - ${c}`),
      '',
      'Recommended actions:',
      ...actions.map((a, i) => `  ${i + 1}. ${a}`),
      '',
      `API: ${alert.apiName} | Type: ${alert.anomalyType} | Occurrences: ${alert.occurrenceCount}`,
      `Last seen: ${alert.lastSeenAt.toISOString()} | Content: ${source}`,
      `Dashboard: ${link}`,
    ].join('\n');

    const html = `<h2>${escapeHtml(subject)}</h2>
<p>${escapeHtml(alert.summary)}</p>
<h3>Possible causes <small>(hypotheses, not verified)</small></h3>
<ul>${causes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
<h3>Recommended actions</h3>
<ol>${actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ol>
<p><b>API:</b> ${escapeHtml(alert.apiName)} &middot; <b>Type:</b> ${alert.anomalyType} &middot; <b>Occurrences:</b> ${alert.occurrenceCount}<br/>
<b>Last seen:</b> ${alert.lastSeenAt.toISOString()} &middot; <b>Content:</b> ${escapeHtml(source)}</p>
<p><a href="${escapeHtml(link)}">Open in dashboard</a></p>`;

    return { from: this.config.from, to: this.config.to, subject, text, html };
  }

  async notify(alert: Alert, reason: EnrichmentReason): Promise<boolean> {
    if (!this.shouldNotify(alert, reason)) return false;
    try {
      await this.transporter.sendMail(this.buildMessage(alert, reason));
      this.logger.info({ alertId: alert.id, severity: alert.severity, reason }, 'alert e-mail sent');
      return true;
    } catch (error) {
      this.logger.warn({ alertId: alert.id, reason: error instanceof Error ? error.message : String(error) }, 'alert e-mail failed');
      return false;
    }
  }
}
