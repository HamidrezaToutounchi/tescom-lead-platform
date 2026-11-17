'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const { z } = require('zod');

const { Lead } = require('./models');
const {
  normalizeClientIp,
  isInternalDockerOrLoopbackIp,
  requireAllowedIp
} = require('./ipAllowlist');
const {
  enqueueLeadMailJob,
  startOutboxWorker,
  stopOutboxWorker
} = require('./outboxWorker');
const {
  findSiteByHost,
  getAllowedHosts,
  getAllowedOrigins
} = require('./siteConfig');
const MongoRateLimitStore = require('./mongoRateLimitStore');
const adminRoutes = require('./adminRoutes');

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tescom_platform_session_secret_default_change_me_in_prod';

function getTurnstileSecretKey() {
  return (process.env.TURNSTILE_SECRET_KEY || '').trim();
}

if (!MONGO_URI && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] MONGO_URI environment variable is required.');
  process.exit(1);
}

if (!getTurnstileSecretKey()) {
  console.warn(
    '[WARN] TURNSTILE_SECRET_KEY tanımlı değil; Cloudflare Turnstile doğrulaması atlanacak (captchaStatus="disabled").'
  );
}

mongoose.set('strictQuery', true);

// ---------------------------------------------------------------------------
// 1. Cryptographic RefCode Generator
// ---------------------------------------------------------------------------
const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateRefCode(prefix = 'TES') {
  const cleanPrefix = String(prefix || 'TES').trim().toUpperCase();
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return `${cleanPrefix}-${suffix}`;
}

// ---------------------------------------------------------------------------
// 2. NoSQL Key Sanitizer
// ---------------------------------------------------------------------------
function sanitizeNoSqlKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeNoSqlKeys);
  }
  if (value !== null && typeof value === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) {
        continue;
      }
      cleaned[k] = sanitizeNoSqlKeys(v);
    }
    return cleaned;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 3. Dynamic Zod Validation Schema Builder
// ---------------------------------------------------------------------------
function buildLeadZodSchema(siteConfig) {
  const allowedTypes = Object.keys(siteConfig?.requestTypes || {});

  return z
    .object({
      requestType: z
        .string({ error: 'Talep türü seçilmelidir.' })
        .refine((val) => allowedTypes.includes(val), {
          message: 'Geçersiz başvuru türü seçildi.'
        }),
      fullName: z
        .string({ error: 'Ad Soyad en az 2 karakter olmalıdır.' })
        .trim()
        .min(2, { error: 'Ad Soyad en az 2 karakter olmalıdır.' })
        .max(120, { error: 'Ad Soyad en fazla 120 karakter olabilir.' }),
      company: z
        .string()
        .trim()
        .max(120, { error: 'Firma / Kurum adı en fazla 120 karakter olabilir.' })
        .optional()
        .default(''),
      email: z
        .string({ error: 'Geçerli bir kurumsal e-posta adresi giriniz.' })
        .trim()
        .email({ error: 'Geçerli bir kurumsal e-posta adresi giriniz.' })
        .max(254, { error: 'E-posta adresi çok uzun.' }),
      phone: z
        .string({ error: 'Telefon numarası en az 7 karakter olmalıdır.' })
        .trim()
        .min(7, { error: 'Telefon numarası en az 7 karakter olmalıdır.' })
        .max(20, { error: 'Telefon numarası en fazla 20 karakter olabilir.' })
        .regex(/^[0-9+\s]+$/, {
          error: 'Telefon numarası yalnızca rakam, + ve boşluk içerebilir.'
        }),
      selectedProduct: z.string().trim().max(200).optional().default(''),
      quantity: z.string().trim().max(200).optional().default(''),
      pbxSystem: z.string().trim().max(200).optional().default(''),
      projectName: z.string().trim().max(200).optional().default(''),
      message: z.string().trim().max(3000).optional().default(''),
      cartSnapshot: z
        .array(
          z
            .object({
              model: z.string().trim().min(1).max(100),
              qty: z.number().int().min(1).max(10000)
            })
            .strict()
        )
        .max(50, { error: 'Sepette en fazla 50 kalem olabilir.' })
        .optional()
        .default([]),
      extra: z
        .record(z.string(), z.any())
        .refine(
          (obj) => {
            const keys = Object.keys(obj);
            if (keys.length > 20) return false;
            for (const k of keys) {
              if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) return false;
              const val = obj[k];
              if (typeof val === 'string' && val.length > 500) return false;
              if (typeof val === 'object' && val !== null) return false;
            }
            return true;
          },
          {
            error:
              'Ek veri formatı geçersiz (en fazla 20 alan, anahtarlar harf/rakam/altçizgi, değerler max 500 karakter).'
          }
        )
        .optional()
        .default({}),
      kvkkAccepted: z.literal(true, {
        error: 'KVKK aydınlatma metnini onaylamanız gerekmektedir.'
      }),
      marketingConsent: z.boolean().optional().default(false),
      kvkkVersion: z.string().trim().max(10).optional().default('v1'),
      website: z.string().max(200).optional().default(''),
      turnstileToken: z.string().max(2048).optional()
    })
    .strict();
}

