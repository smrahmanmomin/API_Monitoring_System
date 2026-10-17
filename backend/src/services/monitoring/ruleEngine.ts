import type { MonitoringThresholds } from '../../config/thresholds.js';
import type { EvidenceValue, Finding, MonitoringEvent, Severity } from './types.js';

/**
 * Deterministic anomaly detection.
 *
 * Every rule is evaluated for every event — one event can produce several findings
 * (e.g. HTTP 500 + high latency + zero records). The LLM never decides whether an
 * anomaly exists; it only explains findings produced here.
 */

type RuleOutput = Omit<Finding, 'apiName' | 'checkedAt' | 'detectedAt'> | null;
type Rule = (event: MonitoringEvent, ctx: RuleContext) => RuleOutput;

interface RuleContext {
  latencyThresholdMs: number;
  latencyHighMultiplier: number;
  expectedMinRecords: number | undefined;
}

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** Plain-English meaning for common status codes, used in deterministic messages. */
const STATUS_MEANINGS: Record<number, string> = {
  301: 'Moved Permanently',
  302: 'Found (redirect)',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function describeStatus(code: number): string {
  const meaning = STATUS_MEANINGS[code];
  return meaning ? `HTTP ${code} (${meaning})` : `HTTP ${code}`;
}

const latencyRule: Rule = (event, ctx) => {
  if (event.responseTimeMs <= ctx.latencyThresholdMs) return null;
  const ratio = event.responseTimeMs / ctx.latencyThresholdMs;
  const severity: Severity = ratio >= ctx.latencyHighMultiplier ? 'HIGH' : 'MEDIUM';
  return {
    type: 'HIGH_LATENCY',
    severity,
    observed: { responseTimeMs: event.responseTimeMs },
    expected: { latencyThresholdMs: ctx.latencyThresholdMs },
    message: `Response time ${event.responseTimeMs} ms exceeded the ${ctx.latencyThresholdMs} ms threshold (${ratio.toFixed(1)}x).`,
  };
};

const statusRule: Rule = (event) => {
  const code = event.statusCode;
  const observed = { statusCode: code };
  if (code >= 500) {
    return {
      type: 'SERVER_ERROR',
      severity: 'HIGH',
      observed,
      expected: { statusClass: '2xx' },
      message: `Request failed with ${describeStatus(code)}, a server-side error.`,
    };
  }
  if (code === HTTP_TOO_MANY_REQUESTS) {
    return {
      type: 'RATE_LIMITED',
      severity: 'MEDIUM',
      observed,
      expected: { statusClass: '2xx' },
      message: `Request was rate limited (${describeStatus(code)}).`,
    };
  }
  if (code === HTTP_UNAUTHORIZED || code === HTTP_FORBIDDEN) {
    return {
      type: 'AUTH_FAILURE',
      severity: 'HIGH',
      observed,
      expected: { statusClass: '2xx' },
      message: `Request was rejected with ${describeStatus(code)}, indicating an authentication or authorization failure.`,
    };
  }
  if (code >= 400) {
    return {
      type: 'CLIENT_ERROR',
      severity: 'MEDIUM',
      observed,
      expected: { statusClass: '2xx' },
      message: `Request failed with ${describeStatus(code)}, a client-side or request-related error.`,
    };
  }
  if (code >= 300) {
    return {
      type: 'UNEXPECTED_STATUS',
      severity: 'LOW',
      observed,
      expected: { statusClass: '2xx' },
      message: `API responded with ${describeStatus(code)} instead of a successful 2xx response.`,
    };
  }
  // 1xx informational codes are not expected as final responses for data APIs.
  if (code < 200) {
    return {
      type: 'UNEXPECTED_STATUS',
      severity: 'LOW',
      observed,
      expected: { statusClass: '2xx' },
      message: `API responded with informational ${describeStatus(code)} instead of a final 2xx response.`,
    };
  }
  return null;
};

const recordsRule: Rule = (event, ctx): RuleOutput => {
  const expectedMin = ctx.expectedMinRecords;
  const expected: Record<string, EvidenceValue> =
    expectedMin !== undefined ? { expectedMinRecords: expectedMin } : { recordsReturned: 'non-negative integer' };

  if (event.recordsIssue === 'missing' || event.recordsIssue === 'null') {
    return {
      type: 'MISSING_RECORD_COUNT',
      severity: 'MEDIUM',
      observed: { recordsReturned: null, issue: event.recordsIssue },
      expected,
      message: 'The response did not report a record count (records_returned was missing or null).',
    };
  }
  if (event.recordsIssue !== null) {
    return {
      type: 'INVALID_RECORD_COUNT',
      severity: 'MEDIUM',
      observed: { recordsReturned: event.rawRecordsValue ?? null, issue: event.recordsIssue },
      expected,
      message: `The reported record count is invalid (${event.recordsIssue.replace('_', ' ')}: ${String(event.rawRecordsValue)}).`,
    };
  }

  const count = event.recordsReturned ?? 0;
  if (count === 0) {
    const hasExpectation = expectedMin !== undefined && expectedMin > 0;
    return {
      type: 'ZERO_RECORDS',
      severity: hasExpectation ? 'MEDIUM' : 'LOW',
      observed: { recordsReturned: 0 },
      expected,
      message: hasExpectation
        ? `The API returned 0 records; at least ${expectedMin} were expected.`
        : 'The API returned 0 records. This may be legitimate for some APIs or time windows and should be verified.',
    };
  }
  if (expectedMin !== undefined && count < expectedMin) {
    return {
      type: 'LOW_RECORD_COUNT',
      severity: 'LOW',
      observed: { recordsReturned: count },
      expected,
      message: `The API returned ${count} records; at least ${expectedMin} were expected.`,
    };
  }
  return null;
};

const RULES: readonly Rule[] = [statusRule, latencyRule, recordsRule];

/** Resolve thresholds for one event: event field > per-API override > global default. */
function buildContext(event: MonitoringEvent, thresholds: MonitoringThresholds): RuleContext {
  const override = thresholds.perApi[event.apiName];
  return {
    latencyThresholdMs: override?.latencyThresholdMs ?? thresholds.latencyThresholdMs,
    latencyHighMultiplier: thresholds.latencyHighMultiplier,
    expectedMinRecords: event.expectedMinRecords ?? override?.expectedMinRecords,
  };
}

/** Evaluate all rules against an event and return every finding (empty array = healthy). */
export function evaluateEvent(event: MonitoringEvent, thresholds: MonitoringThresholds, now: Date = new Date()): Finding[] {
  const ctx = buildContext(event, thresholds);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const result = rule(event, ctx);
    if (result) {
      findings.push({
        ...result,
        apiName: event.apiName,
        checkedAt: event.checkedAt.toISOString(),
        detectedAt: now.toISOString(),
      });
    }
  }
  return findings;
}
