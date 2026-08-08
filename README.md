# HYROX İzmir bilet gözcüsü

HYROX İzmir (19–20 Eylül 2026) **Doubles Open Men** kategorisinde bilet açılınca
Resend üzerinden mail atar. GitHub Actions'ta 5 dakikada bir koşar.

## Nasıl çalışıyor

Checkout sayfası (`turkiye.hyrox.com`, vivenu altyapısı) Next.js SSR olduğu için
tüm bilet kataloğu sayfanın HTML'inde `__NEXT_DATA__` script etiketi içinde JSON
olarak geliyor. Tarayıcı otomasyonu gerekmiyor — tek bir `GET` yetiyor.

Her biletin ilgili alanları:

| alan | anlamı |
| --- | --- |
| `meta.competition_class_matching_key` | kategori, ör. `DOUBLES_OPEN_M` |
| `active` | satışta mı (false ise shop'ta hiç görünmüyor) |
| `v` | **kalan kontenjan** |

Shop'ta "TÜKENDİ" etiketi tam olarak `active === true && v === 0` demek.
Doğrulandı: `DOUBLES_OPEN_W` `v=6` iken adet seçici çıkıyor, `DOUBLES_OPEN_M`
`v=0` iken "TÜKENDİ" yazıyor — aynı sayfada, aynı anda.

**Alarm koşulu:** `DOUBLES_OPEN_M` anahtarlı herhangi bir bilette
`active === true && v > 0`. Bu üç senaryoyu birden yakalar: mevcut Cumartesi
biletine kontenjan eklenmesi, pasif Pazar biletlerinin aktifleşmesi, ve yepyeni
bir bilet kalemi oluşturulması.

### Cumartesi / Pazar

Yarış başta iki günlüktü; Pazar iptal edilip her şey Cumartesi'ye alındı.
Bilet ID'lerindeki ObjectId zaman damgaları bunu doğruluyor:

| tarih | ne olmuş |
| --- | --- |
| 28 Nis 2026 | etkinlik + orijinal biletler (Cumartesi *ve* Pazar) |
| 13 Tem 2026 | yeni **Cumartesi** bilet kalemleri toplu oluşturulmuş |
| 14 Tem 2026 | Cumartesi biletine satın alma kuralı eklenmiş |

Pazar kalemleri sistemde duruyor (`active=false`, `v=97`) ama bu iptal edilmiş
günden kalan ölü stok — açılmayı bekleyen kontenjan değil. Gerçekçi senaryo
Cumartesi'nin `v` değerinin sıfırın üstüne çıkması.

Yine de Pazar aktifleşirse alarm veriliyor: bu ya günün geri açılması ya da eski
kaydın yanlışlıkla aktifleşmesi olabilir. Mail bu durumda konu satırında
`(Pazar ⚠︎)` gösteriyor ve gövdede teyit uyarısı çıkarıyor.

### Open / Pro ayrımı

vivenu bu ikisini ayrı anahtarlarda tutuyor ve shop'un Open/Pro filtresi de tam
bu alandan geliyor:

| UI yolu | anahtar | bilet adı |
| --- | --- | --- |
| Doubles → **Open** → Men | `DOUBLES_OPEN_M` | HYROX DOUBLES MEN |
| Doubles → **Pro** → Men | `DOUBLES_PRO_M` | HYROX PRO DOUBLES MEN |

Script tam eşitlik arıyor (substring değil), dolayısıyla Pro sızamaz. Üstüne
`assertClassSanity()` bir güvenlik ağı: `_OPEN_` izlenirken eşleşen bir biletin
adında `PRO` geçerse script durup uyarı maili atıyor.

## Kurulum

### 1. Repo

```bash
cd ~/Desktop/hyrox-izmir-watcher
git init -b main
git add -A
git commit -m "HYROX İzmir bilet gözcüsü"
gh repo create hyrox-izmir-watcher --private --source=. --push
```

### 2. Resend

Resend panelinden bir API anahtarı oluştur (**Sending access** yetkisi yeter).

Gönderici adresi:

- Resend'de doğrulanmış bir alan adın varsa onu kullan.
- Yoksa varsayılan `onboarding@resend.dev` çalışır — ama **sadece Resend
  hesabının kendi e-posta adresine** gönderim yapabilir. Alıcı adresin
  Resend hesabınla aynıysa sorun yok.

### 3. Secrets ve variables

Anahtarı buraya değil, doğrudan GitHub'a gir:

```bash
gh secret set RESEND_API_KEY
gh secret set MAIL_TO
```

İsteğe bağlı ayarlar (`Settings → Secrets and variables → Actions → Variables`):

| değişken | varsayılan | açıklama |
| --- | --- | --- |
| `MAIL_FROM` | `HYROX Watcher <onboarding@resend.dev>` | gönderici |
| `WATCH_KEYS` | `DOUBLES_OPEN_M` | virgülle çoklu kategori |
| `REALERT_MINUTES` | `30` | bilet açıkken hatırlatma sıklığı |
| `HEARTBEAT_HOURS` | `0` (kapalı) | "hâlâ izliyorum" maili |

### 4. Test

```bash
gh workflow run "HYROX İzmir bilet kontrolü"
```

Mail yolunu gerçekten denemek için geçici olarak `WATCH_KEYS`'i şu an stoklu bir
kategoriye çevir — `DOUBLES_OPEN_W` (kalan 6) iş görür. Mail geldiğini gördükten
sonra `DOUBLES_OPEN_M`'e geri al.

## Yerelde çalıştırma

```bash
RESEND_API_KEY=... MAIL_TO=... node check.mjs
```

Anahtarlar olmadan da koşar; mail atmak yerine durumu ekrana basar.

## Dayanıklılık notları

- **Sessiz bozulma en büyük risk.** Sayfa yapısı değişir veya kategori anahtarı
  kaybolursa script "bilet yok" demiyor — hata verip uyarı maili atıyor
  (`ERROR_ALERT_HOURS`, varsayılan 6 saatte bir).
- `v` alanı beklenmedik şekilde kaybolursa bilet **açık** sayılır. Kaçırmaktansa
  yanlış alarm tercih edildi.
- GitHub, 60 gün commit görmeyen repolarda zamanlanmış workflow'ları durduruyor.
  `state.json` her değişimde commit'lendiği için sayaç sürekli sıfırlanıyor.
- Cron yoğunlukta gecikebilir. Yedek olarak
  [etkinlik sayfasındaki](https://hyrox.com/event/hyrox-izmir/) resmi
  "Notification List"e de kaydol.
