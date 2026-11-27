# Office Media Converter

Aplikasi web internal (< 10 pengguna) untuk mengonversi media **secepat mungkin**: input dari URL atau upload file → MP3 (128/192/320k), M4A/AAC, WAV, Audio Copy, atau MP4. Dibangun dengan Next.js 16 (App Router, TypeScript, Tailwind CSS 4), `ffmpeg`, dan `yt-dlp`.

## Fitur

- Input **URL** (yt-dlp) atau **upload file** (drag & drop, di-stream langsung ke disk).
- Output: MP3 128k / 192k / 320k, M4A/AAC, WAV, **Audio Copy ⚡** (tanpa re-encode), MP4.
- **Fast-path otomatis**: stream copy bila codec sumber sudah cocok, fallback ke transcode penuh bila copy gagal.
- Trim opsional (mulai–selesai) dan judul/nama file yang dibersihkan otomatis (tag seperti “(Official Video)” dihapus, metadata `title` ditulis).
- Status real-time: `Queued → Mengambil sumber → Extracting/Converting → Ready → Expired`, progress bar, tombol Download / Batal / Hapus.
- Riwayat per browser (localStorage) + tombol “Bersihkan semua” yang juga menghapus file di server.
- Antrean in-memory, **maks. 2 job berjalan bersamaan**; file dihapus otomatis setelah 30 menit.
- Login PIN tim (opsional), cookie sesi HMAC, rate-limit login, guard CSRF, blokir SSRF, eksekusi binary tanpa shell.

## Arsitektur singkat

```
Browser ──► proxy.ts (cek sesi halaman) ──► app/page.tsx ──► components/Converter (polling 1 dtk)
        └─► /api/* (cek sesi + header x-omc di tiap route)
              ├─ POST /api/jobs            (URL)  ─┐
              ├─ POST /api/jobs/upload     (raw)  ─┤──► lib/jobs.ts  JobManager (in-memory, konkurensi ≤2)
              ├─ GET  /api/jobs?ids=…  status      │        ├─ lib/ytdlp.ts   unduh (format selector ramah copy)
              ├─ DELETE /api/jobs[/:id] hapus/batal│        ├─ lib/ffmpeg.ts  ffprobe → plan fast-path / transcode
              ├─ GET  /api/jobs/:id/download       │        └─ sweeper 60 dtk: TTL, orphan dir, record lama
              └─ GET  /api/health (tanpa auth)     ┘
Storage: $STORAGE_DIR/j<id>/  (source dihapus setelah sukses, output dihapus saat TTL habis)
```

```
src/
├─ proxy.ts                 proteksi halaman (Next 16 "proxy" = middleware)
├─ instrumentation.ts       start JobManager saat server boot
├─ app/                     page.tsx, login/, api/{health,auth,jobs}
├─ components/              Converter, JobList, LoginForm, LogoutButton, client-api
└─ lib/                     config, auth, api, url (SSRF), validation, process (spawn aman),
                            ffmpeg, ytdlp, jobs, filename, time, types, errors
```

## Menjalankan lokal (development)

Prasyarat: Node.js ≥ 20.9, `ffmpeg`/`ffprobe`, dan `yt-dlp` ada di PATH.

```bash
# Windows:  winget install Gyan.FFmpeg yt-dlp.yt-dlp
# macOS:    brew install ffmpeg yt-dlp
# Debian:   sudo apt install ffmpeg && pipx install yt-dlp

npm install
cp .env.example .env.local     # opsional: isi ACCESS_PIN, STORAGE_DIR=./storage
npm run dev                    # http://localhost:3000
```

Cek lain: `npm run typecheck`, `npm run build`.

> yt-dlp terbaru membutuhkan JavaScript runtime untuk beberapa situs (mis. YouTube). Secara lokal set `YTDLP_JS_RUNTIMES=node` atau pasang Deno. Di Docker sudah diatur ke `node`.

## Deploy dengan Docker Compose

```bash
cp .env.example .env
# Edit .env — minimal: ACCESS_PIN dan AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build
docker compose ps              # status "healthy" setelah ±20 dtk
docker compose logs -f
```

Buka `http://<server>:3000` (port lewat `HOST_PORT`).

