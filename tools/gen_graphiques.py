#!/usr/bin/env python3
"""Génère les figures en couleur du document maître (PNG) dans docs/document-maitre/figures/.
Palette : palette catégorielle validée (ordre fixe), statuts réservés. Les figures fondées sur des
valeurs illustratives portent la mention « EXEMPLE — non opposable »."""
import os, json, re
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs/document-maitre/figures"); os.makedirs(OUT, exist_ok=True)
# Palette de marque : teal Groupe Nseya en tête, ordre validé (validateur CVD : toutes portes franchies)
CAT = ["#1BA996","#eb6834","#2a78d6","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"]
BRAND_DARK = "#0E5E55"
LOGO = os.path.join(ROOT, "docs/assets/logo-groupe-nseya.png")
STATUS = {"good":"#0ca30c","warning":"#fab219","serious":"#ec835a","critical":"#d03b3b"}
SURF, INK, INK2, MUTED, GRID, BASE = "#fcfcfb","#222B2A","#5F6B6A","#898781","#e1e0d9","#c3c2b7"
plt.rcParams.update({"font.family":"DejaVu Sans","font.size":10,"axes.edgecolor":BASE,"axes.labelcolor":INK2,
  "xtick.color":MUTED,"ytick.color":MUTED,"axes.facecolor":SURF,"figure.facecolor":SURF,"axes.grid":True,
  "grid.color":GRID,"grid.linewidth":0.6,"axes.spines.top":False,"axes.spines.right":False,"axes.axisbelow":True})

def title(ax, t, sub=None):
    ax.set_title(t, loc="left", fontsize=13, fontweight="bold", color=BRAND_DARK, pad=22 if sub else 10)
    if sub: ax.text(0, 1.02, sub, transform=ax.transAxes, fontsize=9, color=INK2)
def exemple(fig):
    fig.text(0.99, 0.01, "EXEMPLE — valeurs illustratives, non opposables", ha="right", fontsize=8, color=STATUS["critical"], style="italic")
def source(fig, s):
    fig.text(0.01, 0.01, "Source : "+s, ha="left", fontsize=7.5, color=MUTED)
def brand(fig):
    fig.add_artist(matplotlib.lines.Line2D([0,1],[0.999,0.999],transform=fig.transFigure,color=CAT[0],lw=4))
    img=plt.imread(LOGO); h=0.075; w=h*img.shape[1]/img.shape[0]*fig.get_figheight()/fig.get_figwidth()
    a=fig.add_axes([1-w-0.005,0.905,w,h]); a.imshow(img); a.axis("off")
def save(fig, name):
    brand(fig)
    fig.savefig(os.path.join(OUT, name), dpi=170, bbox_inches="tight"); plt.close(fig)
def bar_labels(ax, bars, fmt="{:,.0f}", horizontal=False):
    for b in bars:
        v = b.get_width() if horizontal else b.get_height()
        if horizontal: ax.text(v, b.get_y()+b.get_height()/2, " "+fmt.format(v).replace(",", " "), va="center", fontsize=9, color=INK)
        else: ax.text(b.get_x()+b.get_width()/2, v, fmt.format(v).replace(",", " "), ha="center", va="bottom", fontsize=9, color=INK)

# 1 Budget
fig, ax = plt.subplots(figsize=(8,4.2))
lab = ["2025\n(adopté)","2026\n(montant A)","2026\n(montant B)"]; val=[3696.2,3023.3,3223.6]
b = ax.bar(lab, val, color=[CAT[0],CAT[1],CAT[2]], width=0.55); bar_labels(ax,b,"{:,.1f}")
ax.set_ylabel("Milliards de CDF"); title(ax,"Budget de la Ville Province de Kinshasa","Deux montants 2026 circulent dans la presse — seul l'édit promulgué fait foi [À VÉRIFIER]")
source(fig,"presse économique congolaise, déc. 2024 – déc. 2025 ; Annexe A"); save(fig,"fig-budget-kinshasa.png")