// ---------------------------------------------------------------------------
// 4. Express Application Setup
// ---------------------------------------------------------------------------
const app = express();

app.set('trust proxy', ['loopback', 'uniquelocal']);
app.disable('x-powered-by');

// Host Header Validation & Site Resolution
app.use((req, res, next) => {
  // Exempt internal Docker/Loopback healthcheck on /api/health
  if (
    req.method === 'GET' &&
    req.path === '/api/health' &&
    isInternalDockerOrLoopbackIp(req.socket?.remoteAddress)
  ) {
    return next();
  }

  const rawHost = (req.headers.host || '').split(':')[0].trim().toLowerCase();
  const siteConfig = findSiteByHost(rawHost);

  if (!rawHost || !siteConfig) {
    return res.status(404).end();
  }

  req.siteConfig = siteConfig;
  req.siteDomain = siteConfig.domain;
  req.siteBrand = siteConfig.brand;
  req.siteRawHost = rawHost;

  return next();
});

app.use(
  helmet({
    strictTransportSecurity: false,
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"]
      }
    }
  })
);

app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Strict CORS: Origin must match current Host site
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      const allowedOrigins = getAllowedOrigins();
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS_NOT_ALLOWED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Accept'],
    maxAge: 86400
  })
);

// Cross-site Origin enforcement: Reject if Origin domain does not match Host domain
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && req.siteConfig) {
    try {
      const parsedOrigin = new URL(origin);
      const originHost = parsedOrigin.hostname.toLowerCase().replace(/^www\./, '');
      const siteDomain = req.siteConfig.domain.toLowerCase().replace(/^www\./, '');

      if (originHost !== siteDomain) {
        return res.status(403).json({
          ok: false,
          error: 'Erişim reddedildi (Origin / Host uyuşmazlığı).'
        });
      }
    } catch (_e) {
      return res.status(403).json({ ok: false, error: 'Geçersiz Origin.' });
    }
  }
  next();
});

app.use(express.json({ limit: '20kb' }));

app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeNoSqlKeys(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeNoSqlKeys(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeNoSqlKeys(req.params);
  }
  next();
});

// Multi-replica Shared Rate Limiter for Leads
const leadsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new MongoRateLimitStore({ windowMs: 15 * 60 * 1000, prefix: 'rl:leads:' }),
  keyGenerator: (req) => `${normalizeClientIp(req.ip) || req.ip}:${req.siteDomain || 'unknown'}`,
  message: {
    ok: false,
    error: 'Çok fazla talep gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.'
  }
});

// ---------------------------------------------------------------------------
// 5. Cloudflare Turnstile Verification Helper
// ---------------------------------------------------------------------------
async function verifyTurnstileToken(token, remoteIp, expectedHost) {
  const secretKey = getTurnstileSecretKey();
  if (!secretKey) {
    return { allowed: true, captchaStatus: 'disabled' };
  }

  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) {
    // If secret key is set, missing token is a hard 400 (NOT fail-open!)
    console.warn(
      `[TURNSTILE-REJECT] Secret key tanımlı ancak token gönderilmedi (IP: ${remoteIp}).`
    );
    return {
      allowed: false,
      userMessage: 'Güvenlik doğrulaması gereklidir.'
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const bodyParams = new URLSearchParams({
      secret: secretKey,
      response: trimmedToken,
      remoteip: remoteIp || '',
      idempotency_key: crypto.randomUUID()
    });

    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString(),
        signal: controller.signal
      }
    );

    // Fail-open ONLY on Cloudflare 5xx server errors
    if (response.status >= 500) {
      console.warn(
        `[TURNSTILE-UNVERIFIED] Cloudflare siteverify HTTP ${response.status} döndü (fail-open, IP: ${remoteIp}).`
      );
      return { allowed: true, captchaStatus: 'unverified' };
    }

    const result = await response.json();
    const errorCodes = Array.isArray(result?.['error-codes'])
      ? result['error-codes']
      : [];

    if (!result || result.success !== true) {
      console.warn(
        `[TURNSTILE-REJECT] Doğrulama başarısız (IP: ${remoteIp}, error-codes: ${
          errorCodes.join(', ') || 'none'
        }).`
      );
      return {
        allowed: false,
        userMessage: 'Güvenlik doğrulaması başarısız, lütfen sayfayı yenileyip tekrar deneyin.'
      };
    }

    const hostname = String(result.hostname || '').trim().toLowerCase();
    const action = String(result.action || '').trim();

    // Verify hostname matches expected site
    const cleanExpectedDomain = String(expectedHost || '').toLowerCase().replace(/^www\./, '');
    const cleanResultHost = hostname.replace(/^www\./, '');

    if (cleanResultHost !== cleanExpectedDomain || (action && action !== 'lead_form')) {
      console.warn(
        `[TURNSTILE-REJECT] Hostname/Action uyuşmazlığı (IP: ${remoteIp}, hostname: ${hostname}, expected: ${expectedHost}, action: ${action}).`
      );
      return {
        allowed: false,
        userMessage: 'Güvenlik doğrulaması alan adı uyuşmazlığı nedeniyle reddedildi.'
      };
    }

    return { allowed: true, captchaStatus: 'passed' };
  } catch (err) {
    // Fail-open ONLY on network timeout or fetch error
    console.warn(
      `[TURNSTILE-UNVERIFIED] Cloudflare siteverify erişim hatası/timeout (fail-open, IP: ${remoteIp}): ${err.message}`
    );
    return { allowed: true, captchaStatus: 'unverified' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// 6. Public Health & Lead Capture Endpoints
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  if (!isConnected) {
    return res.status(503).json({ ok: false, mongo: 'disconnected' });
  }
  return res.status(200).json({ ok: true, mongo: 'connected' });
});

