'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { decryptSecret, escapeHtml } = require('./cryptoUtils');
const { assertSafeSmtpHost } = require('./ipAllowlist');
const { findSiteByHost } = require('./siteConfig');

// Pooled SMTP transporter cache
let cachedTransporter = null;
let cachedConfigSignature = '';

function invalidateMailTransporter() {
  if (cachedTransporter) {
    try {
      cachedTransporter.close();
    } catch (_err) {
      // ignore close error
    }
    cachedTransporter = null;
    cachedConfigSignature = '';
  }
}

function isMailSettingsConfigured(settingsDoc) {
  if (!settingsDoc) return false;
  return Boolean(
    settingsDoc.smtpHost &&
      settingsDoc.smtpPort &&
      settingsDoc.smtpFromAddress &&
      (settingsDoc.smtpUser || settingsDoc.smtpFromAddress) &&
      (settingsDoc.smtpPassEnc || settingsDoc.plainPassword)
  );
}

function resolveSecurityForPort(port, explicitSecurity) {
  const numPort = Number(port) || 587;
  if (numPort === 465) {
    return { secure: true, requireTLS: false, mode: 'tls' };
  }
  if (numPort === 587 || numPort === 25) {
    return { secure: false, requireTLS: true, mode: 'starttls' };
  }
  const isTls = explicitSecurity === 'tls';
  return {
    secure: isTls,
    requireTLS: !isTls,
    mode: isTls ? 'tls' : 'starttls'
  };
}

function classifySmtpError(err) {
  if (
    err &&
    (err.errorCode === 'SSRF_BLOCKED' ||
      err.errorCode === 'INVALID_HOST' ||
      err.errorCode === 'CONFIG_MISSING')
  ) {
    return err;
  }

  const code = String(err?.code || '').toUpperCase();
  const responseCode = Number(err?.responseCode) || 0;
  const rawMsg = String(err?.response || err?.message || err || '');
  const lowerMsg = rawMsg.toLowerCase();

  // 1. Certificate verification error
  if (
    code.includes('CERT') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    lowerMsg.includes('certificate') ||
    lowerMsg.includes('altnames') ||
    lowerMsg.includes('self signed')
  ) {
    const wrapped = new Error('Sunucu sertifikası doğrulanamadı');
    wrapped.errorCode = code || 'TLS_CERT_ERROR';
    wrapped.permanent = true;
    return wrapped;
  }

  // 2. Security mismatch: 530 / "must issue STARTTLS"
  if (
    responseCode === 530 ||
    /\b530\b/.test(rawMsg) ||
    lowerMsg.includes('must issue a starttls') ||
    lowerMsg.includes('must issue starttls') ||
    lowerMsg.includes('starttls first') ||
    lowerMsg.includes('wrong version number') ||
    lowerMsg.includes('tls_validate_record_header')
  ) {
    const wrapped = new Error(
      'Güvenlik ayarı uyumsuz; port 587 için STARTTLS, 465 için SSL seçin'
    );
    wrapped.errorCode = responseCode ? String(responseCode) : code || '530_STARTTLS';
    wrapped.permanent = true;
    return wrapped;
  }

  // 3. Authentication failure: 535 / EAUTH
  if (responseCode === 535 || code === 'EAUTH' || /\b535\b/.test(rawMsg)) {
    const wrapped = new Error('Kullanıcı adı veya şifre hatalı');
    wrapped.errorCode = responseCode ? `${responseCode} EAUTH` : 'EAUTH';
    wrapped.permanent = true;
    return wrapped;
  }

  // 4. Recipient / SPF / DKIM / spam rejection: 550 / 553 / 554
  if (
    responseCode === 550 ||
    responseCode === 553 ||
    responseCode === 554 ||
    /\b(550|553|554)\b/.test(rawMsg)
  ) {
    const matchedCode =
      responseCode || (rawMsg.match(/\b(550|553|554)\b/) || [])[1] || '550';
    const wrapped = new Error('Alıcı sunucu reddetti (SPF/DKIM veya spam filtresi)');
    wrapped.errorCode = String(matchedCode);
    wrapped.permanent = true;
    return wrapped;
  }

  // 5. Connection / timeout / socket / firewall error
  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKET' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('connection timeout') ||
    lowerMsg.includes('greeting never received')
  ) {
    const wrapped = new Error('Sunucuya bağlanılamadı (host/port/firewall)');
    wrapped.errorCode = code || 'ECONNECTION';
    wrapped.permanent = false;
    return wrapped;
  }

  // 6. 4xx temporary server error
  if (
    (responseCode >= 400 && responseCode < 500) ||
    /\b4[0-9]{2}\b/.test(rawMsg)
  ) {
    const matched4xx =
      responseCode || (rawMsg.match(/\b(4[0-9]{2})\b/) || [])[1] || '4XX';
    const wrapped = new Error(`Geçici sunucu hatası (${matched4xx}): ${rawMsg.slice(0, 160)}`);
    wrapped.errorCode = String(matched4xx);
    wrapped.permanent = false;
    return wrapped;
  }

  const fallback = new Error(`SMTP gönderim hatası: ${rawMsg.slice(0, 200)}`);
  fallback.errorCode = responseCode ? String(responseCode) : code || 'SMTP_ERROR';
  fallback.permanent = false;
  return fallback;
}