# 2 IRL
fig, ax = plt.subplots(figsize=(8,4.2)); import numpy as np
x=np.arange(2); w=0.34
b1=ax.bar(x-w/2,[22,17],w,color=CAT[0],label="Taux de l'impôt (% du loyer perçu)")
b2=ax.bar(x+w/2,[20,15],w,color=CAT[1],label="Retenue à la source par le locataire (%)")
bar_labels(ax,b1,"{:.0f} %"); bar_labels(ax,b2,"{:.0f} %")
ax.set_xticks(x,["1er rang","2e, 3e et 4e rangs"]); ax.set_ylim(0,27); ax.legend(frameon=False,loc="upper right")
title(ax,"Impôt sur les revenus locatifs : taux et retenue","Le taux de 20 % cité dans la commande est la retenue du 1er rang, pas le taux de l'impôt")
source(fig,"communiqué du Gouvernement provincial relayé par la presse, fév. 2026 ; arrêté À VÉRIFIER"); save(fig,"fig-irl-taux.png")

# 3 IF barèmes (small multiples)
fig, axs = plt.subplots(1,3,figsize=(11,3.8))
rangs=["1er","2e","3e","4e"]
for ax,(t,v,u,c) in zip(axs,[("Personnes physiques — bâti",[450,150,50,10],"USD / an",CAT[0]),
                             ("Personnes morales",[3.5,2.5,2,1.5],"USD / m²",CAT[1]),
                             ("Sociétés immobilières",[8,5,4,3],"USD / m²",CAT[2])]):
    b=ax.bar(rangs,v,color=c,width=0.6); bar_labels(ax,b,"{:g}"); ax.set_title(t,fontsize=10,color=INK,loc="left"); ax.set_ylabel(u); ax.set_xlabel("Rang de localité")
fig.suptitle("Impôt foncier 2026 : barèmes rapportés par rang de localité",x=0.01,ha="left",fontweight="bold",fontsize=13)
source(fig,"presse économique, fév. 2026 ; arrêté de référence À VÉRIFIER"); fig.tight_layout(rect=(0,0.04,1,0.95)); save(fig,"fig-if-baremes.png")

# 4 Mobile money
fig, ax = plt.subplots(figsize=(8,3.4))
ops=["M-Pesa (Vodacom)","Airtel Money","Orange Money","Afrimoney"]; sh=[47.3,36.3,16.0,0.4]
b=ax.barh(ops[::-1],sh[::-1],color=[CAT[3],CAT[2],CAT[1],CAT[0]]); bar_labels(ax,b,"{:.1f} %",True)
ax.set_xlim(0,58); ax.set_xlabel("Part de marché (%)"); title(ax,"Monnaie mobile en RDC : parts de marché","≈ 24 millions de comptes actifs au T1 2024 — l'intégration multi-opérateurs est indispensable")
source(fig,"ARPTC via presse spécialisée, T2 2024 [PROBABLE]"); save(fig,"fig-mobile-money.png")

# 5 Benchmarks
fig, ax = plt.subplots(figsize=(8,3.8))
lab=["Kampala (KCCA)\nrecettes propres, 5 ans","Freetown\nimpôt foncier, 3 ans","Lagos\nLand Use Charge, 1 an"]; mult=[3.67,3.53,1.37]
b=ax.bar(lab,mult,color=[CAT[0],CAT[2],CAT[1]],width=0.55); bar_labels(ax,b,"×{:.2f}")
ax.axhline(1,color=BASE,lw=1); ax.set_ylabel("Multiple des recettes (base = 1)")
title(ax,"Réformes comparables : ordres de grandeur observés","Ce sont des références, pas des promesses pour Kinshasa")
source(fig,"IGC (Kampala) ; LoGRI/IDS (Freetown) ; presse nigériane (Lagos) — Annexe A"); save(fig,"fig-benchmarks.png")

# 6 Kananga
fig, ax = plt.subplots(figsize=(8,3.8))
red=[0,17,33,50]; comp=[5.6,6.7,10,13]
ax.plot(red,comp,color=CAT[0],lw=2,marker="o",ms=8,markeredgecolor=SURF,markeredgewidth=2)
for r,c in zip(red,comp): ax.annotate(f"{c:g} %",(r,c),textcoords="offset points",xytext=(0,10),ha="center",fontsize=9,color=INK)
ax.set_xlabel("Réduction du montant forfaitaire (%)"); ax.set_ylabel("Taux de conformité (%)"); ax.set_ylim(0,16)
title(ax,"Kananga (RDC) : la conformité réagit au niveau du forfait","Expérience sur 38 028 propriétés — recettes plus élevées à montant réduit")
source(fig,"Bergeron et al., Econometrica 2024 [CONFIRMÉ]"); save(fig,"fig-kananga.png")

