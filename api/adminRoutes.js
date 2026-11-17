'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const ipaddr = require('ipaddr.js');
const { z } = require('zod');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');

const {
  Lead,
  AllowedIp,
  AdminUser,
  MailSettings,
  MailRecipient,
  MailJob,
  AuditLog,
  MailAttempt
} = require('./models');
const {
  encryptSecret,
  decryptSecret,
  escapeHtml,
  escapeRegex,
  escapeCsvCell
} = require('./cryptoUtils');
const {
  getBootstrapIps,
  validateAllowedIpRule,
  invalidateAllowedIpCache,
  requireAllowedIp,
  assertSafeSmtpHost
} = require('./ipAllowlist');
const {
  invalidateMailTransporter,
  resolveSecurityForPort,
  verifySmtpConnection,
  sendMailWithSettings
} = require('./mailer');
const { enqueueLeadMailJob } = require('./outboxWorker');
const { getAllSites, getAllowedOrigins, findSiteByHost } = require('./siteConfig');
const MongoRateLimitStore = require('./mongoRateLimitStore');

const router = express.Router();

const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  'tescom_dummy_timing_defense_password_2026_!@#',
  12
);

const ABSOLUTE_SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

// ---------------------------------------------------------------------------
// Helper: Record Audit Log
// ---------------------------------------------------------------------------
async function writeAuditLog(req, action, details = '', explicitActor = null) {
  try {
    const actor = explicitActor || req.session?.adminUser?.username || 'anonymous';
    const ip = req.clientIpNormalized || req.ip || '';
    await AuditLog.create({
      actor: String(actor).slice(0, 80),
      action: String(action).slice(0, 80),
      details: String(details).slice(0, 1000),
      ip: String(ip).slice(0, 100),
      createdAt: new Date()
    });
  } catch (err) {
    console.error('[ERROR] Failed to write audit log:', err.message);
  }
}

function destroySessionAndClearCookie(req, res, callback) {
  if (!req.session) {
    res.clearCookie('tescom_admin', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict'
    });
    return callback();
  }
  req.session.destroy(() => {
    res.clearCookie('tescom_admin', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict'
    });
    return callback();
  });
}

// ---------------------------------------------------------------------------
// 1. Middleware: IP Allowlist -> Security Headers -> Origin Check
// ---------------------------------------------------------------------------
router.use(requireAllowedIp);

router.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CSRF protection: Verify Origin header on state-changing requests
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin') || '';
    const allowedOrigins = getAllowedOrigins();

    if (!origin || !allowedOrigins.has(origin)) {
      return res.status(403).json({
        ok: false,
        error: 'Geçersiz istek kaynağı (Origin doğrulaması başarısız).'
      });
    }
  }
  return next();
});

// ---------------------------------------------------------------------------
// 2. Auth Middlewares
// ---------------------------------------------------------------------------
async function verifyActiveSession(req) {
  if (!req.session || !req.session.adminUser || !req.session.adminUser.id) {
    return { valid: false, reason: 'no_session' };
  }

  const loginAtMs = Number(req.session.loginAt) || 0;
  if (!loginAtMs || Date.now() - loginAtMs > ABSOLUTE_SESSION_TIMEOUT_MS) {
    return { valid: false, reason: 'absolute_timeout' };
  }

  if (!mongoose.Types.ObjectId.isValid(req.session.adminUser.id)) {
    return { valid: false, reason: 'invalid_user_id' };
  }

  const dbUser = await AdminUser.findById(req.session.adminUser.id, {
    role: 1,
    passwordChangedAt: 1,
    username: 1
  }).lean();

  if (!dbUser) {
    return { valid: false, reason: 'user_deleted' };
  }

  if (dbUser.passwordChangedAt) {
    const pwChangedMs = new Date(dbUser.passwordChangedAt).getTime();
    if (pwChangedMs > loginAtMs) {
      return { valid: false, reason: 'password_changed_after_login' };
    }
  }

  req.adminUser = {
    id: dbUser._id.toString(),
    username: dbUser.username,
    role: dbUser.role
  };

  return { valid: true };
}

async function requireAuth(req, res, next) {
  const check = await verifyActiveSession(req);
  if (!check.valid) {
    return destroySessionAndClearCookie(req, res, () =>
      res.status(401).json({
        ok: false,
        error: 'Oturum süresi doldu veya oturum geçersiz. Lütfen tekrar giriş yapın.'
      })
    );
  }
  return next();
}

