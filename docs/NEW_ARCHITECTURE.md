# Yeni Sistem: OSCQuery Hub

> Bu belge, eski Max-tabanlı Manager'ın yerini alan **Node.js OSCQuery Hub** sisteminin detaylı mimari belgesidir. Geliştirici arkadaşların sisteme katkı yapabilmesi için adım adım her şey açıklanmıştır.

---

## 1. Tek Cümleyle

**Cihazlardan gelen OSC verisini toplayıp Ableton'a yönlendiren, AI ile sürekli geliştirilebilir, web tabanlı yönetim arayüzü olan bir Node.js servisi.**

---

## 2. Üst Düzey Mimari

```
┌────────────────────────────────────────────────────────────────┐
│  AI MAINTENANCE LOOP (Claude / Cursor / GPT)                    │
│  Repo'yu okur, kod yazar, manifest günceller, test ekler        │
└─────────────────────────────┬──────────────────────────────────┘
                              │ Git
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  GIT REPOSITORY (~/Documents/oscquery-hub)                      │
│  • src/index.ts             — Hub'ın beyni                      │
│  • src/oscquery-client.ts   — Cihazlara bağlanan client         │
│  • manifests/*.json (9)     — Cihaz envanteri                   │
│  • web/index.html           — Yönetim arayüzü                   │
│  • CLAUDE.md                — AI bağlam dosyası                  │
└─────────────────────────────┬──────────────────────────────────┘
                              │ npm run dev
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  NODE.JS HUB (Localhost'ta çalışan servis)                      │
│                                                                   │
│  • OSCQuery client × N      → cihazlara HTTP+WS bağlanır         │
│  • Binary OSC parser        → TouchDesigner formatını okur       │
│  • Manifest yöneticisi      → JSON'lardan cihaz tanım            │
│  • Web sunucu               → tarayıcı arayüzü servis eder       │
│  • Ableton Forwarder        → /Ableton/<id>/<param> ↦ UDP 10000  │
│  • Reconnect logic          → cihaz düşerse otomatik yenile      │
└────────┬──────────────────────────────────────────┬────────────┘
         │                                           │
         │ OSCQuery                                  │ UDP 10000
         │ (HTTP + WebSocket)                        │
         ▼                                           ▼
┌─────────────────────┐                  ┌────────────────────────┐
│  CİHAZLAR           │                  │  ABLETON LIVE          │
│  • LeapMotion ✅     │                  │  ┌──────────────────┐  │
│  • Tablet 1-3        │                  │  │ Cosmic Unity M4L │  │
│  • TV, VR, Ring      │                  │  │ (mevcut, değişmedi)│ │
└─────────────────────┘                  │  └────────┬─────────┘  │
                                          │           │            │
                                          │           ▼            │
                                          │       SES ÇIKIŞI 🎵   │
                                          └────────────────────────┘
```

---

## 3. Bileşenler — Detaylı

### 3.1 Hub (`src/index.ts`)

Sistemin **kalbi**. Bir Node.js süreci olarak çalışır. Görevleri:

| Görev | Açıklama |
|-------|----------|
| **Manifest yükleyici** | `manifests/*.json` dosyalarını okur, cihaz listesini hafızaya alır. Klasörü canlı izler — dosya değişirse otomatik yeniden yükler. |
| **OSC dinleyici** | UDP port 5006'da OSC paketleri dinler. Klasik OSC göndericileri (Max patch, vb.) için. |
| **OSCQuery sunucu** | HTTP + WebSocket sunucusu (port 5555). Kendi namespace'imizi başkalarının erişebilmesi için yayınlıyor. |
| **OSCQuery client'ları** | Manifest'teki her aktif cihaz için bir `OscQueryClient` instance'ı oluşturup yönetiyor. |
| **Bonjour duyurusu** | Kendini ağa "OSCQuery Hub" diye duyuruyor (`_oscjson._tcp` ve `_osc._udp`). |
| **Web sunucu** | `web/` klasörünü `/ui` altında servis ediyor. Yönetim arayüzü buradan açılıyor. |
| **WebSocket bridge** | Tarayıcılarla canlı iletişim için. Tüm parametre değişiklikleri tarayıcılara push'lanıyor. |
| **Ableton Forwarder** | Bir cihazdan veri geldiğinde, ID etiketleyip UDP 10000'e gönderiyor. |

