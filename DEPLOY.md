# WMS Deploy Rehberi

## Varsayılan Giriş
- Kullanıcı: admin
- Şifre: password
⚠️ İlk girişte şifreyi değiştirin!

---

## ADIM 1 — GitHub'a yükle

1. github.com → giriş yap
2. Sağ üst + → "New repository"
3. İsim: `wms` → Public → Create
4. Repo sayfasında "Add file" → "Upload files"
5. ZIP'i çıkarın, içindeki TÜM dosyaları sürükleyip bırakın
6. "Commit changes" tıklayın

---

## ADIM 2 — Render (Backend)

1. render.com → Google ile giriş yap
2. "New +" → "Web Service"
3. GitHub hesabını bağla → `wms` reposunu seç
4. Ayarlar:
   - **Name:** wms-backend
   - **Root Directory:** backend
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. "Advanced" → "Add Disk":
   - Name: wms-data
   - Mount Path: /data
   - Size: 1 GB
6. Environment Variables ekle:
   - `JWT_SECRET` = uzun rastgele bir şey (örn: wms2024xyzabc123!)
   - `DATA_DIR` = /data
7. "Create Web Service" → deploy başlar (~2 dk)
8. Size bir link verilir: `https://wms-backend-xxxx.onrender.com`
   Bu linki kaydedin!

---

## ADIM 3 — Vercel (Frontend)

1. vercel.com → GitHub ile giriş yap
2. "Add New Project" → `wms` reposunu seç
3. **Root Directory:** frontend (önemli!)
4. Environment Variables:
   - Bu adımda eklemenize gerek yok
5. Deploy tıkla → 1 dk
6. Size bir link verilir: `https://wms-xxxx.vercel.app`

---

## ADIM 4 — Frontend'e backend linkini bağla

GitHub'da `frontend/index.html` dosyasını açın:
- Kalem ikonu ile düzenleyin
- En üstte şu satırı bulun:
  ```
  const API = window.location.origin + '/api';
  ```
- Şu şekilde değiştirin:
  ```
  const API = 'https://wms-backend-xxxx.onrender.com/api';
  ```
  (Render'dan aldığınız linki yazın)
- "Commit changes"

Vercel otomatik yeniden deploy eder.

---

## ADIM 5 — Test

1. Vercel linkinizi açın
2. admin / password ile giriş yapın
3. Admin → Kullanıcılar → admin şifresini değiştirin
4. Ürün ekleyin → Mal Kabul yapın → deneyin

---

## El Terminali Kullanımı

Android tabanlı Zebra/Honeywell terminaller:
- Chrome veya yerleşik tarayıcı ile Vercel linkini açın
- Ana ekrana ekle → uygulama gibi kullanın
- USB/Bluetooth barkod okuyucu direkt input olarak çalışır

## Roller
| Rol | Yetkiler |
|-----|----------|
| admin | Her şey |
| depo | Mal kabul, transfer, ürün |
| sevkiyat | Çıkış, sevkiyat |
| sayim | Sadece sayım ekranı |

---

## Sorun Giderme

**Render uyku modu:** Ücretsiz planda 15 dk işlem olmayınca uyuyor.
İlk istek ~30 sn yavaş olabilir. Ücretli plana ($7/ay) geçince sürekli açık kalır.

**SQLite veri kaybı:** /data diskini eklediğiniz sürece kaybolmaz.
Render'da "Manual Deploy" yaparsanız disk korunur.