async function requireAdminRole(req, res, next) {
  const check = await verifyActiveSession(req);
  if (!check.valid) {
    return destroySessionAndClearCookie(req, res, () =>
      res.status(401).json({
        ok: false,
        error: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.'
      })
    );
  }
  if (req.adminUser.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Bu işlem için yönetici (admin) yetkisi gereklidir.'
    });
  }
  return next();
}

// Rate Limiter for Admin Login
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new MongoRateLimitStore({ windowMs: 15 * 60 * 1000, prefix: 'rl:admin_login:' }),
  keyGenerator: (req) => `${req.clientIpNormalized || req.ip}`,
  message: {
    ok: false,
    error: 'Çok fazla hatalı giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.'
  }
});

// ---------------------------------------------------------------------------
// 3. Admin Endpoints: Sites, Profile & Auth
// ---------------------------------------------------------------------------

// GET /api/admin/sites: Return all configured sites
router.get('/sites', requireAuth, (_req, res) => {
  try {
    const sites = getAllSites();
    return res.json({ ok: true, sites });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/me: Current authenticated admin session profile
router.get('/me', async (req, res) => {
  const check = await verifyActiveSession(req);
  if (!check.valid) {
    return res.status(401).json({ ok: false, authenticated: false });
  }
  const dbUser = await AdminUser.findById(req.adminUser.id, {
    totpEnabled: 1
  }).lean();

  return res.json({
    ok: true,
    authenticated: true,
    user: {
      id: req.adminUser.id,
      username: req.adminUser.username,
      role: req.adminUser.role,
      totpEnabled: Boolean(dbUser?.totpEnabled)
    }
  });
});

const loginSchema = z
  .object({
    username: z.string().trim().min(3).max(60),
    password: z.string().min(1).max(256),
    totpToken: z.string().trim().optional()
  })
  .strict();

// POST /api/admin/login: Authenticate with password & optional 2FA
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const parseRes = loginSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        ok: false,
        error: 'Kullanıcı adı ve şifre formatı geçersiz.'
      });
    }

    const { username, password, totpToken } = parseRes.data;
    const cleanUsername = username.toLowerCase();

    const user = await AdminUser.findOne({ username: cleanUsername });

    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const waitMin = Math.ceil((user.lockedUntil - Date.now()) / (60 * 1000));
      await writeAuditLog(
        req,
        'LOGIN_BLOCKED_LOCKED',
        `Kilitli hesap girişi engellendi (${waitMin} dk kaldı)`,
        cleanUsername
      );
      return res.status(403).json({
        ok: false,
        error: `Hesabınız çok fazla hatalı giriş denemesi nedeniyle geçici olarak kilitlendi. Lütfen ${waitMin} dakika sonra tekrar deneyin.`
      });
    }

    const targetHash = user ? user.passwordHash : DUMMY_BCRYPT_HASH;
    const pwMatches = await bcrypt.compare(password, targetHash);

    if (!user || !pwMatches) {
      if (user) {
        user.failedAttempts = (user.failedAttempts || 0) + 1;
        if (user.failedAttempts >= 5) {
          user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
          user.failedAttempts = 0;
          await writeAuditLog(
            req,
            'ACCOUNT_LOCKED',
            '5 hatalı deneme sonrası hesap 15 dakika kilitlendi',
            cleanUsername
          );
        }
        await user.save();
      }
      await writeAuditLog(req, 'LOGIN_FAILED', 'Hatalı kullanıcı adı veya şifre', cleanUsername);
      return res.status(401).json({
        ok: false,
        error: 'Kullanıcı adı veya şifre hatalı.'
      });
    }

    // Check 2FA (TOTP)
    if (user.totpEnabled) {
      if (!totpToken) {
        return res.status(200).json({
          ok: false,
          require2FA: true,
          message: 'İki adımlı doğrulama (2FA) kodu gereklidir.'
        });
      }

      let secret = '';
      try {
        secret = decryptSecret(user.totpSecretEnc);
      } catch (_e) {
        console.error('[ERROR] Failed to decrypt user TOTP secret');
      }

      const isValidTotp = secret && authenticator.check(totpToken, secret);
      if (!isValidTotp) {
        user.failedAttempts = (user.failedAttempts || 0) + 1;
        await user.save();
        await writeAuditLog(req, 'LOGIN_2FA_FAILED', 'Hatalı 2FA kodu', cleanUsername);
        return res.status(401).json({
          ok: false,
          require2FA: true,
          error: 'Geçersiz iki adımlı doğrulama (2FA) kodu.'
        });
      }
    }

    // Login success: reset lockout counters
    user.failedAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    user.lastLoginIp = req.clientIpNormalized || req.ip || '';
    await user.save();

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('[ERROR] Session regenerate error:', err);
        return res.status(500).json({ ok: false, error: 'Oturum oluşturulamadı.' });
      }

      req.session.adminUser = {
        id: user._id.toString(),
        username: user.username,
        role: user.role
      };
      req.session.loginAt = Date.now();

      writeAuditLog(req, 'LOGIN_SUCCESS', 'Başarılı giriş yapıldı', user.username);

      return res.json({
        ok: true,
        user: {
          id: user._id.toString(),
          username: user.username,
          role: user.role,
          totpEnabled: Boolean(user.totpEnabled)
        }
      });
    });
  } catch (err) {
    console.error('[ERROR] POST /api/admin/login error:', err);
    return res.status(500).json({ ok: false, error: 'Giriş işlemi sırasında sunucu hatası oluştu.' });
  }
});

