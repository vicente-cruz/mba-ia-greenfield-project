#!/bin/sh
# Gera as fixtures de vídeo da Fase 03 com o FFmpeg da imagem do `nestjs-api` (Debian bookworm,
# FFmpeg 5.1). Uso, a partir de nestjs-project/:
#   docker compose exec nestjs-api sh test/fixtures/videos/generate.sh
#
# Fixtures (phase-03-videos/TD-11, TD-13; V-04), todas com menos de 1.000.000 bytes:
#   h264-aac-faststart.mp4  MP4 H.264/AAC com `moov` no início (+faststart)
#   h264-aac-moov-end.mp4   MP4 H.264/AAC com `moov` no fim (padrão do muxer)
#   h264-no-audio.mp4       MP4 H.264 sem áudio
#   vp9-opus.webm           WebM VP9/Opus
#   qt-brand.mov            MOV, `major_brand` `qt  ` (recusado na Fase 03)
#   invalid.mp4             texto, não é mídia
#   truncated.mp4           metade inicial de h264-aac-moov-end.mp4 (sem o `moov`)
#
# As fontes são sintéticas (testsrc e sine), sem metadados e com bitexact, para que a geração
# seja estável. As fixtures geradas ficam versionadas; este script as recria.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FF="ffmpeg -hide_banner -loglevel error -nostdin -y"
VIDEO_SRC="-f lavfi -i testsrc=size=320x240:rate=25:duration=2"
AUDIO_SRC="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=2"
COMMON="-map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -threads 1"
H264="-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 25"

# shellcheck disable=SC2086
$FF $VIDEO_SRC $AUDIO_SRC $COMMON $H264 -c:a aac -b:a 64k -movflags +faststart "$TMP/h264-aac-faststart.mp4"
# shellcheck disable=SC2086
$FF $VIDEO_SRC $AUDIO_SRC $COMMON $H264 -c:a aac -b:a 64k "$TMP/h264-aac-moov-end.mp4"
# shellcheck disable=SC2086
$FF $VIDEO_SRC $COMMON $H264 -an "$TMP/h264-no-audio.mp4"
# shellcheck disable=SC2086
$FF $VIDEO_SRC $AUDIO_SRC $COMMON -c:v libvpx-vp9 -b:v 200k -deadline good -cpu-used 4 -row-mt 0 \
  -c:a libopus -b:a 48k "$TMP/vp9-opus.webm"
# shellcheck disable=SC2086
$FF $VIDEO_SRC $AUDIO_SRC $COMMON $H264 -c:a aac -b:a 64k -f mov "$TMP/qt-brand.mov"

i=0
: >"$TMP/invalid.mp4"
while [ "$i" -lt 64 ]; do
  echo "este arquivo não é um vídeo: fixture inválida da Fase 03 ($i)" >>"$TMP/invalid.mp4"
  i=$((i + 1))
done

size=$(stat -c %s "$TMP/h264-aac-moov-end.mp4")
head -c $((size / 2)) "$TMP/h264-aac-moov-end.mp4" >"$TMP/truncated.mp4"

for f in h264-aac-faststart.mp4 h264-aac-moov-end.mp4 h264-no-audio.mp4 vp9-opus.webm qt-brand.mov invalid.mp4 truncated.mp4; do
  bytes=$(stat -c %s "$TMP/$f")
  if [ "$bytes" -ge 1000000 ]; then
    echo "fixture $f com $bytes bytes: o limite é menos de 1.000.000" >&2
    exit 1
  fi
  mv "$TMP/$f" "$DIR/$f"
  echo "$f $bytes bytes $(sha256sum "$DIR/$f" | cut -d' ' -f1)"
done
