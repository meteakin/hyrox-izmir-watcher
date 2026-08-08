#!/usr/bin/env node
// HYROX İzmir bilet gözcüsü.
//
// Checkout sayfası Next.js SSR olduğu için tüm bilet kataloğu __NEXT_DATA__
// script etiketinde JSON olarak geliyor. Tek bir GET yetiyor; tarayıcı gerekmiyor.
// Her biletin `v` alanı kalan kontenjanı, `active` alanı satışta olup olmadığını
// veriyor. "TÜKENDİ" durumu tam olarak active && v === 0 demek.

import { readFile, writeFile } from 'node:fs/promises';

// GitHub Actions tanımlanmamış `vars.*` değerlerini boş string olarak geçiriyor,
// bu yüzden ?? yetmiyor: boş olanı da yok say.
const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
};

const CHECKOUT_URL = env(
  'CHECKOUT_URL',
  'https://turkiye.hyrox.com/checkout/hyrox-izmir-season-26-27-0va2xn',
);
const EVENT_PAGE = 'https://hyrox.com/event/hyrox-izmir/';

// meta.competition_class_matching_key değerleri. TAM eşitlik aranır, substring değil.
// Bu yüzden DOUBLES_OPEN_M asla DOUBLES_PRO_M ile karışmaz — vivenu bu ikisini
// ayrı anahtarlarla tutuyor ve shop'un Open/Pro filtresi de tam bu alandan geliyor:
//   Doubles → Open → Men  ⇒  DOUBLES_OPEN_M  ⇒  "HYROX DOUBLES MEN"
//   Doubles → Pro  → Men  ⇒  DOUBLES_PRO_M   ⇒  "HYROX PRO DOUBLES MEN"
const WATCH_KEYS = env('WATCH_KEYS', 'DOUBLES_OPEN_M')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Yanlış kategoriye alarm kurmaktansa hiç kurmamak iyidir: izlenen anahtar
// "OPEN" ise eşleşen biletin adında "PRO" geçemez. Geçiyorsa HYROX anahtarları
// yeniden düzenlemiş demektir ve sessizce yanlış kategoriyi izlemeye devam
// etmektense durup haber vermek gerekir.
function assertClassSanity(watched) {
  const wantsOpen = WATCH_KEYS.some((k) => k.includes('_OPEN_'));
  const wantsPro = WATCH_KEYS.some((k) => k.includes('_PRO_'));
  for (const t of watched) {
    const namesPro = /\bPRO\b/i.test(t.name ?? '');
    if (wantsOpen && !wantsPro && namesPro) {
      throw new Error(
        `Tutarsızlık: "${t.name}" bileti ` +
          `${t.meta?.competition_class_matching_key} anahtarıyla geldi ama adında ` +
          `PRO geçiyor. Open/Pro ayrımı bozulmuş — alarm kurulamıyor.`,
      );
    }
    if (wantsPro && !wantsOpen && !namesPro) {
      throw new Error(
        `Tutarsızlık: "${t.name}" PRO bileti bekleniyordu ama adı uymuyor.`,
      );
    }
  }
}

const STATE_FILE = env('STATE_FILE', 'state.json');

const RESEND_API_KEY = env('RESEND_API_KEY', '');
const MAIL_TO = env('MAIL_TO', '');
const MAIL_FROM = env('MAIL_FROM', 'HYROX Watcher <onboarding@resend.dev>');