// POST /api/admin/logout: Terminate session
router.post('/logout', requireAuth, async (req, res) => {
  const actor = req.adminUser?.username || 'admin';
  await writeAuditLog(req, 'LOGOUT', 'Çıkış yapıldı', actor);
  return destroySessionAndClearCookie(req, res, () => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// 4. Two-Factor Authentication (2FA) Setup & Verify
// ---------------------------------------------------------------------------
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const user = await AdminUser.findById(req.adminUser.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Kullanıcı bulunamadı.' });
    }

    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(user.username, 'Tescom Lead Platform', secret);
    const qrCodeDataUrl = await qrcode.toDataURL(otpAuthUrl);

    req.session.tempTotpSecret = secret;

    return res.json({
      ok: true,
      secret,
      qrCodeDataUrl
    });
  } catch (err) {
    console.error('[ERROR] 2FA setup failed:', err);
    return res.status(500).json({ ok: false, error: '2FA kurulumu başlatılamadı.' });
  }
});

const verify2faSchema = z
  .object({
    token: z.string().trim().min(6).max(8)
  })
  .strict();

router.post('/2fa/verify', requireAuth, async (req, res) => {
  try {
    const parseRes = verify2faSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Geçersiz 2FA kodu.' });
    }

    const tempSecret = req.session.tempTotpSecret;
    if (!tempSecret) {
      return res.status(400).json({
        ok: false,
        error: '2FA kurulum oturumu bulunamadı. Lütfen QR kodu tekrar oluşturun.'
      });
    }

    const isValid = authenticator.check(parseRes.data.token, tempSecret);
    if (!isValid) {
      return res.status(400).json({ ok: false, error: 'Kod doğrulanamadı. Lütfen tekrar deneyin.' });
    }

    const user = await AdminUser.findById(req.adminUser.id);
    user.totpEnabled = true;
    user.totpSecretEnc = encryptSecret(tempSecret);
    await user.save();

    delete req.session.tempTotpSecret;
    await writeAuditLog(req, '2FA_ENABLED', 'İki adımlı doğrulama aktifleştirildi');

    return res.json({ ok: true, message: 'İki adımlı doğrulama başarıyla aktifleştirildi.' });
  } catch (err) {
    console.error('[ERROR] 2FA verify failed:', err);
    return res.status(500).json({ ok: false, error: '2FA doğrulama hatası.' });
  }
});

const disable2faSchema = z
  .object({
    password: z.string().min(1)
  })
  .strict();

router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const parseRes = disable2faSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Şifre gereklidir.' });
    }

    const user = await AdminUser.findById(req.adminUser.id);
    const pwMatch = await bcrypt.compare(parseRes.data.password, user.passwordHash);
    if (!pwMatch) {
      return res.status(401).json({ ok: false, error: 'Girdiğiniz şifre hatalı.' });
    }

    user.totpEnabled = false;
    user.totpSecretEnc = '';
    await user.save();

    await writeAuditLog(req, '2FA_DISABLED', 'İki adımlı doğrulama devre dışı bırakıldı');

    return res.json({ ok: true, message: 'İki adımlı doğrulama devre dışı bırakıldı.' });
  } catch (err) {
    console.error('[ERROR] 2FA disable failed:', err);
    return res.status(500).json({ ok: false, error: '2FA devre dışı bırakılamadı.' });
  }
});

