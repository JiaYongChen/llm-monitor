import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import CurrencyProvider from './components/CurrencyProvider';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 3000, retry: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <CurrencyProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </BrowserRouter>
      </CurrencyProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
