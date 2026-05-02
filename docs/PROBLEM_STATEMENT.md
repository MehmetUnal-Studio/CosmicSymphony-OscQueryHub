# Eski Sistem: Problem Tanımı

> Bu belge, OSCQuery Hub projesi öncesi kullandığımız Max-tabanlı **CosmicInstrumentsManager** sisteminin neden değiştirilmesi gerektiğini açıklar.

---

## 1. Eski Sistem Neydi

Eski sistem, **Max/MSP'de yazılmış bir Standalone Manager uygulamasıydı.** Adı: `CosmicInstrumentsManagerNOMEMORY`. Stüdyodaki/sahnedeki **9 farklı cihazı** koordine ediyordu:

| ID | Cihaz | Tip |
|----|-------|-----|
| 1-4 | Tablet1-4 | Spektra dokunmatik tabletler |
| 5 | TV | Display arayüzü |
| 6-7 | VR, VR2 | VR enstrümanlar |
| 8 | Ring | Dokunma sensörü |
| 9 | LeapMotion | El takip sensörü |

### Sistemin akışı

```
[9 Cihaz]
    │
    │ OSCQuery
    ▼
[CosmicInstrumentsManager (Max Standalone)]
    │
    │ UDP /Ableton/<id>/<param>
    ▼
[Ableton Live + M4L Devices]
    │
    ▼
[SES]
```

Manager şunları yapıyordu:

- Her cihazın OSCQuery server'ına bağlanıyordu
- Cihazlardan gelen veriyi topluyordu
- Her veriye **ID etiketi** ekleyip Ableton'a UDP ile yolluyordu
- Heartbeat, panic, autoreconnect mantığı içeriyordu
- Ableton'daki M4L device'lar `device ID` ile filtreleyip kendi parametrelerini güncelliyordu

**Çalışıyordu.** Hatta uzun süredir profesyonel olarak kullanılıyordu.

---

## 2. Sorun: Çalışıyor Ama Sürdürülemez

Sistem **fonksiyonel** olarak doğruydu, ama mimari olarak **çıkmaz sokağa** girmişti. Sebepleri:

### 2.1 Tüm mantık bir Max patch'inde gömülü

Manager'ın asıl mantığı (cihaz envanteri, IP'ler, bağlantı yönetimi, heartbeat, route'lama) **görsel bir Max patch'inde**, kablolarla bağlı yüzlerce nesne arasında dağınık. Bu şu sorunları yaratıyor:

- **Karmaşıklık görsel olarak büyüyor** — patch ekran sınırlarını aşıyor
- **Aynı patch'i iki kişi aynı anda düzenleyemiyor**
- **"Şu mantık nerede çalışıyor?" sorusu yanıtı uzun**
- **Patch'in çalışması için Max'in açık olması gerek**

### 2.2 Yeni cihaz eklemek = Patch düzenlemek

Yeni bir cihaz ekleneceği zaman:

1. Manager Max'te açılmalı
2. Mevcut patch'in arasında doğru noktaya yeni `route`, `udpsend`, `udpreceive` bağlantıları kurulmalı
3. ID ataması elle yapılmalı
4. Test edilmeli, bağlanmıyorsa neden bağlanmadığı **görsel olarak** debug edilmeli
5. Patch save edilmeli, dağıtılmalı

Yani **her yeni cihaz, Manager'ın baştan düzenlenmesi anlamına geliyor.**

### 2.3 AI ile geliştirilemez

Bu kritik bir mesele. Bir AI modeli (Claude, GPT, vb.) Max patch'lerini **doğal olarak okuyup yazamaz**:

- Patch'ler binary formatta saklanır (.maxpat = düzenlenmiş JSON ama nesnelerin görsel pozisyonları, kabloların çizim koordinatları dahil)
- AI'a "şu objeyi şuraya koy, şununla bağla" demek mümkün ama **ekran karşısında elle kuracak insan** gerekiyor
- AI doğrudan kod yazıp üretemiyor
- Hata mesajları görsel araç içinde (`Cmd + M` console'unda), AI'a yapıştırması mümkün ama **her seferinde elle**

Sonuç: **AI sadece danışman, uygulayıcı insan.** İterasyon hızı sınırlı.

### 2.4 Versiyon kontrolü zayıf

- Git, Max patch'lerinin diff'ini gösteremez (binary)
- "Geçen hafta bu daha iyi çalışıyordu" → manuel olarak eski .maxpat dosyasını bulup açmak gerek
- Branch, merge gibi modern geliştirme akışları imkansız
- Ekipçe çalışma çok zor: iki kişi aynı patch'i değiştirirse merge yapılmaz

### 2.5 Logging ve debug

- Hata varsa Max console'a bakılır (`Cmd + M`)
- Console kapanırsa loglar **kaybolur**
- Tarihli log dosyası tutmak için patch'e ayrı mantık eklemek gerek (`text` nesnesi vs.)
- Production'da "geçen gece sahnedeyken neden bağlantı koptu?" sorusunun cevabı yok

### 2.6 Uzaktan yönetim yok

- Manager'ın çalıştığı bilgisayara fiziksel erişim gerek
- "Telefondan kontrol edeyim" → ek patch yazmak gerek
- Birden fazla kontrol noktası (laptop + tablet + telefon) aynı anda kullanılamıyor

### 2.7 Bağımlılık zinciri kırılgan

- Max for Live lisansı gerekiyor
- Max'in versiyon değişiklikleri patch'i bozabiliyor
- macOS güncellemesi Max'i etkileyebiliyor
- Cycling '74 (Max'in üreticisi) ekosistemine kilitli

### 2.8 İki yönlü iletişim karmaşık

Manager hem cihazlardan **veri alıyor**, hem cihazlara **komut yolluyor** (preset değişikliği, scale değişimi, panic). Her iki yön Max patch'inde ayrı kablolarla kuruldu, neyin neye gittiğini takip etmek zor.

---

## 3. Çıkmaz Sokak

Sistem büyüdükçe maliyetler arttı:

| Aksiyon | Eski Sistem'de | Maliyet |
|---------|----------------|---------|
| Yeni cihaz ekle | Patch'i aç, kabloları çiz, ID ata, test et | 30-60 dk |
| IP değişikliği | Patch'i aç, IP nesnesini değiştir, save et | 5-10 dk |
| Bug fix | Console'a bak, kabloları takip et, deneme yanılma | Saatler |
| Yeni özellik | Patch'in mevcut yapısına nasıl entegre edileceğini düşün | Günler |
| Belgelendirme | Patch'in ekran görüntüsünü al, Notion'a yapıştır | Tutarsız |
| AI ile geliştirme | Mümkün değil | — |

---

## 4. Asıl Problem: Görsel Programlamanın AI Çağındaki Yeri

Görsel programlama (Max, Pure Data, TouchDesigner, vb.) **insan-merkezli** yapılmış. Görsel bir araç olarak çok güzel — sezgisel, hızlı prototip, müzisyen-dostu. Ama:

> **Görsel araçlar, bir AI modeli ile birlikte iteratif geliştirme yapmak için tasarlanmadı.**

AI çağında geliştirme şöyle akar:
1. Sen problemi tarif edersin
2. AI kodu yazar
3. Sen test edersin
4. Hata varsa AI düzeltir
5. Tekrarla

Bu döngü **metin tabanlı kodda saniyeler içinde** gerçekleşir. Görsel patch'lerde **dakikalara çıkar** çünkü AI patch yazamıyor — sen yazıyorsun.

Sonuç: **Eski sistem çalışıyor ama gelişemiyor.** Geliştirici hızı, müzisyenin elinin hızıyla sınırlı kalıyor.

---

## 5. Karar

> Eski sistemin **fonksiyonelliğini koru, mimarisini değiştir.**

- M4L device'lara dokunma (Cosmic Unity vs. üretiyor, çalışıyor, müzisyenin alıştığı arayüz)
- Sadece **Manager katmanını** modern, AI uyumlu bir teknoloji yığınına taşı
- Öyle bir tasarla ki: yeni cihaz = bir JSON dosyası, yeni özellik = bir kod commit'i, hata = bir log satırı

---

## 6. Yeni Sistem: Sonraki Belge

Detaylı yeni mimari için: `NEW_ARCHITECTURE.md`
