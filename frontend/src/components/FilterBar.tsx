import { useEffect, useState } from 'react';
import { SEVERITIES, STATUSES, type AlertFilters, type Severity } from '../api/types';

interface Props {
  filters: AlertFilters;
  onChange: (next: Partial<AlertFilters>) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function FilterBar({ filters, onChange }: Props) {
  const [apiName, setApiName] = useState(filters.apiName);

  // Keep the input in sync when the filter is set elsewhere (e.g. clicking a vitals lane).
  useEffect(() => setApiName(filters.apiName), [filters.apiName]);

  useEffect(() => {
    if (apiName === filters.apiName) return;
    const timer = window.setTimeout(() => onChange({ apiName, offset: 0 }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [apiName, filters.apiName, onChange]);

  const toggleSeverity = (severity: Severity) => {
    const next = filters.severity.includes(severity) ? filters.severity.filter((s) => s !== severity) : [...filters.severity, severity];
    onChange({ severity: next, offset: 0 });
  };

  return (
    <div className="filters" role="search" aria-label="Filter alerts">
      <div className="segmented" role="radiogroup" aria-label="Status">
        {[...STATUSES, 'ALL' as const].map((status) => (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={filters.status === status}
            className={filters.status === status ? 'is-on' : ''}
            onClick={() => onChange({ status, offset: 0 })}
          >
            {status === 'ALL' ? 'All' : status.charAt(0) + status.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <fieldset className="chips">
        <legend className="visually-hidden">Severity</legend>
        {SEVERITIES.map((severity) => (
          <label key={severity} className={`chip chip-${severity.toLowerCase()}${filters.severity.includes(severity) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={filters.severity.includes(severity)} onChange={() => toggleSeverity(severity)} />
            {severity.charAt(0) + severity.slice(1).toLowerCase()}
          </label>
        ))}
      </fieldset>

      <label className="search">
        <span className="visually-hidden">API name</span>
        <input type="search" placeholder="Filter by API name" value={apiName} maxLength={100} onChange={(e) => setApiName(e.target.value)} />
      </label>

      {(filters.severity.length > 0 || filters.apiName || filters.status !== 'ACTIVE') && (
        <button type="button" className="btn btn-quiet" onClick={() => onChange({ status: 'ACTIVE', severity: [], apiName: '', offset: 0 })}>
          Reset filters
        </button>
      )}
    </div>
  );
}
