#!/usr/bin/env bash
# Fabrique le fond de carte OpenStreetMap de la Ville-Province de Kinshasa (fichier PMTiles unique, auto-hébergé).
# Sortie : frontend/public/tiles/kinshasa.pmtiles (servi par MOSOLO, jamais par un tiers). Données © OpenStreetMap (ODbL).
#
# Option A (rapide, recommandée) : extraire l'emprise de Kinshasa de la carte mondiale Protomaps du jour.
#   Prérequis : l'outil « pmtiles » (https://github.com/protomaps/go-pmtiles/releases).
# Option B (entièrement souveraine) : fabriquer depuis l'extrait OSM de la RDC (Geofabrik) avec Planetiler (Java 21),
#   profil « protomaps basemap » : même schéma de couches, donc même style côté application.
# À relancer chaque mois (mises à jour OSM, contributions de la Ville : rues, marchés, parcelles).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=frontend/public/tiles/kinshasa.pmtiles
BBOX="15.05,-4.75,15.70,-4.15"   # lon min, lat min, lon max, lat max
mkdir -p "$(dirname "$OUT")"
MODE="${1:-A}"
if [ "$MODE" = "A" ]; then
  for d in 0 1 2 3; do
    DAY=$(date -u -d "-$d day" +%Y%m%d)
    if pmtiles extract "https://build.protomaps.com/${DAY}.pmtiles" "$OUT" --bbox="$BBOX" --maxzoom=16; then
      echo "Tuiles Kinshasa (${DAY}) : $OUT ($(du -h "$OUT" | cut -f1))"; exit 0
    fi
  done
  echo "Échec de l'extraction (réseau ?) : essayez l'option B." >&2; exit 1
else
  mkdir -p data/osm
  curl -fL -o data/osm/rdc.osm.pbf https://download.geofabrik.de/africa/congo-democratic-republic-latest.osm.pbf
  curl -fL -o data/osm/planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
  java -Xmx4g -jar data/osm/planetiler.jar --osm-path=data/osm/rdc.osm.pbf --bounds="$BBOX" --output="$OUT" --force
  echo "Tuiles Kinshasa (Planetiler) : $OUT"
fi