// ---------------------------------------------------------------------------
// 5. Leads Management: List, Export CSV, Detail, Status, Notes, Resend Mail
// ---------------------------------------------------------------------------
function buildLeadsMongoFilter(query) {
  const filter = {};

  // Site filter (support comma-separated or array)
  if (query.site) {
    const sites = Array.isArray(query.site)
      ? query.site
      : String(query.site).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (sites.length === 1) {
      filter.site = sites[0];
    } else if (sites.length > 1) {
      filter.site = { $in: sites };
    }
  }

  // Brand filter
  if (query.brand) {
    const brands = Array.isArray(query.brand)
      ? query.brand
      : String(query.brand).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (brands.length === 1) {
      filter.brand = brands[0];
    } else if (brands.length > 1) {
      filter.brand = { $in: brands };
    }
  }

  if (query.status && query.status !== 'all') {
    filter.status = query.status;
  }

  if (query.requestType && query.requestType !== 'all') {
    filter.requestType = query.requestType;
  }

  if (query.search && typeof query.search === 'string') {
    const trimmed = query.search.trim();
    if (trimmed.length > 0) {
      const escaped = escapeRegex(trimmed);
      const rgx = new RegExp(escaped, 'i');
      filter.$or = [
        { refCode: rgx },
        { fullName: rgx },
        { company: rgx },
        { email: rgx },
        { phone: rgx }
      ];
    }
  }

  return filter;
}

// GET /api/admin/leads: Paginated leads list with site breakdown & status counts
router.get('/leads', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = buildLeadsMongoFilter(req.query);

    const [leads, total, countsAgg, siteAgg] = await Promise.all([
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
      Lead.aggregate([
        { $match: buildLeadsMongoFilter({ ...req.query, status: 'all' }) },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Lead.aggregate([
        { $match: {} },
        { $group: { _id: '$site', count: { $sum: 1 } } }
      ])
    ]);

    const countsByStatus = {
      all: 0,
      new: 0,
      contacted: 0,
      quoted: 0,
      won: 0,
      lost: 0
    };

    let totalAll = 0;
    for (const c of countsAgg) {
      if (countsByStatus[c._id] !== undefined) {
        countsByStatus[c._id] = c.count;
      }
      totalAll += c.count;
    }
    countsByStatus.all = totalAll;

    const siteBreakdown = {};
    for (const s of siteAgg) {
      if (s._id) {
        siteBreakdown[s._id] = s.count;
      }
    }

    return res.json({
      ok: true,
      items: leads,
      leads,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      countsByStatus,
      siteBreakdown
    });
  } catch (err) {
    console.error('[ERROR] GET /api/admin/leads error:', err);
    return res.status(500).json({ ok: false, error: 'Talepler listelenirken hata oluştu.' });
  }
});

