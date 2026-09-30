import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Splash } from './pages/Offline';
import { MODULE_ROUTES } from './modules/registry';
import { RouteGuard } from './components/RouteGuard';

const Home = lazy(() => import('./pages/Home'));
const Registration = lazy(() => import('./pages/Registration'));
const TaxpayerSpace = lazy(() => import('./pages/TaxpayerSpace'));
const Verify = lazy(() => import('./pages/Verify'));
const Governor = lazy(() => import('./pages/Governor'));
const Communications = lazy(() => import('./pages/Communications'));
const LegalRegister = lazy(() => import('./pages/LegalRegister'));
const Treasury = lazy(() => import('./pages/Treasury'));
const Field = lazy(() => import('./pages/Field'));
const Audit = lazy(() => import('./pages/Audit'));
const AIInbox = lazy(() => import('./pages/AIInbox'));
const Services = lazy(() => import('./pages/Services'));
const VerticalSpace = lazy(() => import('./pages/VerticalSpace'));
const NotFound = lazy(() => import('./pages/NotFound'));
const OfflinePage = lazy(() => import('./pages/Offline'));

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
          <Route path="/hors-ligne" element={<OfflinePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
