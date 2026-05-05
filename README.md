# CosmicSymphony — OSCQuery Hub

Sahnedeki tüm OSC cihazlarını (LeapMotion, Spektra tabletler, VR, Ring, WebInstrument vb.) tek bir merkezi Node.js hub üzerinden Ableton Live'a bağlayan sistem.

Eski Max/MSP Standalone Manager'ın yerini alır.

→ [Görsel teknik anlatım](https://mehmetunal-studio.github.io/CosmicSymphony-OscQueryHub/docs/visual-overview.html)

---

## Mimari

```
                   ┌─────────────────────────────────────┐
                   │           Node.js Hub               │
[OSCQuery cihaz]──►│  • OSCQuery client (HTTP+WS)        │──UDP──►[Ableton M4L]
[Klasik OSC]   ───►│  • UDP OSC listener        :5006    │       (port 10000)
[Max dict.JSON]───►│  • JSON UDP listener       :5007    │
[TouchOSC]     ───►│  • Bonjour/mDNS discovery           │◄──UDP──[M4L feedback]
                   │  • WebSocket broadcast              │       (port 8889)
                   │  • Web kontrol paneli      :5555    │
                   └─────────────────────────────────────┘
                                    ▲
                                    │ tarayıcı / iPad
                                    │ http://localhost:5555/ui/
```

- **Hub:** Bu repo — Node.js + TypeScript
- **Ses:** Ableton Live + Max for Live ("Cosmic Unity" cihazı)
- **Görsel:** TouchDesigner
- **Kontrol:** TouchOSC (iPad), web tarayıcı

---

## Son Yenilikler

### Hub backend
- **JSON UDP listener (port 5007)** — Max'ten `dict.serialize` → `udpsend 127.0.0.1 5007` ile JSON nesnesi yollayabilirsin. `_device` alanı kart eşleştirmesini yapar; diğer key'ler otomatik namespace'e yazılır
- **`permanent` flag** — Manifest'te `"permanent": true` olan cihazlar (Tablet1-3, TV, VR, Ring, LeapMotion) durumdan bağımsız olarak panelde sabit kalır
- **Bug fix'ler** — NaN guard'ı, WebSocket `error` cleanup, manifest silindiğinde `deviceMsgCount` temizliği, eksik `Parameter` alanları
- **Test cihazı emülatörü** — `npm run test-device` ile mock OSCQuery cihazı çalıştırılabilir

### Web arayüzü
- **Tam İngilizce arayüz** — sahne kullanımı için locale tutarlı (`<html lang="en">`)
- **Modern tipografi** — Inter (sans) + JetBrains Mono (mono), `tabular-nums` sayısal kolonlar
- **Aydınlatılmış offline kartlar** — eski `opacity: 0.45` gizliydi; artık metinler okunaklı, OFFLINE rozeti kırmızı, Enable butonu cyan tıklanabilir
- **Generatif arka plan** — `algo-art.js` ambient flow-field + mouse halo; `prefers-reduced-motion` saygılı, tab arka plana düşünce duruyor

### Geliştirme süreci
- **AI destekli code review** — Husky pre-commit/pre-push hook'ları her staged diff'i Anthropic API ile inceler (aşağıda detay)

---

## Kurulum

### Gereksinimler

- [Node.js](https://nodejs.org) v18 veya üzeri
- Terminal (macOS: Terminal.app veya iTerm)
- `ANTHROPIC_API_KEY` (opsiyonel — sadece AI review hook'larını kullanmak istiyorsan)

### Adımlar

```bash
# 1. Repoyu klonla
git clone https://github.com/MehmetUnal-Studio/CosmicSymphony-OscQueryHub.git
cd CosmicSymphony-OscQueryHub

# 2. Bağımlılıkları kur
npm install

# 3. Çalıştır
npm run dev
```

Tarayıcıda aç:
```
http://localhost:5555/ui/
```

---

## Çalıştırma

```bash
# Geliştirme modu (dosya değişince otomatik yeniler)
npm run dev

# Sadece çalıştır (izlemeden)
npm start

# Mock OSCQuery cihazı (test için)
npm run test-device
```

Durdurmak için: `Ctrl + C`

---

## Portlar

| Port  | Protokol | Ne için |
|-------|----------|---------|
| 5555  | TCP      | Web arayüzü + WebSocket |
| 5006  | UDP      | Klasik OSC dinleme |
| 5007  | UDP      | JSON UDP listener (Max `dict.serialize` kanalı) |
| 10000 | UDP      | Ableton M4L `udpreceive` (hub buraya gönderir) |
| 8889  | UDP      | M4L → Hub geri kanal (feedback) |

---

## Cihaz Ekleme

Her cihaz `manifests/` klasöründe bir JSON dosyasıyla tanımlanır.

### Manuel ekleme

```json
{
  "id": 3,
  "name": "Tablet3",
  "type": "spectra-tablet",
  "host": "192.168.1.103",
  "oscQueryPort": 9010,
  "enabled": true,
  "permanent": true,
  "description": "Spektra tablet 3"
}
```

| Alan | Açıklama |
|------|----------|
| `id` | Cihaz ID'si (Ableton'a `device<id>` olarak yansır) |
| `name` | OSC namespace prefix'i (`/Tablet3/...`) |
| `type` | Görsel etiket (UI'da subtitle olarak görünür) |
| `host`, `oscQueryPort` | OSCQuery server'ın yeri |
| `enabled` | Hub bağlanmaya çalışır mı? |
| `permanent` | `true` ise UI'da daima görünür (offline da olsa) |
| `description` | İnsan-okunaklı not |

Sunucuyu yeniden başlatmana gerek yok — manifest değişikliklerini canlı algılar.

### Otomatik keşif (Bonjour/mDNS)

Ağda `_oscjson._tcp` yayınlayan cihazlar otomatik tespit edilir. Web arayüzünde **"Discovered Devices"** bölümünde görünür, **+ Add** butonuyla sisteme katılır. ID otomatik atanır (10, 11, ...).

---

## Max → Hub İletişimi (3 Yol)

### 1. Klasik OSC — port 5006
En basit yöntem. Veri kör UDP olarak gönderilir, hub yorumlar.

```
[flonum]
|
[prepend /tablet3/slider]
|
[udpsend 127.0.0.1 5006]
```

### 2. JSON UDP — port 5007
Max dict'ini tek pakette gönder. `_device` alanı eşleştirme yapar.

```
[dict mydict]
|
[dict.serialize]
|
[udpsend 127.0.0.1 5007]
```

Format:
```json
{ "_device": "tablet3", "x": 0.5, "y": 0.7, "pressure": 0.92 }
```

### 3. Tam OSCQuery server (Max içinde)
Cihaz olarak hub tarafında "connected" görünmek istiyorsan: `oscquery-max` paketi (Çağatay Güçlü, defektu) ile Max içinde gerçek OSCQuery server aç. Hub HTTP'den namespace'i okur, WebSocket'tan canlı değer alır, kart UI'da Params sayısı + Connected status gösterir.

```
[node.script oscquery.server.js http_port=9010 service_name=tablet3]
```

---

## Ableton M4L Bağlantısı

Hub her cihazdan gelen parametreleri şu formatta Ableton'a iletir:

```
device9 /HandR0/palm/Tx 0.5
```

- `device9` → Cihaz ID'si (Max'teki `route` nesnesi bunu filtreler)
- `/HandR0/palm/Tx` → Parametre yolu
- `0.5` → Değer

M4L patch'te `udpreceive 10000` ile dinlenir, `sprintf "device%ld"` + `route` ile cihaz ayrıştırılır.

### Geri kanal (M4L → Hub)

M4L, hub'a port **8889**'dan mesaj gönderebilir. Web arayüzünde her cihaz kartında `◄ M4L` göstergesi yanıp söner.

M4L patch'te: `udpsend localhost 8889`

---

## AI Destekli Geliştirme

Bu proje "human + AI pair-programming" pattern'iyle geliştiriliyor. AI rolünün üç katmanı var:

### Katman 1 — `CLAUDE.md`: Kalıcı bağlam
Repo kökündeki [CLAUDE.md](CLAUDE.md), AI'ya projenin amacını, mimarisini, namespace konvansiyonunu ve geliştirme kurallarını anlatır. AI her oturumda bunu okuyup kararlarını ona göre verir — örneğin yeni cihaz tipi eklerken neden manifest formatına uyduğunu, log'ların neden `logs/` klasörüne tarih damgalı yazıldığını bilir.

### Katman 2 — Pre-commit AI review
`.husky/pre-commit` hook'u her commit'ten önce çalışır:

```
npx lint-staged              # prettier formatting
node scripts/validate-staged.js   # AI review of staged diff
```

`scripts/validate-staged.js`, sadece **staged diff'i** Anthropic Claude API'sine gönderir. AI şu kuralları kontrol eder ([.ai-rules.json](.ai-rules.json)):

- Güvenlik açıkları (XSS, SQL injection, command injection, path traversal)
- Memory leak riski (Map/Set'e ekleme var ama silme yok mu?)
- NaN/null/undefined kontrol eksikleri
- Race condition kalıpları
- WebSocket cleanup'ı (close + error handler)

Bulgular doğrudan terminale basılır. Kritik bir hata varsa commit reddedilir; küçük öneriler bilgi olarak geçer ve sen geçirip geçirmemeyi seçersin.

**Önemli:** Hook sadece diff'i okur, codebase'in tamamını değil — token maliyeti küçük kalır, yanıt 5–15s'de döner.

### Katman 3 — Pre-push AI review
`.husky/pre-push` hook'u repository'ye gönderilmemiş commit yığınını topluca gözden geçirir:

```
node scripts/validate-push.js
```

Daha derin analiz yapar — birden fazla commit'in birlikte tutarlı olup olmadığını, geriye dönük uyumluluk kırılıp kırılmadığını sorgular. Sonuç anlık olarak terminalde özetlenir, push akışı bekletilir.

### Cache mekanizması
[scripts/cache-utils.js](scripts/cache-utils.js) — aynı diff hash'i için aynı cevabı tekrar üretmemek için yerelde `.ai-review-cache.json` dosyası tutulur (gitignore'da, sadece local). Format/whitespace değişikliği zaten lint-staged tarafından normalize edildiği için cache hit oranı yüksek.

### AI'yi devre dışı bırakma
Hook'lar `ANTHROPIC_API_KEY` environment değişkenini ister. Set edilmemişse hook fail eder. Bu durumlarda:

```bash
git commit --no-verify   # tek seferlik bypass
git push   --no-verify   # push hook'unu atla
```

Veya başka bir editör/oturum için API key'i `.env`'e koy (gitignore'da):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Sürecin pratiği
Tipik bir geliştirme döngüsü:

1. Sen Claude Code (terminal) veya Claude Desktop ile bir oturum açıyorsun
2. AI `CLAUDE.md` + ilgili dosyaları okuyor, plan yapıyor, kod yazıyor
3. Kod editöründe değişikliği inceliyor + test ediyorsun
4. `git commit` → pre-commit hook AI review'ı çalıştırıyor (ikinci AI gözü)
5. `git push` → pre-push hook daha derin tarama yapıyor
6. Değişiklik canlıya çıkıyor

Pratikte iki farklı AI rolü var: birinci AI (oturumda) **üretici**, ikinci AI (hook'larda) **denetleyici**. Üretici AI'nın yanlışını denetleyici AI yakalayabiliyor; insan zaten döngünün ortasında.

---

## Klasör Yapısı

```
oscquery-hub/
├── src/
│   ├── index.ts              ← Hub'ın beyni (HTTP/WS/UDP/JSON UDP/Bonjour)
│   ├── oscquery-client.ts    ← Cihazlara bağlanan OSCQuery client
│   └── test-device.ts        ← Mock cihaz emülatörü (npm run test-device)
├── manifests/                ← Cihaz tanımları (JSON)
├── web/
│   ├── index.html            ← Web kontrol paneli
│   ├── algo-art.js           ← Generatif ambient arka plan (drop-in)
│   └── test-device.html      ← Test cihazı için companion sayfa
├── scripts/                  ← AI review araçları
│   ├── ai-review.js              ← Anthropic API çağrısı + prompt'lar
│   ├── validate-staged.js        ← Pre-commit hook entry
│   ├── validate-push.js          ← Pre-push hook entry
│   ├── diff-utils.js             ← Git diff parse helper'ları
│   ├── cache-utils.js            ← Yerel review cache
│   └── output-utils.js           ← Terminal renkli çıktı
├── .husky/                   ← Git hook'ları
│   ├── pre-commit
│   └── pre-push
├── .ai-rules.json            ← AI review için kural seti
├── .prettierrc               ← Formatter config
├── docs/                     ← Teknik belgeler
└── CLAUDE.md                 ← AI bağlam dosyası (kalıcı project memory)
```

---

## Sorun Giderme

**Hub başlamıyor — port meşgul hatası**
```bash
# 5555 portunu tutan süreci bul ve öldür
lsof -ti TCP:5555 | xargs kill -9
```

**Cihaz görünmüyor**
- `manifests/` dosyasında `"enabled": true` olduğunu kontrol et
- Host IP adresinin doğru olduğunu kontrol et (`ping 192.168.1.xxx`)
- Cihaz ile hub'ın aynı ağda olduğundan emin ol
- `permanent: true` ise yine de görünür ama "OFFLINE" badge'i ile

**Ableton'a veri gitmiyor**
- M4L device'ta `udpreceive 10000` açık olmalı
- `sudo tcpdump -i lo0 -n udp port 10000` ile trafiği kontrol et

**JSON UDP'den gelen veri kart sayacını artırmıyor**
- JSON içinde `"_device": "<manifest_name>"` alanı doğru mu?
- Cihaz manifest'inin `name` alanıyla birebir eşleşmeli (büyük/küçük harf duyarlı)

**Pre-commit hook fail ediyor**
- `ANTHROPIC_API_KEY` environment'ta set mi? `echo $ANTHROPIC_API_KEY`
- Geçici geç: `git commit --no-verify`
- Hook'u tamamen kapat: `.husky/pre-commit` içeriğini boşalt veya dosyayı sil

---

## Geliştirme

```bash
# Değişiklik
git add .
git commit -m "ne yaptığını kısaca açıkla"   # → AI review tetiklenir
git push                                       # → AI deeper review tetiklenir

# Güncel kodu çek
git pull
```

API key'in yoksa hook'ları `--no-verify` ile geç (sadece kendi oturumunda).
