#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config/sites.json"
TARGET_BASE_DIR="/srv/sites"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "[HATA] sites.json bulunamadı: ${CONFIG_FILE}" >&2
  exit 1
fi

mkdir -p "${TARGET_BASE_DIR}"

echo "=========================================================="
echo "Tescom Platform Frontend Build Başlatılıyor"
echo "Kök Klasör: ${PROJECT_ROOT}"
echo "Hedef Dizin: ${TARGET_BASE_DIR}"
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

  SITE_DIR="${PROJECT_ROOT}/${repoDir}"
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