**Sürekli çalışan bir süreç.** Geliştirme modunda `tsx watch` ile çalıştırılır — kod değişikliğinde otomatik yeniden başlar.

### 3.2 OSCQuery Client (`src/oscquery-client.ts`)

Bir cihaza bağlanan **client** mantığı. Her cihaz için bir instance oluşturuluyor.

```typescript
const client = new OscQueryClient(host, port, {
  onConnect: () => { /* bağlandı */ },
  onDisconnect: (reason) => { /* koptu */ },
  onValue: (path, value) => { /* yeni değer geldi */ },
  onLog: (msg) => { /* log mesajı */ }
});

client.connect();
```

İçinde şunlar var:

1. **HTTP namespace çekme**
   - `GET http://host:port/` → JSON namespace alınır
   - Tüm path'lerin listesi çıkarılır (örn. `/HandR0/palm/Tx`)
2. **WebSocket bağlanma**
   - `ws://host:port/` üzerinden açılır
   - Her path için `{"COMMAND":"LISTEN","DATA":"/path"}` gönderilir
3. **Mesaj dinleme**
   - Cihaz binary OSC veya JSON yollayabilir
   - **Binary OSC parsing** burada kritik: TouchDesigner ham OSC paketleri yolluyor
   - Bundle'ları (birden çok mesaj tek pakette) recursive olarak işler
4. **Otomatik reconnect**
   - Bağlantı koparsa 3 saniye sonra tekrar dener

### 3.3 Manifest Sistemi (`manifests/*.json`)

Her cihaz **tek bir JSON dosyası**:

```json
{
  "id": 9,
  "name": "LeapMotion",
  "type": "hand-tracker",
  "host": "192.168.1.152",
  "oscQueryPort": 9012,
  "enabled": true,
  "description": "El takip sensörü"
}
```

| Alan | Açıklama |
|------|----------|
| `id` | Ableton'a yollarken `/Ableton/<id>/...` formatında kullanılır. M4L device bu ID'yi filtre olarak kullanıyor. |
| `name` | Görüntü amaçlı, web arayüzünde görünür |
| `type` | Cihaz kategorisi (`spectra-tablet`, `vr-headset`, `hand-tracker`, vb.) — gelecekte tip-spesifik mantık için |
| `host` | Cihazın IP adresi |
| `oscQueryPort` | Cihazın OSCQuery sunucusunun portu |
| `enabled` | `false` ise hub bağlanmaya çalışmaz |
| `description` | Yorum / açıklama, sadece insan için |

**Manifest sistemi = AI ile geliştirilebilirlik anahtarı.** AI bu dosyaları okuyup yazabiliyor, bağlam tek bakışta elde edilebiliyor.

### 3.4 Web Arayüzü (`web/index.html`)

Vanilla HTML/CSS/JS (framework yok). Tek dosya. Şunları yapar:

- **Ağdaki tüm cihazları** kart olarak gösterir
- Her kartta:
  - Cihaz adı, tip, ID
  - IP / port (tıklayıp **canlı düzenlenebilir**)
  - Bağlantı durumu (`connected`, `connecting`, `lost`, `disabled`)
  - Mesaj sayacı
  - Enable/Disable butonu
  - Reconnect butonu
- **Canlı parametre listesi** (alt kısımda)
- **İstatistikler** (toplam cihaz, aktif, bağlı, parametre, msg/saniye)
- **Ableton mesaj sayacı** (kaç mesaj forward edildi)

WebSocket üzerinden hub'a bağlı, her değişiklik anında yansır.

---

## 4. Veri Akışı — Adım Adım

### Senaryo: LeapMotion'dan el hareketi → Ableton'da ses

#### Adım 1: Hub başlatılır
```bash
cd ~/Documents/oscquery-hub
npm run dev
```

