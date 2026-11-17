#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/deploy/.env"
BACKUP_DIR="${PROJECT_ROOT}/backups"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[ERROR] .env dosyası bulunamadı: ${ENV_FILE}" >&2
  exit 1
fi

MONGO_APP_USER="$(grep -E '^MONGO_APP_USER=' "${ENV_FILE}" | cut -d '=' -f2- | tr -d '\r"'"'")"
MONGO_APP_PASSWORD="$(grep -E '^MONGO_APP_PASSWORD=' "${ENV_FILE}" | cut -d '=' -f2- | tr -d '\r"'"'")"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$(grep -E '^BACKUP_PASSPHRASE_FILE=' "${ENV_FILE}" | cut -d '=' -f2- | tr -d '\r"'"'" || true)}"

if [[ -z "${MONGO_APP_USER}" || -z "${MONGO_APP_PASSWORD}" ]]; then
  echo "[ERROR] MONGO_APP_USER veya MONGO_APP_PASSWORD .env içinde tanımlı değil." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

DATE_STAMP="$(date +%F_%H%M%S)"
ARCHIVE_PATH="${BACKUP_DIR}/tescom-${DATE_STAMP}.gz"

docker exec -i \
  -e MONGO_DUMP_USER="${MONGO_APP_USER}" \
  -e MONGO_DUMP_PASS="${MONGO_APP_PASSWORD}" \
  tescom-mongo sh -c '
    set -eu
    TMP_CFG="$(mktemp /tmp/mongodump.XXXXXX.yaml)"
    chmod 600 "${TMP_CFG}"
    trap "rm -f \"${TMP_CFG}\"" EXIT
    printf "password: \"%s\"\n" "$(printf "%s" "${MONGO_DUMP_PASS}" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")" > "${TMP_CFG}"
    mongodump \
      --config="${TMP_CFG}" \
      --username="${MONGO_DUMP_USER}" \
      --authenticationDatabase="tescom" \
      --db="tescom" \
      --archive \
      --gzip
  ' > "${ARCHIVE_PATH}"

chmod 600 "${ARCHIVE_PATH}"

if [[ -n "${BACKUP_PASSPHRASE_FILE}" ]]; then
  if [[ ! -f "${BACKUP_PASSPHRASE_FILE}" ]]; then
    echo "[ERROR] BACKUP_PASSPHRASE_FILE bulunamadı: ${BACKUP_PASSPHRASE_FILE}" >&2
    exit 1
  fi

  if command -v gpg >/dev/null 2>&1; then
    ENC_PATH="${ARCHIVE_PATH}.gpg"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file "${BACKUP_PASSPHRASE_FILE}" \
      -o "${ENC_PATH}" "${ARCHIVE_PATH}"
    chmod 600 "${ENC_PATH}"
    rm -f "${ARCHIVE_PATH}"
    echo "[OK] Şifreli yedek alındı (GPG AES256): ${ENC_PATH}"
  elif command -v age >/dev/null 2>&1; then
    ENC_PATH="${ARCHIVE_PATH}.age"
    age -R "${BACKUP_PASSPHRASE_FILE}" -o "${ENC_PATH}" "${ARCHIVE_PATH}"
    chmod 600 "${ENC_PATH}"
    rm -f "${ARCHIVE_PATH}"
    echo "[OK] Şifreli yedek alındı (age): ${ENC_PATH}"
  else
    echo "[WARN] gpg veya age bulunamadı; yedek şifrelenmeden saklandı: ${ARCHIVE_PATH}" >&2
  fi
else
  echo "[OK] Yedek alındı: ${ARCHIVE_PATH}"
fi

# 14 günden eski yedekleri temizle
find "${BACKUP_DIR}" -maxdepth 1 \( -name "tescom-*.gz" -o -name "tescom-*.gz.gpg" -o -name "tescom-*.gz.age" \) -type f -mtime +14 -delete
echo "[OK] 14 günden eski yedekler temizlendi."
