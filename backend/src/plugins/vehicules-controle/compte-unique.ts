/**
 * Chaîne véhicule RFCK (modules 82 à 84) — contribution au compte unique (ch. 9) : véhicules du registre RFCK rattachés
 * au compte (les véhicules déclarés comme objets fiscaux figurent déjà dans la section « objets »), contrôle technique,
 * rendez-vous et dossiers de fourrière.
 */
import type { AppContext } from '../../context.js';
import type { VehiculesControleService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: VehiculesControleService): void {
  ctx.compteUnique.register({
    module: 'vehicules', titre: 'Véhicules : contrôle technique, vignette, fourrière', lien: '/vehicules/mes-vehicules',
    collect: (tp) => {
      const plates = new Set<string>();
      for (const o of ctx.objects.byTaxpayer(tp).filter((x) => x.category === 'VEHICULE')) {
        const p = o.attributes['immatriculation'] ?? o.attributes['plaque'];
        if (typeof p === 'string') plates.add(svc.d.plate(p));
      }
      for (const v of svc.ct.vehicles.find((x) => x.taxpayerId === tp)) plates.add(v.plate);
      return [
        ...[...plates].map((plate) => {
          const st = svc.ct.status(plate);
          const pv = st.pv;
          return {
            rubrique: 'TITRE' as const, id: `CT-${plate}`, libelle: `Contrôle technique ${plate}`, nature: 'CONTROLE_TECHNIQUE',
            statut: pv ? pv.result : 'AUCUN_CONTROLE', ...(pv?.echeance ? { echeance: pv.echeance } : {}), lien: '/vehicules/mes-vehicules',
          };
        }),
        ...svc.ct.appointments.find((a) => a.taxpayerId === tp).map((a) => ({ rubrique: 'DEMARCHE' as const, id: a.id, libelle: `Rendez-vous de contrôle technique ${a.plate} (${a.date})`, nature: 'RENDEZ_VOUS', statut: a.status, date: a.createdAt, lien: '/vehicules/mes-vehicules' })),
        ...svc.fourriere.dossiers.find((x) => x.taxpayerId === tp).map((x) => ({ rubrique: 'ARRIERE' as const, id: x.id, libelle: `Dossier de fourrière ${x.plate}`, nature: 'FOURRIERE', statut: x.status, date: x.constat.at, ...(x.objectId ? { objectId: x.objectId } : {}), lien: '/vehicules/fourrieres' })),
      ];
    },
  });
}
