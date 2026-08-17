import React, { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';

const Overview = lazy(() => import('./pages/Overview'));
const ToolDetail = lazy(() => import('./pages/ToolDetail'));
const ProviderDetail = lazy(() => import('./pages/ProviderDetail'));
const SessionDetail = lazy(() => import('./pages/SessionDetail'));
const CallDetail = lazy(() => import('./pages/CallDetail'));
const Settings = lazy(() => import('./pages/Settings'));

/** 路由切换时的加载占位 */
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
      加载中…
    </div>
  );
}

export default function App() {
  return (
    <Layout>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/tools/:tool" element={<ToolDetail />} />
          <Route path="/providers/:provider" element={<ProviderDetail />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
