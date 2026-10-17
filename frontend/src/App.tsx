import { useCallback, useEffect, useState } from 'react';
import type { Alert, AlertFilters } from './api/types';
import { AlertDetail } from './components/AlertDetail';
import { AlertsTable } from './components/AlertsTable';
import { DemoPanel } from './components/DemoPanel';
import { FilterBar } from './components/FilterBar';
import { Masthead } from './components/Masthead';
import { EmptyState, ErrorState, LoadingRows } from './components/States';
import { Tally } from './components/Tally';
import { VitalsStrip } from './components/VitalsStrip';
import { useAlerts, useHealth, useStats } from './hooks/useMonitoring';

const PAGE_SIZE = 15;
const DEFAULT_FILTERS: AlertFilters = { status: 'ACTIVE', severity: [], apiName: '', limit: PAGE_SIZE, offset: 0 };

/** `?alert=<id>` deep links (used by alert e-mails) open the detail panel. */
function readAlertParam(): string | null {
  const id = new URLSearchParams(window.location.search).get('alert');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function App() {
  const [filters, setFilters] = useState<AlertFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(readAlertParam);
  const [demoOpen, setDemoOpen] = useState(false);

  const stats = useStats();
  const health = useHealth();
  const alerts = useAlerts(filters);

  const updateFilters = useCallback((next: Partial<AlertFilters>) => setFilters((current) => ({ ...current, ...next })), []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set('alert', selectedId);
    else url.searchParams.delete('alert');
    window.history.replaceState(null, '', url);
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !demoOpen) setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [demoOpen]);

  const noData = stats.data && stats.data.total_checks === 0;

  return (
    <div className="shell">
      <Masthead
        health={health.data}
        healthError={health.isError}
        stats={stats.data}
        updatedAt={Math.max(stats.dataUpdatedAt, alerts.dataUpdatedAt)}
        onOpenDemo={() => setDemoOpen(true)}
      />

      <main className={`layout${selectedId ? ' has-detail' : ''}`}>
        <div className="primary">
          {stats.isLoading && <LoadingRows rows={3} label="Loading API health" />}
          {stats.isError && <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />}
          {stats.data && <Tally stats={stats.data} />}
          {stats.data && stats.data.api_health.length > 0 && (
            <VitalsStrip stats={stats.data} onSelectApi={(apiName) => updateFilters({ apiName, status: 'ALL', offset: 0 })} />
          )}

          <section className="alerts-section" aria-labelledby="alerts-title">
            <div className="section-head">
              <h2 id="alerts-title">Alerts</h2>
              <p className="section-note">Most severe first, then most recent. Repeats of the same anomaly are grouped into one alert.</p>
            </div>
            <FilterBar filters={filters} onChange={updateFilters} />

            {alerts.isLoading && <LoadingRows rows={6} label="Loading alerts" />}
            {alerts.isError && <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />}
            {alerts.data && alerts.data.data.length === 0 && (
              noData ? (
                <EmptyState title="No monitoring data yet">
                  <p>Send the sample batch to see how anomalies are detected and explained.</p>
                  <button type="button" className="btn btn-primary" onClick={() => setDemoOpen(true)}>
                    Send test events
                  </button>
                </EmptyState>
              ) : (
                <EmptyState title={filters.status === 'ACTIVE' && filters.severity.length === 0 && !filters.apiName ? 'No active alerts' : 'No alerts match these filters'}>
                  <p>{filters.status === 'ACTIVE' ? 'Every monitored API passed its latest checks, or open alerts were acknowledged.' : 'Change or reset the filters to see more.'}</p>
                </EmptyState>
              )
            )}
            {alerts.data && alerts.data.data.length > 0 && (
              <AlertsTable
                list={alerts.data}
                selectedId={selectedId}
                onSelect={(alert: Alert) => setSelectedId(alert.id)}
                onPage={(offset) => updateFilters({ offset })}
              />
            )}
          </section>
        </div>

        {selectedId && (
          <AlertDetail key={selectedId} alertId={selectedId} aiEnabled={health.data?.dependencies.llm === 'configured'} onClose={() => setSelectedId(null)} />
        )}
      </main>

      <DemoPanel open={demoOpen} onClose={() => setDemoOpen(false)} />
    </div>
  );
}
