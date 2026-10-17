import type { Stats } from '../api/types';
import { formatMs, latencyFill, recordsLabel, statusTone, timeAgo } from '../lib/format';
import { HttpCode, SeverityBadge } from './Badges';

/** Where the threshold tick sits along each latency track. */
const THRESHOLD_AT = 0.6;

interface Props {
  stats: Stats;
  onSelectApi: (apiName: string) => void;
}

/**
 * Signature element: one "monitor lane" per API, showing the latest check's latency against
 * the threshold tick, the HTTP status and the record count — the three vitals the rules evaluate.
 */
export function VitalsStrip({ stats, onSelectApi }: Props) {
  const openByApi = new Map(stats.affected_apis.map((a) => [a.api_name, a]));
  const threshold = stats.config.latency_threshold_ms;

  return (
    <section className="vitals" aria-labelledby="vitals-title">
      <div className="section-head">
        <h2 id="vitals-title">API health</h2>
        <p className="section-note">
          Latest check per API. The marker shows the {formatMs(threshold)} latency threshold. Select an API to filter its alerts.
        </p>
      </div>
      <ol className="lanes">
        {stats.api_health.map((check) => {
          const open = openByApi.get(check.api_name);
          const over = check.response_time_ms > threshold;
          const tone = open ? 'alarm' : statusTone(check.status_code) === 'ok' && !over ? 'calm' : 'watch';
          return (
            <li key={check.api_name}>
              <button type="button" className={`lane lane-${tone}`} onClick={() => onSelectApi(check.api_name)} aria-label={`Show alerts for ${check.api_name}`}>
                <span className="lane-name">
                  <span className="lane-dot" aria-hidden="true" />
                  {check.api_name}
                </span>
                <span className="lane-track" aria-hidden="true">
                  <span className={`lane-fill${over ? ' is-over' : ''}`} style={{ width: `${latencyFill(check.response_time_ms, threshold, THRESHOLD_AT) * 100}%` }} />
                  <span className="lane-threshold" style={{ left: `${THRESHOLD_AT * 100}%` }} />
                </span>
                <span className="lane-metrics">
                  <span className="metric">{formatMs(check.response_time_ms)}</span>
                  <HttpCode code={check.status_code} />
                  <span className="metric metric-dim">
                    {recordsLabel(check)}
                    {check.records_returned !== null ? ' rec' : ''}
                  </span>
                </span>
                <span className="lane-state">
                  {open ? (
                    <>
                      <SeverityBadge severity={open.highest_severity} />
                      <span className="metric-dim">{open.open_alerts} open</span>
                    </>
                  ) : (
                    <span className="metric-dim">No open alerts</span>
                  )}
                  <span className="metric-dim lane-time">{timeAgo(check.checked_at)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
