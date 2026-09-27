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
import { flushPendingDrafts, hydrateDrafts } from './lib/drafts';

captureInstallPrompt();
try {
  registerSW({ immediate: true });
} catch {
  // Service worker indisponible (contexte isolé, stockage bloqué) : l'application fonctionne en ligne, sans hors-ligne.
}
window.addEventListener('online', () => { void flushPendingDrafts(); });

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <AppProvider>
          <App />
        </AppProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

// Brouillons chiffrés : déchiffrement en mémoire avant le premier rendu (plafonné à 800 ms).
void Promise.race([hydrateDrafts(), new Promise((r) => setTimeout(r, 800))]).finally(render);
