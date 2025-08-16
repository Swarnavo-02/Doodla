import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import App from './App';
import Setup from './Setup';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <BrowserRouter>
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/room" element={<App />} />
      <Route path="*" element={<Navigate to="/setup" replace />} />
    </Routes>
  </BrowserRouter>
);