function buildTransportOptions(settingsDoc, usePool = true) {
  const host = (settingsDoc.smtpHost || 'mail.dogrumail.com').trim();
  const port = Number(settingsDoc.smtpPort) || 587;
  const fromAddress = (settingsDoc.smtpFromAddress || '').trim();
  const user = (settingsDoc.smtpUser || fromAddress).trim();
  const sec = resolveSecurityForPort(port, settingsDoc.smtpSecurity);

  const pass = settingsDoc.plainPassword
    ? String(settingsDoc.plainPassword)
    : settingsDoc.smtpPassEnc
      ? decryptSecret(settingsDoc.smtpPassEnc)
      : '';

  if (!host || !port || !fromAddress || !user || !pass) {
    const missingErr = new Error(
      'SMTP ayarları eksik (E-posta adresi, Şifre, SMTP sunucu ve Port zorunludur).'
    );
    missingErr.errorCode = 'CONFIG_MISSING';
    missingErr.permanent = true;
    throw missingErr;
  }

  return {
    host,
    port,
    user,
    pass,
    fromAddress,
    sec,
    transportConfig: {
      ...(usePool
        ? {
            pool: true,
            maxConnections: 1,
            maxMessages: 50
          }
        : {}),
      host,
      port,
      secure: sec.secure,
      requireTLS: sec.requireTLS,
      auth: { user, pass },
      tls: {
        minVersion: 'TLSv1.2',
        servername: host
      },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000
    }
  };
}

function getOrCreatePooledTransporter(settingsDoc) {
  const { host, port, user, pass, sec, transportConfig } = buildTransportOptions(
    settingsDoc,
    true
  );

  const signature = crypto
    .createHash('sha256')
    .update(`${host}:${port}:${sec.mode}:${user}:${pass}`)
    .digest('hex');

  if (cachedTransporter && cachedConfigSignature === signature) {
    return cachedTransporter;
  }

  invalidateMailTransporter();
  cachedTransporter = nodemailer.createTransport(transportConfig);
  cachedConfigSignature = signature;
  return cachedTransporter;
}

async function verifySmtpConnection(settingsDoc) {
  let tempTransporter = null;
  try {
    const { transportConfig, host, port, sec } = buildTransportOptions(settingsDoc, false);
    await assertSafeSmtpHost(host);
    tempTransporter = nodemailer.createTransport(transportConfig);
    await tempTransporter.verify();
    return {
      ok: true,
      host,
      port,
      security: sec.mode === 'tls' ? 'SSL/TLS (secure: true)' : 'STARTTLS (requireTLS: true)'
    };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    if (tempTransporter && typeof tempTransporter.close === 'function') {
      try {
        tempTransporter.close();
      } catch (_e) {
        // ignore
      }
    }
  }
}