- Image: multi-stage (deps → build → yt-dlp standalone → runtime `node:22-bookworm-slim` + `ffmpeg`), jalan sebagai user non-root `node`.
- Volume `media-data` → `/data` (file sementara di `/data/media`).
- `restart: unless-stopped`, `init: true` (merapikan proses anak), healthcheck ke `/api/health` (503 bila ffmpeg tidak tersedia).
- Update yt-dlp: `docker compose build --no-cache && docker compose up -d`, atau set `YTDLP_AUTO_UPDATE=true` (update tiap start).
- Di belakang HTTPS reverse proxy (Nginx/Caddy/Traefik): set `COOKIE_SECURE=true` dan naikkan batas body proxy (mis. Nginx `client_max_body_size 500m;`, `proxy_request_buffering off;`).
- Sumber yang butuh login: mount file cookies, mis. `- ./cookies.txt:/run/cookies.txt:ro`, lalu `YTDLP_COOKIES_FILE=/run/cookies.txt`.

## Deploy: VPS + Nginx + Cloudflare (converter.deevatech.my.id)

**1. Cloudflare (dashboard domain deevatech.my.id)**
- DNS → record `A` `converter` → IP VPS, **Proxied** (awan oranye).
- SSL/TLS → Overview → mode **Full (strict)**.
- SSL/TLS → Origin Server → **Create Certificate** (hostname `converter.deevatech.my.id`, RSA, 15 tahun). Simpan isi *Origin Certificate* dan *Private Key*.
- Speed → Optimization: pastikan **Rocket Loader = Off** (mengganggu JavaScript Next.js).

**2. VPS: aplikasi (Docker)**
```bash
# upload/clone folder proyek ke /opt/office-media-converter
cd /opt/office-media-converter
cp deploy/env.production.example .env
nano .env        # isi ACCESS_PIN dan AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build
docker compose ps                                   # tunggu "healthy"
curl -s http://127.0.0.1:3000/api/health            # harus "ok":true
```

**3. VPS: Nginx**
```bash
# Sertifikat origin dari langkah 1
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/converter.deevatech.my.id.pem   # tempel Origin Certificate
sudo nano /etc/ssl/cloudflare/converter.deevatech.my.id.key   # tempel Private Key
sudo chmod 600 /etc/ssl/cloudflare/converter.deevatech.my.id.key

# IP asli pengunjung dari header CF-Connecting-IP (dipakai rate-limit login)
sudo sh deploy/nginx/update-cloudflare-ips.sh

# Site config
sudo cp deploy/nginx/converter.deevatech.my.id.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/converter.deevatech.my.id.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Certbot tidak diperlukan: TLS pengunjung ditangani Cloudflare, dan Cloudflare ↔ VPS memakai Origin Certificate.

**4. Uji** `https://converter.deevatech.my.id` → login PIN → 1 upload + 1 URL YouTube.

**Catatan Cloudflare & VPS**
- **Batas upload 100 MB** (paket Free/Pro): karena itu `MAX_UPLOAD_MB=95`. Unduhan dari URL tidak terkena batas ini (diunduh langsung oleh server).
- **Firewall**: buka hanya 22, 80, 443 (`sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`). Docker melewati aturan ufw untuk port yang dipublish, karena itu `HOST_BIND=127.0.0.1` penting.
- **YouTube dari IP VPS** sering membalas “Sign in to confirm you’re not a bot”. Ekspor cookies akun YouTube (sebaiknya akun khusus, bukan akun pribadi) format Netscape ke `/opt/office-media-converter/cookies.txt`, lalu buat `docker-compose.override.yml`:
  ```yaml
  services:
    converter:
      volumes:
        - ./cookies.txt:/run/secrets/cookies.txt:ro
      environment:
        YTDLP_COOKIES_FILE: /run/secrets/cookies.txt
  ```
  lalu `docker compose up -d`.
- **Update aplikasi**: `git pull && docker compose up -d --build`. yt-dlp ikut diperbarui tiap restart (`YTDLP_AUTO_UPDATE=true`).
- **Log**: `docker compose logs -f` (dirotasi otomatis, maks. 3×10 MB).

## Catatan kecepatan konversi

