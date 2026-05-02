# OSCQuery Hub — Proje Durumu

> Bu dosya, projenin mevcut durumunu ve gelecek AI oturumları için bağlamı içerir.
> Son güncelleme: 2 Mayıs 2026

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
            │
            │ UDP /Ableton/<id>/<param> ↦ port 10000
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
│   └── leapmotion.json       ← Şu an aktif olan
├── web/index.html             ← Yönetim arayüzü (vanilla HTML/JS)
├── package.json, tsconfig.json
└── CLAUDE.md                  ← AI bağlam dosyası
```

### Önemli portlar
- **5006**: Hub'ın OSC dinleme portu (UDP)
- **5555**: Hub'ın HTTP+WebSocket portu (web arayüz)
- **10000**: Ableton M4L'ın `udpreceive` portu — Hub buraya forward eder
- **8888**: Eski sistemin port'u (kullanılmıyor artık)

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

---

## NE BAŞARILDI

### ✅ Aşama 1-10 (tamamı)
- OSC dinleyici (UDP 5006)
- OSCQuery server (kendi namespace'imizi sunuyoruz, port 5555)
- WebSocket canlı veri akışı
- Web kontrol paneli (vanilla HTML/JS, tarayıcıda IP düzenleme)
- İki yönlü iletişim (tarayıcı → cihaz SET komutları)
- Bonjour ile ağ keşfi (kendimizi duyuruyoruz, başkalarını buluyoruz)
- Manifest sistemi (JSON dosyaları, canlı yenileme)
- **OSCQuery client** (cihazlara HTTP+WS ile aktif bağlanma)
- **Binary OSC parser** (TouchDesigner ham OSC paketleri yolluyor, JSON değil)
- **Ableton Forwarder** (`/Ableton/<id>/<param>` formatında UDP 10000'e gönderim)

### ✅ Gerçek dünya testi
LeapMotion (192.168.1.152:9012) ile test edildi:
- 31 parametre keşfedildi
- Saniyede ~60 kez veri akıyor (`/HandR0/palm/Tx`, `/HandL0/status/Pinch`, vs.)
- Hub doğru forward ediyor: `tcpdump` çıktısı kanıtladı
- Cosmic Unity M4L device (ID 9) sesi üretiyor

---

## ESKİ SİSTEM (DEĞİŞTİRİLEN)

Önceden kullanıcı **Max'te yazılmış bir Standalone Manager** kullanıyordu (`CosmicInstrumentsManagerNOMEMORY`). Bu Manager:
- 9 cihaza ayrı ayrı bağlanıyordu
- Her cihazın `OSCQuery server`'ını dinliyordu
- Verileri toplayıp Ableton'daki M4L'a UDP ile yolluyordu
- Heartbeat, panic, autoreconnect mantığı vardı
- Kullanıcı **artık bu Max patch'ini kullanmayacak** — Node.js hub onun yerini aldı

**Önemli:** Ableton'daki M4L device (`Cosmic Unity` — MPE synth, gesture-mapped) **aynen kalıyor**. Bu konuşmada ona dokunulmadı.

---

## TEKNOLOJİ YIĞINI

- **Node.js + TypeScript** (`tsx watch` ile geliştirme, derleme yok)
- **Kütüphaneler:**
  - `osc` (OSC mesaj parsing)
  - `express` (HTTP server)
  - `ws` (WebSocket)
  - `bonjour-service` (mDNS keşif)
- **Web arayüz:** Vanilla HTML/CSS/JS (framework yok)
- **Build:** Yok — `tsx` direkt TypeScript çalıştırıyor

---

## SIRADAKI POTANSİYEL ADIMLAR

Kullanıcı bu sırada karar verecek:

1. **Path format düzeltmesi** — Şu an `/HandR0/palm/Tx` → `HandR0_palm_Tx` underscore'a çevriliyor. Cosmic Unity'nin route nesnesi `/HandR0/palm/Tx` formatını bekliyor olabilir. Test edilmeli.
2. **Heartbeat & Reconnect** — Cihaz X saniye sessiz kalırsa "lost" işaretle, panic gönder, otomatik geri bağlan. Sahnede kritik.
3. **Logging** — `logs/` klasörüne tarih damgalı log dosyaları
4. **Geri yön** (Ableton → Cihaz) — Eski Manager iki yönlüydü, biz tek yön yaptık
5. **Recording / Replay** — OSC akışını dosyaya kaydet, sonra oynat (cihazlar yokken geliştirme için)
6. **GitHub'a yükleme** (kullanıcı şimdilik istemedi)

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

---

## KULLANICI HAKKINDA NOTLAR

- M4L'de profesyonel
- TypeScript/Node.js'te yeni
- Git'te yeni
- CMake/C++ tamamen yeni (öğrenmek istemiyor şu an)
- Türkçe konuşuyor
- Sahnede çalan bir müzisyen/ses sanatçısı (bence)
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

# Test (lokalden Hub'a OSC mesajı yolla)
node --input-type=module -e "
import osc from 'osc';
const port = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: 0,
  remoteAddress: '127.0.0.1', remotePort: 5006, metadata: true });
port.on('ready', () => {
  port.send({ address: '/test', args: [{ type: 'f', value: 0.5 }] });
  setTimeout(() => process.exit(0), 500);
});
port.open();
"

# Hub'tan Ableton'a giden trafiği izle
sudo tcpdump -i lo0 -n udp port 10000 -X -s 200

# Manifest IP değiştir (örnek)
sed -i '' 's/"host": ".*"/"host": "192.168.1.200"/' manifests/leapmotion.json
```

---

## GIT DURUMU

- Tek commit: `Working: LeapMotion → Hub → Ableton, ses çıkıyor`
- 18 dosya, 3773 satır
- `main` branch'te
- Remote yok (lokal repo)
