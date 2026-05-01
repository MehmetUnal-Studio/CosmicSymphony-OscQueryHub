# OSCQuery Hub — Project Context

## Amaç
Sahnedeki/stüdyodaki tüm OSC cihazlarını (enstrümanlar, tabletler,
Spektra, TouchDesigner, Ableton M4L) tek bir merkezi OSCQuery hub
üzerinden bağlamak. AI ile birlikte sürekli geliştirilebilir mimari.

## Mimari
- **Hub**: Node.js + TypeScript (bu repo)
- **Ses tarafı**: Ableton + Max for Live (kullanıcının uzmanlık alanı)
- **Görsel tarafı**: TouchDesigner (arkadaşı kullanır)
- **Kontrol**: TouchOSC (iPad), web tarayıcı, enstrümanlar

## Teknoloji Yığını
- TypeScript / Node.js
- Express (HTTP server)
- ws (WebSocket)
- osc (OSC mesaj parsing)
- bonjour-service (ağ keşfi)
- Vanilla HTML/JS (web GUI)

## Klasör Yapısı
- src/        — TypeScript kaynak kodu
- web/        — Tarayıcıda çalışan kontrol paneli
- manifests/  — Cihaz şemaları (JSON)
- logs/       — Çalışma logları

## Namespace Konvansiyonu
/<device_type>/<device_name>/<param>
Örnek: /touchosc/ipad1/slider1
       /spektra/main/touch_x

## Geliştirme Kuralları
- Her yeni cihaz tipi manifests/<type>.json ile tanıtılır
- Parametre tipi + aralık + açıklama zorunlu
- Logging logs/ klasörüne tarih damgalı

## Mevcut Durum
- Aşama 1: OSC dinleyici (devam ediyor)
- Aşama 2: OSCQuery namespace (planlanıyor)
- Aşama 3: WebSocket canlı veri (planlanıyor)
- Aşama 4: Web kontrol paneli (planlanıyor)
- Aşama 5: M4L bağlantısı (planlanıyor)
- Aşama 6: Discovery (planlanıyor)
- Aşama 7: Manifest sistemi (planlanıyor)
