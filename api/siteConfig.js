'use strict';

const fs = require('fs');
const path = require('path');

function resolveSitesPath() {
  if (process.env.SITES_CONFIG_PATH && fs.existsSync(process.env.SITES_CONFIG_PATH)) {
    return path.resolve(process.env.SITES_CONFIG_PATH);
  }
  const candidate1 = path.resolve(__dirname, '../config/sites.json');
  if (fs.existsSync(candidate1)) return candidate1;

  const candidate2 = path.resolve(__dirname, 'config/sites.json');
  if (fs.existsSync(candidate2)) return candidate2;

  const candidate3 = '/app/config/sites.json';
  if (fs.existsSync(candidate3)) return candidate3;

  return candidate1;
}

let cachedSites = null;
let domainMap = new Map();
let allowedHostsSet = new Set();
let allowedOriginsSet = new Set();

function loadSitesConfig() {
  const filePath = resolveSitesPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`[FATAL] sites.json bulunamadı: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('[FATAL] sites.json geçerli bir site listesi içermiyor.');
  }

  cachedSites = parsed;
  domainMap.clear();
  allowedHostsSet.clear();
  allowedOriginsSet.clear();

  for (const site of parsed) {
    const primaryDomain = site.domain.trim().toLowerCase();
    const withoutWww = primaryDomain.replace(/^www\./, '');
    const withWww = `www.${withoutWww}`;

    domainMap.set(withoutWww, site);
    domainMap.set(withWww, site);

    allowedHostsSet.add(withoutWww);
    allowedHostsSet.add(withWww);

    allowedOriginsSet.add(`https://${withoutWww}`);
    allowedOriginsSet.add(`https://${withWww}`);

    // If site has aliases
    if (Array.isArray(site.aliases)) {
      for (const alias of site.aliases) {
        const aClean = alias.trim().toLowerCase();
        const aWithoutWww = aClean.replace(/^www\./, '');
        const aWithWww = `www.${aWithoutWww}`;
        domainMap.set(aWithoutWww, site);
        domainMap.set(aWithWww, site);
        allowedHostsSet.add(aWithoutWww);
        allowedHostsSet.add(aWithWww);
        allowedOriginsSet.add(`https://${aWithoutWww}`);
        allowedOriginsSet.add(`https://${aWithWww}`);
      }
    }
  }

  return cachedSites;
}

// Initial load
loadSitesConfig();

function getAllSites() {
  if (!cachedSites) {
    loadSitesConfig();
  }
  return cachedSites;
}

function findSiteByHost(rawHost) {
  if (!rawHost) return null;
  const host = String(rawHost).split(':')[0].trim().toLowerCase();
  return domainMap.get(host) || null;
}

function getAllowedHosts() {
  return allowedHostsSet;
}

function getAllowedOrigins() {
  return allowedOriginsSet;
}

module.exports = {
  loadSitesConfig,
  getAllSites,
  findSiteByHost,
  getAllowedHosts,
  getAllowedOrigins
};
