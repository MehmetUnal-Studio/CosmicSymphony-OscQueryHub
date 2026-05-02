# CosmicSymphony — OSCQuery Hub

Sahnedeki tüm OSC cihazlarını (LeapMotion, Spektra tabletler, VR, Ring, WebInstrument vb.) tek bir merkezi Node.js hub üzerinden Ableton Live'a bağlayan sistem.

Eski Max/MSP Standalone Manager'ın yerini alır.

→ [Görsel teknik anlatım](docs/visual-overview.html)

---

## Mimari

```
[Cihazlar]  ──OSCQuery──►  [Node.js Hub]  ──UDP──►  [Ableton M4L]
                                 │
                            Web arayüzü
                         http://localhost:5555/ui/
```

- **Hub:** Bu repo — Node.js + TypeScript
- **Ses:** Ableton Live + Max for Live ("Cosmic Unity" cihazı)
- **Görsel:** TouchDesigner
- **Kontrol:** TouchOSC (iPad), web tarayıcı

---

## Kurulum

### Gereksinimler

- [Node.js](https://nodejs.org) v18 veya üzeri
- Terminal (macOS: Terminal.app veya iTerm)

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
```

Durdurmak için: `Ctrl + C`

---

## Portlar

| Port | Protokol | Ne için |
|------|----------|---------|
| 5555 | TCP | Web arayüzü + WebSocket |
| 5006 | UDP | Hub'ın OSC dinleme portu |
| 10000 | UDP | Ableton M4L `udpreceive` (hub buraya gönderir) |
| 8889 | UDP | M4L → Hub geri kanal (feedback) |

---

## Cihaz Ekleme

Her cihaz `manifests/` klasöründe bir JSON dosyasıyla tanımlanır.

### Manuel ekleme

`manifests/` klasöründe yeni bir `.json` dosyası oluştur:

```json
{
  "id": 3,
  "name": "Tablet3",
  "type": "spectra-tablet",
  "host": "192.168.1.103",
  "oscQueryPort": 9010,
  "enabled": true,
  "description": "Spektra tablet 3"
}
```

Sunucuyu yeniden başlatmana gerek yok — manifest değişikliklerini canlı algılar.

### Otomatik keşif (Bonjour/mDNS)

Ağda `_oscjson._tcp` yayınlayan cihazlar otomatik olarak tespit edilir. Web arayüzünde **"Keşfedilen Cihazlar"** bölümünde görünür, **EKLE** butonuyla sisteme katılır. ID otomatik atanır (10, 11, ...).

---

## Ableton M4L Bağlantısı

Hub, her cihazdan gelen parametreleri şu formatta Ableton'a iletir:

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

## Klasör Yapısı

```
oscquery-hub/
├── src/
│   ├── index.ts              ← Hub'ın beyni
│   └── oscquery-client.ts    ← Cihazlara bağlanan client
├── manifests/                ← Cihaz tanımları (JSON)
├── web/
│   └── index.html            ← Web kontrol paneli
├── docs/                     ← Teknik belgeler
└── CLAUDE.md                 ← AI bağlam dosyası
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

**Ableton'a veri gitmiyor**
- M4L device'ta `udpreceive 10000` açık olmalı
- `sudo tcpdump -i lo0 -n udp port 10000` ile trafiği kontrol et

---

## Geliştirme

Değişiklik yapıp GitHub'a göndermek için:

```bash
git add .
git commit -m "ne yaptığını kısaca açıkla"
git push
```

Güncel kodu çekmek için:

```bash
git pull
```