// GET /api/admin/leads/export.csv: Secure CSV export
router.get('/leads/export.csv', requireAuth, async (req, res) => {
  try {
    const filter = buildLeadsMongoFilter(req.query);
    const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const headers = [
      'Sıra',
      'Referans Kodu',
      'Site',
      'Marka',
      'Talep Tipi',
      'Ad Soyad',
      'Firma',
      'E-Posta',
      'Telefon',
      'Ürün / Çözüm',
      'Adet / Ölçek',
      'Santral (PBX)',
      'Proje Adı',
      'Mesaj',
      'Sepet Özeti',
      'Ek Alanlar (JSON)',
      'KVKK Onayı',
      'Pazarlama İzni',
      'Durum',
      'Tarih (İstanbul)'
    ];

    const lines = [headers.map(escapeCsvCell).join(',')];

    leads.forEach((lead, index) => {
      const cartSummary = (lead.cartSnapshot || [])
        .map((item) => `${item.model} (${item.qty} adet)`)
        .join('; ');

      const extraJson =
        lead.extra && Object.keys(lead.extra).length > 0
          ? JSON.stringify(lead.extra)
          : '';

      const formattedDate = new Date(lead.createdAt).toLocaleString('tr-TR', {
        timeZone: 'Europe/Istanbul'
      });

      const row = [
        index + 1,
        lead.refCode,
        lead.site || '',
        lead.brand || '',
        lead.requestType,
        lead.fullName,
        lead.company || '',
        lead.email,
        lead.phone,
        lead.selectedProduct || '',
        lead.quantity || '',
        lead.pbxSystem || '',
        lead.projectName || '',
        lead.message || '',
        cartSummary,
        extraJson,
        lead.kvkkAccepted ? 'Evet' : 'Hayır',
        lead.marketingConsent ? 'Evet' : 'Hayır',
        lead.status,
        formattedDate
      ];

      lines.push(row.map(escapeCsvCell).join(','));
    });

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const filename = `tescom-talepler-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (err) {
    console.error('[ERROR] CSV Export error:', err);
    return res.status(500).json({ ok: false, error: 'CSV dışa aktarım hatası.' });
  }
});

// GET /api/admin/leads/:id: Get lead details
router.get('/leads/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'Talep bulunamadı.' });
    }

    if (!lead.isRead) {
      lead.isRead = true;
      await lead.save();
    }

    return res.json({ ok: true, lead });
  } catch (err) {
    console.error('[ERROR] GET /api/admin/leads/:id error:', err);
    return res.status(500).json({ ok: false, error: 'Talep detayı alınamadı.' });
  }
});

const patchStatusSchema = z
  .object({
    status: z.enum(['new', 'contacted', 'quoted', 'won', 'lost'])
  })
  .strict();

// PATCH /api/admin/leads/:id/status: Update lead status
router.patch('/leads/:id/status', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const parseRes = patchStatusSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Geçersiz durum değeri.' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'Talep bulunamadı.' });
    }

    const oldStatus = lead.status;
    lead.status = parseRes.data.status;
    await lead.save();

    await writeAuditLog(
      req,
      'STATUS_CHANGED',
      `Talep (${lead.refCode}) durumu '${oldStatus}' -> '${lead.status}' olarak güncellendi.`
    );

    return res.json({ ok: true, lead });
  } catch (err) {
    console.error('[ERROR] Status update error:', err);
    return res.status(500).json({ ok: false, error: 'Durum güncellenemedi.' });
  }
});

const addNoteSchema = z
  .object({
    text: z.string().trim().min(1).max(2000)
  })
  .strict();

// POST /api/admin/leads/:id/notes: Add internal note to lead
router.post('/leads/:id/notes', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const parseRes = addNoteSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Not metni 1-2000 karakter olmalıdır.' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'Talep bulunamadı.' });
    }

    const newNote = {
      text: parseRes.data.text,
      by: req.adminUser.username,
      at: new Date()
    };

    lead.notes.unshift(newNote);
    await lead.save();

    await writeAuditLog(req, 'NOTE_ADDED', `Talep (${lead.refCode}) kaydına yeni not eklendi.`);

    return res.json({ ok: true, notes: lead.notes });
  } catch (err) {
    console.error('[ERROR] Add note error:', err);
    return res.status(500).json({ ok: false, error: 'Not eklenirken hata oluştu.' });
  }
});

// POST /api/admin/leads/:id/resend-mail: Re-enqueue outbox notification email
router.post('/leads/:id/resend-mail', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'Talep bulunamadı.' });
    }

    const job = await enqueueLeadMailJob(lead._id);
    if (!job) {
      return res.status(500).json({ ok: false, error: 'Mail iş kuyruğuna alınamadı.' });
    }

    await writeAuditLog(
      req,
      'RESEND_MAIL_TRIGGERED',
      `Talep (${lead.refCode}) için bildirim e-postası yeniden kuyruğa eklendi.`
    );

    return res.json({ ok: true, message: 'Bildirim e-postası başarıyla kuyruğa eklendi.' });
  } catch (err) {
    console.error('[ERROR] Resend mail error:', err);
    return res.status(500).json({ ok: false, error: 'Mail gönderim isteği başarısız oldu.' });
  }
});

// ---------------------------------------------------------------------------
// 6. SMTP Settings & Connection Testing
// ---------------------------------------------------------------------------
router.get('/mail-settings', requireAdminRole, async (_req, res) => {
  try {
    const settings = await MailSettings.findOne({ key: 'default' }).lean();
    const attempts = await MailAttempt.find().sort({ createdAt: -1 }).limit(20).lean();

    return res.json({
      ok: true,
      settings: {
        smtpHost: settings?.smtpHost || 'mail.dogrumail.com',
        smtpPort: settings?.smtpPort || 587,
        smtpSecurity: settings?.smtpSecurity || 'starttls',
        smtpUser: settings?.smtpUser || '',
        hasPassword: Boolean(settings?.smtpPassEnc),
        smtpFromAddress: settings?.smtpFromAddress || '',
        smtpFromName: settings?.smtpFromName || 'Tescom Lead Platform',
        updatedAt: settings?.updatedAt || null,
        updatedBy: settings?.updatedBy || ''
      },
      recentAttempts: attempts
    });
  } catch (err) {
    console.error('[ERROR] GET /mail-settings error:', err);
    return res.status(500).json({ ok: false, error: 'Ayarlar getirilemedi.' });
  }
});

const putMailSettingsSchema = z
  .object({
    smtpHost: z.string().trim().min(3).max(254),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecurity: z.enum(['starttls', 'tls']),
    smtpUser: z.string().trim().max(254).optional().default(''),
    smtpPassword: z.string().max(256).optional(),
    smtpFromAddress: z.string().trim().email().max(254),
    smtpFromName: z.string().trim().max(120).optional().default('Tescom Lead Platform')
  })
  .strict();

router.put('/mail-settings', requireAdminRole, async (req, res) => {
  try {
    const parseRes = putMailSettingsSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        ok: false,
        error: parseRes.error.issues?.[0]?.message || 'Geçersiz SMTP ayarları.'
      });
    }

    const d = parseRes.data;
    await assertSafeSmtpHost(d.smtpHost);

    let settings = await MailSettings.findOne({ key: 'default' });
    if (!settings) {
      settings = new MailSettings({ key: 'default' });
    }

    settings.smtpHost = d.smtpHost;
    settings.smtpPort = d.smtpPort;
    settings.smtpSecurity = d.smtpSecurity;
    settings.smtpUser = d.smtpUser || d.smtpFromAddress;
    settings.smtpFromAddress = d.smtpFromAddress;
    settings.smtpFromName = d.smtpFromName;
    settings.updatedAt = new Date();
    settings.updatedBy = req.adminUser.username;

    if (d.smtpPassword && d.smtpPassword.trim().length > 0) {
      settings.smtpPassEnc = encryptSecret(d.smtpPassword);
    }

    await settings.save();
    invalidateMailTransporter();

    await writeAuditLog(req, 'MAIL_SETTINGS_UPDATED', 'SMTP sunucu ayarları güncellendi.');

    return res.json({ ok: true, message: 'SMTP ayarları başarıyla kaydedildi.' });
  } catch (err) {
    console.error('[ERROR] PUT /mail-settings error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Ayarlar kaydedilemedi.' });
  }
});

router.post('/mail-settings/test-connection', requireAdminRole, async (req, res) => {
  try {
    let settings = await MailSettings.findOne({ key: 'default' }).lean();
    if (!settings) {
      return res.status(400).json({ ok: false, error: 'SMTP ayarları bulunamadı.' });
    }

    if (req.body && req.body.smtpPassword) {
      settings = { ...settings, plainPassword: req.body.smtpPassword };
    }

    const testRes = await verifySmtpConnection(settings);
    return res.json({ ok: true, ...testRes });
  } catch (err) {
    console.error('[ERROR] Test SMTP connection failed:', err);
    return res.status(400).json({
      ok: false,
      errorCode: err.errorCode || 'SMTP_ERROR',
      error: err.message || 'SMTP bağlantısı başarısız.'
    });
  }
});

const sendTestMailSchema = z
  .object({
    recipient: z.string().trim().email().max(254)
  })
  .strict();

router.post('/mail-settings/send-test-mail', requireAdminRole, async (req, res) => {
  try {
    const parseRes = sendTestMailSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Geçerli bir alıcı e-posta adresi giriniz.' });
    }

    const settings = await MailSettings.findOne({ key: 'default' }).lean();
    if (!settings) {
      return res.status(400).json({ ok: false, error: 'SMTP ayarları yapılandırılmamış.' });
    }

    const recipient = parseRes.data.recipient;
    const testSubject = `[Tescom Lead Platform] SMTP Test İletisi – ${new Date().toLocaleTimeString('tr-TR')}`;
    const testHtml = `<p>Merhaba,</p><p>Bu bir test e-postasıdır. Tescom Multi-Site Lead Platform SMTP yapılandırmanız sorunsuz çalışmaktadır.</p>`;

    await sendMailWithSettings(
      settings,
      {
        toAddresses: [recipient],
        subject: testSubject,
        html: testHtml,
        text: 'Tescom Lead Platform SMTP Test iletisi'
      },
      { ephemeral: true }
    );

    await writeAuditLog(req, 'TEST_MAIL_SENT', `Test e-postası gönderildi: ${recipient}`);

    return res.json({ ok: true, message: `Test e-postası ${recipient} adresine başarıyla iletildi.` });
  } catch (err) {
    console.error('[ERROR] Send test mail error:', err);
    return res.status(400).json({
      ok: false,
      errorCode: err.errorCode || 'SMTP_ERROR',
      error: err.message || 'Test e-postası gönderilemedi.'
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Mail Recipients CRUD (Supports multi-site and requestTypes)
// ---------------------------------------------------------------------------
router.get('/recipients', requireAdminRole, async (_req, res) => {
  try {
    const recipients = await MailRecipient.find().sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, recipients, items: recipients });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Alıcılar listelenemedi.' });
  }
});

const recipientSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(2).max(120),
    active: z.boolean().optional().default(true),
    sites: z.array(z.string().trim()).optional().default([]),
    requestTypes: z.array(z.string().trim()).optional().default([])
  })
  .strict();

router.post('/recipients', requireAdminRole, async (req, res) => {
  try {
    const parseRes = recipientSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        ok: false,
        error: parseRes.error.issues?.[0]?.message || 'Geçersiz alıcı bilgileri.'
      });
    }

    const { email, name, active, sites, requestTypes } = parseRes.data;
    const cleanEmail = email.toLowerCase();

    const existing = await MailRecipient.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Bu e-posta adresi zaten kayıtlı.' });
    }

    const created = await MailRecipient.create({
      email: cleanEmail,
      name,
      active,
      sites,
      requestTypes,
      createdAt: new Date()
    });

    await writeAuditLog(req, 'RECIPIENT_ADDED', `Yeni alıcı eklendi: ${cleanEmail}`);
    return res.status(201).json({ ok: true, recipient: created });
  } catch (err) {
    console.error('[ERROR] Create recipient error:', err);
    return res.status(500).json({ ok: false, error: 'Alıcı eklenemedi.' });
  }
});

router.patch('/recipients/:id', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const parseRes = recipientSchema.partial().safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Geçersiz güncelleme verisi.' });
    }

    const updated = await MailRecipient.findByIdAndUpdate(
      req.params.id,
      { $set: parseRes.data },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Alıcı bulunamadı.' });
    }

    await writeAuditLog(req, 'RECIPIENT_UPDATED', `Alıcı güncellendi: ${updated.email}`);
    return res.json({ ok: true, recipient: updated });
  } catch (err) {
    console.error('[ERROR] Update recipient error:', err);
    return res.status(500).json({ ok: false, error: 'Alıcı güncellenemedi.' });
  }
});

router.delete('/recipients/:id', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const deleted = await MailRecipient.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Alıcı bulunamadı.' });
    }

    await writeAuditLog(req, 'RECIPIENT_DELETED', `Alıcı silindi: ${deleted.email}`);
    return res.json({ ok: true, message: 'Alıcı başarıyla silindi.' });
  } catch (err) {
    console.error('[ERROR] Delete recipient error:', err);
    return res.status(500).json({ ok: false, error: 'Alıcı silinemedi.' });
  }
});

// ---------------------------------------------------------------------------
// 8. Allowed IPs CRUD
// ---------------------------------------------------------------------------
router.get('/allowed-ips', requireAdminRole, async (_req, res) => {
  try {
    const [dbIps, bootstrapList] = await Promise.all([
      AllowedIp.find().sort({ createdAt: -1 }).lean(),
      Promise.resolve(getBootstrapIps())
    ]);

    return res.json({
      ok: true,
      allowedIps: dbIps,
      bootstrapIps: bootstrapList
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'IP listesi alınamadı.' });
  }
});

const allowedIpPostSchema = z
  .object({
    ip: z.string().trim().min(3).max(64),
    note: z.string().trim().max(200).optional().default('')
  })
  .strict();

router.post('/allowed-ips', requireAdminRole, async (req, res) => {
  try {
    const parseRes = allowedIpPostSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ ok: false, error: 'Geçersiz IP kuralı verisi.' });
    }

    const { ip, note } = parseRes.data;
    const ruleCheck = validateAllowedIpRule(ip);
    if (!ruleCheck.ok) {
      return res.status(400).json({ ok: false, error: ruleCheck.error });
    }

    const normalizedRule = ruleCheck.normalized;
    const existing = await AllowedIp.findOne({ ip: normalizedRule });
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Bu IP veya CIDR kuralı zaten mevcut.' });
    }

    const created = await AllowedIp.create({
      ip: normalizedRule,
      note,
      createdBy: req.adminUser.username,
      createdAt: new Date()
    });

    invalidateAllowedIpCache();
    await writeAuditLog(req, 'ALLOWED_IP_ADDED', `İzinli IP eklendi: ${normalizedRule}`);

    return res.status(201).json({ ok: true, allowedIp: created });
  } catch (err) {
    console.error('[ERROR] Create allowed IP error:', err);
    return res.status(500).json({ ok: false, error: 'IP eklenemedi.' });
  }
});

router.delete('/allowed-ips/:id', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    const deleted = await AllowedIp.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'IP kuralı bulunamadı.' });
    }

    invalidateAllowedIpCache();
    await writeAuditLog(req, 'ALLOWED_IP_DELETED', `İzinli IP kuralı silindi: ${deleted.ip}`);

    return res.json({ ok: true, message: 'IP kuralı silindi.' });
  } catch (err) {
    console.error('[ERROR] Delete allowed IP error:', err);
    return res.status(500).json({ ok: false, error: 'IP silinemedi.' });
  }
});

// ---------------------------------------------------------------------------
// 9. Admin Users CRUD & Password Change
// ---------------------------------------------------------------------------
router.get('/users', requireAdminRole, async (_req, res) => {
  try {
    const users = await AdminUser.find(
      {},
      { passwordHash: 0, totpSecretEnc: 0 }
    )
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, users, items: users });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Kullanıcılar listelenemedi.' });
  }
});

const createUserSchema = z
  .object({
    username: z.string().trim().min(3).max(60),
    password: z.string().min(12).max(128),
    role: z.enum(['admin', 'viewer']).default('admin')
  })
  .strict();

router.post('/users', requireAdminRole, async (req, res) => {
  try {
    const parseRes = createUserSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        ok: false,
        error: 'Kullanıcı adı en az 3, şifre en az 12 karakter olmalıdır.'
      });
    }

    const { username, password, role } = parseRes.data;
    const cleanUsername = username.toLowerCase();

    const existing = await AdminUser.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Bu kullanıcı adı zaten mevcut.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await AdminUser.create({
      username: cleanUsername,
      passwordHash,
      role,
      failedAttempts: 0,
      lockedUntil: null,
      passwordChangedAt: new Date(),
      createdAt: new Date()
    });

    await writeAuditLog(req, 'USER_CREATED', `Yeni kullanıcı oluşturuldu: ${cleanUsername} (${role})`);

    return res.status(201).json({
      ok: true,
      user: {
        id: created._id.toString(),
        username: created.username,
        role: created.role,
        createdAt: created.createdAt
      }
    });
  } catch (err) {
    console.error('[ERROR] Create user error:', err);
    return res.status(500).json({ ok: false, error: 'Kullanıcı oluşturulamadı.' });
  }
});

router.delete('/users/:id', requireAdminRole, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ID formatı.' });
    }

    if (req.params.id === req.adminUser.id) {
      return res.status(400).json({ ok: false, error: 'Kendi hesabınızı silemezsiniz.' });
    }

    const adminCount = await AdminUser.countDocuments({ role: 'admin' });
    const targetUser = await AdminUser.findById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({ ok: false, error: 'Kullanıcı bulunamadı.' });
    }

    if (targetUser.role === 'admin' && adminCount <= 1) {
      return res.status(400).json({
        ok: false,
        error: 'Sistemde en az 1 yönetici (admin) bulunmalıdır; son yönetici silinemez.'
      });
    }

    await AdminUser.findByIdAndDelete(req.params.id);
    await writeAuditLog(req, 'USER_DELETED', `Kullanıcı silindi: ${targetUser.username}`);

    return res.json({ ok: true, message: 'Kullanıcı başarıyla silindi.' });
  } catch (err) {
    console.error('[ERROR] Delete user error:', err);
    return res.status(500).json({ ok: false, error: 'Kullanıcı silinemedi.' });
  }
});

const changePwSchema = z
  .object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(12).max(128)
  })
  .strict();

router.post('/users/change-password', requireAuth, async (req, res) => {
  try {
    const parseRes = changePwSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        ok: false,
        error: 'Yeni şifre en az 12 karakter uzunluğunda olmalıdır.'
      });
    }

    const { oldPassword, newPassword } = parseRes.data;
    const user = await AdminUser.findById(req.adminUser.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Kullanıcı bulunamadı.' });
    }

    const pwMatch = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!pwMatch) {
      return res.status(400).json({ ok: false, error: 'Mevcut şifreniz hatalı.' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.passwordChangedAt = new Date();
    await user.save();

    await writeAuditLog(req, 'PASSWORD_CHANGED', 'Kullanıcı kendi şifresini değiştirdi.');

    return res.json({ ok: true, message: 'Şifreniz başarıyla değiştirildi.' });
  } catch (err) {
    console.error('[ERROR] Change password error:', err);
    return res.status(500).json({ ok: false, error: 'Şifre değiştirilemedi.' });
  }
});

// ---------------------------------------------------------------------------
// 10. Audit Logs
// ---------------------------------------------------------------------------
router.get('/audit-logs', requireAdminRole, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AuditLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments()
    ]);

    return res.json({
      ok: true,
      logs,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    console.error('[ERROR] Audit logs error:', err);
    return res.status(500).json({ ok: false, error: 'Denetim kayıtları alınamadı.' });
  }
});

module.exports = router;
