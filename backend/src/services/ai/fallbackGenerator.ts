import type { AnomalyType } from '../monitoring/types.js';
import { describeStatus } from '../monitoring/ruleEngine.js';
import type { AlertContent, AlertContext } from './types.js';

/**
 * Deterministic alert generator. Used immediately at ingestion time (so every alert has
 * readable content before any LLM call) and whenever the LLM is disabled or fails.
 * Output is built only from stored evidence; nothing is inferred beyond the rules.
 */

interface Template {
  title: (api: string) => string;
  outlook: string;
  causes: string[];
  actions: string[];
}

const TEMPLATES: Record<AnomalyType, Template> = {
  SERVER_ERROR: {
    title: (api) => `${api} server error`,
    outlook: 'Possible outage or backend failure.',
    causes: ['Unhandled exception in the API service', 'Failure of an upstream dependency (database, downstream service)', 'Recent deployment or configuration change'],
    actions: [
      'Inspect the API service logs around the check timestamp',
      'Check the health of upstream dependencies',
      'Review recent deployments or configuration changes',
      'Retry according to the API retry policy once the failure is understood',
    ],
  },
  HIGH_LATENCY: {
    title: (api) => `${api} slow response`,
    outlook: 'Possible performance degradation.',
    causes: ['Increased load on the API or its database', 'Slow upstream dependency or network path', 'Resource saturation (CPU, memory, connection pool)'],
    actions: [
      'Compare with recent response times to see if latency is trending upward',
      'Check API host resource utilisation and connection pool usage',
      'Check latency of upstream dependencies',
      'Consider whether client timeouts need adjusting while the issue is investigated',
    ],
  },
  RATE_LIMITED: {
    title: (api) => `${api} rate limited`,
    outlook: 'Requests are being throttled by the provider.',
    causes: ['Request volume exceeded the provider quota', 'Retries without backoff amplifying traffic', 'Quota reduced on the provider side'],
    actions: ['Check request volume against the provider quota', 'Ensure retries use exponential backoff and honour Retry-After', 'Contact the API provider if the quota appears incorrect'],
  },
  AUTH_FAILURE: {
    title: (api) => `${api} authentication/authorization failure`,
    outlook: 'Integration credentials may be invalid or lack permission.',
    causes: ['Expired or rotated API credentials', 'Missing permissions or scopes for the integration account', 'Misconfigured authentication settings'],
    actions: ['Verify the integration credentials are current (without exposing them in logs)', 'Confirm the account has the required permissions', 'Check for recent credential rotation or provider-side policy changes'],
  },
  CLIENT_ERROR: {
    title: (api) => `${api} client error`,
    outlook: 'The request may be malformed or targeting the wrong resource.',
    causes: ['Request parameters or payload no longer match the API contract', 'Endpoint moved or resource removed', 'Provider-side API version change'],
    actions: ['Review the request being sent against the current API documentation', 'Check the provider changelog for breaking changes', 'Inspect the error response body in the integration logs'],
  },
  UNEXPECTED_STATUS: {
    title: (api) => `${api} unexpected status`,
    outlook: 'The API did not return a final successful response.',
    causes: ['Endpoint URL changed and now redirects', 'Proxy or gateway configuration change', 'Client not following redirects as expected'],
    actions: ['Confirm the configured endpoint URL is current', 'Check whether the redirect target is expected and trusted', 'Update the integration configuration if the endpoint moved'],
  },
  MISSING_RECORD_COUNT: {
    title: (api) => `${api} missing record count`,
    outlook: 'Data completeness cannot be verified for this check.',
    causes: ['Response format changed and the count field is no longer populated', 'Monitoring collector failed to extract the count', 'Partial or truncated response'],
    actions: ['Verify the response schema against the expected data contract', 'Check the monitoring collector for parsing errors', 'Confirm whether the provider changed the response format'],
  },
  INVALID_RECORD_COUNT: {
    title: (api) => `${api} invalid record count`,
    outlook: 'The reported data violates the expected contract.',
    causes: ['Response format or type change', 'Data corruption or serialisation bug', 'Monitoring collector parsing error'],
    actions: ['Inspect how the record count is produced and parsed', 'Compare against the documented data contract', 'Check for recent changes to the API or collector'],
  },
  ZERO_RECORDS: {
    title: (api) => `${api} returned zero records`,
    outlook: 'Possible data issue — zero records can be legitimate for some APIs or time windows.',
    causes: ['No data exists for the requested period (may be legitimate)', 'Upstream data pipeline or sync failure', 'Query filters or parameters excluding all results'],
    actions: ['Verify whether zero records is expected for this API and time window', 'Check upstream data pipelines or synchronisation jobs', 'Review the request parameters and filters'],
  },
  LOW_RECORD_COUNT: {
    title: (api) => `${api} returned fewer records than expected`,
    outlook: 'Possible partial data.',
    causes: ['Partial data synchronisation', 'Pagination or filtering change', 'Genuine drop in data volume'],
    actions: ['Compare with typical record counts for this API', 'Check pagination and filter parameters', 'Check upstream data pipelines for partial failures'],
  },
};