# 7 Matrice gisements
fig, ax = plt.subplots(figsize=(9,5.6))
feas={"A":4,"A/B":3.5,"B":3,"B/C":2.5,"C":2,"C/D":1.5,"D":1}; pot={"Faible":1,"Faible à moyen":1.5,"Moyen":2,"Moyen à élevé":2.5,"Élevé":3,"Très élevé":4}
G=[("G01","A","Très élevé",1),("G02","A","Élevé",1),("G03","B","Élevé",1),("G04","A","Élevé",1),("G05","A","Très élevé",1),("G06","A","Élevé",1),("G07","A","Moyen à élevé",1),
   ("G08","A","Élevé",2),("G09","A","Élevé",2),("G10","A/B","Moyen",2),("G11","A/B","Élevé",2),("G12","A/B","Élevé",2),("G13","A","Élevé",2),("G14","A","Élevé",2),("G15","B/C","Moyen à élevé",2),
   ("G16","A/B","Moyen à élevé",3),("G17","B/C","Moyen",3),("G18","A","Moyen",3),("G19","A","Moyen",3),("G20","A","Faible à moyen",3),("G21","B/C","Moyen",3),("G29","B/C","Moyen",3),("G32","B/C","Moyen",3),
   ("G22","C","Faible à moyen",4),("G23","C","Faible",4),("G24","C","Faible",4),("G25","D","Moyen",4),("G26","C/D","Moyen",4),("G27","D","Élevé",4),("G28","D","Moyen",4)]
import random; random.seed(4)
pc={1:CAT[0],2:CAT[2],3:CAT[3],4:CAT[4]}
seen={}
for p in (1,2,3,4):
    pts=[]
    for g,f,q,pp in G:
        if pp!=p: continue
        key=(f,q); k=seen.get(key,0); seen[key]=k+1
        dx=[-0.2,0,0.2,-0.2,0,0.2,-0.2,0,0.2][k]; dy=[0.1,0.1,0.1,-0.1,-0.1,-0.1,0.3,0.3,0.3][k]
        pts.append((feas[f]+dx,pot[q]+dy,g))
    ax.scatter([a for a,_,_ in pts],[b for _,b,_ in pts],s=260,color=pc[p],edgecolor=SURF,linewidth=2,label=f"Priorité {p}",zorder=3)
    for a,b_,g in pts: ax.text(a,b_,g[1:],ha="center",va="center",fontsize=6.5,color="white",fontweight="bold",zorder=4)
ax.set_xticks([1,2,3,4],["D — loi\nnationale","C — acte\nprovincial","B — arrêté","A — droit\nexistant"]); ax.set_yticks([1,2,3,4],["Faible","Moyen","Élevé","Très élevé"])
ax.set_xlabel("Faisabilité juridique →"); ax.set_ylabel("Potentiel qualitatif →"); ax.legend(frameon=False,loc="lower left",ncol=4,bbox_to_anchor=(0,-0.32))
title(ax,"Matrice des gisements de recettes (G01–G33)","En haut à droite : droit existant et fort potentiel — à engager d'abord")
save(fig,"fig-matrice-gisements.png")

# 8 Echelle de la recette
fig, ax = plt.subplots(figsize=(9,5))
lv=["1 Potentiel estimé","2 Assiette vérifiée","3 Liquidé","4 Exigible","5 En retard","6 Contesté","7 Paiement initié","8 Paiement confirmé","9 Réglé compte public","10 Rapproché","11 Disponible budget"]
vv=[100,62,55,50,21,4,30,28,27.5,27,26]; cols=[CAT[0]]*2+[CAT[1]]*4+[CAT[2]]*2+[CAT[5]]*2+[CAT[6]]
b=ax.barh(lv[::-1],vv[::-1],color=cols[::-1]); bar_labels(ax,b,"{:g}",True); ax.set_xlim(0,112); ax.set_xlabel("Indice (potentiel estimé = 100)")
title(ax,"Échelle unifiée de la recette","Chaque niveau est mesuré séparément ; jamais additionnés entre eux"); exemple(fig); save(fig,"fig-echelle-recette.png")

