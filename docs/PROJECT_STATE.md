# OSCQuery Hub — Proje Durumu

> Bu dosya, projenin mevcut durumunu ve gelecek AI oturumları için bağlamı içerir.
> Son güncelleme: 2 Mayıs 2026 (2. oturum)

---

## TEK CÜMLEYLE NE YAPIYORUZ

Sahnedeki/stüdyodaki tüm OSC cihazlarını (Spektra tabletler, LeapMotion, VR, Ring, TV, vb.) merkezi bir **Node.js hub** üzerinden yöneten, eski Max-tabanlı **Standalone Manager**'ın yerini alan, **AI ile sürekli geliştirilebilir** bir sistem inşa ediyoruz.

---

## SİSTEMİN ÇALIŞMA PRENSİBİ

```
[Cihazlar (LeapMotion, Tabletler, vs.)]
            │
            │ OSCQuery (HTTP+WebSocket, binary OSC)
            ▼
    [Node.js Hub @ localhost]
            │   ◄── Web arayüzü (http://localhost:5555/ui/)
            │   ◄── Manifest dosyaları (manifests/*.json)
            │   ◄── Bonjour mDNS keşif (yeni cihazları otomatik bulur)
            │
            │ UDP  device9 /HandR0/palm/Tx 0.5  ──► port 10000
            │ UDP  ◄ M4L geri kanal              ──  port 8889
            ▼
    [Ableton Live + M4L Device "Cosmic Unity"]
            │
            ▼
    [SES ÇIKIYOR ✅]
```

---

## REPO

**Konum:** `~/Documents/oscquery-hub/`
**GitHub:** Yok, sadece lokal git
**Çalıştırma:** `cd ~/Documents/oscquery-hub && npm run dev`

### Dosya yapısı
```
oscquery-hub/
├── src/
│   ├── index.ts              ← Hub'ın beyni (manifest, forwarder, web sunucu)
│   └── oscquery-client.ts    ← Cihazlara bağlanan client (binary OSC parser dahil)
├── manifests/
│   ├── tablet1.json … tablet4.json
│   ├── tv.json, vr.json, vr2.json, ring.json
│   ├── leapmotion.json       ← Şu an aktif (192.168.1.152:9012)
│   ├── maxoscquery_10.json   ← Bonjour ile keşfedildi (192.168.1.101:8000)
│   └── webinstrument_11.json ← Bonjour ile keşfedildi (192.168.1.152:9100)
├── web/index.html             ← Yönetim arayüzü (per-device param kartları)
├── docs/
│   ├── PROJECT_STATE.md       ← Bu dosya
│   └── ...
├── package.json, tsconfig.json
└── CLAUDE.md                  ← AI bağlam dosyası
```

### Önemli portlar
| Port | Protokol | Kullanım |
|------|----------|----------|
| 5006 | UDP | Hub'ın OSC dinleme portu |
| 5555 | TCP | Hub'ın HTTP+WebSocket portu (web arayüz) |
| 10000 | UDP | Ableton M4L `udpreceive` — Hub buraya forward eder |
| 8889 | UDP | M4L geri kanal (◄ M4L feedback) — **8888 Max tarafından tutuluyordu** |

---

## CİHAZ ENVANTERİ

| ID | İsim | Tip | Host | Aktif? |
|----|------|-----|------|--------|
| 1 | Tablet1 | spectra-tablet | 192.168.1.153:9010 | ✓ |
| 2 | Tablet2 | spectra-tablet | 192.168.1.102:9010 | ✓ |
| 3 | Tablet3 | spectra-tablet | 192.168.1.103:9010 | ✓ |
| 4 | Tablet4 | spectra-tablet | — | ✗ |
| 5 | TV | tv-display | — | ✗ |
| 6 | VR | vr-headset | — | ✗ |
| 7 | VR2 | vr-headset | — | ✗ |
| 8 | Ring | ring-controller | — | ✗ |
| 9 | LeapMotion | hand-tracker | 192.168.1.152:9012 | ✓ TEST EDİLDİ, ÇALIŞIYOR |
| 10 | maxoscquery_10 | keşfedildi | 192.168.1.101:8000 | Bonjour ile bulundu |
| 11 | webinstrument_11 | keşfedildi | 192.168.1.152:9100 | Bonjour ile bulundu |

