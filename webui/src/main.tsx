import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import CurrencyProvider from './components/CurrencyProvider';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // 静态数据 60s 内视为新鲜，避免每次 focus/mount 都重新请求
      staleTime: 60_000,
      // 不在窗口级别统一设置 refetchInterval — 需要轮询的查询自行声明间隔
    },
  },
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