# 9 Scenarios
fig, ax = plt.subplots(figsize=(8.5,4.2))
yrs=["Base\n2026","2027","2028","2029","2030","2031"]
S={"Conservateur":[100,108,118,128,138,146],"Attendu":[100,118,145,175,205,230],"Transformationnel":[100,130,180,240,300,350]}
for (k,v),c in zip(S.items(),[CAT[0],CAT[1],CAT[2]]):
    ax.plot(yrs,v,color=c,lw=2,marker="o",ms=8,markeredgecolor=SURF,markeredgewidth=2,label=k); ax.text(5.08,v[-1],k,color=INK,fontsize=9,va="center")
ax.set_ylabel("Recettes propres rapprochées (indice, base = 100)"); ax.set_xlim(-0.2,6.3); ax.legend(frameon=False,loc="upper left")
title(ax,"Trois scénarios de recettes additionnelles","À recalculer sur la base de référence mesurée (chapitre 38)"); exemple(fig); save(fig,"fig-scenarios.png")

# 10 Risk heat map
fig, ax = plt.subplots(figsize=(8,6))
import numpy as np
grid=np.add.outer(np.arange(1,6),np.arange(1,6))
cmap=matplotlib.colors.ListedColormap([STATUS["good"],"#9ad17a",STATUS["warning"],STATUS["serious"],STATUS["critical"]])
lvl=np.digitize(grid,[4,6,7,9])
ax.imshow(lvl,cmap=cmap,origin="lower",extent=(0.5,5.5,0.5,5.5),alpha=0.85); ax.grid(False)
R={"R01":(4,5),"R02":(3,5),"R03":(4,4),"R04":(3,4),"R05":(3,5),"R06":(4,4),"R07":(3,4),"R08":(4,3),"R09":(2,5),"R10":(3,4),"R11":(4,3),"R12":(3,3),"R13":(2,4),"R14":(3,4),"R15":(3,3),"R16":(2,4),"R17":(4,4),"R18":(3,3),"R19":(3,4),"R20":(2,3)}
from collections import defaultdict
cell=defaultdict(list)
for k,(p,i) in R.items(): cell[(p,i)].append(k)
for (p,i),ks in cell.items():
    ax.text(p,i,"\n".join(ks),ha="center",va="center",fontsize=8,color=INK,fontweight="bold")
ax.set_xticks(range(1,6),["Rare","Peu\nprobable","Possible","Probable","Quasi\ncertain"]); ax.set_yticks(range(1,6),["Mineur","Modéré","Significatif","Majeur","Critique"])
ax.set_xlabel("Probabilité"); ax.set_ylabel("Impact"); title(ax,"Cartographie des risques résiduels avant traitement","Identifiants du registre des risques (chapitre 40)")
save(fig,"fig-risques.png")

# 11 Roadmap gantt
fig, ax = plt.subplots(figsize=(12,4.8))
ph=[("Phase 0 — Mandat et mobilisation juridique",0,2),("Phase 1 — Découverte et architecture",1,4),("Phase 2 — Socle (R0 recensement → R1)",2,8),
    ("Phase 3 — Pilote 180 jours (4 communes)",4,10),("Phase 4 — Extension",10,18),("Phase 5 — Généralisation",16,26),("Phase 6 — Optimisation continue",24,30)]
for i,(n,s,e) in enumerate(ph[::-1]):
    ax.barh(i,e-s,left=s,color=CAT[len(ph)-1-i],height=0.55)
ax.set_yticks(range(len(ph)),[n for n,_,_ in ph[::-1]],color=INK,fontsize=9); months=["oct. 26","janv. 27","avr. 27","juil. 27","oct. 27","janv. 28","avr. 28","juil. 28","oct. 28","janv. 29","avr. 29"]
ax.set_xticks(range(0,31,3),months); ax.set_xlim(0,30)
ax.axvline(4.3,color=STATUS["critical"],lw=1.5,ls="--"); ax.text(4.45,-0.45,"Campagne IF/IRL — février 2027",fontsize=8,color=STATUS["critical"],va="center")
title(ax,"Feuille de route KINSHASA MOSOLO","Chaque phase est franchie par une porte d'approbation (chapitre 34)"); save(fig,"fig-feuille-de-route.png")

