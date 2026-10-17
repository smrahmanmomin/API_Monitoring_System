import { useEffect, useRef, useState } from 'react';
import sampleBatch from '../../../samples/sample-batch.json';
import { ApiError } from '../api/client';
import type { IngestResult } from '../api/types';
import { useIngest } from '../hooks/useMonitoring';
import { anomalyLabel, formatMs } from '../lib/format';
import { useToast } from './Toasts';

/** What each event in samples/sample-batch.json is meant to demonstrate (same order as the file). */
const SCENARIOS = ['Normal response', 'Slow response', 'Server error, slow, zero records', 'Zero records where at least 1 is expected', 'Record count missing'];

interface Props {
  open: boolean;
  onClose: () => void;
}

function ResultList({ result }: { result: IngestResult }) {
  const { summary } = result;
  return (
    <div className="ingest-result">
      <p className="mono">
        {summary.accepted}/{summary.received} accepted · {summary.anomalies_detected} anomalies · {summary.alerts_created} new alerts · {summary.alerts_updated} updated
        {summary.rejected > 0 ? ` · ${summary.rejected} rejected` : ''}
      </p>
      <ol>
        {result.results.map((r) => (
          <li key={r.index} className={`result-${r.status}`}>
            <span className="mono">#{r.index}</span>{' '}
            {r.status === 'accepted' && (
              <>
                <b>{r.api_name}</b> {r.anomalies.length === 0 ? 'healthy' : r.anomalies.map((a) => anomalyLabel(a.type)).join(', ')}
              </>
            )}
            {r.status === 'rejected' && <>rejected: {r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}</>}
            {r.status === 'failed' && <>failed to store: {r.error.message}</>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function DemoPanel({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ingest = useIngest();
  const toast = useToast();
  const [custom, setCustom] = useState(() => JSON.stringify(sampleBatch[2], null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const send = (events: unknown, label: string) => {
    setResult(null);
    ingest.mutate(
      { events, source: 'demo' },
      {
        onSuccess: (r) => {
          setResult(r);
          toast(`${label}: ${r.summary.accepted} accepted, ${r.summary.alerts_created} new alerts`);
        },
        onError: (e) => {
          const body = e instanceof ApiError ? (e.body as { error?: { details?: unknown } } | undefined) : undefined;
          const details = body?.error?.details;
          if (Array.isArray(details) && details.every((d) => typeof d === 'object' && d !== null && 'index' in d)) {
            setResult({ summary: { received: details.length, accepted: 0, rejected: details.length, failed: 0, with_anomalies: 0, anomalies_detected: 0, alerts_created: 0, alerts_updated: 0 }, results: details as IngestResult['results'] });
          }
          toast(e instanceof ApiError ? e.message : 'Could not send events', 'error');
        },
      },
    );
  };

  const sendCustom = () => {
    try {
      const parsed: unknown = JSON.parse(custom);
      setParseError(null);
      send(parsed, 'Custom events');
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  return (
    <dialog ref={dialogRef} className="demo" onClose={onClose} aria-labelledby="demo-title">
      <div className="demo-head">
        <div>
          <span className="eyebrow">Demo data · not real API traffic</span>
          <h2 id="demo-title">Send test events</h2>
        </div>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>

      <section>
        <h3>Sample batch</h3>
        <p className="section-note">
          Five synthetic checks from <code>samples/sample-batch.json</code>, sent to <code>POST /monitor</code> and labelled as demo data.
        </p>
        <ol className="scenarios">
          {sampleBatch.map((event, i) => (
            <li key={i}>
              <span>{SCENARIOS[i] ?? 'Event'}</span>
              <span className="mono metric-dim">
                {event.api_name} · {event.status_code} · {formatMs(event.response_time_ms)} · {'records_returned' in event ? `${event.records_returned} rec` : 'no count'}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-primary" disabled={ingest.isPending} onClick={() => send(sampleBatch, 'Sample batch')}>
          {ingest.isPending ? 'Sending…' : 'Send sample batch'}
        </button>
      </section>

      <section>
        <h3>Custom JSON</h3>
        <p className="section-note">One event object or an array. Fields: api_name, response_time_ms, status_code, records_returned, optional expected_min_records and checked_at.</p>
        <label className="visually-hidden" htmlFor="custom-json">
          Monitoring events JSON
        </label>
        <textarea id="custom-json" className="mono" rows={9} spellCheck={false} value={custom} onChange={(e) => setCustom(e.target.value)} />
        {parseError && <p className="field-error">Not valid JSON: {parseError}</p>}
        <button type="button" className="btn btn-secondary" disabled={ingest.isPending} onClick={sendCustom}>
          Send JSON
        </button>
      </section>

      {result && <ResultList result={result} />}
    </dialog>
  );
}
