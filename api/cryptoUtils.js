'use strict';

const crypto = require('crypto');

function getEncryptionKeyBuffer() {
  const hexKey = process.env.SETTINGS_ENC_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey.trim())) {
    throw new Error(
      'SETTINGS_ENC_KEY geçersiz veya eksik (64 karakterlik 32-byte hex olmalı).'
    );
  }
  return Buffer.from(hexKey.trim(), 'hex');
}

function encryptSecret(plainText) {
  if (!plainText) return '';
  const key = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(encryptedPayload) {
  if (!encryptedPayload) return '';
  const parts = String(encryptedPayload).split(':');
  if (parts.length !== 3) {
    throw new Error('Şifreli veri formatı geçersiz.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKeyBuffer();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(input) {
  return String(input ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCsvCell(value) {
  let str = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Prevent CSV formula injection in Excel (=, +, -, @, Tab, CR)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes('"') || str.includes(',') || str.includes(';') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  escapeHtml,
  escapeRegex,
  escapeCsvCell
};
