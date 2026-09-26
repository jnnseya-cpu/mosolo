import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/fraunces/latin-400.css';
import '@fontsource/fraunces/latin-600.css';
import '@fontsource/fraunces/latin-400-italic.css';
import './styles.css';
import { AppProvider } from './context';
import { App } from './App';
import { captureInstallPrompt } from './hooks/useInstallPrompt';
import { flushPendingDrafts } from './lib/drafts';

captureInstallPrompt();
registerSW({ immediate: true });
window.addEventListener('online', () => { void flushPendingDrafts(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