app.post('/api/leads', leadsRateLimiter, async (req, res) => {
  try {
    // 1. Honeypot check: return 200 OK immediately without saving
    if (
      req.body &&
      typeof req.body.website === 'string' &&
      req.body.website.trim().length > 0
    ) {
      return res.status(200).json({
        ok: true,
        refCode: generateRefCode(req.siteConfig?.refPrefix)
      });
    }

    // 2. Strict dynamic Zod validation
    const schema = buildLeadZodSchema(req.siteConfig);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues?.[0]?.message || 'Geçersiz form verisi.';
      return res.status(400).json({
        ok: false,
        error: firstIssue
      });
    }

    if (mongoose.connection.readyState !== 1) {
      console.error('[ERROR] Lead submission attempted while MongoDB is disconnected.');
      return res.status(503).json({
        ok: false,
        error: 'Veritabanı bağlantısı geçici olarak kullanılamıyor. Lütfen biraz sonra tekrar deneyin.'
      });
    }

    const validData = parsed.data;
    const clientIp = String(normalizeClientIp(req.ip) || req.ip || '').slice(0, 100);
    const userAgent = String(req.get('user-agent') || '').slice(0, 300);

    // 3. Turnstile verification
    const turnstileCheck = await verifyTurnstileToken(
      validData.turnstileToken,
      clientIp,
      req.siteDomain
    );

    if (!turnstileCheck.allowed) {
      return res.status(400).json({
        ok: false,
        error: turnstileCheck.userMessage || 'Güvenlik doğrulaması başarısız.'
      });
    }

    const captchaStatus = turnstileCheck.captchaStatus;

    // 4. Rate limit for unverified leads: max 3 per hour per IP
    if (captchaStatus === 'unverified') {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const unverifiedRecentCount = await Lead.countDocuments({
        ip: clientIp,
        captchaStatus: 'unverified',
        createdAt: { $gte: oneHourAgo }
      });
      if (unverifiedRecentCount >= 3) {
        console.warn(
          `[TURNSTILE-RATE-LIMIT] IP (${clientIp}) saatlik 3 doğrulanmamış lead sınırını aştı.`
        );
        return res.status(429).json({
          ok: false,
          error: 'Çok fazla doğrulanmamış talep gönderildi. Lütfen sayfayı yenileyip tekrar deneyin.'
        });
      }
    }

    // 5. Save lead with refCode collision retry (max 3)
    let savedLead = null;
    let lastErr = null;
    const refPrefix = req.siteConfig?.refPrefix || 'TES';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const candidateRefCode = generateRefCode(refPrefix);
      const now = new Date();
      const hasMarketingConsent = Boolean(validData.marketingConsent);
      try {
        savedLead = await Lead.create({
          refCode: candidateRefCode,
          site: req.siteDomain,
          brand: req.siteBrand,
          requestType: validData.requestType,
          fullName: validData.fullName,
          company: validData.company || '',
          email: validData.email,
          phone: validData.phone,
          selectedProduct: validData.selectedProduct || '',
          quantity: validData.quantity || '',
          pbxSystem: validData.pbxSystem || '',
          projectName: validData.projectName || '',
          message: validData.message || '',
          cartSnapshot: validData.cartSnapshot || [],
          extra: validData.extra || {},
          kvkkAccepted: validData.kvkkAccepted,
          kvkkAcceptedAt: now,
          kvkkVersion: validData.kvkkVersion || 'v1',
          marketingConsent: hasMarketingConsent,
          marketingConsentAt: hasMarketingConsent ? now : null,
          status: 'new',
          captchaStatus,
          isRead: false,
          notes: [],
          ip: clientIp,
          userAgent,
          createdAt: now
        });
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.code === 11000 && attempt < 3) {
          continue;
        }
        throw err;
      }
    }

    if (!savedLead) {
      throw lastErr || new Error('Failed to generate unique refCode');
    }

    // 6. Enqueue Outbox Mail Job asynchronously
    enqueueLeadMailJob(savedLead._id).catch((mailErr) => {
      console.error('[WARN] Outbox enqueue failed:', mailErr.message);
    });

    return res.status(201).json({
      ok: true,
      refCode: savedLead.refCode
    });
  } catch (err) {
    console.error('[ERROR] POST /api/leads failed:', err);
    return res.status(500).json({
      ok: false,
      error: 'Talebiniz kaydedilirken bir sunucu hatası oluştu. Lütfen tekrar deneyin.'
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Admin Session & API Routes (/api/admin/*)
// ---------------------------------------------------------------------------
let cachedSessionMiddleware = null;

function getOrCreateSessionMiddleware() {
  if (cachedSessionMiddleware) {
    return cachedSessionMiddleware;
  }
  cachedSessionMiddleware = session({
    name: 'tescom_admin',
    secret: SESSION_SECRET,
    proxy: true,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: 'admin_sessions',
      ttl: 8 * 60 * 60 // 8 hours
    }),
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
  });
  return cachedSessionMiddleware;
}

app.use(
  '/api/admin',
  (req, res, next) => {
    req.headers['x-forwarded-proto'] = 'https';
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.getClient()) {
      return res.status(503).json({
        ok: false,
        error: 'Veritabanı bağlantısı henüz hazır değil.'
      });
    }
    return getOrCreateSessionMiddleware()(req, res, next);
  },
  adminRoutes
);

// ---------------------------------------------------------------------------
// 8. Admin Panel Static SPA Serving (/admin & /admin/*)
// ---------------------------------------------------------------------------
const adminDistDir = path.join(__dirname, 'public', 'admin');
const adminIndexHtml = path.join(adminDistDir, 'index.html');

app.use(
  '/admin',
  requireAllowedIp,
  (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  express.static(adminDistDir, {
    index: false,
    etag: false,
    lastModified: false
  })
);

app.get(['/admin', '/admin/*'], requireAllowedIp, (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  if (fs.existsSync(adminIndexHtml)) {
    return res.sendFile(adminIndexHtml);
  }
  return res.status(404).type('text/plain').send('404 Not Found');
});

// Reject all other routes with 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Bulunamadı.' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  if (err && err.message === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({ ok: false, error: 'Erişim reddedildi.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Gönderilen veri boyutu çok büyük.' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'Geçersiz JSON formatı.' });
  }
  console.error('[ERROR] Unhandled express error:', err);
  return res.status(500).json({ ok: false, error: 'Beklenmeyen bir hata oluştu.' });
});

// ---------------------------------------------------------------------------
// 9. MongoDB Connection with Retry, Outbox Worker & Graceful Shutdown
// ---------------------------------------------------------------------------
let isShuttingDown = false;
let retryTimer = null;

async function connectWithRetry() {
  if (isShuttingDown || !MONGO_URI) return;
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 5
    });
    console.log('[INFO] Connected to MongoDB successfully.');
    startOutboxWorker();
  } catch (err) {
    console.error('[WARN] MongoDB connection failed, retrying in 4s:', err.message);
    if (!isShuttingDown) {
      retryTimer = setTimeout(connectWithRetry, 4000);
    }
  }
}

mongoose.connection.on('disconnected', () => {
  if (!isShuttingDown && MONGO_URI) {
    console.warn('[WARN] MongoDB disconnected. Attempting reconnect in 4s...');
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connectWithRetry, 4000);
  }
});

let server = null;
if (require.main === module) {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[INFO] tescom-lead-api listening on port ${PORT}`);
    connectWithRetry();
  });
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[INFO] Received ${signal}. Starting graceful shutdown...`);

  stopOutboxWorker();
  if (retryTimer) {
    clearTimeout(retryTimer);
  }

  if (server) {
    server.close(async () => {
      try {
        await mongoose.connection.close(false);
        console.log('[INFO] MongoDB connection closed cleanly.');
        process.exit(0);
      } catch (err) {
        console.error('[ERROR] Error closing MongoDB connection:', err);
        process.exit(1);
      }
    });

    setTimeout(() => {
      console.error('[WARN] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
