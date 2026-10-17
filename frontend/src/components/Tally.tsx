import type { Stats } from '../api/types';

/** Compact counters — deliberately small; the alerts list is the main event. */
export function Tally({ stats }: { stats: Stats }) {
  const items = [
    { label: 'Active alerts', value: stats.alerts.active, emphasis: stats.alerts.active > 0 },
    { label: 'Critical / high', value: stats.alerts.critical_or_high_active, emphasis: stats.alerts.critical_or_high_active > 0, danger: true },
    { label: 'Acknowledged', value: stats.alerts.acknowledged },
    { label: 'APIs with anomalies', value: `${stats.affected_apis.length} / ${stats.monitored_apis}` },
    { label: 'Checks recorded', value: stats.total_checks.toLocaleString('en-US'), hint: `${stats.checks_last_24h.toLocaleString('en-US')} in last 24h` },
  ];
  return (
    <dl className="tally">
      {items.map((item) => (
        <div key={item.label} className={`tally-item${item.emphasis ? ' is-hot' : ''}${item.danger ? ' is-danger' : ''}`}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.hint ? <small>{item.hint}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