| Output | Fast-path (tanpa re-encode) | Fallback |
|---|---|---|
| Audio Copy | selalu `-vn -c:a copy` → wadah sesuai codec (aac→m4a, opus→opus, mp3→mp3, …) | `.mka` copy |
| M4A | sumber AAC → `-c:a copy` | AAC 192k |
| MP3 | sumber MP3 dengan bitrate ≤ target → copy | LAME CBR 128/192/320k |
| WAV | sumber PCM 16-bit → copy | `pcm_s16le` |
| MP4 | video H.264/HEVC → remux `-c:v copy` (+ audio copy bila AAC/MP3) | x264 `veryfast` CRF 23 |

- **Unduhan URL dipilih agar fast-path bisa dipakai**: MP3/WAV hanya mengunduh stream audio (tanpa video); M4A/Audio Copy memprioritaskan audio AAC; MP4 mengambil resolusi tertinggi ≤ `MAX_VIDEO_HEIGHT` (default 720p), lalu memprioritaskan H.264 + AAC. yt-dlp memakai `--concurrent-fragments 4`.
- Trim memakai input seeking (`-ss` sebelum `-i`) → hampir instan. Pada remux video, titik potong mengikuti keyframe.
- `FFMPEG_THREADS` default = jumlah CPU / `MAX_CONCURRENT_JOBS`, jadi 2 job paralel tidak saling berebut CPU. Encoder MP3 (LAME) sendiri single-thread; percepatan utama ada di decode dan di menjalankan 2 job sekaligus.
- `MP3_ALGORITHM_QUALITY=5` jauh lebih cepat daripada default LAME (3) dengan perbedaan kualitas yang praktis tak terdengar pada 192–320k. Pakai `7` untuk lebih cepat lagi, `2` untuk kualitas maksimum.
- `VIDEO_PRESET=ultrafast|superfast` mempercepat transcode MP4 (file lebih besar).
- Source dihapus segera setelah output siap, jadi disk hanya menyimpan hasil.

## Batas ukuran & pembersihan file

- `MAX_UPLOAD_MB` (default 500) berlaku untuk upload dan unduhan URL (`--max-filesize`). Upload dihitung per byte saat streaming dan langsung dihentikan bila lewat batas.
- `MAX_DURATION_MINUTES` (default 180): dicek di yt-dlp (`--match-filter`) dan ffprobe. Siaran live ditolak.
- `MAX_QUEUED_JOBS` (default 20) dan `JOB_TIMEOUT_MINUTES` (default 30) mencegah server kewalahan.
- Pembersihan otomatis (setiap 60 detik):
  - output yang lebih tua dari `FILE_TTL_MINUTES` dihapus → status **Expired**;
  - job gagal/dibatalkan langsung dibersihkan; record dihapus dari memori setelah 6 jam;
  - folder yatim (crash/upload terputus) dihapus;
  - saat server start, sisa folder job dari run sebelumnya dibersihkan.
- Manual: tombol **Hapus** per job atau **Bersihkan semua** di riwayat.
- Status job disimpan di memori: restart container menghapus antrean & file yang sedang ada (by design untuk tool sementara). Jalankan **satu** replika.

## Keamanan

- `ACCESS_PIN` mengaktifkan login; cookie `httpOnly`, `SameSite=Lax`, ditandatangani HMAC (`AUTH_SECRET` + PIN, ganti PIN = semua sesi keluar). Login dibatasi 10 percobaan / 10 menit per IP.
- Semua API memeriksa sesi; request yang mengubah data wajib membawa header `x-omc: 1` (proteksi CSRF).
- `ffmpeg`/`ffprobe`/`yt-dlp` dijalankan dengan `spawn(cmd, [args])` tanpa shell; URL diberikan setelah `--`, path file dibuat server.
- Validasi URL: hanya http/https, tanpa kredensial, host yang resolve ke IP privat/loopback/link-local ditolak (matikan dengan `ALLOW_PRIVATE_URLS=true`), whitelist domain opsional `ALLOWED_URL_HOSTS`.
- Upload: whitelist ekstensi + verifikasi isi dengan ffprobe.
- Gunakan hanya untuk konten yang boleh diunduh/dikonversi oleh tim Anda (hak cipta & ketentuan layanan situs sumber tetap berlaku).
