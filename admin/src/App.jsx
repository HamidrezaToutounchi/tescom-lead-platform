import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  LogOut,
  Inbox,
  Mail,
  Users,
  Globe,
  UserCog,
  History,
  Search,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  ArrowLeft,
  Send,
  Plus,
  Trash2,
  Lock,
  KeyRound,
  Eye,
  Smartphone,
  QrCode,
  Building,
  Layers,
  Check
} from 'lucide-react';

const DEFAULT_REQUEST_TYPE_LABELS = {
  bilgi: 'Ürün Bilgi & Fiyat Teklifi',
  proje: 'Kurumsal Proje Kaydı & İskonto',
  bayi: 'Alt Bayilik / Partner Başvurusu',
  demo: 'Test & Demo Cihaz Talebi',
  teklif: 'Toplu Ürün & Fiyat Teklifi',
  kesif: 'Yerinde Oda Keşif Talebi'
};

const STATUS_META = {
  new: { label: 'Yeni', cls: 'bg-red-50 text-[#E60012] border-red-200' },
  contacted: { label: 'İletişime Geçildi', cls: 'bg-sky-50 text-[#0284C7] border-sky-200' },
  quoted: { label: 'Teklif Verildi', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  won: { label: 'Kazanıldı (Won)', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  lost: { label: 'Kaybedildi (Lost)', cls: 'bg-slate-100 text-slate-600 border-slate-300' }
};

const MAIL_STATUS_META = {
  pending: { label: 'Kuyrukta (Pending)', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  processing: { label: 'Gönderiliyor...', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  sent: { label: 'Gönderildi ✓', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: 'Hata (Failed)', cls: 'bg-red-50 text-red-700 border-red-200' },
  skipped: { label: 'Atlandı (Ayar/Alıcı Yok)', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
};

const CAPTCHA_META = {
  passed: { label: 'Doğrulandı', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  unverified: { label: 'Doğrulanmadı', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  disabled: { label: 'Kapalı', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
};

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    data = null;
  }
  return { res, data };
}

function formatDateTR(val) {
  if (!val) return '-';
  try {
    return new Date(val).toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'short',
      timeStyle: 'short'
    });
  } catch (_e) {
    return String(val);
  }
}

function BrandBadge({ brand, site }) {
  const isJabra = String(brand || '').toLowerCase() === 'jabra';
  return (
    <div className="flex flex-col items-start gap-1">
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${
          isJabra
            ? 'bg-amber-100 text-amber-900 border-amber-300'
            : 'bg-red-50 text-red-700 border-red-200'
        }`}
      >
        {brand ? brand.toUpperCase() : (site?.includes('jabra') ? 'JABRA' : 'FANVIL')}
      </span>
      <span className="text-[11px] font-semibold text-slate-500 truncate max-w-[130px]" title={site}>
        {site}
      </span>
    </div>
  );
}

export default function App() {
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [user, setUser] = useState(null);
  const [clientIp, setClientIp] = useState('');
  const [sites, setSites] = useState([]);

  // Navigation tab: 'leads' | 'mail' | 'recipients' | 'ips' | 'users' | 'audit'
  const [activeTab, setActiveTab] = useState('leads');
  const [selectedLeadId, setSelectedLeadId] = useState(() => {
    const m = window.location.pathname.match(/\/admin\/leads\/([a-fA-F0-9]{24})/);
    return m ? m[1] : null;
  });

  // Login state
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [require2FA, setRequire2FA] = useState(false);
  const [totpToken, setTotpToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const checkSession = useCallback(async () => {
    setLoadingAuth(true);
    try {
      const { res, data } = await apiFetch('/api/admin/me');
      if (res.ok && data?.ok) {
        setClientIp(data.clientIp || '');
        if (data.authenticated && data.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      }
    } catch (_err) {
      setUser(null);
    } finally {
      setLoadingAuth(false);
    }
  }, []);

  const loadSites = useCallback(async () => {
    try {
      const { res, data } = await apiFetch('/api/admin/sites');
      if (res.ok && data?.ok && Array.isArray(data.sites)) {
        setSites(data.sites);
      }
    } catch (_e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (user) {
      loadSites();
    }
  }, [user, loadSites]);

  // Aggregate requestType labels dynamically from sites.json
  const requestTypeLabels = useMemo(() => {
    const map = { ...DEFAULT_REQUEST_TYPE_LABELS };
    for (const s of sites) {
      if (s.requestTypes) {
        Object.assign(map, s.requestTypes);
      }
    }
    return map;
  }, [sites]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const payload = {
        username: loginUsername,
        password: loginPassword,
        ...(require2FA ? { totpToken: totpToken.trim() } : {})
      };

      const { res, data } = await apiFetch('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!res.ok || !data?.ok) {
        if (data?.require2FA) {
          setRequire2FA(true);
          setLoginError(data.message || 'Lütfen 2FA doğrulama kodunuzu giriniz.');
          return;
        }
        setLoginError(data?.error || 'Giriş başarısız.');
        return;
      }

      setUser(data.user);
      setClientIp(data.clientIp || clientIp);
      setLoginPassword('');
      setTotpToken('');
      setRequire2FA(false);
    } catch (_err) {
      setLoginError('Sunucu bağlantı hatası.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/admin/logout', { method: 'POST' });
    setUser(null);
    setSelectedLeadId(null);
    setRequire2FA(false);
    setTotpToken('');
    window.history.replaceState(null, '', '/admin/');
  };

  const openLeadDetail = (id) => {
    setSelectedLeadId(id);
    setActiveTab('leads');
    window.history.pushState(null, '', `/admin/leads/${id}`);
  };

  const closeLeadDetail = () => {
    setSelectedLeadId(null);
    window.history.pushState(null, '', '/admin/');
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0F172A] text-white">
        <div className="flex items-center gap-3 text-sm font-semibold">
          <RefreshCw className="w-5 h-5 animate-spin text-amber-400" />
          <span>Tescom Lead Platform Yükleniyor...</span>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 1. LOGIN SCREEN
  // -------------------------------------------------------------------------
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-[#0F172A] px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 text-slate-800 text-xs font-black">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Tescom B2B Lead Platform</span>
            </div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">
              Kurumsal Yönetim Paneli
            </h1>
            <p className="text-xs text-slate-500">
              Fanvil &amp; Jabra Çoklu Site Yönetimi • İzinli IP Doğrulandı
            </p>
          </div>

          {loginError && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Kullanıcı Adı
              </label>
              <input
                type="text"
                required
                disabled={require2FA}
                autoComplete="username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-sm focus:bg-white focus:outline-none focus:border-slate-800 disabled:opacity-75"
                placeholder="admin"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Şifre
              </label>
              <input
                type="password"
                required
                disabled={require2FA}
                autoComplete="current-password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-sm focus:bg-white focus:outline-none focus:border-slate-800 disabled:opacity-75"
                placeholder="••••••••••••"
              />
            </div>

            {require2FA && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-2 animate-in fade-in">
                <div className="flex items-center gap-2 text-xs font-extrabold text-amber-900">
                  <Smartphone className="w-4 h-4 text-amber-700" />
                  <span>2FA Doğrulama Kodu</span>
                </div>
                <p className="text-[11px] text-amber-800">
                  Authenticator uygulamanızdaki 6 haneli kodu giriniz.
                </p>
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={8}
                  value={totpToken}
                  onChange={(e) => setTotpToken(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-amber-300 text-center font-mono font-black text-lg tracking-widest focus:outline-none focus:border-amber-600"
                  placeholder="123456"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loginBusy}
              className="w-full py-3.5 px-5 rounded-xl bg-[#0F172A] hover:bg-slate-800 disabled:opacity-60 text-white font-extrabold text-sm transition-all flex items-center justify-center gap-2 shadow-lg"
            >
              <Lock className="w-4 h-4 text-amber-400" />
              <span>
                {loginBusy
                  ? 'Doğrulanıyor...'
                  : require2FA
                  ? 'Kodu Doğrula ve Gir'
                  : 'Panele Giriş Yap'}
              </span>
            </button>

            {require2FA && (
              <button
                type="button"
                onClick={() => {
                  setRequire2FA(false);
                  setTotpToken('');
                  setLoginError('');
                }}
                className="w-full py-2 text-xs font-bold text-slate-500 hover:text-slate-800 text-center"
              >
                Giriş bilgilerini değiştir
              </button>
            )}
          </form>
        </div>
      </div>
    );
  }

  const isAdmin = user.role === 'admin';

  // -------------------------------------------------------------------------
  // 2. AUTHENTICATED SHELL
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC]">
      {/* Top Navbar */}
      <header className="bg-[#0F172A] text-white border-b border-slate-800 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center border border-white/15">
              <Layers className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-base tracking-tight">Tescom Lead Panel</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-amber-400 text-slate-950">
                  v2.0
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Fanvil &amp; Jabra Çoklu Site Lead Merkezi
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex flex-col items-end text-xs">
              <span className="font-bold text-slate-200">{user.username}</span>
              <span className="text-[10px] text-slate-400">
                {isAdmin ? 'Yönetici (Admin)' : 'Gözlemci (Viewer)'} • {clientIp || 'Güvenli IP'}
              </span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold transition-all flex items-center gap-1.5"
              title="Çıkış Yap"
            >
              <LogOut className="w-4 h-4 text-red-400" />
              <span className="hidden sm:inline">Çıkış</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-800 flex overflow-x-auto gap-1 py-1.5 scrollbar-none">
          <button
            type="button"
            onClick={() => {
              setSelectedLeadId(null);
              setActiveTab('leads');
              window.history.pushState(null, '', '/admin/');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
              activeTab === 'leads' && !selectedLeadId
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Inbox className="w-4 h-4" />
            <span>Talepler (Leads)</span>
          </button>

          {isAdmin && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelectedLeadId(null);
                  setActiveTab('mail');
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                  activeTab === 'mail'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Mail className="w-4 h-4" />
                <span>SMTP Ayarları</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedLeadId(null);
                  setActiveTab('recipients');
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                  activeTab === 'recipients'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Bildirim Alıcıları</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedLeadId(null);
                  setActiveTab('ips');
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                  activeTab === 'ips'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Globe className="w-4 h-4" />
                <span>İzinli IP'ler</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedLeadId(null);
                  setActiveTab('users');
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                  activeTab === 'users'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <UserCog className="w-4 h-4" />
                <span>Kullanıcılar &amp; 2FA</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSelectedLeadId(null);
                  setActiveTab('audit');
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                  activeTab === 'audit'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <History className="w-4 h-4" />
                <span>Denetim Kayıtları</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {selectedLeadId ? (
          <LeadDetailView
            leadId={selectedLeadId}
            isAdmin={isAdmin}
            onBack={closeLeadDetail}
            sites={sites}
            requestTypeLabels={requestTypeLabels}
          />
        ) : activeTab === 'leads' ? (
          <LeadsListView
            onSelectLead={openLeadDetail}
            onUnauthorized={checkSession}
            sites={sites}
            requestTypeLabels={requestTypeLabels}
          />
        ) : activeTab === 'mail' && isAdmin ? (
          <MailSettingsView />
        ) : activeTab === 'recipients' && isAdmin ? (
          <RecipientsView sites={sites} requestTypeLabels={requestTypeLabels} />
        ) : activeTab === 'ips' && isAdmin ? (
          <AllowedIpsView currentIp={clientIp} />
        ) : activeTab === 'users' && isAdmin ? (
          <AdminUsersView currentUser={user} onUserUpdated={checkSession} />
        ) : activeTab === 'audit' && isAdmin ? (
          <AuditLogsView />
        ) : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. LEADS LIST VIEW (Multi-site & Multi-brand filtering, site breakdown)
// ---------------------------------------------------------------------------
function LeadsListView({ onSelectLead, onUnauthorized, sites, requestTypeLabels }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [siteBreakdown, setSiteBreakdown] = useState({});

  const [q, setQ] = useState('');
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [requestType, setRequestType] = useState('');
  const [status, setStatus] = useState('');

  const buildQueryString = useCallback(
    (targetPage = page) => {
      const params = new URLSearchParams();
      params.set('page', String(targetPage));
      if (q.trim()) params.set('search', q.trim());
      if (selectedSite) params.set('site', selectedSite);
      if (selectedBrand) params.set('brand', selectedBrand);
      if (requestType) params.set('requestType', requestType);
      if (status) params.set('status', status);
      return params.toString();
    },
    [page, q, selectedSite, selectedBrand, requestType, status]
  );

  const loadLeads = useCallback(
    async (targetPage = page) => {
      setLoading(true);
      setListError('');
      try {
        const qs = buildQueryString(targetPage);
        const { res, data } = await apiFetch(`/api/admin/leads?${qs}`);
        if (res.status === 401) {
          if (onUnauthorized) onUnauthorized();
          return;
        }
        if (res.ok && data?.ok) {
          setItems(data.items || data.leads || []);
          setTotal(data.total || 0);
          setTotalPages(data.totalPages || 1);
          setSiteBreakdown(data.siteBreakdown || {});
          setPage(data.page || targetPage);
        } else {
          setListError(data?.error || `Lead listesi alınamadı (HTTP ${res.status}).`);
        }
      } catch (_err) {
        setListError('Sunucu bağlantısı sırasında hata oluştu.');
      } finally {
        setLoading(false);
      }
    },
    [buildQueryString, page, onUnauthorized]
  );

  useEffect(() => {
    loadLeads(page);
  }, [loadLeads, page]);

  const handleFilterSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    loadLeads(1);
  };

  const handleExportCsv = () => {
    const qs = buildQueryString(1);
    window.location.href = `/api/admin/leads/export.csv?${qs}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">
            Gelen Müşteri Talepleri (Lead'ler)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Toplam <strong>{total}</strong> kayıt bulundu
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => loadLeads(page)}
            className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-xs font-bold text-slate-700 inline-flex items-center gap-1.5 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Yenile</span>
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            className="px-4 py-2.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-sm"
          >
            <Download className="w-3.5 h-3.5 text-amber-400" />
            <span>CSV Dışa Aktar (Excel)</span>
          </button>
        </div>
      </div>

      {/* Site Breakdown Overview Cards */}
      {sites && sites.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {sites.map((s) => {
            const count = siteBreakdown[s.domain] || 0;
            const isJabra = s.brand === 'jabra';
            return (
              <button
                key={s.domain}
                type="button"
                onClick={() => {
                  setSelectedSite(selectedSite === s.domain ? '' : s.domain);
                  setPage(1);
                }}
                className={`p-4 rounded-2xl border text-left transition-all ${
                  selectedSite === s.domain
                    ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                    : 'bg-white hover:bg-slate-50 text-slate-900 border-slate-200 shadow-sm'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                      isJabra
                        ? selectedSite === s.domain
                          ? 'bg-amber-400 text-slate-950 border-transparent'
                          : 'bg-amber-50 text-amber-800 border-amber-200'
                        : selectedSite === s.domain
                        ? 'bg-red-500 text-white border-transparent'
                        : 'bg-red-50 text-red-700 border-red-200'
                    }`}
                  >
                    {s.brand}
                  </span>
                  <span
                    className={`text-xl font-black ${
                      selectedSite === s.domain ? 'text-amber-400' : 'text-slate-900'
                    }`}
                  >
                    {count}
                  </span>
                </div>
                <div className="mt-2.5">
                  <div className="text-xs font-black truncate">{s.displayName}</div>
                  <div
                    className={`text-[10px] font-mono truncate ${
                      selectedSite === s.domain ? 'text-slate-400' : 'text-slate-500'
                    }`}
                  >
                    {s.domain}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Filter Bar */}
      <form
        onSubmit={handleFilterSubmit}
        className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3"
      >
        <div className="lg:col-span-4 relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ad, firma, e-posta, tel veya refCode ara..."
            className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800"
          />
        </div>

        <div className="lg:col-span-2">
          <select
            value={selectedSite}
            onChange={(e) => {
              setSelectedSite(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800 font-medium"
          >
            <option value="">Tüm Siteler</option>
            {sites.map((s) => (
              <option key={s.domain} value={s.domain}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-2">
          <select
            value={selectedBrand}
            onChange={(e) => {
              setSelectedBrand(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800 font-medium"
          >
            <option value="">Tüm Markalar</option>
            <option value="fanvil">Fanvil</option>
            <option value="jabra">Jabra</option>
          </select>
        </div>

        <div className="lg:col-span-2">
          <select
            value={requestType}
            onChange={(e) => {
              setRequestType(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800 font-medium"
          >
            <option value="">Tüm Talep Tipleri</option>
            {Object.entries(requestTypeLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-2">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800 font-medium"
          >
            <option value="">Tüm Durumlar</option>
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label}
              </option>
            ))}
          </select>
        </div>
      </form>

      {listError && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold">
          {listError}
        </div>
      )}

      {/* Leads Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50/75 border-b border-slate-200 text-slate-600 font-extrabold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3 px-4">Site &amp; Marka</th>
                <th className="py-3 px-4">Referans</th>
                <th className="py-3 px-4">Talep Tipi</th>
                <th className="py-3 px-4">Müşteri / Kurum</th>
                <th className="py-3 px-4">İletişim</th>
                <th className="py-3 px-4">Durum</th>
                <th className="py-3 px-4">Tarih</th>
                <th className="py-3 px-4 text-right">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400 font-semibold">
                    Yükleniyor...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400 font-semibold">
                    Kayıt bulunamadı.
                  </td>
                </tr>
              ) : (
                items.map((lead) => {
                  const st = STATUS_META[lead.status] || STATUS_META.new;
                  const reqLabel = requestTypeLabels[lead.requestType] || lead.requestType;
                  return (
                    <tr
                      key={lead._id}
                      onClick={() => onSelectLead(lead._id)}
                      className={`hover:bg-slate-50/80 cursor-pointer transition-colors ${
                        !lead.isRead ? 'bg-amber-50/20' : ''
                      }`}
                    >
                      <td className="py-3 px-4">
                        <BrandBadge brand={lead.brand} site={lead.site} />
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono font-bold text-slate-900 bg-slate-100 px-2 py-0.5 rounded">
                          {lead.refCode}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold text-slate-800">{reqLabel}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{lead.fullName}</div>
                        <div className="text-[11px] text-slate-500 font-medium">
                          {lead.company || '-'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-700">{lead.email}</div>
                        <div className="text-[11px] text-slate-500 font-mono">{lead.phone}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2.5 py-1 rounded-full border text-[11px] font-bold ${st.cls}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-500 font-medium whitespace-nowrap">
                        {formatDateTR(lead.createdAt)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectLead(lead._id);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px]"
                        >
                          Detay
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-4 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <div>
              Sayfa <strong>{page}</strong> / <strong>{totalPages}</strong>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50 font-bold"
              >
                Önceki
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50 font-bold"
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. LEAD DETAIL VIEW
// ---------------------------------------------------------------------------
function LeadDetailView({ leadId, isAdmin, onBack, sites, requestTypeLabels }) {
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const { res, data } = await apiFetch(`/api/admin/leads/${leadId}`);
      if (res.ok && data?.ok) {
        setLead(data.lead);
      }
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleStatusChange = async (newStatus) => {
    if (!isAdmin || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      const { res, data } = await apiFetch(`/api/admin/leads/${leadId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok && data?.ok) {
        setLead(data.lead);
        setFeedback('Durum güncellendi.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAddNote = async (e) => {
    e.preventDefault();
    if (!isAdmin || !noteText.trim() || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      const { res, data } = await apiFetch(`/api/admin/leads/${leadId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: noteText.trim() })
      });
      if (res.ok && data?.ok) {
        setLead((prev) => ({ ...prev, notes: data.notes }));
        setNoteText('');
        setFeedback('Not eklendi.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleResendMail = async () => {
    if (!isAdmin || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      const { res, data } = await apiFetch(`/api/admin/leads/${leadId}/resend-mail`, {
        method: 'POST'
      });
      if (res.ok && data?.ok) {
        setFeedback('Bildirim maili kuyruğa alındı.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="py-12 text-center text-sm text-slate-500">Yükleniyor...</div>;
  }

  if (!lead) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Listeye Dön</span>
        </button>
        <div className="p-8 bg-white rounded-2xl border text-center text-sm">Lead bulunamadı.</div>
      </div>
    );
  }

  const st = STATUS_META[lead.status] || STATUS_META.new;
  const cp = CAPTCHA_META[lead.captchaStatus] || CAPTCHA_META.disabled;
  const reqLabel = requestTypeLabels[lead.requestType] || lead.requestType;
  const extraObj = lead.extra && typeof lead.extra === 'object' ? lead.extra : {};
  const hasExtra = Object.keys(extraObj).length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-xs font-bold text-slate-700 shadow-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Taleplere Dön</span>
        </button>

        {feedback && (
          <span className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold">
            {feedback}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 8 cols: Full Lead Data */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-sm space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <BrandBadge brand={lead.brand} site={lead.site} />
                  <span className="text-xs font-black text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                    {reqLabel}
                  </span>
                </div>
                <h2 className="text-2xl font-black text-slate-900 mt-2">
                  {lead.refCode} {lead.company ? `— ${lead.company}` : ''}
                </h2>
                <p className="text-xs text-slate-500">
                  Tarih: {formatDateTR(lead.createdAt)} (Europe/Istanbul)
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className={`px-2.5 py-1 rounded-full border text-xs font-bold ${cp.cls}`}>
                  {cp.label}
                </span>
                <span className={`px-3 py-1 rounded-full border text-xs font-bold ${st.cls}`}>
                  {st.label}
                </span>
              </div>
            </div>

            {/* Core Info Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs sm:text-sm">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">Ad Soyad</div>
                <div className="font-bold text-slate-900 mt-0.5">{lead.fullName}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">Firma / Kurum</div>
                <div className="font-bold text-slate-900 mt-0.5">{lead.company || '-'}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">E-Posta</div>
                <a
                  href={`mailto:${lead.email}`}
                  className="font-bold text-blue-600 hover:underline mt-0.5 block truncate"
                >
                  {lead.email}
                </a>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">Telefon</div>
                <a href={`tel:${lead.phone}`} className="font-bold text-slate-900 hover:underline mt-0.5 block">
                  {lead.phone}
                </a>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">İlgilenilen Ürün / Model</div>
                <div className="font-bold text-slate-900 mt-0.5">{lead.selectedProduct || '-'}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="text-slate-500 text-xs font-medium">Adet / Ölçek &amp; PBX</div>
                <div className="font-bold text-slate-900 mt-0.5">
                  {lead.quantity || '-'} {lead.pbxSystem ? `• ${lead.pbxSystem}` : ''}
                </div>
              </div>
              {lead.projectName && (
                <div className="sm:col-span-2 p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                  <div className="text-slate-500 text-xs font-medium">Proje Adı / Notu</div>
                  <div className="font-bold text-slate-900 mt-0.5">{lead.projectName}</div>
                </div>
              )}
              {lead.message && (
                <div className="sm:col-span-2 p-4 rounded-xl bg-slate-50 border border-slate-200/70">
                  <div className="text-slate-500 text-xs font-medium mb-1">Müşteri Mesajı</div>
                  <div className="text-slate-900 whitespace-pre-wrap leading-relaxed font-medium">
                    {lead.message}
                  </div>
                </div>
              )}
            </div>

            {/* Extra Dynamic Form Fields (if present) */}
            {hasExtra && (
              <div className="space-y-3 pt-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">
                  Ek Form Alanları
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {Object.entries(extraObj).map(([k, v]) => (
                    <div key={k} className="p-3 rounded-xl bg-slate-50 border border-slate-200/70 text-xs">
                      <div className="text-slate-500 font-mono text-[11px] font-bold">{k}</div>
                      <div className="font-bold text-slate-900 mt-0.5">{String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Cart Snapshot */}
            {Array.isArray(lead.cartSnapshot) && lead.cartSnapshot.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">
                  Proje Teklif Sepeti ({lead.cartSnapshot.length} Kalem)
                </h3>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl overflow-hidden text-xs">
                  {lead.cartSnapshot.map((item, idx) => (
                    <div key={idx} className="p-3 flex items-center justify-between bg-white">
                      <span className="font-bold text-slate-800">{item.model}</span>
                      <span className="font-mono px-2 py-0.5 bg-slate-100 rounded text-slate-700 font-bold">
                        {item.qty} Adet
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right 4 cols: Status & Internal Notes */}
        <div className="lg:col-span-4 space-y-6">
          {/* Status Change & Outbox Action */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
              Talep Yönetimi
            </h3>

            {isAdmin && (
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">
                  Durum Değiştir
                </label>
                <select
                  value={lead.status}
                  disabled={busy}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:border-slate-800"
                >
                  {Object.entries(STATUS_META).map(([key, meta]) => (
                    <option key={key} value={key}>
                      {meta.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {isAdmin && (
              <button
                type="button"
                disabled={busy}
                onClick={handleResendMail}
                className="w-full py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs flex items-center justify-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5 text-slate-600" />
                <span>Bildirim Mailini Yeniden Gönder</span>
              </button>
            )}
          </div>

          {/* Internal Notes */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
              İç Notlar ({lead.notes?.length || 0})
            </h3>

            {isAdmin && (
              <form onSubmit={handleAddNote} className="space-y-2">
                <textarea
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Bu talep hakkında ekip için not ekleyin..."
                  className="w-full p-3 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none focus:border-slate-800"
                />
                <button
                  type="submit"
                  disabled={busy || !noteText.trim()}
                  className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold text-xs"
                >
                  Not Ekle
                </button>
              </form>
            )}

            <div className="space-y-2.5 max-h-80 overflow-y-auto">
              {Array.isArray(lead.notes) && lead.notes.length > 0 ? (
                lead.notes.map((n, i) => (
                  <div key={i} className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-bold">
                      <span>{n.by}</span>
                      <span>{formatDateTR(n.at)}</span>
                    </div>
                    <div className="text-slate-800 font-medium whitespace-pre-wrap">{n.text}</div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-400 text-center py-4">Henüz not eklenmedi.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. MAIL SETTINGS VIEW
// ---------------------------------------------------------------------------
function MailSettingsView() {
  const [settings, setSettings] = useState(null);
  const [recentAttempts, setRecentAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const [smtpHost, setSmtpHost] = useState('mail.dogrumail.com');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecurity, setSmtpSecurity] = useState('starttls');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpFromAddress, setSmtpFromAddress] = useState('');
  const [smtpFromName, setSmtpFromName] = useState('Tescom Lead Platform');

  const [testEmail, setTestEmail] = useState('');

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const { res, data } = await apiFetch('/api/admin/mail-settings');
      if (res.ok && data?.ok) {
        setSettings(data.settings);
        setRecentAttempts(data.recentAttempts || []);
        if (data.settings) {
          setSmtpHost(data.settings.smtpHost || 'mail.dogrumail.com');
          setSmtpPort(data.settings.smtpPort || 587);
          setSmtpSecurity(data.settings.smtpSecurity || 'starttls');
          setSmtpUser(data.settings.smtpUser || '');
          setSmtpFromAddress(data.settings.smtpFromAddress || '');
          setSmtpFromName(data.settings.smtpFromName || 'Tescom Lead Platform');
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { res, data } = await apiFetch('/api/admin/mail-settings', {
        method: 'PUT',
        body: JSON.stringify({
          smtpHost,
          smtpPort: Number(smtpPort),
          smtpSecurity,
          smtpUser,
          smtpPassword: smtpPassword || undefined,
          smtpFromAddress,
          smtpFromName
        })
      });
      if (res.ok && data?.ok) {
        setMsg({ type: 'ok', text: 'SMTP ayarları başarıyla kaydedildi.' });
        setSmtpPassword('');
        loadSettings();
      } else {
        setMsg({ type: 'err', text: data?.error || 'Kayıt başarısız.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleTestConnection = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { res, data } = await apiFetch('/api/admin/mail-settings/test-connection', {
        method: 'POST',
        body: JSON.stringify({ smtpPassword: smtpPassword || undefined })
      });
      if (res.ok && data?.ok) {
        setMsg({ type: 'ok', text: `Bağlantı başarılı: ${data.host}:${data.port}` });
      } else {
        setMsg({ type: 'err', text: data?.error || 'Bağlantı kurulamadı.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSendTestMail = async (e) => {
    e.preventDefault();
    if (!testEmail) return;
    setBusy(true);
    setMsg(null);
    try {
      const { res, data } = await apiFetch('/api/admin/mail-settings/send-test-mail', {
        method: 'POST',
        body: JSON.stringify({ recipient: testEmail })
      });
      if (res.ok && data?.ok) {
        setMsg({ type: 'ok', text: data.message || 'Test e-postası başarıyla iletildi.' });
        loadSettings();
      } else {
        setMsg({ type: 'err', text: data?.error || 'Test e-postası gönderilemedi.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">SMTP Sunucu Ayarları</h1>
        <p className="text-xs text-slate-500 mt-1">
          Gelen taleplerin bildirim e-postaları için Doğru Mail veya kurumsal SMTP sunucusu yapılandırması.
        </p>
      </div>

      {msg && (
        <div
          className={`p-4 rounded-xl text-xs font-semibold ${
            msg.type === 'ok'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {msg.text}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-sm space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">SMTP Host</label>
            <input
              type="text"
              required
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
              placeholder="mail.dogrumail.com"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">Port &amp; Güvenlik</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                required
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
              />
              <select
                value={smtpSecurity}
                onChange={(e) => setSmtpSecurity(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">SSL/TLS</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">SMTP Kullanıcı Adı</label>
            <input
              type="text"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              placeholder="bildirim@domain.com"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              SMTP Şifresi {settings?.hasPassword && '(Kayıtlı Şifre Mevcut)'}
            </label>
            <input
              type="password"
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              placeholder={settings?.hasPassword ? '•••••••••••• (Değiştirmek için girin)' : 'Şifre'}
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">Gönderici E-Posta (From)</label>
            <input
              type="email"
              required
              value={smtpFromAddress}
              onChange={(e) => setSmtpFromAddress(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              placeholder="teklif@domain.com"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">Gönderici Adı (From Name)</label>
            <input
              type="text"
              required
              value={smtpFromName}
              onChange={(e) => setSmtpFromName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
              placeholder="Tescom Lead Platform"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-100">
          <button
            type="submit"
            disabled={busy}
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
          >
            Ayarları Kaydet
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleTestConnection}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold"
          >
            Bağlantıyı Test Et
          </button>
        </div>
      </form>

      {/* Test Mail Form */}
      <form onSubmit={handleSendTestMail} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Test E-Postası Gönder</h3>
        <div className="flex gap-2">
          <input
            type="email"
            required
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="test-alici@domain.com"
            className="flex-1 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold"
          >
            Gönder
          </button>
        </div>
      </form>

      {/* Recent Delivery Attempts */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
          Son Mail Gönderim Denemeleri
        </h3>
        <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto text-xs">
          {recentAttempts.length === 0 ? (
            <div className="text-slate-400 py-3 text-center">Kayıtlı deneme bulunmuyor.</div>
          ) : (
            recentAttempts.map((att, i) => (
              <div key={i} className="py-2.5 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800">{att.recipient}</span>
                  <span className="text-[10px] text-slate-400 ml-2">{formatDateTR(att.createdAt)}</span>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                    att.status === 'sent' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                  }`}
                >
                  {att.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. RECIPIENTS VIEW (Multi-site & RequestTypes selector)
// ---------------------------------------------------------------------------
function RecipientsView({ sites, requestTypeLabels }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [selectedSites, setSelectedSites] = useState([]);
  const [requestTypes, setRequestTypes] = useState([]);
  const [error, setError] = useState('');

  const loadRecipients = useCallback(async () => {
    const { res, data } = await apiFetch('/api/admin/recipients');
    if (res.ok && data?.ok) {
      setItems(data.recipients || data.items || []);
    }
  }, []);

  useEffect(() => {
    loadRecipients();
  }, [loadRecipients]);

  const toggleSite = (domain) => {
    setSelectedSites((prev) =>
      prev.includes(domain) ? prev.filter((d) => d !== domain) : [...prev, domain]
    );
  };

  const toggleType = (t) => {
    setRequestTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');

    const { res, data } = await apiFetch('/api/admin/recipients', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        active: true,
        sites: selectedSites,
        requestTypes
      })
    });
    if (!res.ok || !data?.ok) {
      setError(data?.error || 'Alıcı eklenemedi.');
      return;
    }
    setName('');
    setEmail('');
    setSelectedSites([]);
    setRequestTypes([]);
    loadRecipients();
  };

  const handleToggleActive = async (item) => {
    await apiFetch(`/api/admin/recipients/${item._id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !item.active })
    });
    loadRecipients();
  };

  const handleDelete = async (id) => {
    await apiFetch(`/api/admin/recipients/${id}`, { method: 'DELETE' });
    loadRecipients();
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">Lead Bildirim Alıcıları</h1>
        <p className="text-xs text-slate-500 mt-1">
          Hangi site ve hangi talep tiplerinin kime e-posta ile iletileceğini yapılandırın.
        </p>
      </div>

      <form onSubmit={handleAdd} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Yeni Alıcı Ekle</h3>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            required
            placeholder="Ad Soyad (Örn: Ahmet Satış)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
          <input
            type="email"
            required
            placeholder="E-Posta (ahmet@tescom.com.tr)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
        </div>

        {/* Target Sites Selection */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            İlgili Siteler (Hiçbiri seçilmezse TÜM sitelerin bildirimlerini alır)
          </label>
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => {
              const active = selectedSites.includes(s.domain);
              return (
                <button
                  type="button"
                  key={s.domain}
                  onClick={() => toggleSite(s.domain)}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  {s.displayName}
                </button>
              );
            })}
          </div>
        </div>

        {/* Target Request Types */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            İlgili Talep Tipleri (Hiçbiri seçilmezse TÜM tipleri alır)
          </label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(requestTypeLabels).map(([key, label]) => {
              const active = requestTypes.includes(key);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggleType(key)}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
        >
          Alıcıyı Kaydet
        </button>
      </form>

      {/* Recipients List */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-100">
        {items.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">Henüz bildirim alıcısı eklenmedi.</div>
        ) : (
          items.map((r) => (
            <div key={r._id} className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-black text-sm text-slate-900">{r.name}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                      r.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {r.active ? 'Aktif' : 'Pasif'}
                  </span>
                </div>
                <div className="text-xs font-medium text-slate-600">{r.email}</div>

                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Array.isArray(r.sites) && r.sites.length > 0 ? (
                    r.sites.map((st) => (
                      <span key={st} className="px-2 py-0.5 rounded bg-blue-50 text-blue-800 text-[10px] font-bold">
                        {st}
                      </span>
                    ))
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold">
                      Tüm Siteler
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleActive(r)}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  {r.active ? 'Pasife Al' : 'Aktifleştir'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(r._id)}
                  className="p-1.5 rounded-lg text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. ALLOWED IPS VIEW
// ---------------------------------------------------------------------------
function AllowedIpsView({ currentIp }) {
  const [allowedIps, setAllowedIps] = useState([]);
  const [bootstrapIps, setBootstrapIps] = useState([]);
  const [newIp, setNewIp] = useState('');
  const [newNote, setNewNote] = useState('');
  const [error, setError] = useState('');

  const loadIps = useCallback(async () => {
    const { res, data } = await apiFetch('/api/admin/allowed-ips');
    if (res.ok && data?.ok) {
      setAllowedIps(data.allowedIps || []);
      setBootstrapIps(data.bootstrapIps || []);
    }
  }, []);

  useEffect(() => {
    loadIps();
  }, [loadIps]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');
    const { res, data } = await apiFetch('/api/admin/allowed-ips', {
      method: 'POST',
      body: JSON.stringify({ ip: newIp.trim(), note: newNote.trim() })
    });
    if (!res.ok || !data?.ok) {
      setError(data?.error || 'IP kuralı eklenemedi.');
      return;
    }
    setNewIp('');
    setNewNote('');
    loadIps();
  };

  const handleDelete = async (id) => {
    await apiFetch(`/api/admin/allowed-ips/${id}`, { method: 'DELETE' });
    loadIps();
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">Admin IP Allowlist</h1>
        <p className="text-xs text-slate-500 mt-1">
          Yalnızca izin verilen IP adresleri /admin ve /api/admin/* endpointlerine erişebilir; diğer tüm IP'ler için 404 döner.
        </p>
      </div>

      <div className="p-4 rounded-2xl bg-slate-900 text-white flex items-center justify-between text-xs font-semibold">
        <span>Mevcut Bağlantı IP Adresiniz:</span>
        <span className="font-mono bg-white/10 px-2 py-1 rounded text-amber-400 font-bold">
          {currentIp || '127.0.0.1'}
        </span>
      </div>

      <form onSubmit={handleAdd} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Yeni İzinli IP / CIDR Ekle</h3>
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            required
            placeholder="IP veya CIDR (Örn: 88.247.12.34 veya 88.247.12.0/24)"
            value={newIp}
            onChange={(e) => setNewIp(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
          />
          <input
            type="text"
            placeholder="Açıklama (Örn: Ofis Statik IP)"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
        >
          IP Kuralını Ekle
        </button>
      </form>

      {/* Bootstrap IPs */}
      {bootstrapIps.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-2">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">
            Sistem Çekirdek IP'leri (ADMIN_BOOTSTRAP_IPS)
          </h3>
          <div className="flex flex-wrap gap-2">
            {bootstrapIps.map((ip) => (
              <span key={ip} className="px-2.5 py-1 rounded-lg bg-slate-100 font-mono text-xs font-bold text-slate-800">
                {ip}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* DB Allowed IPs List */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm divide-y divide-slate-100">
        {allowedIps.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">Veritabanında ek IP kuralı bulunmuyor.</div>
        ) : (
          allowedIps.map((rule) => (
            <div key={rule._id} className="p-4 flex items-center justify-between text-xs">
              <div>
                <div className="font-mono font-bold text-slate-900">{rule.ip}</div>
                {rule.note && <div className="text-slate-500 text-[11px]">{rule.note}</div>}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(rule._id)}
                className="p-1.5 rounded-lg text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. ADMIN USERS & 2FA MANAGEMENT VIEW
// ---------------------------------------------------------------------------
function AdminUsersView({ currentUser, onUserUpdated }) {
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('admin');
  const [error, setError] = useState('');

  // Password Change
  const [oldPassword, setOldPassword] = useState('');
  const [changedPassword, setChangedPassword] = useState('');
  const [pwMsg, setPwMsg] = useState(null);

  // 2FA Modal
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [twoFaMsg, setTwoFaMsg] = useState(null);

  const loadUsers = useCallback(async () => {
    const { res, data } = await apiFetch('/api/admin/users');
    if (res.ok && data?.ok) {
      setUsers(data.users || data.items || []);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setError('');
    const { res, data } = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
    });
    if (!res.ok || !data?.ok) {
      setError(data?.error || 'Kullanıcı eklenemedi.');
      return;
    }
    setNewUsername('');
    setNewPassword('');
    loadUsers();
  };

  const handleDeleteUser = async (id) => {
    setError('');
    const { res, data } = await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    if (!res.ok || !data?.ok) {
      setError(data?.error || 'Kullanıcı silinemedi.');
      return;
    }
    loadUsers();
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwMsg(null);
    const { res, data } = await apiFetch('/api/admin/users/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword: changedPassword })
    });
    if (!res.ok || !data?.ok) {
      setPwMsg({ type: 'err', text: data?.error || 'Şifre güncellenemedi.' });
      return;
    }
    setOldPassword('');
    setChangedPassword('');
    setPwMsg({ type: 'ok', text: 'Şifreniz başarıyla değiştirildi.' });
  };

  const handleStart2FASetup = async () => {
    setTwoFaMsg(null);
    setVerifyToken('');
    const { res, data } = await apiFetch('/api/admin/2fa/setup', { method: 'POST' });
    if (res.ok && data?.ok) {
      setTotpSecret(data.secret);
      setQrCodeUrl(data.qrCodeDataUrl);
      setShow2FAModal(true);
    } else {
      alert('2FA kurulumu başlatılamadı.');
    }
  };

  const handleConfirm2FA = async (e) => {
    e.preventDefault();
    setTwoFaMsg(null);
    const { res, data } = await apiFetch('/api/admin/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ token: verifyToken })
    });
    if (res.ok && data?.ok) {
      alert('İki adımlı doğrulama (2FA) başarıyla aktifleştirildi.');
      setShow2FAModal(false);
      if (onUserUpdated) onUserUpdated();
      loadUsers();
    } else {
      setTwoFaMsg(data?.error || 'Doğrulama başarısız.');
    }
  };

  const handleDisable2FA = async () => {
    const pw = prompt('2FA devre dışı bırakmak için mevcut şifrenizi giriniz:');
    if (!pw) return;

    const { res, data } = await apiFetch('/api/admin/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ password: pw })
    });
    if (res.ok && data?.ok) {
      alert('İki adımlı doğrulama devre dışı bırakıldı.');
      if (onUserUpdated) onUserUpdated();
      loadUsers();
    } else {
      alert(data?.error || 'Devre dışı bırakılamadı.');
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">Kullanıcılar &amp; 2FA Güvenliği</h1>
        <p className="text-xs text-slate-500 mt-1">
          Yönetici hesapları, şifre değişikliği ve Google Authenticator iki adımlı doğrulama yönetimi.
        </p>
      </div>

      {/* 2FA Status Card for Current User */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-amber-500" />
            <h3 className="font-black text-sm text-slate-900">İki Adımlı Doğrulama (2FA - TOTP)</h3>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Giriş güvenliği için Google Authenticator / Microsoft Authenticator kodu zorunlu kılınabilir.
          </p>
        </div>

        <div>
          {currentUser.totpEnabled ? (
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
                2FA Aktif ✓
              </span>
              <button
                type="button"
                onClick={handleDisable2FA}
                className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-red-600 hover:bg-red-50"
              >
                Devre Dışı Bırak
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleStart2FASetup}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5"
            >
              <QrCode className="w-4 h-4 text-amber-400" />
              <span>2FA'yı Aktifleştir (QR Kod)</span>
            </button>
          )}
        </div>
      </div>

      {/* 2FA Setup Modal */}
      {show2FAModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-4">
            <h3 className="text-lg font-black text-slate-900 text-center">
              Google Authenticator ile Eşleştirin
            </h3>
            <p className="text-xs text-slate-500 text-center">
              Aşağıdaki QR kodu telefonunuzdaki Authenticator uygulaması ile tarayın veya gizli anahtarı girin.
            </p>

            {qrCodeUrl && (
              <div className="flex justify-center p-4 bg-slate-50 rounded-2xl border border-slate-200">
                <img src={qrCodeUrl} alt="2FA QR Code" className="w-48 h-48 rounded" />
              </div>
            )}

            <div className="text-center">
              <span className="text-[11px] text-slate-400">Gizli Anahtar (Manuel giriş için):</span>
              <div className="font-mono font-bold text-xs text-slate-800 bg-slate-100 p-2 rounded mt-1 select-all">
                {totpSecret}
              </div>
            </div>

            {twoFaMsg && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold text-center">
                {twoFaMsg}
              </div>
            )}

            <form onSubmit={handleConfirm2FA} className="space-y-3 pt-2">
              <label className="block text-xs font-bold text-slate-700 text-center">
                Uygulamanızdaki 6 Haneli Kodu Girin
              </label>
              <input
                type="text"
                required
                maxLength={8}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="w-full text-center font-mono font-black text-xl py-2.5 rounded-xl border border-slate-300"
                placeholder="000000"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShow2FAModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
                >
                  Onayla ve Bitir
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Password Change Form */}
      <form onSubmit={handleChangePassword} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Şifremi Değiştir</h3>
        {pwMsg && (
          <div
            className={`p-3 rounded-xl text-xs font-semibold ${
              pwMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {pwMsg.text}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="password"
            required
            placeholder="Mevcut Şifreniz"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
          <input
            type="password"
            required
            placeholder="Yeni Şifre (En az 12 karakter)"
            value={changedPassword}
            onChange={(e) => setChangedPassword(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
        </div>
        <button type="submit" className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold">
          Şifreyi Güncelle
        </button>
      </form>

      {/* Add New User */}
      <form onSubmit={handleCreateUser} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Yeni Yetkili Kullanıcı Ekle</h3>
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            required
            placeholder="Kullanıcı Adı"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
          <input
            type="password"
            required
            placeholder="Şifre (En az 12 karakter)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
          >
            <option value="admin">Yönetici (Admin)</option>
            <option value="viewer">Gözlemci (Viewer)</option>
          </select>
        </div>
        <button type="submit" className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold">
          Kullanıcıyı Kaydet
        </button>
      </form>

      {/* Users List */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm divide-y divide-slate-100">
        {users.map((u) => (
          <div key={u._id} className="p-4 flex items-center justify-between text-xs">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-slate-900">{u.username}</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                  {u.role}
                </span>
                {u.totpEnabled && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700">
                    2FA Aktif
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Oluşturulma: {formatDateTR(u.createdAt)}
              </div>
            </div>

            {u.username !== currentUser.username && (
              <button
                type="button"
                onClick={() => handleDeleteUser(u._id)}
                className="p-1.5 rounded-lg text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 9. AUDIT LOGS VIEW
// ---------------------------------------------------------------------------
function AuditLogsView() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const loadLogs = useCallback(async (targetPage = 1) => {
    setLoading(true);
    try {
      const { res, data } = await apiFetch(`/api/admin/audit-logs?page=${targetPage}&limit=50`);
      if (res.ok && data?.ok) {
        setLogs(data.logs || []);
        setTotal(data.total || 0);
        setPage(data.page || targetPage);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs(1);
  }, [loadLogs]);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">Güvenlik &amp; Denetim Kayıtları</h1>
        <p className="text-xs text-slate-500 mt-1">
          Yönetici işlemleri, oturum açma, durum değişiklikleri ve IP denetim kayıtları ({total} toplam kayıt).
        </p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-extrabold text-[11px]">
              <tr>
                <th className="py-3 px-4">Tarih</th>
                <th className="py-3 px-4">Kullanıcı</th>
                <th className="py-3 px-4">İşlem</th>
                <th className="py-3 px-4">Detay</th>
                <th className="py-3 px-4">IP Adresi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">Yükleniyor...</td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">Kayıt bulunamadı.</td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log._id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4 text-slate-500 whitespace-nowrap">{formatDateTR(log.createdAt)}</td>
                    <td className="py-2.5 px-4 font-bold text-slate-900">{log.actor}</td>
                    <td className="py-2.5 px-4">
                      <span className="font-mono bg-slate-100 text-slate-800 px-2 py-0.5 rounded text-[10px] font-bold">
                        {log.action}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{log.details || '-'}</td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500">{log.ip || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
