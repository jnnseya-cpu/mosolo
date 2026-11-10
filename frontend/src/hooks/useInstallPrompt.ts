import { useEffect, useState } from 'react';

/** L'événement beforeinstallprompt est capturé dès le démarrage (main.tsx) puis partagé. */
let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; notify(); });
}

export function useInstallPrompt(): { canInstall: boolean; installed: boolean; standalone: boolean; install: () => Promise<void> } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const standalone = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  return {
    canInstall: !!deferred && !standalone,
    installed: installed || standalone,
    standalone,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      notify();
    },
  };
}
