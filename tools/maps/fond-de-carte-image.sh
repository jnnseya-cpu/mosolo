#!/usr/bin/env bash
# Étape « fond-de-carte » de l'image Docker (Dockerfile racine, donc aussi `gcloud run deploy --source .`,
# infra/gcp/cloudbuild.yaml et infra/vps) : fabrique le fond OpenStreetMap de Kinshasa pendant la construction.
#
#   bash tools/maps/fond-de-carte-image.sh <dossier de sortie>      (défaut : /tuiles)
#
# - Outil « pmtiles » ÉPINGLÉ (version et empreintes SHA-256 ci-dessous, vérifiées avant exécution).
# - Source ÉPINGLÉE : copie publique stable de la carte mondiale Protomaps (MOSOLO_TUILES_SOURCE, objet fixe) ;
#   son ETag et l'empreinte SHA-256 du fichier produit sont journalisés. Même source + même emprise = même fichier.
# - Ne fait JAMAIS échouer la construction : sans réseau, source injoignable ou contrôle refusé, un AVERTISSEMENT
#   clair est affiché et l'image est construite sans fond de carte (les cartes affichent alors le message
#   « Fond OpenStreetMap de Kinshasa non encore installé… » et les seules couches MOSOLO, comme avant).
# - MOSOLO_FOND_DE_CARTE=0 : étape sautée (construction hors ligne volontaire).
# Téléchargements par Node (présent dans l'image de base) : aucun paquet système à installer.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 0
SORTIE="${1:-/tuiles}"
PMTILES_VERSION="1.31.2"
SOURCE="${MOSOLO_TUILES_SOURCE:-https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/protomaps/openstreetmap/v4.pmtiles}"

avertir() {
  echo "======================================================================================================"
  echo "AVERTISSEMENT — fond de carte OpenStreetMap de Kinshasa NON fabriqué : $1"
  echo "L'image est construite quand même, SANS fond de carte : les cartes afficheront le message"
  echo "« Fond OpenStreetMap de Kinshasa non encore installé sur ce serveur » et les seules couches MOSOLO."
  echo "Pour l'installer : reconstruire l'image avec accès réseau (voir infra/gcp/README.md, « Fond de carte »),"
  echo "ou lancer tools/maps/construire-tuiles-kinshasa.sh puis reconstruire."
  echo "======================================================================================================"
}

mkdir -p "$SORTIE" || exit 0
if [ "${MOSOLO_FOND_DE_CARTE:-1}" = "0" ]; then echo "Fond de carte : étape sautée (MOSOLO_FOND_DE_CARTE=0)."; exit 0; fi

case "${TARGETARCH:-$(uname -m)}" in
  amd64 | x86_64) ARCH="x86_64"; SHA="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f" ;;
  arm64 | aarch64) ARCH="arm64"; SHA="f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1" ;;
  *) avertir "architecture non prise en charge (${TARGETARCH:-$(uname -m)})"; exit 0 ;;
esac

TRAVAIL="$(mktemp -d)"
trap 'rm -rf "$TRAVAIL"' EXIT
URL_OUTIL="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${ARCH}.tar.gz"
echo "Fond de carte : outil pmtiles ${PMTILES_VERSION} (${ARCH}) — ${URL_OUTIL}"
# Téléchargement + contrôle d'empreinte (refus si l'empreinte diffère de celle épinglée).
# shellcheck disable=SC2016  # code JavaScript : les « ${…} » sont des gabarits JavaScript, pas des variables shell.
if ! node --input-type=module -e '
  import { createHash } from "node:crypto"; import { writeFileSync } from "node:fs";
  const [url, attendu, sortie] = process.argv.slice(1);
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) }).catch((e) => { console.error(`Téléchargement impossible : ${e.cause?.code ?? e.message}`); process.exit(1); });
  if (!r.ok) { console.error(`HTTP ${r.status} pour ${url}`); process.exit(1); }
  const octets = Buffer.from(await r.arrayBuffer());
  const sha = createHash("sha256").update(octets).digest("hex");
  if (sha !== attendu) { console.error(`Empreinte SHA-256 inattendue : ${sha} (attendu ${attendu})`); process.exit(1); }
  writeFileSync(sortie, octets); console.log(`Outil vérifié : SHA-256 ${sha}`);
' "$URL_OUTIL" "$SHA" "$TRAVAIL/pmtiles.tar.gz"; then
  avertir "téléchargement ou contrôle d'empreinte de l'outil pmtiles impossible (réseau ?)"; exit 0
fi
tar -xzf "$TRAVAIL/pmtiles.tar.gz" -C "$TRAVAIL" pmtiles || { avertir "archive de l'outil pmtiles illisible"; exit 0; }

# Certificats racine pour l'outil (Go) : ceux du système s'ils existent, sinon ceux embarqués dans Node.
if [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ -z "${SSL_CERT_FILE:-}" ]; then
  node -e 'console.log(require("node:tls").rootCertificates.join("\n"))' > "$TRAVAIL/racines.pem" && export SSL_CERT_FILE="$TRAVAIL/racines.pem"
fi

# Journal de la source (ETag = empreinte de l'objet chez l'hébergeur) pour la traçabilité et la reproductibilité.
# shellcheck disable=SC2016  # code JavaScript (gabarits « ${…} »).
node -e '
  fetch(process.argv[1], { method: "HEAD", signal: AbortSignal.timeout(30000) })
    .then((r) => console.log(`Source : ${process.argv[1]} — HTTP ${r.status}, ETag ${r.headers.get("etag")}, modifiée ${r.headers.get("last-modified")}`))
    .catch((e) => console.log(`Source : ${process.argv[1]} — en-têtes indisponibles (${e.message})`));
' "$SOURCE"

if MOSOLO_TUILES_SORTIE="$SORTIE/kinshasa.pmtiles" MOSOLO_TUILES_SOURCE="$SOURCE" PMTILES="$TRAVAIL/pmtiles" \
  timeout 900 bash tools/maps/construire-tuiles-kinshasa.sh A 2>&1 | grep -v "fetching chunks"; then
  if [ -s "$SORTIE/kinshasa.pmtiles" ]; then
    echo "Fond de carte installé dans l'image : $(du -h "$SORTIE/kinshasa.pmtiles" | cut -f1)."
    exit 0
  fi
fi
rm -f "$SORTIE"/kinshasa.pmtiles "$SORTIE"/*.partiel.pmtiles "$SORTIE"/kinshasa.pmtiles.txt
avertir "extraction depuis ${SOURCE} impossible (réseau ?) ou fichier refusé par les contrôles"
exit 0
