# Tescom Multi-Site Lead Platform

Tescom Telekomünikasyon B2B web siteleri için tekilleştirilmiş lead yakalama, admin paneli ve mikroservis mimarisi.

## 1. Mimari Genel Bakış

```
İnternet (DNS Made Easy, Doğrudan A Kaydı)
    │
    ▼
Caddy 2.8.4 (Port 80/443, Otomatik Let's Encrypt SSL, IP Rate Limiting)
    ├── <domain>/         → /srv/sites/<domain> (Her sitenin derlenmiş statik dosyaları)
    ├── <domain>/api/*    → lead-api:3000 (2 Replika, Docker DNS Round-Robin)
    └── <domain>/admin*   → lead-api:3000 (Tek Yönetim Paneli, IP Allowlist)
                               │
                            MongoDB 7.0 (Tek DB: 'tescom', İzole Internal Network)
```

### Temel Güvenlik İlkeleri
- **Tek Backend & Tek DB:** Tüm siteler (`fanvilpartner.com`, `jabrapanacast.com.tr`, `jabrapartner.com.tr`, `jabravideokonferans.com`) tek bir MongoDB kümesinde toplanır. Her lead `site` ve `brand` alanlarıyla etiketlenir.
- **Fail-Closed Admin IP Allowlist:** Yetkisiz IP adreslerinden `/admin` ve `/api/admin/*` adreslerine yapılan tüm isteklere **404 Not Found** döner (panelin varlığı tamamen gizlenir).
- **İki Adımlı Doğrulama (2FA - TOTP):** Admin hesapları için Google Authenticator / Microsoft Authenticator desteği.
- **CORS & Origin Savunması:** Siteler arası (cross-site) istekler Host ve Origin eşleşmesi kontrol edilerek reddedilir.
- **Bot Koruması & Turnstile:** Formlarda bot tespitinde Cloudflare Turnstile kullanılır. Gizli anahtar tanımlıysa jetonsuz istekler 400 ile engellenir.
- **NoSQL & CSV Injection Koruması:** Kullanıcı girdilerindeki `$` ve `.` karakterleri temizlenir. CSV dışa aktarımlarında formül enjeksiyonu (`=`, `+`, `-`, `@`) otomatik filtrelenir.
- **İç Ağ İzolasyonu:** MongoDB dış dünyaya port açmaz (`internal: true` bridge network).

---

## 2. Hızlı Kurulum & Dağıtım

### Adım 1: Depoyu Klonlayın
```bash
git clone git@github.com:HamidrezaToutounchi/tescom-lead-platform.git
cd tescom-lead-platform
```

### Adım 2: Ortam Değişkenlerini Tanımlayın
```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```
Gerekli parola ve anahtarları `openssl rand -hex 32` komutuyla üreterek `.env` dosyasını doldurun.
- `SITES_ROOT`: Sitelerin klonlandığı kök dizin (varsayılan: `/opt/tescom/sites`)
- `SITES_DIST`: Statik build çıktılarının toplanıp Caddy'ye sunulduğu dizin (varsayılan: `/opt/tescom/sites-dist`)
- `TURNSTILE_SITE_KEY` & `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile anahtarları

### Adım 3: Siteleri Derleyin ve Dağıtın
Siteleri `SITES_ROOT` klasörüne klonlayın ve build scriptini çalıştırın:
```bash
bash deploy/build-sites.sh
```

### Adım 4: Docker Konteynerlerini Başlatın
```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

### Adım 5: İlk Yönetici Kullanıcısını Oluşturun
```bash
docker compose -f deploy/docker-compose.yml exec lead-api node scripts/create-admin.js admin
```

---

## 3. Yeni Site Ekleme Rehberi

Sisteme yeni bir marka veya site eklemek için **backend veya admin kodunda hiçbir değişiklik gerekmez**:

1. `config/sites.json` dosyasına yeni sitenin kaydını ekleyin:
```json
{
  "domain": "yensite.com.tr",
  "brand": "markaadi",
  "displayName": "Yeni Site Başlığı",
  "refPrefix": "YNS",
  "repoDir": "yenisite-klasor-adi",
  "buildCmd": "npm ci && npm run build",
  "outDir": "out",
  "requestTypes": {
    "teklif": "Fiyat Teklifi Al",
    "demo": "Demo Cihazı İste"
  }
}
```

2. Caddyfile'ı yeniden üretin:
```bash
node deploy/generate-caddyfile.js
```

3. Yeni sitenin frontendini derleyin:
```bash
bash deploy/build-sites.sh
```

4. Caddy'ye yeni yapılandırmayı yükletin:
```bash
docker compose -f deploy/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```
Site hemen SSL sertifikasıyla yayına girer ve talepler doğrudan merkezi panele düşer!

---

## 4. Yedekleme & Geri Yükleme

### Günlük MongoDB Yedeği Alma
```bash
bash scripts/backup_mongo.sh
```
Yedekler `backups/tescom-YYYY-MM-DD_HHMMSS.gz` olarak saklanır ve 14 günden eski yedekler otomatik temizlenir.
