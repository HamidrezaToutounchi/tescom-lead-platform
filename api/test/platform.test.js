'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

let mongoServer;
let app;
let Lead;
let AdminUser;
let AllowedIp;
let MongoRateLimitStore;

jest.setTimeout(180000);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = uri;
  process.env.SESSION_SECRET = 'super_secret_test_session_key_at_least_32_chars';
  process.env.SETTINGS_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.ADMIN_BOOTSTRAP_IPS = '93.184.216.34'; // Valid public unicast IP

  await mongoose.connect(uri);

  const models = require('../models');
  Lead = models.Lead;
  AdminUser = models.AdminUser;
  AllowedIp = models.AllowedIp;
  MongoRateLimitStore = require('../mongoRateLimitStore');

  app = require('../server');
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

beforeEach(async () => {
  await Lead.deleteMany({});
  await AdminUser.deleteMany({});
  await AllowedIp.deleteMany({});
});

describe('Tescom Multi-Site Lead Platform Tests', () => {
  describe('1. Host Validation & Unknown Hosts', () => {
    it('should return 404 for unknown host', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'evil-domain.com')
        .send({ requestType: 'bilgi' });

      expect(res.status).toBe(404);
    });

    it('should return 200 for allowed host on /api/health', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Host', 'fanvilpartner.com');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('2. Multi-Site Lead Submissions', () => {
    it('should submit lead for fanvilpartner.com with FVL prefix and fanvil brand', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .send({
          requestType: 'bilgi',
          fullName: 'Ahmet Yilmaz',
          company: 'Tescom A.S.',
          email: 'ahmet@example.com',
          phone: '+90 555 123 4567',
          selectedProduct: 'Fanvil V67',
          quantity: '5',
          kvkkAccepted: true,
          kvkkVersion: 'v1'
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.refCode).toMatch(/^FVL-[A-Z0-9]{8}$/);

      const saved = await Lead.findOne({ refCode: res.body.refCode });
      expect(saved).toBeTruthy();
      expect(saved.site).toBe('fanvilpartner.com');
      expect(saved.brand).toBe('fanvil');
      expect(saved.requestType).toBe('bilgi');
    });

    it('should submit lead for jabrapanacast.com.tr with JPC prefix and jabra brand', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'jabrapanacast.com.tr')
        .set('Origin', 'https://jabrapanacast.com.tr')
        .send({
          requestType: 'kesif',
          fullName: 'Mehmet Demir',
          company: 'Demir Holding',
          email: 'mehmet@example.com',
          phone: '+90 532 987 6543',
          selectedProduct: 'Jabra PanaCast 50',
          kvkkAccepted: true
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.refCode).toMatch(/^JPC-[A-Z0-9]{8}$/);

      const saved = await Lead.findOne({ refCode: res.body.refCode });
      expect(saved).toBeTruthy();
      expect(saved.site).toBe('jabrapanacast.com.tr');
      expect(saved.brand).toBe('jabra');
      expect(saved.requestType).toBe('kesif');
    });

    it('should submit lead for jabrapartner.com.tr with JBP prefix and jabra brand', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'jabrapartner.com.tr')
        .set('Origin', 'https://jabrapartner.com.tr')
        .send({
          requestType: 'teklif',
          fullName: 'Ayse Kaya',
          email: 'ayse@example.com',
          phone: '+90 533 111 2233',
          kvkkAccepted: true
        });

      expect(res.status).toBe(201);
      expect(res.body.refCode).toMatch(/^JBP-[A-Z0-9]{8}$/);

      const saved = await Lead.findOne({ refCode: res.body.refCode });
      expect(saved).toBeTruthy();
      expect(saved.site).toBe('jabrapartner.com.tr');
      expect(saved.brand).toBe('jabra');
    });

    it('should submit lead for jabravideokonferans.com with JVK prefix and jabra brand', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'jabravideokonferans.com')
        .set('Origin', 'https://jabravideokonferans.com')
        .send({
          requestType: 'demo',
          fullName: 'Canan Ozturk',
          email: 'canan@example.com',
          phone: '+90 544 555 6677',
          kvkkAccepted: true,
          extra: {
            room_size: 'large',
            screen_count: '2'
          }
        });

      expect(res.status).toBe(201);
      expect(res.body.refCode).toMatch(/^JVK-[A-Z0-9]{8}$/);

      const saved = await Lead.findOne({ refCode: res.body.refCode });
      expect(saved).toBeTruthy();
      expect(saved.site).toBe('jabravideokonferans.com');
      expect(saved.brand).toBe('jabra');
      expect(saved.extra.room_size).toBe('large');
    });
  });

  describe('3. Cross-Site Origin Protection', () => {
    it('should reject lead submission with 403 when Origin does not match Host', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'jabrapanacast.com.tr')
        .set('Origin', 'https://fanvilpartner.com') // Cross-site attack!
        .send({
          requestType: 'kesif',
          fullName: 'Attacker',
          email: 'attacker@example.com',
          phone: '+90 555 000 0000',
          kvkkAccepted: true
        });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('4. Input Validation & Strict Schema', () => {
    it('should reject invalid requestType for the site with 400', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .send({
          requestType: 'kesif', // 'kesif' is not in fanvilpartner.com requestTypes
          fullName: 'Test User',
          email: 'test@example.com',
          phone: '+90 555 123 4567',
          kvkkAccepted: true
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('should reject unknown extra property with 400 due to .strict()', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .send({
          requestType: 'bilgi',
          fullName: 'Test User',
          email: 'test@example.com',
          phone: '+90 555 123 4567',
          kvkkAccepted: true,
          injectedUnknownField: 'malicious' // Unknown field
        });

      expect(res.status).toBe(400);
    });

    it('should silently discard honeypot submissions with 200 OK and no DB record', async () => {
      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .send({
          requestType: 'bilgi',
          fullName: 'Spam Bot',
          email: 'bot@example.com',
          phone: '+90 555 123 4567',
          kvkkAccepted: true,
          website: 'http://spam-link.ru' // Honeypot filled!
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const count = await Lead.countDocuments({ email: 'bot@example.com' });
      expect(count).toBe(0);
    });
  });

  describe('5. Turnstile Security Enforcement', () => {
    it('should return 400 when TURNSTILE_SECRET_KEY is set but no token is provided', async () => {
      process.env.TURNSTILE_SECRET_KEY = '0x4AAAAAAATestSecretKeyDummy';

      const res = await request(app)
        .post('/api/leads')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .send({
          requestType: 'bilgi',
          fullName: 'Test User',
          email: 'test@example.com',
          phone: '+90 555 123 4567',
          kvkkAccepted: true
          // no turnstileToken!
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Güvenlik doğrulaması');

      delete process.env.TURNSTILE_SECRET_KEY;
    });
  });

  describe('6. IP Allowlist & Admin Access Control', () => {
    it('should return 404 (NEVER 403) to unauthorized IP accessing /admin or /api/admin/me', async () => {
      // 203.0.113.99 is not in bootstrap IPs (198.51.100.10)
      const res1 = await request(app)
        .get('/api/admin/me')
        .set('Host', 'fanvilpartner.com')
        .set('X-Forwarded-For', '203.0.113.99');

      expect(res1.status).toBe(404);

      const res2 = await request(app)
        .get('/admin')
        .set('Host', 'fanvilpartner.com')
        .set('X-Forwarded-For', '203.0.113.99');

      expect(res2.status).toBe(404);
    });

    it('should allow authorized IP to access /api/admin/me and return 401 unauthenticated', async () => {
      const res = await request(app)
        .get('/api/admin/me')
        .set('Host', 'fanvilpartner.com')
        .set('X-Forwarded-For', '93.184.216.34');

      expect(res.status).toBe(401);
      expect(res.body.authenticated).toBe(false);
    });

    it('should authenticate admin user and return session cookie', async () => {
      const passwordHash = await bcrypt.hash('SecurePassword123!', 10);
      await AdminUser.create({
        username: 'tescomadmin',
        passwordHash,
        role: 'admin',
        createdAt: new Date()
      });

      const res = await request(app)
        .post('/api/admin/login')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://fanvilpartner.com')
        .set('X-Forwarded-For', '93.184.216.34')
        .send({
          username: 'tescomadmin',
          password: 'SecurePassword123!'
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.username).toBe('tescomadmin');

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toContain('tescom_admin=');
    });

    it('should reject admin login when Origin does not match allowed origin', async () => {
      const res = await request(app)
        .post('/api/admin/login')
        .set('Host', 'fanvilpartner.com')
        .set('Origin', 'https://malicious-site.com')
        .set('X-Forwarded-For', '93.184.216.34')
        .send({
          username: 'tescomadmin',
          password: 'SecurePassword123!'
        });

      expect(res.status).toBe(403);
    });
  });

  describe('7. Shared Mongo Rate Limiter Across Store Instances', () => {
    it('should share rate limit counter across multiple store instances on same MongoDB', async () => {
      const store1 = new MongoRateLimitStore({ windowMs: 60000, prefix: 'rl:test:' });
      const store2 = new MongoRateLimitStore({ windowMs: 60000, prefix: 'rl:test:' });

      const testKey = 'client_192_0_2_1';

      const res1 = await store1.increment(testKey);
      expect(res1.totalHits).toBe(1);

      const res2 = await store2.increment(testKey); // second replica increments same key
      expect(res2.totalHits).toBe(2);

      const res3 = await store1.increment(testKey);
      expect(res3.totalHits).toBe(3);

      await store1.resetKey(testKey);
      const res4 = await store2.increment(testKey);
      expect(res4.totalHits).toBe(1);
    });
  });
});