Hub:
1. `manifests/` klasörünü okur
2. `enabled: true` olan cihazlar için `OscQueryClient` oluşturur
3. Her client cihazına bağlanmaya başlar (ayrı thread olmadan, async olarak)
4. HTTP server'ı 5555'te başlatır
5. UDP 5006'yı dinlemeye başlar
6. Bonjour ile kendini duyurur

#### Adım 2: LeapMotion ile bağlantı kurulur

```
Hub: HTTP GET http://192.168.1.152:9012/
LeapMotion: → JSON namespace döner (31 parametre)

Hub: WebSocket aç → ws://192.168.1.152:9012/
LeapMotion: → bağlantı açıldı

Hub: 31 path için LISTEN gönder
   {"COMMAND":"LISTEN","DATA":"/HandR0/palm/Tx"}
   {"COMMAND":"LISTEN","DATA":"/HandR0/palm/Ty"}
   ...

LeapMotion: → kabul etti, artık değişiklikleri push'layacak
```

#### Adım 3: Kullanıcı el hareketi yapar

LeapMotion sensörü el verisini OSC paketi olarak hazırlar:
```
/HandR0/palm/Tx 0.137
/HandR0/palm/Ty -0.357
/HandR0/palm/Tz 0.103
... (60 fps oranında)
```

Bunları **binary OSC paketi** olarak WebSocket üzerinden hub'a yollar.

#### Adım 4: Hub mesajı işler

```typescript
// oscquery-client.ts
ws.on('message', (raw, isBinary) => {
  if (isBinary || looksLikeOscPacket(buf)) {
    const packet = osc.readPacket(buf);
    // packet.address = "/HandR0/palm/Tx"
    // packet.args = [{type: 'f', value: 0.137}]
    events.onValue(packet.address, 0.137);
  }
});
```

`onValue` callback'i `index.ts`'te tanımlı:

```typescript
function handleClientValue(dev, path, value) {
  // 1. Hub'ın kendi namespace'ine kaydet
  namespace.set(`/${dev.name}${path}`, { ... });

  // 2. Tarayıcılara WebSocket ile push'la
  broadcastToClients({ type: 'PATH_CHANGED', ... });

  // 3. Ableton'a UDP ile forward et
  if (dev.enabled) {
    const paramName = path.replace(/^\//, '').replace(/\//g, '_');
    forwardToAbleton(dev.id, paramName, value, type);
    // → /Ableton/9/HandR0_palm_Tx 0.137
  }
}
```

#### Adım 5: Ableton tarafı

M4L device:
- `udpreceive 10000` ile mesajı alır
- `route /Ableton/9` ile sadece kendine ait olanları geçirir
- `route /HandR0/palm/Tx /HandR0/palm/Ty ...` ile parametreleri ayrıştırır
- Her parametreyi MPE synth'ine route eder
- **Synth ses üretir**

#### Adım 6: Tarayıcı arayüzü

Aynı anda kullanıcının tarayıcısı (eğer açıksa):
- WebSocket'ten `PATH_CHANGED` mesajı alır
- İlgili parametreyi listede günceller
- Cihaz kartında **flash** efekti yapar
- Mesaj sayacını arttırır

**Tüm bu adımlar ~5ms içinde gerçekleşir.**

---

## 5. AI ile Nasıl Geliştirilir

Bu sistemin **asıl gücü** burada. Geliştirici akışı:

### 5.1 Repo'yu AI'a sun

Yeni bir AI oturumunda:
- `CLAUDE.md` dosyasını ya da `PROJECT_STATE.md`'yi yapıştır
- AI sistemi 30 saniyede tanır

### 5.2 Yeni özellik eklemek

**Örnek: "Cihaz 5 saniye sessiz kalırsa 'lost' işaretle ve panic gönder"**

Sen yazarsın:
> Hub'a heartbeat mantığı ekle. Her cihaz için son mesaj zamanı takip edilsin. 5 saniye sessizlik = `status: 'lost'` ve UDP `/panic 1` mesajı yolla.

AI:
1. `src/index.ts`'te `setInterval` ekler
2. `lastMessageAt` field'ı kullanıp kontrol yazar
3. `forwardToAbleton(id, 'panic', 1, 'i')` çağrısı ekler
4. Web arayüzünü günceller (kartlar `lost` durumunda kırmızı yansın)