Yeni keşfedilen cihazlar otomatik olarak bir sonraki ID'yi alır (10, 11, ...).

---

## NE BAŞARILDI

### ✅ Aşama 1-10 (önceki oturumdan)
- OSC dinleyici (UDP 5006)
- OSCQuery server (kendi namespace'imizi sunuyoruz, port 5555)
- WebSocket canlı veri akışı
- Web kontrol paneli (vanilla HTML/JS, tarayıcıda IP düzenleme)
- İki yönlü iletişim (tarayıcı → cihaz SET komutları)
- Bonjour ile ağ keşfi (kendimizi duyuruyoruz, başkalarını buluyoruz)
- Manifest sistemi (JSON dosyaları, canlı yenileme)
- **OSCQuery client** (cihazlara HTTP+WS ile aktif bağlanma)
- **Binary OSC parser** (TouchDesigner ham OSC paketleri yolluyor, JSON değil)
- **Ableton Forwarder** (`device{id} /param/path value` formatında UDP 10000'e gönderim)

### ✅ 2 Mayıs 2026 oturumunda tamamlananlar

#### 1. Ableton mesaj formatı düzeltildi
Eski (bozuk): `/Ableton/9//HandR0/palm/Tx 0.5`
Yeni (doğru): `device9 /HandR0/palm/Tx 0.5`

`osc` kütüphanesi baştaki `/` olmayan adresleri reddediyordu. Çözüm: `osc` kütüphanesi bypass edildi, `dgram` ile manuel binary OSC encoding yapıldı. Max `route device9` ile filtreliyor.

```
M4L patch route mantığı: sprintf "device%ld" → route device1 device2 ... device9
```

#### 2. Per-device param kartları (Web UI)
Her cihaz artık kendi kutucuğunda yaşıyor. Parametre listesi o kutucuk içinde görünüyor. Tek global veri akışı yerine her cihaz bağımsız kart.

#### 3. Bonjour keşif + otomatik ID
Ağda `_oscjson._tcp` duyuran yeni cihazlar otomatik tespit ediliyor, bir sonraki ID atanıyor, manifest oluşturuluyor. ID 10, 11, ... diye devam ediyor.

#### 4. M4L geri kanal (◄ M4L)
Hub port 8889'u dinliyor. M4L'dan gelen feedback mesajları UI'da yanıp sönen `◄ M4L` göstergesi ile görünüyor. Her cihaz kartında ayrı gösterge var.

**Dikkat:** M4L patch'teki `udpsend localhost 8888` → `udpsend localhost 8889` olarak değiştirilmeli (8888 eski Max Manager tarafından tutuluyordu).

---

## ESKİ SİSTEM (DEĞİŞTİRİLEN)

Önceden kullanıcı **Max'te yazılmış bir Standalone Manager** kullanıyordu (`CosmicInstrumentsManagerNOMEMORY`). Bu Manager:
- 9 cihaza ayrı ayrı bağlanıyordu
- Her cihazın `OSCQuery server`'ını dinliyordu
- Verileri toplayıp Ableton'daki M4L'a UDP ile yolluyordu
- Heartbeat, panic, autoreconnect mantığı vardı
- Kullanıcı **artık bu Max patch'ini kullanmayacak** — Node.js hub onun yerini aldı

**Önemli:** Ableton'daki M4L device (`Cosmic Unity` — MPE synth, gesture-mapped) **aynen kalıyor**. Sadece ona gelen mesajların kaynağı değişti.

---

## TEKNOLOJİ YIĞINI

- **Node.js + TypeScript** (`tsx watch` ile geliştirme, derleme yok)
- **Kütüphaneler:**
  - `osc` (OSC mesaj parsing — gelen paketler için)
  - `dgram` (ham UDP — Ableton'a gönderim için, osc bypass)
  - `express` (HTTP server)
  - `ws` (WebSocket)
  - `bonjour-service` (mDNS keşif)
- **Web arayüz:** Vanilla HTML/CSS/JS (framework yok)
- **Build:** Yok — `tsx` direkt TypeScript çalıştırıyor

---

## SIRADAKI POTANSİYEL ADIMLAR (ÖNCELİK SIRALI)

1. **M4L geri kanal testi** (P0) — `udpsend localhost 8889` yapılınca `◄ M4L` göstergesi yanmalı
2. **Heartbeat & Panic** (P1) — Cihaz 5sn sessiz → kırmızı kart, panic gönder, otomatik geri bağlan. Sahnede kritik.
3. **Logging** (P2) — `logs/` klasörüne tarih damgalı log dosyaları
4. **Recording / Replay** (P3) — OSC akışını dosyaya kaydet, sonra oynat (cihazlar yokken geliştirme için)
5. **GitHub'a yükleme** (kullanıcı şimdilik istemedi)

---

## ÇÖZÜLEN BÜYÜK PROBLEMLER

### 1. JUCE/CMake derlenemedi
- CMake 4.3.2 ile JUCE 8.0.4 uyumsuzdu
- Çözüm: CMake 3.31'e düşürdük, ama yine sorun çıktı
- Sonuç: **JUCE'tan vazgeçtik**, Node.js'e döndük (doğru karar)

### 2. AirPlay portu 5000'i tutuyordu
- macOS AirPlay Receiver port 5000'i kullanıyor
- Çözüm: Hub'ın HTTP portunu **5555**'e taşıdık

### 3. TouchDesigner JSON değil binary OSC yolluyor
- Bizim ilk parser sadece JSON bekliyordu
- Terminalde `f=w?` gibi bozuk karakterler ve "heartbeat zili" görüldü
- Tanı: Binary OSC paketleri null character içeriyordu
- Çözüm: `osc.readPacket()` ile binary parsing eklendi

### 4. Port uyuşmazlığı
- Hub UDP 8888'e gönderiyordu, M4L `udpreceive 10000` dinliyordu
- Çözüm: `ABLETON_PORT = 10000` yapıldı

### 5. osc kütüphanesi `/`-siz adresleri reddediyordu
- Max'in `route` nesnesi `device9` (slash yok) bekliyor
- `osc` kütüphanesi invalid OSC diyerek hata verdi
- Çözüm: `dgram` ile manuel binary OSC encoding — `encodeOscString` + `buildOscMessage` fonksiyonları

### 6. M4L geri kanal port çakışması
- Port 8888 Max Standalone Manager tarafından tutuluyordu (`lsof -i UDP:8888` → Max PID 3944)
- Çözüm: Hub 8889'u dinliyor, M4L patch'te `udpsend localhost 8889` yapılmalı

---

## KULLANICI HAKKINDA NOTLAR

- M4L'de profesyonel
- TypeScript/Node.js'te yeni
- Git'te yeni
- CMake/C++ tamamen yeni (öğrenmek istemiyor şu an)
- Türkçe konuşuyor
- Sahnede çalan bir müzisyen/ses sanatçısı
- Spektra tablet, LeapMotion gibi alternatif kontrolcülerle çalışıyor
- Çok hızlı öğreniyor — kavramları kapıyor, ama detayları sormaya cesareti var
- Eski sistemi sofistikeydi (CosmicInstrumentsManager), AI uyumlu değildi sadece

---

## ÇALIŞTIRMA / TEST

```bash
# Çalıştır
cd ~/Documents/oscquery-hub
npm run dev

# Tarayıcı
open http://localhost:5555/ui/

# Hub'tan Ableton'a giden trafiği izle
sudo tcpdump -i lo0 -n udp port 10000 -X -s 200

# M4L geri kanalı dinle (test)
sudo tcpdump -i lo0 -n udp port 8889 -X -s 200

# Manifest IP değiştir (örnek)
sed -i '' 's/"host": ".*"/"host": "192.168.1.200"/' manifests/leapmotion.json

# Server öldür
pkill -f "tsx watch src/index.ts"
```

---

## GIT DURUMU

- Son commit: `M4L geri kanal (port 8889), tip tag fix, yeni manifest'ler, referans görseller`
- 18+ dosya
- `main` branch'te
- Remote yok (lokal repo)
