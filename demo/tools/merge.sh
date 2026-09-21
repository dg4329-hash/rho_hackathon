#!/usr/bin/env bash
# Merge ElevenLabs voiceover onto the silent film.
#   one file : tools/merge.sh voice.mp3            → starts at 0.4 s; if longer than ~119 s it's tempo-fitted (max 8 %)
#   six files: tools/merge.sh s1.mp3 … s6.mp3     → each starts 0.4 s into its 20 s scene
# Output: render/mesh-demo.mp4 (1080p30 H.264 + AAC 192k, loudness -16 LUFS, fades)
set -euo pipefail
cd "$(dirname "$0")/.."
V=render/mesh-demo-silent.mp4; OUT=render/mesh-demo.mp4; DUR=120.6
if [ $# -eq 1 ]; then
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1")
  tempo=$(python3 -c "l=$len; print(1.0 if l<=119 else min(1.08, l/119))")
  echo "voice ${len}s, tempo ${tempo}"
  ffmpeg -v error -y -i "$V" -i "$1" -filter_complex "[1:a]atempo=${tempo},adelay=400|400,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${DUR},afade=t=out:st=$(python3 -c "print($DUR-1.2)"):d=1.2[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
else
  inputs=(); parts=""; i=0
  for f in "$@"; do inputs+=(-i "$f"); d=$(( i*20000 + 400 )); parts+="[$((i+1)):a]adelay=${d}|${d}[a$i];"; i=$((i+1)); done
  mix=""; for ((k=0;k<i;k++)); do mix+="[a$k]"; done
  ffmpeg -v error -y -i "$V" "${inputs[@]}" -filter_complex "${parts}${mix}amix=inputs=${i}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${DUR},afade=t=out:st=$(python3 -c "print($DUR-1.2)"):d=1.2[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
fi
ffprobe -v error -show_entries format=duration:stream=codec_name -of compact=p=0 "$OUT"; echo "→ $OUT"
