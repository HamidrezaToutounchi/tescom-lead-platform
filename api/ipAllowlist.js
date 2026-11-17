'use strict';

const dns = require('dns');
const ipaddr = require('ipaddr.js');
const { AllowedIp } = require('./models');

const CACHE_TTL_MS = 30 * 1000; // 30 seconds
let cachedDbIps = null;
let cacheExpiresAt = 0;

const FORBIDDEN_IP_RANGES = new Set([
  'loopback',
  'private',
  'uniqueLocal',
  'linkLocal',
  'reserved',
  'unspecified',
  'multicast',
  'broadcast',
  'carrierGradeNat'
]);

function getBootstrapIps() {
  const raw = process.env.ADMIN_BOOTSTRAP_IPS || '';
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeClientIp(rawIp) {
  if (!rawIp) return '';
  const cleaned = String(rawIp).trim();
  try {
    if (ipaddr.isValid(cleaned)) {
      const parsed = ipaddr.process(cleaned);
      return parsed.toString();
    }
  } catch (_err) {
    // ignore parse error
  }
  return cleaned;
}

/**
 * Checks whether an ipaddr instance or CIDR (addr/prefix) falls within or intersects
 * any forbidden range (loopback, private, uniqueLocal, linkLocal, reserved,
 * unspecified, multicast, broadcast, carrierGradeNat).
 */
function intersectsForbiddenRange(addr, prefix) {
  const directRange = addr.range();
  if (FORBIDDEN_IP_RANGES.has(directRange) || directRange !== 'unicast') {
    return true;
  }

  const specialMap = addr.SpecialRanges || {};
  for (const [rangeName, entry] of Object.entries(specialMap)) {
    if (rangeName === 'unicast') continue;
    if (!entry) continue;
    const tuples = Array.isArray(entry[0]) ? entry : [entry];
    for (const [specialAddr, specialPrefix] of tuples) {
      if (!specialAddr || typeof specialPrefix !== 'number') continue;
      if (addr.kind() !== specialAddr.kind()) continue;
      const minPrefix = Math.min(prefix, specialPrefix);
      if (addr.match([specialAddr, minPrefix])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validates an IPv4, IPv6, or CIDR rule for the admin allowlist:
 * - Rejects CIDR wider than /24 for IPv4 or /48 for IPv6
 * - Rejects loopback, private, uniqueLocal, linkLocal, reserved, unspecified, multicast,
 *   or any CIDR intersecting those ranges
 */
function validateAllowedIpRule(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: 'Geçerli bir IP veya CIDR giriniz.' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Geçerli bir IP veya CIDR giriniz.' };
  }

  try {
    if (trimmed.includes('/')) {
      const [rawAddr, rawPrefix] = ipaddr.parseCIDR(trimmed);
      let addr = rawAddr;
      let prefix = rawPrefix;

      if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
        addr = addr.toIPv4Address();
        prefix = prefix - 96;
      }

      if (addr.kind() === 'ipv4') {
        if (prefix < 24 || prefix > 32) {
          return {
            ok: false,
            error:
              'CIDR aralığı çok geniş. IPv4 için en az /24 (örn. x.x.x.0/24), IPv6 için en az /48 olmalıdır.'
          };
        }
      } else if (addr.kind() === 'ipv6') {
        if (prefix < 48 || prefix > 128) {
          return {
            ok: false,
            error:
              'CIDR aralığı çok geniş. IPv4 için en az /24, IPv6 için en az /48 olmalıdır.'
          };
        }
      }

      if (intersectsForbiddenRange(addr, prefix)) {
        return {
          ok: false,
          error:
            'Loopback, private (iç ağ), link-local, multicast veya rezerve IP aralıkları eklenemez.'
        };
      }

      return { ok: true, normalized: `${addr.toString()}/${prefix}` };
    }

    if (ipaddr.isValid(trimmed)) {
      const parsed = ipaddr.process(trimmed);
      const maxPrefix = parsed.kind() === 'ipv4' ? 32 : 128;

      if (intersectsForbiddenRange(parsed, maxPrefix)) {
        return {
          ok: false,
          error:
            'Loopback, private (iç ağ), link-local, multicast veya rezerve IP adresleri eklenemez.'
        };
      }

      return { ok: true, normalized: parsed.toString() };
    }
  } catch (_err) {
    return {
      ok: false,
      error: 'Geçersiz IPv4, IPv6 veya CIDR formatı.'
    };
  }

  return {
    ok: false,
    error: 'Geçersiz IPv4, IPv6 veya CIDR formatı.'
  };
}

function validateIpOrCidr(input) {
  const res = validateAllowedIpRule(input);
  return res.ok ? res.normalized : null;
}

function ipMatchesRule(clientIpStr, ruleStr) {
  try {
    if (!ipaddr.isValid(clientIpStr)) return false;
    const clientAddr = ipaddr.process(clientIpStr);

    if (ruleStr.includes('/')) {
      const [rangeAddr, prefix] = ipaddr.parseCIDR(ruleStr);
      const normalizedRange =
        rangeAddr.kind() === 'ipv6' && rangeAddr.isIPv4MappedAddress()
          ? rangeAddr.toIPv4Address()
          : rangeAddr;
      if (clientAddr.kind() !== normalizedRange.kind()) return false;
      return clientAddr.match([normalizedRange, prefix]);
    }

    if (!ipaddr.isValid(ruleStr)) return false;
    const ruleAddr = ipaddr.process(ruleStr);
    if (clientAddr.kind() !== ruleAddr.kind()) return false;
    return clientAddr.toString() === ruleAddr.toString();
  } catch (_err) {
    return false;
  }
}

function isInternalDockerOrLoopbackIp(rawIp) {
  try {
    const norm = normalizeClientIp(rawIp);
    if (!norm || !ipaddr.isValid(norm)) return false;
    const addr = ipaddr.process(norm);
    const range = addr.range();
    return (
      range === 'loopback' ||
      range === 'private' ||
      range === 'uniqueLocal' ||
      range === 'linkLocal'
    );
  } catch (_err) {
    return false;
  }
}

function invalidateAllowedIpCache() {
  cachedDbIps = null;
  cacheExpiresAt = 0;
}

async function getAllowedRules() {
  const now = Date.now();
  if (!cachedDbIps || now >= cacheExpiresAt) {
    try {
      const docs = await AllowedIp.find().sort({ createdAt: -1 }).lean();
      const validDbRules = [];
      for (const d of docs) {
        const check = validateAllowedIpRule(d.ip);
        if (!check.ok) {
          console.warn(
            `[WARN] allowed_ips koleksiyonundaki yasaklı/geçersiz kural yok sayıldı: "${d.ip}" (${check.error})`
          );
          continue;
        }
        validDbRules.push(check.normalized);
      }
      cachedDbIps = validDbRules;
      cacheExpiresAt = now + CACHE_TTL_MS;
    } catch (err) {
      console.error('[ERROR] Failed to read allowed_ips from MongoDB:', err.message);
      cachedDbIps = cachedDbIps || [];
    }
  }

  const validBootstrap = [];
  for (const rawRule of getBootstrapIps()) {
    const check = validateAllowedIpRule(rawRule);
    if (!check.ok) {
      console.warn(
        `[WARN] ADMIN_BOOTSTRAP_IPS içindeki yasaklı/geçersiz kural yok sayıldı: "${rawRule}" (${check.error})`
      );
      continue;
    }
    validBootstrap.push(check.normalized);
  }

  const combined = Array.from(new Set([...validBootstrap, ...(cachedDbIps || [])]));
  if (combined.length === 0) {
    // Fail-closed notification
    // console.warn('[WARN] No admin allowlist rules found (ADMIN_BOOTSTRAP_IPS empty and no DB records). Fail-closed: Admin access disabled.');
  }

  return combined;
}

async function isClientIpAllowed(rawIp) {
  const clientIp = normalizeClientIp(rawIp);
  if (!clientIp || !ipaddr.isValid(clientIp)) return false;

  // Always deny admin access if req.ip is loopback, private, uniqueLocal, linkLocal, reserved, etc.
  const clientAddr = ipaddr.process(clientIp);
  const maxPrefix = clientAddr.kind() === 'ipv4' ? 32 : 128;
  if (intersectsForbiddenRange(clientAddr, maxPrefix)) {
    return false;
  }

  const rules = await getAllowedRules();
  return rules.some((rule) => ipMatchesRule(clientIp, rule));
}

async function requireAllowedIp(req, res, next) {
  const clientIp = normalizeClientIp(req.ip);
  const allowed = await isClientIpAllowed(clientIp);
  if (!allowed) {
    console.warn(
      `[ADMIN_IP_DENIED] ip=${clientIp || 'unknown'} path=${req.originalUrl} time=${new Date().toISOString()}`
    );
    // Return 404 (NEVER 403) so the existence of /admin is completely hidden
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
    }
    return res.status(404).type('text/plain').send('404 Not Found');
  }
  req.clientIpNormalized = clientIp;
  return next();
}

/**
 * Resolves an SMTP hostname via dns.lookup and rejects if any resolved address
 * is loopback, private, uniqueLocal, linkLocal, reserved, unspecified, etc.
 */
async function assertSafeSmtpHost(hostname) {
  const cleanHost = String(hostname || '').trim().toLowerCase();
  if (
    !cleanHost ||
    cleanHost.length > 253 ||
    !/^[a-z0-9.-]+$/.test(cleanHost) ||
    ipaddr.isValid(cleanHost) ||
    /^\d+(\.\d+){3}$/.test(cleanHost) ||
    /^\d+$/.test(cleanHost)
  ) {
    const err = new Error('Geçerli bir SMTP sunucu adresi (hostname) giriniz; IP adresi kabul edilmez.');
    err.statusCode = 400;
    err.errorCode = 'INVALID_HOST';
    err.permanent = true;
    throw err;
  }

  let records;
  try {
    records = await dns.promises.lookup(cleanHost, { all: true });
  } catch (dnsErr) {
    throw dnsErr;
  }

  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error('Sunucuya bağlanılamadı (host/port/firewall)');
    err.errorCode = 'ENOTFOUND';
    err.permanent = false;
    throw err;
  }

  for (const rec of records) {
    if (!rec || !rec.address || !ipaddr.isValid(rec.address)) {
      const err = new Error('İç ağ adreslerine bağlantıya izin verilmez.');
      err.statusCode = 400;
      err.errorCode = 'SSRF_BLOCKED';
      err.permanent = true;
      throw err;
    }
    const addr = ipaddr.process(rec.address);
    const range = addr.range();
    const maxPrefix = addr.kind() === 'ipv4' ? 32 : 128;
    if (
      range === 'loopback' ||
      range === 'private' ||
      range === 'uniqueLocal' ||
      range === 'linkLocal' ||
      range === 'reserved' ||
      range === 'unspecified' ||
      intersectsForbiddenRange(addr, maxPrefix)
    ) {
      const err = new Error('İç ağ adreslerine bağlantıya izin verilmez.');
      err.statusCode = 400;
      err.errorCode = 'SSRF_BLOCKED';
      err.permanent = true;
      throw err;
    }
  }

  return records;
}

module.exports = {
  FORBIDDEN_IP_RANGES,
  getBootstrapIps,
  normalizeClientIp,
  validateAllowedIpRule,
  validateIpOrCidr,
  ipMatchesRule,
  isInternalDockerOrLoopbackIp,
  invalidateAllowedIpCache,
  isClientIpAllowed,
  requireAllowedIp,
  assertSafeSmtpHost
};
