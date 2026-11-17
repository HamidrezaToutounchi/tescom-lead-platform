#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config/sites.json"
ENV_FILE="${SCRIPT_DIR}/.env"

# Load environment variables if deploy/.env exists
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}" 2>/dev/null || true
  set +a
fi

SITES_ROOT="${SITES_ROOT:-/opt/tescom/sites}"
SITES_DIST="${SITES_DIST:-/opt/tescom/sites-dist}"
TARGET_BASE_DIR="${SITES_DIST}"

# Export Turnstile site keys for Vite and Next.js frontends
if [[ -n "${TURNSTILE_SITE_KEY:-}" ]]; then
  export VITE_TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY}"
  export NEXT_PUBLIC_TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY}"
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "[HATA] sites.json bulunamadı: ${CONFIG_FILE}" >&2
  exit 1
fi

mkdir -p "${TARGET_BASE_DIR}"

echo "=========================================================="
echo "Tescom Platform Frontend Build Başlatılıyor"
echo "Siteler Kök Dizini (SITES_ROOT): ${SITES_ROOT}"
echo "Dağıtım Hedef Dizini (SITES_DIST): ${TARGET_BASE_DIR}"
echo "Turnstile Site Key: ${TURNSTILE_SITE_KEY:-(tanımlı değil)}"
echo "=========================================================="

# Parse sites.json using node
node -e '
const fs = require("fs");
const sites = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
sites.forEach(s => {
  console.log([s.domain, s.repoDir, s.outDir, s.buildCmd].join("\t"));
});
' "${CONFIG_FILE}" | while IFS=$'\t' read -r domain repoDir outDir buildCmd; do
  echo ""
  echo ">>> [BUILD] Site: ${domain} (Klasör: ${repoDir})"

  SITE_DIR="${SITES_ROOT}/${repoDir}"
  if [[ ! -d "${SITE_DIR}" ]]; then
    echo "[UYARI] Klasör bulunamadı: ${SITE_DIR}, atlanıyor." >&2
    continue
  fi

  # Run build in site directory
  (
    cd "${SITE_DIR}"
    echo "Komut çalıştırılıyor: ${buildCmd}"
    eval "${buildCmd}"
  )

  SOURCE_OUT="${SITE_DIR}/${outDir}"
  if [[ ! -d "${SOURCE_OUT}" ]]; then
    echo "[HATA] Build çıktı klasörü oluşmadı: ${SOURCE_OUT}" >&2
    exit 1
  fi

  TMP_DEST="${TARGET_BASE_DIR}/${domain}.tmp"
  FINAL_DEST="${TARGET_BASE_DIR}/${domain}"

  rm -rf "${TMP_DEST}"
  mkdir -p "${TMP_DEST}"
  cp -a "${SOURCE_OUT}/." "${TMP_DEST}/"

  # Atomic swap
  rm -rf "${FINAL_DEST}"
  mv "${TMP_DEST}" "${FINAL_DEST}"
  chmod -R 755 "${FINAL_DEST}"

  echo "[BAŞARILI] ${domain} güncellendi -> ${FINAL_DEST}"
done

echo ""
echo "=========================================================="
echo "[TAMAMLANDI] Tüm siteler başarıyla derlendi ve yerleştirildi."
echo "=========================================================="
