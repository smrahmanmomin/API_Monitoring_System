import type { Alert, AlertList } from '../api/types';
import { anomalyLabel, formatMs, recordsLabel, timeAgo, formatDateTime } from '../lib/format';
import { DemoTag, HttpCode, SeverityBadge, SourceTag, StatusTag } from './Badges';

interface Props {
  list: AlertList;
  selectedId: string | null;
  onSelect: (alert: Alert) => void;
  onPage: (offset: number) => void;
}

export function AlertsTable({ list, selectedId, onSelect, onPage }: Props) {
  const { total, limit, offset, has_more } = list.pagination;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + list.data.length;

  return (
    <>
      <div className="table-wrap">
        <table className="alerts">
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Alert</th>
              <th scope="col" className="num">HTTP</th>
              <th scope="col" className="num">Latency</th>
              <th scope="col" className="num">Records</th>
              <th scope="col" className="num">Seen</th>
              <th scope="col">Last seen</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((alert) => {
              const check = alert.latest_check;
              const selected = alert.id === selectedId;
              return (
                <tr key={alert.id} className={selected ? 'is-selected' : undefined} aria-selected={selected}>
                  <td data-label="Severity">
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td data-label="Alert" className="alert-cell">
                    <button type="button" className="row-link" onClick={() => onSelect(alert)}>
                      <span className="alert-api">{alert.api_name}</span>
                      <span className="alert-type">{anomalyLabel(alert.anomaly_type)}</span>
                    </button>
                    <span className="alert-title">
                      {alert.title} <SourceTag source={alert.generation.source} model={alert.generation.model} />
                      {check?.source === 'DEMO' ? <DemoTag /> : null}
                    </span>
                  </td>
                  <td data-label="HTTP" className="num">{check ? <HttpCode code={check.status_code} /> : '—'}</td>
                  <td data-label="Latency" className="num mono">{check ? formatMs(check.response_time_ms) : '—'}</td>
                  <td data-label="Records" className="num mono">{check ? recordsLabel(check) : '—'}</td>
                  <td data-label="Seen" className="num mono" title="Occurrences grouped into this alert">
                    ×{alert.occurrence_count}
                  </td>
                  <td data-label="Last seen" className="mono" title={formatDateTime(alert.last_seen_at)}>
                    {timeAgo(alert.last_seen_at)}
                  </td>
                  <td data-label="Status">
                    <StatusTag status={alert.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Alert pages">
        <span className="mono">
          {from}–{to} of {total}
        </span>
        <button type="button" className="btn btn-quiet" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button type="button" className="btn btn-quiet" disabled={!has_more} onClick={() => onPage(offset + limit)}>
          Next
        </button>
      </nav>
    </>
  );
}
