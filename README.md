# Trendyol Stok Senkron Sistemi

7/24 çalışan, 4 Trendyol firması arasında merkezi stok havuzu.

---

## Kurulum Adımları

### 1. GitHub'a Yükle

1. **github.com**'a git, giriş yap
2. Sağ üstte **"+"** → **"New repository"** tıkla
3. Repository name: `trendyol-stok`
4. **Public** seç → **Create repository**
5. Açılan sayfada **"uploading an existing file"** linkine tıkla
6. Bu klasördeki TÜM dosyaları sürükle-bırak
7. **"Commit changes"** butonuna bas

---

### 2. Railway'e Deploy Et

1. **railway.app**'e git
2. **"Start a New Project"** → **"Deploy from GitHub repo"**
3. GitHub hesabınla giriş yap, `trendyol-stok` reposunu seç
4. Deploy başlar (2-3 dakika)

---

### 3. API Bilgilerini Gir

Railway'de projeye tıkla → **"Variables"** sekmesi → şunları ekle:

```
FIRM1_NAME=BanaNeVar
FIRM1_SUPPLIER_ID=xxxxxxx
FIRM1_API_KEY=xxxxxxx
FIRM1_API_SECRET=xxxxxxx

FIRM2_NAME=BenimTarzım
FIRM2_SUPPLIER_ID=xxxxxxx
FIRM2_API_KEY=xxxxxxx
FIRM2_API_SECRET=xxxxxxx

FIRM3_NAME=Ricalena
FIRM3_SUPPLIER_ID=xxxxxxx
FIRM3_API_KEY=xxxxxxx
FIRM3_API_SECRET=xxxxxxx

FIRM4_NAME=Naffy
FIRM4_SUPPLIER_ID=xxxxxxx
FIRM4_API_KEY=xxxxxxx
FIRM4_API_SECRET=xxxxxxx

SYNC_INTERVAL_MINUTES=3
PANEL_PASSWORD=sifreniyaz
```

Ekledikten sonra Railway otomatik yeniden başlar.

---

### 4. Panele Eriş

Railway → projen → **"Settings"** → domain adresini kopyala
Tarayıcıda aç → Panel gelir.

---

### 5. İlk Kullanım

1. **Ana Depo** sekmesine git → ürünlerini ekle (model, renk, beden, başlangıç stok)
2. **Ürün Eşleştirme** sekmesine git → her firmayı seç → Trendyol'daki ürünü depo ürünüyle eşleştir
3. Sistem artık 7/24 otomatik çalışır

---

## Özellikler

- ✅ Her 3 dakikada 4 firmayı tarar
- ✅ Yeni sipariş gelince merkezi stoktan düşer
- ✅ Diğer firmaların stokunu anında günceller
- ✅ İade / yeni mal için manuel stok girişi
- ✅ Eşleştirilmemiş ürün uyarısı
- ✅ Tüm işlemlerin logu
