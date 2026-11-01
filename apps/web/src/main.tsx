import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/red-hat-text/wght.css';
import '@fontsource-variable/red-hat-text/wght-italic.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { captureInstallPrompt } from './install';
import { registerServiceWorker } from './push';

// Notifications only: the service worker caches nothing.
registerServiceWorker();
// Android browsers offer their install dialog once, early: keep it for the "Get the app" sheet.
captureInstallPrompt();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