Sen `git diff` ile bakar, `npm run dev`'in otomatik yenilemesini izlersin. Çalışırsa commit:
```bash
git add . && git commit -m "Heartbeat: cihaz sessiz kalırsa panic gönder"
```

**Toplam süre: 5-10 dakika.**

### 5.3 Bug fix

**Örnek: "TouchDesigner'dan gelen bazı parametreler tipsiz görünüyor"**

Sen:
> Web arayüzünde bazı parametreler `?` tipinde görünüyor. Hangi adresler tipsiz geliyor, terminale logla.

AI:
1. `oscquery-client.ts`'te debug log ekler
2. Sen birkaç dakika izlersin
3. Terminale yapıştırırsın AI'a
4. AI tanı koyar — örn. "TouchDesigner array tipi `T,T,T` yolluyor, bizim parser sadece tek değer bekliyor"
5. Düzeltme yazar

### 5.4 Yeni cihaz tipi

**Örnek: "Yeni bir SoundFlow cihazı eklenecek"**

Sen:
> `manifests/soundflow.json` dosyası oluştur. ID 10, host 192.168.1.180, port 9020, type "audio-trigger".

AI dosyayı yazar, hub `manifests/` watcher'ı sayesinde **anında yükler**, web arayüzünde belirir. **Hiç restart gerekmez.**

### 5.5 Refactor

Sistem büyüdükçe AI'a:
> `src/index.ts` çok büyüdü. Manifest yönetimini ayrı bir dosyaya taşı.

AI:
1. `src/manifest-manager.ts` oluşturur
2. İlgili kodu taşır
3. `src/index.ts`'ten import eder
4. Test edilebilir hale gelir

---

## 6. Geliştirici Rehberi — Sıfırdan Başlama

### 6.1 Gereksinimler

- macOS, Windows veya Linux
- Node.js 18+ (kontrol: `node --version`)
- Git
- Bir terminal
- Bir kod editörü (VS Code, Cursor önerilir — AI entegrasyonu için)

### 6.2 Repo'yu al

```bash
cd ~/Documents
git clone <repo_url> oscquery-hub  # eğer GitHub'daysa
cd oscquery-hub
```