async function sendMailWithSettings(
  settingsDoc,
  { toAddresses, subject, html, text, replyTo },
  options = { ephemeral: false }
) {
  if (!settingsDoc) {
    const err = new Error('Mail ayarları henüz yapılandırılmamış.');
    err.errorCode = 'CONFIG_MISSING';
    err.permanent = true;
    throw err;
  }

  const fromAddress = (settingsDoc.smtpFromAddress || '').trim();
  const fromName = (settingsDoc.smtpFromName || 'Tescom Lead Platform').trim();

  let transporter = null;
  const isEphemeral = Boolean(options && options.ephemeral);

  try {
    const hostToCheck = (settingsDoc.smtpHost || 'mail.dogrumail.com').trim();
    await assertSafeSmtpHost(hostToCheck);

    if (isEphemeral) {
      const { transportConfig } = buildTransportOptions(settingsDoc, false);
      transporter = nodemailer.createTransport(transportConfig);
    } else {
      transporter = getOrCreatePooledTransporter(settingsDoc);
    }

    await transporter.sendMail({
      from: `"${fromName.replace(/"/g, '')}" <${fromAddress}>`,
      to: toAddresses.join(', '),
      ...(replyTo ? { replyTo } : {}),
      subject,
      text: text || subject,
      html,
      headers: {
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All'
      }
    });

    return { ok: true, errorCode: '250 OK' };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    if (isEphemeral && transporter && typeof transporter.close === 'function') {
      try {
        transporter.close();
      } catch (_e) {
        // ignore
      }
    }
  }
}

