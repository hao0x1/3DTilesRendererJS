import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      window.dispatchEvent(new Event('moonda-offline-error'));
      // A local static server still works without a service worker. The application
      // never depends on registration succeeding to display or analyze NASA data.
    });
  });
}
