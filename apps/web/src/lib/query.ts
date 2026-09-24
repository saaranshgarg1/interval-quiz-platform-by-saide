import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api';

/**
 * Shared query client. Server state lives here — pages read via hooks in
 * `src/lib/queries.ts` and never hand-roll fetch/loading/error again.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry client errors (401/403/404/409) — they won't fix themselves.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
