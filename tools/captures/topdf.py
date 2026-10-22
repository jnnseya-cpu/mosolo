import json,glob,os
from PIL import Image, ImageDraw, ImageFont
G='gallery'; D='/home/user/mosolo/docs/captures/galerie'
titles={}
for e in json.load(open(G+'/liste.json')): titles[(e.get('section'),e.get('id'))]=e.get('title') or e.get('titre')
PT={'01-choix-bitripay':'Contribuable — choix de la passerelle BitriPay','02-reference-bitripay':'Contribuable — référence et intention BitriPay (bac à sable)',
'03-choix-koda':'Contribuable — choix de la passerelle KODA','04-reference-koda':'Contribuable — référence et intention KODA (bac à sable)',
'05-console-prestataires':'Trésor — console des prestataires connectés','05-console-prestataires-page':'Trésor — console complète',
'06-confirmation-signee':'Trésor — webhook signé reçu, paiement confirmé','07-journal-webhooks':'Trésor — journal des webhooks signés'}
for k,v in PT.items(): titles[('prestataires',k)]=v
PC={'01-verifier-comment-lire':'Vérifier une preuve — comment lire la couleur (vert ≥ 50 %, ambre 1–50 %, rouge < 1 %)','02-ticket-stationnement-vert':'Ticket de stationnement — vert, compte à rebours en direct',
'03-support-publicitaire-ambre':'Autorisation publicitaire — ambre : 5 % restant (entre 1 % et 50 %), encore valable','04-certificat-pas-encore-actif':'Autorisation d’événement — pas encore active (gris)',
'05-impression-a6':'Preuve imprimée A6 — logo de la Ville, QR, échéancier des couleurs','06-impression-ticket-80mm':'Preuve imprimée — ticket thermique 80 mm','07-impression-ticket-58mm':'Preuve imprimée — ticket thermique 58 mm',
'08a-whatsapp-consentement':'WhatsApp — consentement explicite avant tout message','08b-whatsapp-verification':'WhatsApp — vérification d’un ticket par son code','08c-whatsapp-comment-payer':'WhatsApp — comment payer, sans aucun lien de paiement',
'09-sms-telephone-basique':'SMS « V + code » — téléphone basique, sans Internet','10-version-legere-accueil':'Version légère /l — sans JavaScript, moins de 10 Ko','11-version-legere-resultat-ambre':'Version légère — résultat ambre avec barre en caractères',
'12-version-legere-imprimable':'Version légère — version imprimable avec QR','13-stationnement-compte-a-rebours':'Stationnement — compte à rebours de la place payée','14-pass-wewa-compte-a-rebours':'Pass wewa — compte à rebours et impression','15-quitus-compte-a-rebours':'Quitus fiscal — compte à rebours et impression'}
PC.update({'16-bouton-scanner':'Vérifier une preuve — bouton « Scanner un QR code »','17-camera-en-direct':'Scanner — caméra en direct (détecteur du navigateur ou jsQR)',
'18-resultat-apres-scan':'Scanner — ticket reconnu dès que le QR imprimé est dans le cadre','19-resultat-apres-photo':'Scanner — secours par photo du QR (iPhone, page hors HTTPS, caméra refusée)'})
for k,v in PC.items(): titles[('preuves-canaux',k)]=v
TP={'01-lecture-plaque-camera':'Agent — lecture de la plaque à la caméra (OCR embarqué)','02-plaque-lue-a-confirmer':'Agent — plaque lue, à vérifier et confirmer (la machine propose, l’agent décide)',
'03-plaque-rouge-camera-ouverte':'Plaque rouge — la caméra de preuve géolocalisée s’ouvre d’elle-même','04-camera-de-preuve':'Caméra de preuve — les abords du véhicule, pas la plaque ; heure serveur, agent, GPS, lieu',
'05-cinq-photos-prises':'Cinq vues des abords : devant, derrière, côté droit, côté gauche, autre','06-constat-enregistre-photos':'Constat enregistré avec ses photos horodatées (empreinte SHA-256)',
'07-penalites-usager-au-controle':'Agent du module — pénalités de l’usager au contrôle de sa plaque','08-mes-gains-10-pourcent':'Agent du stationnement — « Mes gains » : 10 % des pénalités et paiements générés',
'08b-mes-gains-page':'Agent — « Mes gains », page complète','09-verification-avec-photos':'Superviseur — vérification du constat avec les photos',
'10-regie-commissions-agents':'Régie — commissions de tous les agents, tous modules (10 %)','11-autre-module-penalite-30-jours':'Autre module — pénalité impayée depuis plus de 30 jours, visible avec son montant après un contrôle','12-mes-gains-agent-verticales':'Agent des verticales — « Mes gains » : 10 % aussi, dans son module'}
for k,v in TP.items(): titles[('terrain-parking',k)]=v
SEC={'terrain-parking':'Terrain : plaque, preuves des abords, pénalités, gains de tous les agents','preuves-canaux':'Preuves et canaux sans application','verification-publique':'Vérification publique','prestataires':'BitriPay et KODA','verticales-usagers':'Verticales — usagers','verticales-agents':'Verticales — agents'}
try: F=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',34); f2=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',24)
except: F=f2=ImageFont.load_default()
pages=[]
for sec in SEC:
  for dev in ['telephone','ordinateur']:
    for p in sorted(glob.glob(f'{G}/{sec}/{dev}/*.png')):
      i=Image.open(p).convert('RGB'); n=os.path.basename(p)[:-4]
      out=f'{D}/{sec}/{dev}'; os.makedirs(out,exist_ok=True); i.save(f'{out}/{n}.jpg',quality=82,optimize=True)
      if n.endswith('-page'): continue
      W=1600; H=1100; pg=Image.new('RGB',(W,H),'white'); d=ImageDraw.Draw(pg)
      d.rectangle((0,0,W,90),fill='#1f2a6b'); d.text((30,24),f"{SEC[sec]} · {'Téléphone' if dev=='telephone' else 'Ordinateur'}",fill='white',font=F)
      d.text((30,105),titles.get((sec,n),n),fill='black',font=f2)
      t=i.copy(); t.thumbnail((W-60,H-170)); pg.paste(t,((W-t.width)//2,150))
      d.text((30,H-36),'Données de démonstration fictives — non opposables',fill='#8a6d00',font=f2)
      pages.append(pg)
pages[0].save('/home/user/mosolo/docs/captures/KINSHASA_MOSOLO_Galerie_Verification_Prestataires_Verticales.pdf',save_all=True,append_images=pages[1:],resolution=150)
print(len(pages))