/** Shared rules for co-occurring anomalies so the summary reflects the whole check. */
const RELATED_ACTIONS: Partial<Record<AnomalyType, string>> = {
  ZERO_RECORDS: 'Verify whether the zero-record result is expected or a consequence of the failure',
  HIGH_LATENCY: 'Check whether the slow response is related to the failure (e.g. timeouts in dependencies)',
  MISSING_RECORD_COUNT: 'Confirm whether the missing record count is a side-effect of the failure',
};

/** "2026-10-16 19:34 UTC" — readable and unambiguous in alerts and e-mails. */
function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function describeCheckFacts(ctx: AlertContext): string {
  const { check } = ctx.evidence;
  const parts: string[] = [];
  parts.push(check.statusCode >= 200 && check.statusCode < 300 ? `responded with ${describeStatus(check.statusCode)}` : `failed with ${describeStatus(check.statusCode)}`);

  const threshold = check.latencyThresholdMs;
  const latencyFlagged = ctx.anomalyType === 'HIGH_LATENCY' || ctx.evidence.relatedFindings.some((f) => f.type === 'HIGH_LATENCY');
  parts.push(latencyFlagged && typeof threshold === 'number'
    ? `took ${check.responseTimeMs} ms (threshold ${threshold} ms)`
    : `took ${check.responseTimeMs} ms`);

  const expectedMin = check.expectedMinRecords !== null && check.expectedMinRecords > 0 ? ` (at least ${check.expectedMinRecords} expected)` : '';
  if (check.recordsReturned !== null) parts.push(`returned ${check.recordsReturned} records${expectedMin}`);
  else if (check.recordsIssue === 'missing' || check.recordsIssue === 'null') parts.push('did not report a record count');
  else {
    const raw = ctx.evidence.finding.type === 'INVALID_RECORD_COUNT' ? ctx.evidence.finding.observed['recordsReturned'] : undefined;
    parts.push(`reported an invalid record count${raw !== undefined && raw !== null ? ` (${String(raw)})` : ''}`);
  }

  const last = parts.pop();
  return parts.length > 0 ? `${parts.join(', ')} and ${last}` : (last ?? '');
}

export function generateFallbackAlert(ctx: AlertContext): AlertContent {
  const template = TEMPLATES[ctx.anomalyType];
  const related = ctx.evidence.relatedFindings;

  const relatedLabel = related.length > 0 ? ` (with ${related.map((f) => f.type.toLowerCase().replace(/_/g, ' ')).join(', ')})` : '';
  const repeat = ctx.occurrenceCount > 1 ? ` This anomaly has been detected ${ctx.occurrenceCount} times since ${formatUtc(ctx.firstSeenAt)}.` : '';
  const escalation = ctx.evidence.escalation
    ? ` Severity was escalated from ${ctx.evidence.escalation.fromSeverity} to ${ctx.evidence.escalation.toSeverity} because of repeated occurrences.`
    : '';

  // The facts sentence already covers status, latency and record count, so the rule message is not repeated.
  const summary = `${ctx.apiName} ${describeCheckFacts(ctx)}. ${template.outlook}${repeat}${escalation}`;

  const extraActions = related.map((f) => RELATED_ACTIONS[f.type]).filter((a): a is string => Boolean(a));
  const recommendedActions = [...template.actions.slice(0, 3), ...extraActions, ...template.actions.slice(3)].slice(0, 5);

  return {
    title: `${template.title(ctx.apiName)}${relatedLabel}`.slice(0, 120),
    summary,
    possibleCauses: [...template.causes],
    recommendedActions,
  };
}
