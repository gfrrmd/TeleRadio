# Telegram Radio 24/7

Live stream musik 24 jam ke Telegram lewat RTMPS: cover album + judul + artist + timer + bar progres.
Admin panel untuk upload lagu, atur urutan, shuffle/loop, skip, start/stop.

**Stack:** Node.js (Express) · PostgreSQL · FFmpeg · Railway (Docker)

## 1. Ambil RTMPS Telegram
1. Buka channel/grup → **Start Live Stream** (atau Live Broadcast) → **Start with...** / "Stream with other apps".
2. Salin **Server URL** (contoh `rtmps://dc5-1.rtmp.t.me/s/`) dan **Stream Key**.
3. Jangan tekan "Start Streaming" dulu; Telegram baru menayangkan setelah ada data masuk dari worker.
   Jika key berubah (Telegram membuat key baru tiap sesi), ganti variabel di Railway lalu redeploy.

## 2. Deploy ke Railway
1. Upload folder ini ke repo GitHub (private disarankan): `git init && git add . && git commit -m init && git push`.
2. Di Railway: **New Project → Deploy from GitHub repo** → pilih repo ini. Railway otomatis memakai `Dockerfile`.
3. Di project yang sama: **+ New → Database → PostgreSQL**.
4. Klik service app → **Variables**, tambahkan:

| Variable | Isi |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference ke service Postgres) |
| `ADMIN_PASSWORD` | password panel admin (kuat!) |
| `STATION_NAME` | nama radio di tampilan |
| `TELEGRAM_RTMPS_URL` | Server URL dari Telegram |
| `TELEGRAM_STREAM_KEY` | Stream Key dari Telegram |
| `DATA_DIR` | `/data` |

5. **Volume:** service app → **Settings → Volumes → Add Volume**, mount path `/data`. Wajib, supaya lagu & cover tidak hilang saat redeploy.
6. **Networking → Generate Domain** untuk mendapat URL website.
7. Buka `https://domain-kamu/admin` → login → upload lagu → **Start**.
   Halaman publik (now playing) ada di `/`.

## 3. Cara kerja singkat
- Satu proses FFmpeg "pusher" selalu terhubung ke Telegram. Tiap lagu di-encode oleh FFmpeg terpisah (kartu cover + timer + bar), lalu dialirkan ke pusher, jadi koneksi tidak putus antar lagu. Timestamp disambung otomatis (`-output_ts_offset`).
- Status "running" disimpan di database: setelah redeploy/restart, stream menyala sendiri.
- Jika Telegram memutus koneksi, pusher dimulai ulang tiap 5 detik.

## 4. Jalankan lokal (opsional)
Butuh Node 20+, FFmpeg, Postgres, font DejaVu.
```
cp .env.example .env   # isi nilainya, lalu export ke environment
npm install && npm start
```

## 5. Troubleshooting
- **Tidak ada video di Telegram:** cek log di panel admin. Error `Connection refused`/`Input/output error` biasanya URL/key salah atau key sudah kedaluwarsa.
- **Glitch/patah saat pindah lagu:** ganti `-c copy` di pusher (`src/streamer.js`) menjadi `-c:v libx264 -preset veryfast -c:a aac` (CPU naik sedikit).
- **Cover/teks tidak muncul:** pastikan deploy memakai Dockerfile (font DejaVu terpasang di sana).
- **Biaya:** FFmpeg berjalan terus; resolusi 720p @ 5 fps ~700 kbps. Untuk lebih hemat turunkan `-b:v` atau resolusi di `src/render.js` dan `src/streamer.js`.
- **Upload besar gagal:** batas 100 MB per file (ubah `fileSize` di `src/server.js`).

## 6. Catatan penting
- Hanya putar musik yang kamu punya haknya atau berlisensi/bebas royalti. Lagu berhak cipta bisa membuat live stream dihentikan.
- Satu instance saja (jangan scale ke >1 replica), karena stream hanya boleh dikirim dari satu worker.
- Sesi login disimpan di memori; setelah redeploy kamu perlu login ulang.

## 7. Bot Telegram (ambil lagu dari channel + remote control)
Alur: upload audio ke channel → bot mengunduh → masuk playlist → diputar bergantian di stream.

**Setup**
1. Buat bot di [@BotFather](https://t.me/BotFather) → salin token.
2. Jadikan bot **Administrator** channel musikmu (wajib, kalau tidak bot tidak menerima postingan channel).
3. Cari ID user Telegram-mu lewat [@userinfobot](https://t.me/userinfobot), lalu kirim `/start` ke bot kamu sendiri (supaya bot boleh mengirim notifikasi).
4. Tambahkan variabel di Railway: `BOT_TOKEN`, `BOT_ADMIN_IDS` (ID user, pisahkan koma), `SOURCE_CHAT_IDS` (ID channel, formatnya `-100xxxxxxxxxx`).
   Belum tahu ID channel? Isi dulu dua variabel pertama, posting 1 audio di channel; bot akan mengirim DM berisi ID channel-nya.
5. Redeploy. Posting audio di channel, bot membalas lewat DM: "✅ Ditambahkan ...".

**Perintah bot** (hanya untuk `BOT_ADMIN_IDS`, lewat chat pribadi): `/play` `/stop` `/skip` `/now` `/list` `/shuffle on|off` `/loop on|off`.
Kamu juga bisa kirim/forward file audio langsung ke bot untuk menambah lagu.

**Batasan**
- Bot API hanya bisa mengunduh file sampai **20 MB**. MP3 320 kbps ±5 menit masih muat. Untuk file lebih besar, jalankan [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) sendiri (batas 2 GB).
- Bot hanya melihat postingan **setelah** ia jadi admin. Lagu lama: forward ke chat bot.
- Menghapus pesan di channel **tidak** menghapus lagu dari playlist (Telegram tidak memberi tahu bot). Hapus lewat panel admin.
- Lagu yang sama (file_unique_id) tidak ditambahkan dua kali.
- Pakai satu instance saja; dua proses yang polling dengan token sama akan bentrok (error 409).
- Bot tidak bisa mengirim video live sendiri. Yang mengirim stream tetap RTMPS dari akun/channelmu; bot hanya mengambil lagu dan mengontrol.
