import { Suspense } from 'react';
import { lazyPage } from './lib/nouvelleVersion';
import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Splash } from './pages/Offline';
import { MODULE_ROUTES } from './modules/registry';
import { RouteGuard } from './components/RouteGuard';

const Home = lazyPage(() => import('./pages/Home'));
const Registration = lazyPage(() => import('./pages/Registration'));
const TaxpayerSpace = lazyPage(() => import('./pages/TaxpayerSpace'));
const Verify = lazyPage(() => import('./pages/Verify'));
const Governor = lazyPage(() => import('./pages/Governor'));
const Communications = lazyPage(() => import('./pages/Communications'));
const LegalRegister = lazyPage(() => import('./pages/LegalRegister'));
const Treasury = lazyPage(() => import('./pages/Treasury'));
const Field = lazyPage(() => import('./pages/Field'));
const Audit = lazyPage(() => import('./pages/Audit'));
const AIInbox = lazyPage(() => import('./pages/AIInbox'));
const Services = lazyPage(() => import('./pages/Services'));
const VerticalSpace = lazyPage(() => import('./pages/VerticalSpace'));
const NotFound = lazyPage(() => import('./pages/NotFound'));
const OfflinePage = lazyPage(() => import('./pages/Offline'));
const OuVaVotreArgent = lazyPage(() => import('./modules/agents-recettes/OuVaVotreArgent'));

export function App() {
  return (
    <Shell>
      <Suspense fallback={<Splash compact />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/accueil" element={<Home />} />
          <Route path="/inscription" element={<Registration />} />
          <Route path="/espace" element={<TaxpayerSpace />} />
          <Route path="/services" element={<Services />} />
          <Route path="/services/:slug" element={<VerticalSpace />} />
          <Route path="/verifier" element={<Verify />} />
          <Route path="/verifier/:code" element={<Verify />} />
          <Route path="/gouverneur" element={<Governor />} />
          <Route path="/communications" element={<Communications />} />
          <Route path="/registre" element={<LegalRegister />} />
          <Route path="/tresor" element={<Treasury />} />
          <Route path="/terrain" element={<Field />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/ia" element={<AIInbox />} />
          {MODULE_ROUTES.map((m) => <Route key={m.path} path={m.path} element={<RouteGuard roles={m.nav?.roles}><m.element /></RouteGuard>} />)}
          <Route path="/ou-va-votre-argent" element={<OuVaVotreArgent />} />
          <Route path="/hors-ligne" element={<OfflinePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