(Şu an repo lokalde, GitHub'a yüklenmedi — yüklendiğinde URL eklenecek.)

### 6.3 Bağımlılıklar

```bash
npm install
```

Bu, `package.json`'daki tüm bağımlılıkları kurar:
- `osc` — OSC mesaj parsing
- `express` — HTTP server
- `ws` — WebSocket
- `bonjour-service` — mDNS (Bonjour) keşif
- `tsx` — TypeScript çalıştırma (dev mode)

### 6.4 Çalıştır

```bash
npm run dev
```

Beklenen çıktı:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OSCQuery Hub — Aşama 8 (OSCQuery Client)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OSC dinleniyor:    UDP port 5006
  Ableton'a forward: UDP 127.0.0.1:10000
  HTTP server:       http://localhost:5555
  Web arayüz:        http://localhost:5555/ui/
  Bonjour adı:       OSCQuery Hub
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📋 Manifest yüklendi: 9 cihaz
  Bonjour duyuruldu  ✓
```

### 6.5 Web arayüz

Tarayıcıda aç: `http://localhost:5555/ui/`

Görmen gerekenler:
- Sağ üstte yeşil noktalı "BAĞLI" yazısı
- 9 cihaz kartı (manifest'ten yüklendi)
- Üstte Ableton Forwarder banner'ı
- Stats: cihaz sayısı, aktif, bağlı, parametre, msg/sn

### 6.6 İlk değişiklik

Bir cihazın IP'sini değiştir:
1. Tarayıcıda LeapMotion kartında `192.168.1.152` üstüne tıkla
2. `192.168.1.200` yaz, Enter'a bas
3. "✓ Kaydedildi" mesajını gör
4. Terminalde `cat manifests/leapmotion.json` ile doğrula

**Dosya gerçekten güncellendi.** Hub canlı yeniden bağlanmayı dener.

### 6.7 Kod değişikliği

`src/index.ts`'te bir mesaj değiştir, kaydet. Hub `tsx watch` sayesinde **otomatik yeniden başlar**, terminalde yeni log'u görürsün. Tarayıcıyı yenilediğinde değişiklik görünür.

### 6.8 Commit

```bash
git add .
git commit -m "Açıklayıcı bir mesaj"
```

**Her anlamlı değişiklikten sonra commit at.** Bozulan bir şey olursa `git checkout` ile geri dönersin.

---

## 7. Mevcut Özellikler

### Tamamlandı ✅

- [x] OSC dinleyici (UDP 5006)
- [x] OSCQuery namespace sunumu (HTTP 5555)
- [x] WebSocket canlı veri akışı
- [x] Web kontrol paneli (vanilla JS)
- [x] İki yönlü iletişim (tarayıcı → cihaz SET)
- [x] Bonjour duyurusu + ağ keşfi
- [x] Manifest sistemi (JSON dosyaları, canlı yenileme)
- [x] OSCQuery client (cihazlara aktif bağlanma)
- [x] Binary OSC parser (TouchDesigner uyumu)
- [x] Ableton forwarder (`/Ableton/<id>/<param>` ↦ UDP 10000)
- [x] Otomatik reconnect (3 saniye)
- [x] IP/port düzenleme web arayüzünden

### Yapılacaklar ⏳

| Öncelik | Özellik | Tahmini süre |
|---------|---------|--------------|
| P1 | **Path format**: slash'ları koru (M4L route uyumu) | 30 dk |
| P1 | **Heartbeat & panic**: cihaz sessiz kalırsa uyarı | 1 saat |
| P2 | **Logging**: tarih damgalı log dosyaları | 1 saat |
| P2 | **Geri yön**: Ableton → Cihaz parametre yollama | 2 saat |
| P3 | **Recording / Replay**: OSC akışını kaydet, oynat | 3 saat |
| P3 | **Manifest doğrulama**: JSON şeması | 1 saat |
| P4 | **Hub'lar arası bridge**: birden çok hub | 4 saat |
| P4 | **Preset sistemi**: konfigürasyon snapshot'ları | 3 saat |

---

## 8. Sorun Giderme

### Hub başlamıyor

```bash
# Port çakışması mı?
lsof -i UDP:5006
lsof -i TCP:5555

# Bir şey portu tutuyorsa öldür
kill <PID>

# Bağımlılıklar eksik olabilir
rm -rf node_modules
npm install
```

### Cihaz bağlanmıyor

1. **Cihaz açık mı?** ICMP ile dene: `ping 192.168.1.152`
2. **OSCQuery server çalışıyor mu?** `curl http://192.168.1.152:9012/`
3. **Aynı ağda mıyız?** IP aralıkları uyumlu mu?
4. **Manifest doğru mu?** `cat manifests/<cihaz>.json`

### Ableton mesaj almıyor

1. M4L'deki `udpreceive` portu **10000** mi?
2. M4L'deki `device ID` doğru mu? (manifest'teki `id` ile aynı olmalı)
3. Hub gerçekten gönderiyor mu? `sudo tcpdump -i lo0 -n udp port 10000`
4. Track muted mi?

### Web arayüzü açılmıyor

1. Hub gerçekten 5555'i dinliyor mu? `lsof -i TCP:5555`
2. macOS firewall'u Node.js'e izin veriyor mu?
3. URL'de sondaki `/ui/` slash'ı var mı?

---

## 9. Mimari Kararlar (Why)

### Neden Node.js / TypeScript?

- **AI dostu**: Eğitim verilerinde devasa
- **Web stack ile aynı dil**: OSCQuery zaten HTTP+WS+JSON, doğal eşleşme
- **Hızlı iterasyon**: derleme yok, save → otomatik yeniden başlatma
- **Cross-platform**: Mac, Windows, Linux'ta aynı kod

### Neden Vanilla HTML/JS (React/Svelte yok)

- **Bağımlılık yok**: kurulum karmaşası yok
- **Build gerek yok**: HTML dosyası diskten servis ediliyor
- **AI yazması kolay**: tek dosyada her şey
- **Yeterli**: arayüz karmaşık değil

### Neden manifest dosyaları (veritabanı yok)

- **Git'lenebilir**: değişiklikler tarihçede
- **AI okunabilir**: JSON, AI doğrudan değiştirebilir
- **Düzenleme kolay**: text editor ile aç, değiştir
- **Yedekleme kolay**: dosya kopyala
- **9 cihaz için yeterli**: ölçek küçük

### Neden M4L'a dokunmadık

- Cosmic Unity zaten çalışıyor, müzisyenin alıştığı arayüz
- MPE synth, gesture mapping zaten ayarlı
- Riski azaltmak için: sadece **arka uçu** değiştir, **ön uç** aynı kalsın

### Neden Bonjour/mDNS

- **Manuel IP girişi yok**: cihazlar kendini duyurur
- **Standart**: Apple, TouchDesigner, vb. zaten kullanıyor
- **Hub'lar arası ileride bridge**: aynı protokolle çoklu hub mümkün

---

## 10. Eski Sistem ile Karşılaştırma

| Konu | Eski (Max Manager) | Yeni (Node.js Hub) |
|------|-------------------|---------------------|
| **Dil** | Görsel patch | TypeScript |
| **Cihaz tanım** | Patch içinde gömülü | `manifests/*.json` |
| **Yeni cihaz ekleme** | 30-60 dk patch düzenlemesi | 30 saniye, JSON yaz |
| **AI ile geliştirme** | Mümkün değil | Doğal akış |
| **Versiyon kontrolü** | Binary patch (.maxpat) | Git diff/merge |
| **Bağımlılık** | Max for Live lisansı | Sıfır lisans (Node.js açık) |
| **Logging** | Console (uçucu) | Dosya (kalıcı) |
| **Uzaktan yönetim** | Yok | Web arayüzü |
| **Çoklu kullanıcı** | İmkansız | Birden çok tarayıcı eş zamanlı |
| **Test edilebilirlik** | Zor | Unit test mümkün |
| **Cross-platform** | Mac (Max sınırlı) | Mac/Win/Linux |
| **Deploy** | Manuel kopyalama | `git pull && npm install` |
| **Dokümantasyon** | Patch ekran görüntüleri | Markdown + kod yorumları |

---

## 11. Felsefe

> **Eski sistem insan-merkezli, yeni sistem AI-insan ortaklığı için tasarlandı.**

İki temel ilke:

1. **Her şey metin olmalı.** AI'ın okuyabileceği, yazabileceği formatlar: `.ts`, `.json`, `.md`, `.html`. Görsel patch yok.

2. **Sürdürülebilirlik > Hız.** Kısa vadede Max'te bir şey daha hızlı kurulur, ama 6 ay sonra **AI ile saniyeler içinde değişiklik yapabilmek** her şeyden değerli.

Bu projede AI sadece bir araç değil, **sürekli bir takım üyesi**. Geliştirici döngüsü:

```
Sen problemi söylersin → AI kodu yazar → Sen test edersin → Çalışırsa commit
```

Her adım dakikalarla ölçülür. Eski Max sistemde aynı döngü saatlerle ölçülüyordu.

---

## 12. Katkı Sağlama

### Yeni özellik için:

1. Yeni branch aç: `git checkout -b feature/heartbeat`
2. AI ile çalış, kodu yaz
3. Test et: `npm run dev`
4. Commit: `git commit -m "..."`
5. Main'e merge et veya pull request aç

### Bug fix için:

1. Issue olarak yaz (GitHub'da veya internal tracker'da)
2. Reproduce adımlarını net yaz
3. Console output yapıştır
4. AI ile birlikte tanı koy
5. Düzelt, test et, commit at

### Belgelendirme için:

- `CLAUDE.md` ve bu belge **canlı tutulmalı** — yeni özellik eklendiğinde güncellenmeli
- Kod yorumları **niye** yapıldığını anlatmalı, **ne** yapıldığını anlatmamalı (kod zaten anlatıyor)

---

## 13. İletişim

Bu proje hakkında sorular, geliştirme önerileri veya problemler için: [iletişim bilgileri buraya]

---

*Bu belge AI ile birlikte hazırlandı. Sürekli güncellenmeye devam edecek.*