# 12-13 Evénements
data=open(os.path.join(ROOT,"specs/evenements-communication.yaml")).read()
ev=re.findall(r"- code: (\S+)\n    categorie: \"(\w+)\".*?canaux_defaut: \[(.*?)\]\n    whatsapp_optin: (\w+)\n    obligatoire: (\w+)",data,re.S)
ch=["email","in-app","sms","push","ussd","svi","courrier"]; cnt=[sum(c in [x.strip() for x in e[2].split(",")] for e in ev) for c in ch]
cnt.append(sum(e[3]=="true" for e in ev)); lab=["Courriel","Application","SMS","Push","USSD","SVI vocal","Courrier","WhatsApp\n(opt-in)"]
fig, ax = plt.subplots(figsize=(9,3.8)); b=ax.bar(lab,cnt,color=CAT,width=0.6); bar_labels(ax,b)
ax.set_ylabel("Événements diffusés par défaut"); title(ax,f"Couverture des canaux — {len(ev)} événements au catalogue",f"{sum(e[4]=='true' for e in ev)} avis obligatoires ignorent la désinscription")
save(fig,"fig-evenements-canaux.png")
from collections import Counter
cc=Counter(e[1] for e in ev); mc=Counter(e[1] for e in ev if e[4]=="true")
names=dict(re.findall(r'\("(\w+)", "([^"]+)", \[',open(os.path.join(ROOT,"tools/gen_evenements.py")).read()))
keys=sorted(cc,key=lambda k:cc[k])
fig, ax = plt.subplots(figsize=(9,7.5))
ax.barh([names[k] for k in keys],[cc[k]-mc.get(k,0) for k in keys],color=CAT[0],label="Facultatifs")
ax.barh([names[k] for k in keys],[mc.get(k,0) for k in keys],left=[cc[k]-mc.get(k,0) for k in keys],color=CAT[1],label="Obligatoires")
for i,k in enumerate(keys): ax.text(cc[k]+0.2,i,str(cc[k]),va="center",fontsize=8.5,color=INK)
ax.legend(frameon=False,loc="lower right"); ax.set_xlabel("Nombre d'événements"); title(ax,"Événements par catégorie")
save(fig,"fig-evenements-categories.png")

# 14 Tableau de bord Gouverneur (maquette)
fig=plt.figure(figsize=(13,8)); fig.patch.set_facecolor("#f9f9f7")
fig.text(0.02,0.965,"KINSHASA MOSOLO — Centre de commandement du Gouverneur",fontsize=15,fontweight="bold",color=BRAND_DARK)
fig.text(0.02,0.938,"Mercredi 10 février 2027 · données à 09:15 · consolidation 🇨🇩 CDF (bascule USD)".replace("🇨🇩 ",""),fontsize=9,color=INK2)
tiles=[("Confirmé aujourd'hui","4,82 Md CDF","▲ 12 % vs J-1",CAT[0]),("Réglé compte public","4,31 Md CDF","89 % du confirmé",CAT[2]),("Rapproché","4,12 Md CDF","96 % du réglé",CAT[5]),("Taux rapprochement J-1","97,4 %","cible ≥ 95 %",CAT[6]),("Alertes critiques","3","2 bénéficiaires, 1 annulations",STATUS["critical"])]
for i,(t,v,s,c) in enumerate(tiles):
    a=fig.add_axes([0.02+i*0.19,0.79,0.175,0.105]); a.set_xticks([]); a.set_yticks([]); a.grid(False)
    for sp in a.spines.values(): sp.set_visible(False)
    a.add_patch(FancyBboxPatch((0,0),1,1,boxstyle="round,pad=0,rounding_size=0.06",fc="white",ec=GRID,transform=a.transAxes))
    a.add_patch(FancyBboxPatch((0,0),0.025,1,boxstyle="square,pad=0",fc=c,ec=c,transform=a.transAxes))
    a.text(0.08,0.72,t,fontsize=9,color=INK2,transform=a.transAxes); a.text(0.08,0.35,v,fontsize=16,fontweight="bold",color=INK,transform=a.transAxes); a.text(0.08,0.1,s,fontsize=8,color=MUTED,transform=a.transAxes)
