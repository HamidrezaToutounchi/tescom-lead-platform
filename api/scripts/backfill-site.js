#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const { Lead } = require('../models');
const { findSiteByHost, getAllSites } = require('../siteConfig');

const domainArg = (process.argv[2] || '').trim().toLowerCase();

if (!domainArg) {
  console.error('Kullanım: node scripts/backfill-site.js <domain>');
  console.error('Örnek: node scripts/backfill-site.js fanvilpartner.com');
  process.exit(1);
}

const siteConfig = findSiteByHost(domainArg);
if (!siteConfig) {
  console.error(`[HATA] '${domainArg}' sites.json içinde tanımlı değil.`);
  console.log('Mevcut siteler:', getAllSites().map((s) => s.domain).join(', '));
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('[HATA] MONGO_URI ortam değişkeni tanımlı değil.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 8000
  });

  const query = {
    $or: [
      { site: { $exists: false } },
      { site: '' },
      { site: null }
    ]
  };

  const countBefore = await Lead.countDocuments(query);
  console.log(`[BİLGİ] 'site' alanı eksik olan toplam ${countBefore} lead kaydı bulundu.`);

  if (countBefore === 0) {
    console.log('[BİLGİ] Güncellenecek kayıt bulunmuyor.');
    await mongoose.connection.close();
    process.exit(0);
  }

  const result = await Lead.updateMany(query, {
    $set: {
      site: siteConfig.domain,
      brand: siteConfig.brand
    }
  });

  console.log(
    `[BAŞARILI] ${result.modifiedCount} lead kaydı '${siteConfig.domain}' (${siteConfig.brand}) olarak güncellendi.`
  );

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
