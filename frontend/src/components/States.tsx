import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function LoadingRows({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="loading" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong while loading data.';
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