a1=fig.add_axes([0.05,0.43,0.40,0.30]); com=["Gombe","Limete","Ngaliema","Kalamu","Lemba","Masina","Kintambo","Bandal"]; vals=[1.42,0.98,0.87,0.55,0.41,0.33,0.25,0.21]
bb=a1.barh(com[::-1],vals[::-1],color=CAT[0]); bar_labels(a1,bb,"{:.2f}",True); a1.set_xlim(0,1.7); a1.set_title("Recettes confirmées par commune (Md CDF, jour)",loc="left",fontsize=10,color=INK)
a2=fig.add_axes([0.53,0.43,0.20,0.30]); a2.grid(False)
cats=["Impôt foncier","IRL","Véhicules","Taxes et droits"]; cv=[38,31,18,13]
a2.pie(cv,colors=CAT[:4],startangle=90,counterclock=False,wedgeprops=dict(width=0.38,edgecolor="white",linewidth=2)); a2.set_title("Par catégorie (%)",loc="left",fontsize=10,color=INK)
a2.legend([f"{c} {v} %" for c,v in zip(cats,cv)],frameon=False,loc="upper center",bbox_to_anchor=(0.5,0.02),ncol=2,fontsize=8.5)
a3=fig.add_axes([0.05,0.07,0.40,0.27]); d=list(range(1,11)); cum=[5,11,18,27,39,52,68,85,104,126]; tgt=[8,16,24,32,40,48,56,64,72,80]
a3.plot(d,cum,color=CAT[1],lw=2,marker="o",ms=5,label="Réalisé cumulé"); a3.plot(d,tgt,color=MUTED,lw=1.5,ls="--",label="Cible cumulée")
a3.set_title("Campagne IF/IRL : cumul vs cible (Md CDF)",loc="left",fontsize=10,color=INK); a3.legend(frameon=False,fontsize=8); a3.set_xlabel("Jours de campagne")
a4=fig.add_axes([0.53,0.07,0.44,0.27]); a4.set_xticks([]); a4.set_yticks([]); a4.grid(False)
for sp in a4.spines.values(): sp.set_visible(False)
a4.add_patch(FancyBboxPatch((0,0),1,1,boxstyle="round,pad=0,rounding_size=0.03",fc="white",ec=GRID,transform=a4.transAxes))
a4.text(0.03,0.88,"◆ Analyse IA — actions recommandées",fontsize=10.5,fontweight="bold",color=CAT[6],transform=a4.transAxes)
lines=["Situation : Kalamu à 41 % de sa cible, retard concentré sur l'IRL.","Analyse : 62 % des unités recensées n'ont pas de bail déclaré.","Risque : 0,9 Md CDF non mobilisé d'ici l'échéance du 28 février.","Recommandation : campagne SMS ciblée + 2 guichets mobiles.","Responsable : DG DGIPK · Échéance : 12 février · Confiance : moyenne","Enregistrement automatique : ✓ enregistré à 09:15"]
for i,l in enumerate(lines): a4.text(0.03,0.72-i*0.13,l,fontsize=9,color=INK if i<5 else STATUS["good"],transform=a4.transAxes)
a5=fig.add_axes([0.80,0.43,0.18,0.30]); a5.set_xticks([]); a5.set_yticks([]); a5.grid(False)
for sp in a5.spines.values(): sp.set_visible(False)
a5.set_title("Alertes critiques",loc="left",fontsize=10,color=INK)
al=[("Compte bénéficiaire :\nchangement proposé",STATUS["critical"]),("Pic d'annulations\nquartier Matonge",STATUS["serious"]),("Règlement opérateur B\nen retard de 26 h",STATUS["warning"])]
for i,(t,c) in enumerate(al):
    a5.add_patch(FancyBboxPatch((0,0.7-i*0.33),1,0.28,boxstyle="round,pad=0,rounding_size=0.04",fc=c,ec=c,alpha=0.18,transform=a5.transAxes))
    a5.text(0.05,0.84-i*0.33,"● "+t,fontsize=8.5,color=INK,transform=a5.transAxes,va="center")
exemple(fig); save(fig,"fig-tableau-de-bord-gouverneur.png")
print(sorted(os.listdir(OUT)))