function buildLeadNotificationContent(lead) {
  const siteConfig = findSiteByHost(lead.site);
  const siteDomain = lead.site || 'tescom.com.tr';
  const siteDisplayName = siteConfig?.displayName || siteDomain;
  const adminLeadUrl = `https://${siteDomain}/admin/leads/${lead._id}`;

  const requestLabel =
    siteConfig?.requestTypes?.[lead.requestType] || lead.requestType;

  const formattedDate = new Date(lead.createdAt || Date.now()).toLocaleString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });

  const unverifiedPrefix = lead.captchaStatus === 'unverified' ? '[DOĞRULANMADI] ' : '';
  const entityIdentifier = lead.company || lead.fullName;
  const subject = `${unverifiedPrefix}[${siteDisplayName}] Yeni Talep ${lead.refCode} – ${entityIdentifier}`;

  const cartItems = Array.isArray(lead.cartSnapshot) ? lead.cartSnapshot : [];
  const cartText =
    cartItems.length > 0
      ? cartItems.map((item) => `- ${item.model}: ${item.qty} Adet`).join('\n')
      : 'Sepet boş';

  const cartHtml =
    cartItems.length > 0
      ? `<ul style="margin:0;padding-left:18px;">${cartItems
          .map(
            (item) =>
              `<li><strong>${escapeHtml(item.model)}</strong> — ${escapeHtml(item.qty)} Adet</li>`
          )
          .join('')}</ul>`
      : '<span style="color:#64748b;">Sepet boş</span>';

  // Format extra fields
  const extraObj = lead.extra && typeof lead.extra === 'object' ? lead.extra : {};
  const extraKeys = Object.keys(extraObj);
  const extraRows = extraKeys.map((k) => [
    `Ek: ${k}`,
    escapeHtml(String(extraObj[k]))
  ]);

  const rows = [
    ['Referans Kodu', `<strong>${escapeHtml(lead.refCode)}</strong>`],
    ['Site / Marka', `${escapeHtml(siteDisplayName)} (${escapeHtml((lead.brand || '').toUpperCase())})`],
    ['Talep Tipi', escapeHtml(requestLabel)],
    ['Ad Soyad', escapeHtml(lead.fullName)],
    ['Firma / Kurum', `<strong>${escapeHtml(lead.company || '-')}</strong>`],
    [
      'E-Posta',
      `<a href="mailto:${escapeHtml(lead.email)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(lead.email)}</a>`
    ],
    ['Telefon', escapeHtml(lead.phone)],
    ['Ürün / Çözüm', escapeHtml(lead.selectedProduct || '-')],
    ['Adet / Ölçek', escapeHtml(lead.quantity || '-')],
    ['Santral (PBX)', escapeHtml(lead.pbxSystem || '-')],
    ['Proje Adı', escapeHtml(lead.projectName || '-')],
    ...extraRows,
    [
      'Mesaj / Not',
      `<div style="white-space:pre-wrap;">${escapeHtml(lead.message || '-')}</div>`
    ],
    ['Teklif Sepeti', cartHtml],
    ['Tarih (İstanbul)', escapeHtml(formattedDate)]
  ];

  const textLines = [
    `Yeni Talep Kaydı (${lead.refCode})`,
    `=========================================`,
    `Site / Marka  : ${siteDisplayName} (${(lead.brand || '').toUpperCase()})`,
    `Referans Kodu : ${lead.refCode}`,
    `Talep Tipi    : ${requestLabel}`,
    `Ad Soyad      : ${lead.fullName}`,
    `Firma / Kurum : ${lead.company || '-'}`,
    `E-Posta       : ${lead.email}`,
    `Telefon       : ${lead.phone}`,
    `Ürün / Çözüm  : ${lead.selectedProduct || '-'}`,
    `Adet / Ölçek  : ${lead.quantity || '-'}`,
    `Santral (PBX) : ${lead.pbxSystem || '-'}`,
    `Proje Adı     : ${lead.projectName || '-'}`
  ];

  for (const [k, v] of Object.entries(extraObj)) {
    textLines.push(`Ek Alan (${k}) : ${v}`);
  }

  textLines.push(
    `Tarih         : ${formattedDate} (Europe/Istanbul)`,
    ``,
    `Mesaj / Not:`,
    `${lead.message || '-'}`,
    ``,
    `Teklif Sepeti:`,
    `${cartText}`,
    ``,
    `Yönetim Panelinde Görüntüle: ${adminLeadUrl}`
  );

  const accentColor = lead.brand === 'jabra' ? '#FBBF24' : '#E60012';

  const html = `<!DOCTYPE html>
<html lang="tr">
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;color:#0f172a;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
    <div style="background:#0f172a;color:#ffffff;padding:18px 24px;border-bottom:3px solid ${accentColor};">
      <div style="font-size:12px;color:#94a3b8;font-weight:bold;text-transform:uppercase;letter-spacing:0.6px;">${escapeHtml(siteDisplayName)}</div>
      <h2 style="margin:6px 0 0;font-size:18px;">Yeni Müşteri Talebi: ${escapeHtml(lead.refCode)}</h2>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tbody>
          ${rows
            .map(
              ([label, val]) => `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;width:170px;color:#475569;font-weight:bold;vertical-align:top;">${label}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#0f172a;vertical-align:top;">${val}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div style="margin-top:24px;text-align:center;">
        <a href="${escapeHtml(adminLeadUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;font-weight:bold;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;border-left:4px solid ${accentColor};">
          Admin Panelinde Lead Detayını Aç
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;

  return {
    subject,
    text: textLines.join('\n'),
    html,
    replyTo: lead.email
  };
}

module.exports = {
  invalidateMailTransporter,
  isMailSettingsConfigured,
  resolveSecurityForPort,
  verifySmtpConnection,
  sendMailWithSettings,
  buildLeadNotificationContent
};
