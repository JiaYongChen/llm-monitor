import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SessionDetail from './pages/SessionDetail';
import CallDetail from './pages/CallDetail';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
        <Route path="/calls/:id" element={<CallDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}