// Bilet açıkken kaç dakikada bir tekrar hatırlatma maili atılsın.
const REALERT_MINUTES = Number(env('REALERT_MINUTES', '30'));
// Gözcü bozulursa (site değişti, ağ gitti) kaç saatte bir uyarı maili atılsın.
const ERROR_ALERT_HOURS = Number(env('ERROR_ALERT_HOURS', '6'));
// "Hâlâ izliyorum" maili. 0 = kapalı.
const HEARTBEAT_HOURS = Number(env('HEARTBEAT_HOURS', '0'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// --- durum dosyası -------------------------------------------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

const elapsed = (since, span) => !since || Date.now() - Date.parse(since) >= span;

// --- sayfayı çek ve ayrıştır ---------------------------------------------

async function fetchTickets() {
  const res = await fetch(CHECKOUT_URL, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (!res.ok) throw new Error(`Checkout sayfası HTTP ${res.status} döndü`);

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error('__NEXT_DATA__ bulunamadı — sayfa yapısı değişmiş olabilir');
  }

  const tickets = JSON.parse(match[1])?.props?.pageProps?.event?.tickets;
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error('Sayfa verisinde bilet listesi yok');
  }
  return tickets;
}

// Kalan kontenjan bilinmiyorsa haber vermeyi tercih et: kaçırmaktansa
// yanlış alarm iyidir.
const isOpen = (t) => t.active === true && (t.v == null || Number(t.v) > 0);

// --- mail ----------------------------------------------------------------

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

async function sendMail(subject, html) {
  if (!RESEND_API_KEY || !MAIL_TO) {
    console.error('RESEND_API_KEY veya MAIL_TO tanımlı değil — mail atlanıyor');
    console.error(`  konu: ${subject}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  }
  console.log(`Mail gönderildi: ${subject}`);
  return true;
}

const shell = (body) => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              max-width:560px;margin:0 auto;padding:24px;color:#111">
    ${body}
    <p style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;
              font-size:12px;color:#888">
      HYROX İzmir bilet gözcüsü · ${escapeHtml(new Date().toISOString())}
    </p>
  </div>`;

// Yarış aslında iki günlüktü; Pazar iptal edilip her şey Cumartesi'ye alındı
// (13 Tem 2026'da yeni Cumartesi biletleri oluşturulmuş). Pazar bilet kalemleri
// hâlâ sistemde duruyor, pasif ve üzerlerinde iptal edilmiş günün stoğu var.
// Böyle bir kalem tekrar aktifleşirse bu gerçek bir yeniden açılış da olabilir,
// yönetim panelinde yapılmış bir kaza da — mailde ayırt edilebilsin.
const isSunday = (t) => /pazar|sunday/i.test(t.name ?? '');

function availableMail(open) {
  const rows = open
    .map(
      (t) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">
          ${escapeHtml(t.name)}
          ${isSunday(t) ? '<span style="color:#b45309;font-weight:600"> ⚠︎</span>' : ''}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;
                   font-variant-numeric:tabular-nums">
          ${t.v == null ? '?' : escapeHtml(t.v)}
        </td>
      </tr>`,
    )
    .join('');

  const sundayWarning = open.some(isSunday)
    ? `<p style="margin:20px 0 0;padding:12px 16px;background:#fffbeb;
                 border-left:3px solid #b45309;font-size:13px;color:#78350f">
         <strong>⚠︎ Dikkat:</strong> Açılan biletlerden en az biri
         <strong>Pazar</strong> günü. Pazar yarışı iptal edilip her şey Cumartesi'ye
         alınmıştı, dolayısıyla bu ya günün tekrar açılması ya da sistemde kalmış
         eski kaydın yanlışlıkla aktifleşmesi olabilir. Satın almadan önce günü
         teyit et.
       </p>`
    : '';

  return shell(`
    <h1 style="font-size:22px;margin:0 0 8px">🎟️ Bilet açıldı — hemen al</h1>
    <p style="margin:0 0 20px;color:#444">
      HYROX İzmir <strong>Doubles Open Men</strong> kategorisinde satın alınabilir
      bilet göründü.
    </p>
    ${sundayWarning}
    <a href="${CHECKOUT_URL}"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              padding:14px 28px;border-radius:6px;font-weight:600">
      Satın alma sayfasına git →
    </a>
    <table style="width:100%;border-collapse:collapse;margin-top:24px;font-size:14px">
      <tr>
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111">Bilet</th>
        <th style="text-align:right;padding:8px 12px;border-bottom:2px solid #111">Kalan</th>
      </tr>
      ${rows}
    </table>
    <p style="margin-top:20px;font-size:13px;color:#666">
      Sayfada: Athlete Tickets → Doubles → Open → Men.
      Doubles biletinde 2 atlet birlikte sepete ekleniyor.
    </p>`);
}

function errorMail(message) {
  return shell(`
    <h1 style="font-size:20px;margin:0 0 8px">⚠️ Gözcü kontrol yapamıyor</h1>
    <p style="margin:0 0 16px;color:#444">
      Son kontrol başarısız oldu. Bu düzeltilene kadar bilet açılsa bile
      haber alamazsın — sayfayı elle kontrol et.
    </p>
    <pre style="background:#f6f6f6;padding:12px;border-radius:6px;font-size:13px;
                white-space:pre-wrap;margin:0 0 16px">${escapeHtml(message)}</pre>
    <a href="${EVENT_PAGE}" style="color:#111">Etkinlik sayfası</a>`);
}

// --- ana akış ------------------------------------------------------------

// Kontrol yapılamadı: uyar, durumu yaz, çık. Mail gönderimi de patlarsa
// durumu yine de kaydet — yoksa hata zaman damgası ilerlemez ve her koşuda
// yeniden mail denenir.
async function fail(state, message) {
  state.lastError = { at: new Date().toISOString(), message };
  if (elapsed(state.lastErrorAlertAt, ERROR_ALERT_HOURS * HOUR)) {
    try {
      await sendMail('⚠️ HYROX gözcü hatası', errorMail(message));
      state.lastErrorAlertAt = new Date().toISOString();
    } catch (mailErr) {
      console.error(`Hata maili de gönderilemedi: ${mailErr.message}`);
    }
  }
  await saveState(state);
  throw new Error(message);
}

async function main() {
  const state = await loadState();
  const now = new Date().toISOString();

  let tickets;
  try {
    tickets = await fetchTickets();
  } catch (err) {
    await fail(state, err.message);
  }

  const watched = tickets.filter((t) =>
    WATCH_KEYS.includes(t.meta?.competition_class_matching_key),
  );
  // Kategori anahtarı değişmiş demektir; sessizce "tükenmiş" saymak tehlikeli.
  if (watched.length === 0) {
    await fail(
      state,
      `"${WATCH_KEYS.join(', ')}" anahtarıyla hiç bilet eşleşmedi. ` +
        `Kategori adlandırması değişmiş olabilir.`,
    );
  }

  try {
    assertClassSanity(watched);
  } catch (err) {
    await fail(state, err.message);
  }

  const open = watched.filter(isOpen);
  const available = open.length > 0;

  // Önce izlenenler, sonra referans olsun diye komşu Doubles sınıfları. Böylece
  // loglara bakınca doğru kategoriyi izlediğin gözle doğrulanabiliyor.
  console.log(`İzlenen: ${WATCH_KEYS.join(', ')}`);
  for (const t of watched) {
    console.log(
      `  ${isOpen(t) ? '✅' : '· '} ${t.name} — active=${t.active} kalan=${t.v ?? '?'}`,
    );
  }
  const context = tickets.filter((t) => {
    const k = t.meta?.competition_class_matching_key;
    return k?.startsWith('DOUBLES_') && !WATCH_KEYS.includes(k);
  });
  if (context.length > 0) {
    console.log('Referans (izlenmiyor):');
    for (const t of context) {
      console.log(
        `  · ${t.meta.competition_class_matching_key} — ${t.name} ` +
          `(active=${t.active} kalan=${t.v ?? '?'})`,
      );
    }
  }

  delete state.lastError;
  state.lastCheckAt = now;
  state.snapshot = watched.map((t) => ({
    name: t.name,
    key: t.meta?.competition_class_matching_key,
    active: t.active,
    remaining: t.v ?? null,
  }));

  if (available) {
    // Gün, telefon bildiriminde maili açmadan görünsün.
    const days = [
      open.some((t) => !isSunday(t)) && 'Cumartesi',
      open.some(isSunday) && 'Pazar ⚠︎',
    ].filter(Boolean);

    const firstTime = state.available !== true;
    if (firstTime || elapsed(state.lastAlertAt, REALERT_MINUTES * MINUTE)) {
      await sendMail(
        `🎟️ HYROX İzmir Doubles Open Men — ` +
          `${firstTime ? 'BİLET AÇILDI' : 'hâlâ açık'} (${days.join(' + ')})`,
        availableMail(open),
      );
      state.lastAlertAt = now;
    } else {
      console.log('Bilet açık ama hatırlatma penceresi dolmadı — mail atlandı');
    }
    state.available = true;
  } else {
    if (state.available === true) console.log('Bilet tekrar tükendi');
    state.available = false;
    delete state.lastAlertAt;

    if (HEARTBEAT_HOURS > 0 && elapsed(state.lastHeartbeatAt, HEARTBEAT_HOURS * HOUR)) {
      await sendMail(
        '💓 HYROX gözcü çalışıyor (bilet yok)',
        shell(
          `<p>Gözcü çalışıyor. Şu an ${escapeHtml(WATCH_KEYS.join(', '))} ` +
            `kategorisinde alınabilir bilet yok.</p>`,
        ),
      );
      state.lastHeartbeatAt = now;
    }
  }

  await saveState(state);
  console.log(available ? 'SONUÇ: BİLET VAR' : 'SONUÇ: tükenmiş');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
