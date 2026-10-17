import type { Health, Stats } from '../api/types';

interface Props {
  health: Health | undefined;
  healthError: boolean;
  stats: Stats | undefined;
  updatedAt: number;
  onOpenDemo: () => void;
}

function Indicator({ state, label, title }: { state: 'up' | 'down' | 'muted'; label: string; title: string }) {
  return (
    <li className={`indicator indicator-${state}`} title={title}>
      <span className="indicator-dot" aria-hidden="true" />
      {label}
    </li>
  );
}

export function Masthead({ health, healthError, stats, updatedAt, onOpenDemo }: Props) {
  const apiUp = !healthError && health !== undefined;
  const dbUp = health?.dependencies.database === 'up';
  const aiOn = health?.dependencies.llm === 'configured';

  return (
    <header className="masthead">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M3 17h6l3-8 5 15 3-7h9" />
        </svg>
        <div>
          <h1>API Triage</h1>
          <p className="brand-sub">Patient &amp; operational integrations</p>
        </div>
      </div>

      <ul className="indicators" aria-label="System status">
        <Indicator state={apiUp ? 'up' : 'down'} label={apiUp ? 'Backend online' : 'Backend unreachable'} title="Monitoring API reachability" />
        <Indicator state={apiUp ? (dbUp ? 'up' : 'down') : 'muted'} label={dbUp ? 'Database up' : 'Database down'} title="PostgreSQL connectivity" />
        <Indicator
          state={aiOn ? 'up' : 'muted'}
          label={aiOn ? `AI: ${stats?.config.llm_model ?? 'LLM'}` : 'AI off: rule-based text'}
          title={aiOn ? 'Alerts are explained by the configured LLM; rules still decide what is an anomaly' : 'No LLM key configured — alerts use deterministic text'}
        />
        <Indicator state={health?.dependencies.email === 'configured' ? 'up' : 'muted'} label={health?.dependencies.email === 'configured' ? 'E-mail on' : 'E-mail off'} title="Anomaly e-mail reports" />
      </ul>

      <div className="masthead-actions">
        <span className="refreshed" aria-live="off">
          Updated {updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}
        </span>
        <button type="button" className="btn btn-primary" onClick={onOpenDemo}>
          Send test events
        </button>
      </div>
    </header>
  );
}
