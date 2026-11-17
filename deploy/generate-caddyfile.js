#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const sitesPath = path.resolve(__dirname, '../config/sites.json');
const caddyfilePath = path.resolve(__dirname, 'caddy/Caddyfile');

if (!fs.existsSync(sitesPath)) {
  console.error('[HATA] config/sites.json bulunamadı:', sitesPath);
  process.exit(1);
}

const sites = JSON.parse(fs.readFileSync(sitesPath, 'utf8'));

let caddyContent = `# ===========================================================================
# Auto-generated Caddyfile from config/sites.json
# Generated on: ${new Date().toISOString()}
# DO NOT EDIT DIRECTLY. Run 'node deploy/generate-caddyfile.js' to regenerate.
# ===========================================================================

{
  email {$ACME_EMAIL:destek@tescom.com.tr}
  order rate_limit before basic_auth
}

`;

for (const site of sites) {
  const domain = site.domain.trim().toLowerCase();
  const withoutWww = domain.replace(/^www\./, '');
  const withWww = `www.${withoutWww}`;
  const refPrefix = (site.refPrefix || 'TES').toLowerCase();

  caddyContent += `# ---------------------------------------------------------------------------
# Site: ${site.displayName} (${site.domain})
# ---------------------------------------------------------------------------
${withoutWww}, ${withWww} {
  # Security Headers
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    -Server
  }

  # Rate Limiting via caddy-ratelimit (IP-based)
  rate_limit {
    zone leads_${refPrefix} {
      key {remote_host}
      events 10
      window 1m
      match {
        path /api/leads
        method POST
      }
    }
    zone global_${refPrefix} {
      key {remote_host}
      events 300
      window 1m
    }
  }

  # Reverse Proxy: Unified Lead API (2 replicas via Docker internal DNS round-robin)
  handle /api/* {
    reverse_proxy lead-api:3000 {
      header_up Host {host}
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  # Reverse Proxy: Unified Admin SPA (IP allowlist enforced by lead-api)
  handle /admin* {
    reverse_proxy lead-api:3000 {
      header_up Host {host}
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  # Static Website Frontend
  handle {
    root * /srv/sites/${withoutWww}
    file_server
    try_files {path} {path}/ /index.html
  }

  # Access Logs
  log {
    output file /var/log/caddy/${withoutWww}.access.log {
      roll_size 50mb
      roll_keep 10
    }
    format json
  }
}

`;
}

fs.writeFileSync(caddyfilePath, caddyContent, 'utf8');
console.log(`[BAŞARILI] Caddyfile üretildi (${sites.length} site): ${caddyfilePath}`);
