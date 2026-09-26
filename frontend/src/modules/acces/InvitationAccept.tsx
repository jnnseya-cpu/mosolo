/**
 * Finalisation d'une invitation par la personne invitée (§ 12A.5) : lien à usage unique, lié au numéro invité,
 * code reçu, pièce d'identité, photographie, second facteur (clé d'accès obligatoire pour les rôles sensibles).
 */
import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip, StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { REQUIREMENT_LABEL, SandboxBox, Status, useAction } from './common';
import './acces.css';

interface Lookup {
  id: string; entity: { id: string; name: string }; accessLevel: string; accessLevelLabel: string; roleLabels: string[]; phoneMasked: string;
  expiresAt: string; status: string; sensitive: boolean; requirement: string | null; passkeyRequired: boolean; deviceRequired: boolean;
}
interface Result { accountId: string; status: string; requirement: string | null; message: string }

export default function InvitationAccept() {
  const { fmtDate, setUserId } = useApp();
  const loc = useLocation();
  const [token, setToken] = useState(() => new URLSearchParams(loc.search).get('jeton') ?? '');
  const [typed, setTyped] = useState(token);
  const look = useApi(() => (token.length >= 16 ? api<Lookup>(`/v1/acces/invitations/lookup?token=${encodeURIComponent(token)}`) : Promise.resolve(null)), [token]);
  const act = useAction(undefined);
  const [f, setF] = useState({ phone: '', code: '', docType: 'Carte d’électeur', docNumber: '', photo: false, mfa: 'PASSKEY', device: '' });
  const [res, setRes] = useState<Result | null>(null);
  const inv = look.data;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api<Result>('/v1/acces/invitations/accept', {
      method: 'POST',
      body: {
        token, phone: f.phone.replace(/[\s-]/g, ''), code: f.code, identityDocument: { type: f.docType, number: f.docNumber }, photoTaken: f.photo,
        mfaMethod: f.mfa, ...(f.device ? { deviceId: f.device } : {}),
      },
    }));
    if (r) setRes(r);
  }

  return (
    <div className="page">
      <PageHead eyebrow="Compte de travail" title="Finaliser mon invitation" lead="Seul votre lien personnel permet de finaliser l’inscription. Il ne sert qu’une fois, expire et ne fonctionne qu’avec le numéro invité. Personne — pas même un agent — ne doit vous demander votre code." />
      {!token && (
        <form className="panel form" onSubmit={(e) => { e.preventDefault(); setToken(typed.trim()); }}>
          <div className="field"><label className="label" htmlFor="ia-t">Jeton du lien reçu</label><input id="ia-t" className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
          <button type="submit" className="btn btn-primary">Ouvrir l’invitation</button>
        </form>
      )}
      {look.loading && <Loading />}
      {look.error !== null && <ErrorState error={look.error} />}
      {inv && !res && (
        <div className="ac-grid ac-grid-even">
          <section className="panel" aria-labelledby="ia-sum">
            <h2 className="panel-title" id="ia-sum">Invitation</h2>
            <dl className="ac-kv">
              <dt>Entité</dt><dd>{inv.entity.name}</dd>
              <dt>Niveau d’accès</dt><dd>{inv.accessLevelLabel}</dd>
              <dt>Rôles</dt><dd><div className="ac-chips">{inv.roleLabels.map((r) => <Chip key={r}>{r}</Chip>)}</div></dd>
              <dt>Numéro invité</dt><dd className="mono">{inv.phoneMasked}</dd>
              <dt>Échéance</dt><dd>{fmtDate(inv.expiresAt, true)}</dd>
              <dt>État</dt><dd><Status s={inv.status} /></dd>
            </dl>
            {inv.requirement && <p className="ac-guard ac-guard-warn" style={{ marginTop: 12 }}><Icon name="shieldCheck" size={16} /> <span>{REQUIREMENT_LABEL[inv.requirement]} : votre compte restera inactif jusqu’à cette validation.</span></p>}
          </section>
          {inv.status === 'ENVOYEE' ? (
            <form className="panel form" onSubmit={(e) => void submit(e)} aria-label="Vérification d’identité">
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="ia-p">Votre numéro</label><input id="ia-p" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></div>
                <div className="field"><label className="label" htmlFor="ia-c">Code reçu</label><input id="ia-c" className="mono ac-code-input" inputMode="numeric" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} required /></div>
              </div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="ia-dt">Pièce d’identité</label><input id="ia-dt" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="ia-dn">Numéro de la pièce</label><input id="ia-dn" value={f.docNumber} onChange={(e) => setF({ ...f, docNumber: e.target.value })} required /></div>
              </div>
              <label className="ac-check"><input type="checkbox" checked={f.photo} onChange={(e) => setF({ ...f, photo: e.target.checked })} /> Photographie prise (démonstration)</label>
              <fieldset className="field"><legend className="label">Second facteur que vous définissez vous-même</legend>
                <div className="radio-list">
                  {[['PASSKEY', 'Clé d’accès (résistante à l’hameçonnage)'], ['TOTP', 'Application d’authentification'], ['SMS', 'Code par SMS']].map(([k, l]) => (
                    <label key={k} className={`radio ${f.mfa === k ? 'checked' : ''}`}><input type="radio" name="mfa" checked={f.mfa === k} onChange={() => setF({ ...f, mfa: k! })} /><span>{l}{inv.passkeyRequired && k !== 'PASSKEY' ? ' — refusé pour ce rôle' : ''}</span></label>
                  ))}
                </div>
              </fieldset>
              {inv.deviceRequired && <div className="field"><label className="label" htmlFor="ia-d">Terminal de terrain enregistré</label><input id="ia-d" className="mono" value={f.device} onChange={(e) => setF({ ...f, device: e.target.value })} placeholder="dev-terrain-…" /></div>}
              {act.node}
              <button type="submit" className="btn btn-primary btn-block" disabled={act.busy || !f.photo || f.code.length !== 6}><Icon name="check" size={18} /> Finaliser mon inscription</button>
              {f.phone.replace(/[\s-]/g, '').length >= 9 && <SandboxBox to={f.phone.replace(/[\s-]/g, '')} title="Mes SMS (bac à sable)" />}
            </form>
          ) : <section className="panel"><p>Cette invitation n’est plus utilisable ({inv.status.toLowerCase()}). Demandez une nouvelle invitation à votre administrateur.</p></section>}
        </div>
      )}
      {res && (
        <section className="panel result-card" role="status">
          <StatusBadge tone={res.status === 'ACTIF' ? 'good' : 'warning'} label={res.status === 'ACTIF' ? 'Compte actif' : 'En attente'} />
          <p>{res.message}</p>
          {res.requirement && <p className="small">{REQUIREMENT_LABEL[res.requirement]}</p>}
          <p className="small muted">Identifiant de démonstration : <span className="mono">{res.accountId}</span></p>
          <button type="button" className="btn btn-secondary" onClick={() => { setUserId(res.accountId); window.location.assign('/acces/invitations'); }}>Utiliser ce compte (démonstration)</button>
        </section>
      )}
    </div>
  );
}
