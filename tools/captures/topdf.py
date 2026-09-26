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
SEC={'verification-publique':'Vérification publique','prestataires':'BitriPay et KODA','verticales-usagers':'Verticales — usagers','verticales-agents':'Verticales — agents'}
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
