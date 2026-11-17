'use strict';

const mongoose = require('mongoose');

// 1. Lead Schema (supports multi-site, multi-brand, and extensible 'extra' fields)
const cartItemSchema = new mongoose.Schema(
  {
    model: { type: String, required: true, maxlength: 100, trim: true },
    qty: { type: Number, required: true, min: 1, max: 10000 }
  },
  { _id: false }
);

const leadNoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: 2000, trim: true },
    by: { type: String, required: true, maxlength: 80, trim: true },
    at: { type: Date, default: Date.now }
  },
  { _id: true }
);

const leadMongooseSchema = new mongoose.Schema(
  {
    refCode: { type: String, required: true, unique: true },
    site: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    brand: { type: String, required: true, trim: true, lowercase: true, maxlength: 50 },
    requestType: { type: String, required: true, trim: true, maxlength: 60 },
    fullName: { type: String, required: true, minlength: 2, maxlength: 120, trim: true },
    company: { type: String, default: '', maxlength: 120, trim: true },
    email: { type: String, required: true, maxlength: 254, lowercase: true, trim: true },
    phone: { type: String, required: true, minlength: 7, maxlength: 20, trim: true },
    selectedProduct: { type: String, default: '', maxlength: 200, trim: true },
    quantity: { type: String, default: '', maxlength: 200, trim: true },
    pbxSystem: { type: String, default: '', maxlength: 200, trim: true },
    projectName: { type: String, default: '', maxlength: 200, trim: true },
    message: { type: String, default: '', maxlength: 3000, trim: true },
    cartSnapshot: {
      type: [cartItemSchema],
      default: [],
      validate: [(arr) => arr.length <= 50, 'En fazla 50 sepet kalemi gönderilebilir.']
    },
    extra: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    kvkkAccepted: { type: Boolean, required: true },
    kvkkAcceptedAt: { type: Date, default: Date.now },
    kvkkVersion: { type: String, default: 'v1', maxlength: 10, trim: true },
    marketingConsent: { type: Boolean, default: false },
    marketingConsentAt: { type: Date, default: null },
    status: {
      type: String,
      default: 'new',
      enum: ['new', 'contacted', 'quoted', 'won', 'lost']
    },
    captchaStatus: {
      type: String,
      default: 'disabled',
      enum: ['passed', 'unverified', 'disabled']
    },
    isRead: { type: Boolean, default: false },
    notes: { type: [leadNoteSchema], default: [] },
    ip: { type: String, default: '', maxlength: 100 },
    userAgent: { type: String, default: '', maxlength: 300 },
    createdAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    collection: 'leads'
  }
);

leadMongooseSchema.index({ createdAt: -1 });
leadMongooseSchema.index({ site: 1, createdAt: -1 });
leadMongooseSchema.index({ brand: 1, createdAt: -1 });
leadMongooseSchema.index({ email: 1 });
leadMongooseSchema.index({ status: 1, createdAt: -1 });
leadMongooseSchema.index({ requestType: 1, createdAt: -1 });
leadMongooseSchema.index({ captchaStatus: 1, createdAt: -1 });
leadMongooseSchema.index({ marketingConsent: 1, createdAt: -1 });
leadMongooseSchema.index({ ip: 1, captchaStatus: 1, createdAt: -1 });

// 2. Allowed IPs Collection ("allowed_ips")
const allowedIpSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, maxlength: 64, trim: true },
    note: { type: String, default: '', maxlength: 200, trim: true },
    createdBy: { type: String, required: true, maxlength: 80, trim: true },
    createdAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    collection: 'allowed_ips'
  }
);

// 3. Admin Users Collection ("admin_users")
const adminUserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 60
    },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['admin', 'viewer'], default: 'admin' },
    totpEnabled: { type: Boolean, default: false },
    totpSecretEnc: { type: String, default: '' },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: '' }
  },
  {
    versionKey: false,
    collection: 'admin_users'
  }
);

// 4. Mail Settings Collection ("mail_settings" - singleton document with key='default')
const mailSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    smtpHost: { type: String, default: 'mail.dogrumail.com', maxlength: 254, trim: true },
    smtpPort: { type: Number, default: 587, min: 1, max: 65535 },
    smtpSecurity: { type: String, enum: ['starttls', 'tls'], default: 'starttls' },
    smtpUser: { type: String, default: '', maxlength: 254, trim: true },
    smtpPassEnc: { type: String, default: '' },
    smtpFromAddress: { type: String, default: '', maxlength: 254, trim: true },
    smtpFromName: { type: String, default: 'Tescom B2B Panel', maxlength: 120, trim: true },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: '' }
  },
  {
    versionKey: false,
    collection: 'mail_settings'
  }
);

// 5. Mail Recipients Collection ("mail_recipients")
const mailRecipientSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    active: { type: Boolean, default: true },
    sites: {
      type: [String],
      default: []
    },
    requestTypes: {
      type: [String],
      default: []
    },
    createdAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    collection: 'mail_recipients'
  }
);

// 6. Outbox Mail Jobs Collection ("mail_jobs")
const mailJobSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'sent', 'failed', 'skipped'],
      default: 'pending',
      index: true
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '', maxlength: 2000 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false,
    collection: 'mail_jobs'
  }
);

mailJobSchema.index({ status: 1, nextAttemptAt: 1 });

// 7. Audit Logs Collection ("audit_logs")
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: String, required: true, maxlength: 80, trim: true },
    action: { type: String, required: true, maxlength: 80, trim: true },
    details: { type: String, default: '', maxlength: 1000, trim: true },
    ip: { type: String, default: '', maxlength: 100 },
    createdAt: { type: Date, default: Date.now, index: -1 }
  },
  {
    versionKey: false,
    collection: 'audit_logs'
  }
);

// 8. Mail Attempt Logs Collection ("mail_attempts")
const mailAttemptSchema = new mongoose.Schema(
  {
    recipient: { type: String, required: true, maxlength: 500, trim: true },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    errorCode: { type: String, default: '250 OK', maxlength: 100, trim: true },
    errorMessage: { type: String, default: '', maxlength: 1000, trim: true },
    refCode: { type: String, default: '', maxlength: 40, trim: true },
    createdAt: { type: Date, default: Date.now, index: -1 }
  },
  {
    versionKey: false,
    collection: 'mail_attempts'
  }
);

// 9. Rate Limits Collection ("rate_limits") with TTL index for multi-replica shared rate limiting
const rateLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    totalHits: { type: Number, required: true, default: 1 },
    resetTime: { type: Date, required: true }
  },
  {
    versionKey: false,
    collection: 'rate_limits'
  }
);

rateLimitSchema.index({ resetTime: 1 }, { expireAfterSeconds: 0 });

const Lead = mongoose.model('Lead', leadMongooseSchema);
const AllowedIp = mongoose.model('AllowedIp', allowedIpSchema);
const AdminUser = mongoose.model('AdminUser', adminUserSchema);
const MailSettings = mongoose.model('MailSettings', mailSettingsSchema);
const MailRecipient = mongoose.model('MailRecipient', mailRecipientSchema);
const MailJob = mongoose.model('MailJob', mailJobSchema);
const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const MailAttempt = mongoose.model('MailAttempt', mailAttemptSchema);
const RateLimitRecord = mongoose.model('RateLimitRecord', rateLimitSchema);

module.exports = {
  Lead,
  AllowedIp,
  AdminUser,
  MailSettings,
  MailRecipient,
  MailJob,
  AuditLog,
  MailAttempt,
  RateLimitRecord
};
