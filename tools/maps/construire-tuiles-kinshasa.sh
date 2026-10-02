#!/usr/bin/env bash
# Fabrique le fond de carte OpenStreetMap de la Ville-Province de Kinshasa (fichier PMTiles unique, auto-hébergé).
# Sortie : frontend/public/tiles/kinshasa.pmtiles (servi par MOSOLO, jamais par un tiers). Données © OpenStreetMap (ODbL).
#
# Option A (rapide, recommandée) : extraire l'emprise de Kinshasa de la carte mondiale Protomaps.
#   1. carte mondiale du jour (build.protomaps.com, 4 derniers jours) ;
#   2. à défaut, copie publique stable de la carte mondiale sur Source Cooperative (S3 us-west-2, objet fixe
#      « protomaps/openstreetmap/v4.pmtiles ») — c'est aussi la source de l'image Docker (reproductible).
#   Prérequis : l'outil « pmtiles » (https://github.com/protomaps/go-pmtiles/releases ; version épinglée dans le
#   Dockerfile), ou la variable PMTILES=/chemin/vers/pmtiles.
# Option B (entièrement souveraine) : fabriquer depuis l'extrait OSM de la RDC (Geofabrik) avec Planetiler (Java 21),
#   profil « protomaps basemap » : même schéma de couches, donc même style côté application.
# À relancer chaque mois (mises à jour OSM, contributions de la Ville : rues, marchés, parcelles).
#
# Variables facultatives :
#   MOSOLO_TUILES_SORTIE  fichier produit (défaut : frontend/public/tiles/kinshasa.pmtiles) ;
#   MOSOLO_TUILES_SOURCE  carte mondiale PMTiles à utiliser en option A (URL https) — saute la carte du jour ;
#   PMTILES               binaire « pmtiles » (défaut : celui du PATH).
# Contrôles à la sortie : signature « PMTiles », emprise de Kinshasa, mention « OpenStreetMap » dans l'attribution
# (licence ODbL : l'application affiche « © contributeurs OpenStreetMap »), empreinte SHA-256 journalisée et fiche
# « kinshasa.pmtiles.txt » (source, date, empreinte, licence) écrite à côté du fichier.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${MOSOLO_TUILES_SORTIE:-frontend/public/tiles/kinshasa.pmtiles}"
BBOX="15.05,-4.75,15.70,-4.15"   # lon min, lat min, lon max, lat max
MIROIR_STABLE="https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/protomaps/openstreetmap/v4.pmtiles"
PMTILES="${PMTILES:-pmtiles}"
mkdir -p "$(dirname "$OUT")"
MODE="${1:-A}"

# Contrôle du fichier produit (signature, attribution OpenStreetMap), empreinte et fiche d'origine.
verifier() {
  local source="$1" tmp="$2"
  if [ "$(head -c 7 "$tmp")" != "PMTiles" ]; then echo "Fichier produit invalide (signature PMTiles absente)." >&2; return 1; fi
  if command -v "$PMTILES" >/dev/null 2>&1; then
    local meta; meta="$("$PMTILES" show "$tmp" 2>/dev/null || true)"
    if ! grep -qi "attribution.*openstreetmap" <<<"$meta"; then
      echo "Attribution « OpenStreetMap » absente des métadonnées : fichier refusé (licence ODbL)." >&2; return 1
    fi
  fi
  mv -f "$tmp" "$OUT"
  local sha taille; sha="$(sha256sum "$OUT" | cut -d' ' -f1)"; taille="$(du -h "$OUT" | cut -f1)"
  {
    echo "Fond de carte OpenStreetMap de Kinshasa (KINSHASA MOSOLO)"
    echo "Source : $source"
    echo "Emprise : $BBOX (lon min, lat min, lon max, lat max)"
    echo "Fabriqué le : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "SHA-256 : $sha"
    echo "Taille : $taille"
    echo "Licence : Open Database License (ODbL) — © contributeurs OpenStreetMap, https://www.openstreetmap.org/copyright"
  } > "$OUT.txt"
  echo "Tuiles Kinshasa : $OUT ($taille) — source $source — SHA-256 $sha"
}

if [ "$MODE" = "A" ]; then
  TMP="${OUT%.pmtiles}.partiel.pmtiles"; rm -f "$TMP"
  SOURCES=()
  if [ -n "${MOSOLO_TUILES_SOURCE:-}" ]; then
    SOURCES+=("$MOSOLO_TUILES_SOURCE")
  else
    for d in 0 1 2 3; do SOURCES+=("https://build.protomaps.com/$(date -u -d "-$d day" +%Y%m%d).pmtiles"); done
    SOURCES+=("$MIROIR_STABLE")
  fi
  for src in "${SOURCES[@]}"; do
    echo "Extraction de l'emprise de Kinshasa depuis $src…"
    if "$PMTILES" extract "$src" "$TMP" --bbox="$BBOX" --maxzoom=16 && verifier "$src" "$TMP"; then exit 0; fi
    rm -f "$TMP"
  done
  echo "Échec de l'extraction (réseau ?) : essayez l'option B." >&2; exit 1
else
  mkdir -p data/osm
  curl -fL -o data/osm/rdc.osm.pbf https://download.geofabrik.de/africa/congo-democratic-republic-latest.osm.pbf
  echo "Extrait OSM de la RDC (Geofabrik) : SHA-256 $(sha256sum data/osm/rdc.osm.pbf | cut -d' ' -f1)"
  curl -fL -o data/osm/planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
  java -Xmx4g -jar data/osm/planetiler.jar --osm-path=data/osm/rdc.osm.pbf --bounds="$BBOX" --output="${OUT%.pmtiles}.partiel.pmtiles" --force
  verifier "Planetiler — Geofabrik congo-democratic-republic-latest.osm.pbf" "${OUT%.pmtiles}.partiel.pmtiles"
  echo "Tuiles Kinshasa (Planetiler) : $OUT"
fi
