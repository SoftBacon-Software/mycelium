import { useEffect } from 'react';
import { useDashboardStore } from '../stores/dashboardStore';

export function usePolling(intervalMs = 10_000) {
  const refresh = useDashboardStore((s) => s.refresh);
  const lastRefresh = useDashboardStore((s) => s.lastRefresh);
  const loading = useDashboardStore((s) => s.loading);
  const error = useDashboardStore((s) => s.error);

  useEffect(() => {
    // Initial fetch on mount
    refresh();

    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { lastRefresh, loading, error };
}
