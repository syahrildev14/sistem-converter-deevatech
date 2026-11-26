#!/bin/sh
set -e

mkdir -p "${STORAGE_DIR:-/data/media}"

# Optional: update yt-dlp on container start (sites change often; a stale yt-dlp is the #1 cause of URL failures).
if [ "${YTDLP_AUTO_UPDATE:-false}" = "true" ]; then
  echo "[entrypoint] updating yt-dlp..."
  yt-dlp -U || echo "[entrypoint] yt-dlp update failed, continuing with $(yt-dlp --version 2>/dev/null || echo unknown)"
fi

echo "[entrypoint] ffmpeg: $(ffmpeg -hide_banner -version 2>/dev/null | head -n1)"
echo "[entrypoint] yt-dlp: $(yt-dlp --version 2>/dev/null || echo 'not available')"

exec "$@"
