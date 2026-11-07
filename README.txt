# TACTICAL STRIKE ONLINE (Co-op, 10 oyuncu)

## Bilgisayarda çalıştırma
1. Node.js 18 veya üzerini kur.
2. Bu klasörde terminal/CMD aç.
3. `npm install` komutunu çalıştır.
4. `npm start` komutunu çalıştır.
5. Tarayıcıda `http://localhost:3000` adresini aç.
6. ODA OLUŞTUR'a bas. Arkadaşların aynı sunucu adresini ve ekranda çıkan oda kodunu kullanarak katılsın.

## İnternetten arkadaşlarla oynama
Sunucuyu internete açık bir Node.js hosting/VPS hizmetine yükleyip çalıştırmalısın. Hosting sağlayıcısının verdiği HTTPS adresini oyundaki **Sunucu adresi** alanına yaz. Oda kuran ve katılan herkes aynı sunucu adresini kullanmalı. Oda kodunu arkadaşlarına gönder.

## Önemli notlar
- Oda kapasitesi 10 oyuncudur.
- Oyun co-op olarak tasarlanmıştır: oyuncular aynı odada buluşur ve botlara karşı birlikte savaşır.
- WASD, fareyle bakış, sol tık ateş, sağ tık AWM dürbünü, R şarjör, 1/2/3 silah değiştirme korunmuştur.
- Bu ilk online sürümde oyuncu konumları ve bot can/ölüm bilgisi eşitlenir. Botların hareket/yapay zekâ simülasyonu istemci tarafında çalışır; tam rekabetçi/anti-hile güvenliği veya profesyonel sunucu otoritesi değildir.
- Three.js ve Socket.IO istemci kütüphaneleri CDN üzerinden yüklenir; oyun açılırken internet bağlantısı gerekir.
