'use strict';

const { Lead, MailSettings, MailRecipient, MailJob, MailAttempt } = require('./models');
const {
  invalidateMailTransporter,
  isMailSettingsConfigured,
  sendMailWithSettings,
  buildLeadNotificationContent
} = require('./mailer');

// Backoff delays in minutes for attempts 1, 2, 3, 4, 5
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes

let workerInterval = null;
let isProcessingBatch = false;

async function enqueueLeadMailJob(leadId) {
  try {
    const job = await MailJob.create({
      leadId,
      status: 'pending',
      attempts: 0,
      lastError: '',
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    // Trigger non-blocking immediate check
    setImmediate(() => {
      processDueMailJobs().catch((err) =>
        console.error('[WARN] Outbox immediate trigger error:', err.message)
      );
    });
    return job;
  } catch (err) {
    console.error('[ERROR] Failed to enqueue mail job for lead:', leadId, err.message);
    return null;
  }
}

async function processSingleJob(job) {
  const lead = await Lead.findById(job.leadId).lean();
  if (!lead) {
    await MailJob.findByIdAndUpdate(job._id, {
      $set: {
        status: 'skipped',
        lastError: 'İlgili lead kaydı bulunamadı.',
        lockedAt: null,
        updatedAt: new Date()
      }
    });
    return;
  }

  const settingsDoc = await MailSettings.findOne({ key: 'default' }).lean();
  if (!isMailSettingsConfigured(settingsDoc)) {
    await MailJob.findByIdAndUpdate(job._id, {
      $set: {
        status: 'skipped',
        lastError: 'Mail gönderim ayarları henüz tanımlanmamış.',
        lockedAt: null,
        updatedAt: new Date()
      }
    });
    return;
  }

  const senderAddrLower = String(settingsDoc.smtpFromAddress || settingsDoc.smtpUser || '')
    .trim()
    .toLowerCase();

  const activeRecipients = await MailRecipient.find({ active: true }).lean();
  const matchingRecipients = activeRecipients.filter((r) => {
    const rEmail = String(r.email || '').trim().toLowerCase();
    // Never send notification to the sender/ticket address itself
    if (
      (senderAddrLower && rEmail === senderAddrLower) ||
      rEmail.startsWith('support@')
    ) {
      return false;
    }
    // Filter by site: empty sites array means all sites
    if (Array.isArray(r.sites) && r.sites.length > 0) {
      if (!r.sites.includes(lead.site)) {
        return false;
      }
    }
    // Filter by requestType: empty requestTypes array means all types
    if (Array.isArray(r.requestTypes) && r.requestTypes.length > 0) {
      if (!r.requestTypes.includes(lead.requestType)) {
        return false;
      }
    }
    return true;
  });

  if (matchingRecipients.length === 0) {
    await MailJob.findByIdAndUpdate(job._id, {
      $set: {
        status: 'skipped',
        lastError: 'Bu site ve talep tipi için aktif alıcı e-posta adresi bulunmuyor.',
        lockedAt: null,
        updatedAt: new Date()
      }
    });
    return;
  }

  const toAddresses = matchingRecipients.map((r) => r.email.trim());
  const mailContent = buildLeadNotificationContent(lead);

  const attemptNumber = (job.attempts || 0) + 1;

  try {
    await sendMailWithSettings(settingsDoc, {
      toAddresses,
      subject: mailContent.subject,
      html: mailContent.html,
      text: mailContent.text,
      replyTo: mailContent.replyTo
    });

    await MailJob.findByIdAndUpdate(job._id, {
      $set: {
        status: 'sent',
        attempts: attemptNumber,
        sentAt: new Date(),
        lastError: '',
        lockedAt: null,
        updatedAt: new Date()
      }
    });

    await MailAttempt.create({
      recipient: toAddresses.join(', '),
      status: 'sent',
      errorCode: '250 OK',
      errorMessage: 'E-posta başarıyla iletildi.',
      refCode: lead.refCode,
      createdAt: new Date()
    });
  } catch (sendErr) {
    const isPermanent = Boolean(sendErr && sendErr.permanent);
    const errorCode = sendErr.errorCode || 'SMTP_ERROR';
    const errorMsg = sendErr.message || String(sendErr);

    console.error(
      `[ERROR] Outbox job (${job._id}) attempt ${attemptNumber} failed:`,
      errorCode,
      errorMsg
    );

    await MailAttempt.create({
      recipient: toAddresses.join(', '),
      status: 'failed',
      errorCode: String(errorCode).slice(0, 100),
      errorMessage: String(errorMsg).slice(0, 1000),
      refCode: lead.refCode,
      createdAt: new Date()
    });

    if (isPermanent || attemptNumber >= MAX_ATTEMPTS) {
      await MailJob.findByIdAndUpdate(job._id, {
        $set: {
          status: 'failed',
          attempts: attemptNumber,
          lastError: `[Kalıcı Hata / ${errorCode}] ${errorMsg}`.slice(0, 2000),
          lockedAt: null,
          updatedAt: new Date()
        }
      });
    } else {
      const delayMinutes = BACKOFF_MINUTES[attemptNumber - 1] || 60;
      const nextAttemptAt = new Date(Date.now() + delayMinutes * 60 * 1000);

      await MailJob.findByIdAndUpdate(job._id, {
        $set: {
          status: 'pending',
          attempts: attemptNumber,
          lastError: `[Deneme ${attemptNumber} / ${errorCode}] ${errorMsg}`.slice(0, 2000),
          nextAttemptAt,
          lockedAt: null,
          updatedAt: new Date()
        }
      });
    }
  }
}

async function processDueMailJobs() {
  if (isProcessingBatch) return;
  isProcessingBatch = true;

  try {
    const staleLockThreshold = new Date(Date.now() - STALE_LOCK_MS);
    await MailJob.updateMany(
      {
        status: 'processing',
        lockedAt: { $lt: staleLockThreshold }
      },
      {
        $set: {
          status: 'pending',
          lockedAt: null,
          updatedAt: new Date()
        }
      }
    );

    const now = new Date();
    while (true) {
      const candidate = await MailJob.findOneAndUpdate(
        {
          status: 'pending',
          nextAttemptAt: { $lte: now }
        },
        {
          $set: {
            status: 'processing',
            lockedAt: new Date(),
            updatedAt: new Date()
          }
        },
        { new: true, sort: { nextAttemptAt: 1 } }
      );

      if (!candidate) {
        break;
      }

      await processSingleJob(candidate);
    }
  } catch (err) {
    console.error('[ERROR] processDueMailJobs exception:', err.message);
  } finally {
    isProcessingBatch = false;
  }
}

function startOutboxWorker(intervalMs = 30000) {
  if (workerInterval) return;
  console.log('[INFO] Outbox mail worker started.');
  workerInterval = setInterval(() => {
    processDueMailJobs().catch((err) =>
      console.error('[WARN] Outbox interval error:', err.message)
    );
  }, intervalMs);

  processDueMailJobs().catch((err) =>
    console.error('[WARN] Initial outbox run error:', err.message)
  );
}

function stopOutboxWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[INFO] Outbox mail worker stopped.');
  }
}

module.exports = {
  enqueueLeadMailJob,
  processDueMailJobs,
  startOutboxWorker,
  stopOutboxWorker
};
