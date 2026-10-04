# ClipForge Pro — MVP

Web clipper untuk video yang Anda miliki/izinkan: URL media langsung atau upload file → tentukan IN/OUT → pilih resolusi/rasio → download clip.

## Fitur
- URL media langsung (HTTP/HTTPS) tanpa menyimpan video penuh secara permanen.
- Upload video.
- IN/OUT `HH:MM:SS`.
- 360p / 480p / 720p / 1080p.
- 16:9 / 9:16 / 1:1.
- MP4 atau MP3.
- Target ukuran MB opsional (perkiraan bitrate).
- File upload sementara dihapus otomatis.
- Blok URL localhost/private IP untuk mengurangi risiko SSRF.

## Menjalankan lokal
Pastikan Node.js 20+ dan FFmpeg tersedia di PATH.

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## Docker
```bash
docker build -t clipforge-pro .
docker run --rm -p 3000:3000 clipforge-pro
```

## Deploy
Karena proses video menggunakan FFmpeg dan bisa berlangsung lebih lama daripada fungsi serverless biasa, gunakan backend container/VPS (contoh: Railway, Render, Fly.io, VPS). Frontend bisa dipisahkan ke Vercel pada tahap berikutnya.

## Catatan URL
MVP ini menerima URL media yang bisa dibaca FFmpeg (contoh URL MP4/HLS yang memang mengizinkan akses). Ia **tidak** membypass DRM, login, atau proteksi platform. Untuk YouTube atau platform lain, gunakan hanya integrasi resmi / konten sendiri / konten yang memang diizinkan oleh platform dan pemegang hak.

## Environment opsional
- `PORT=3000`
- `MAX_UPLOAD_MB=1500`
- `MAX_CLIP_SECONDS=900`
