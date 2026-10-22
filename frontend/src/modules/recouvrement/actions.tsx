/** Aides d'action partagées des écrans de recouvrement : message de retour (erreur backend en clair) et exécution. */
import { useState } from 'react';
import { errText } from './types';

export type ActionMsg = { ok: boolean; text: string } | null;

export function Msg({ msg }: { msg: ActionMsg }) {
  if (!msg) return null;
  return <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>;
}

export function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ActionMsg>(null);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); onDone(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }
  return { busy, msg, run };
}
