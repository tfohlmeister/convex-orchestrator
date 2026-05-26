import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError, clearToken } from './api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000,
      staleTime: 2500,
      retry: (failureCount, error) => {
        // Auth errors are not transient — retrying them just keeps
        // useQuery in `isLoading: true` and locks the UI on "Loading…"
        // when the stored token is wrong. Surface immediately, clear
        // the bad token, and reload so the App re-prompts.
        if (error instanceof ApiError && error.status === 401) {
          clearToken();
          window.location.reload();
          return false;
        }
        return failureCount < 3;
      },
    },
  },
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
