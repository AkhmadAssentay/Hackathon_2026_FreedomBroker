"""Word-level timestamps for call recordings (Whisper large-v3-turbo, transformers, GPU).
usage: python whisper_words.py <in_dir_with_mp3> <out_dir>"""
import json
import sys
from pathlib import Path

import soundfile as sf
import torch
from transformers import pipeline

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
asr = pipeline("automatic-speech-recognition", model="openai/whisper-large-v3-turbo",
               torch_dtype=torch.float16, device="cuda:0")
for mp3 in sorted(src.glob("*.mp3")):
    audio, sr = sf.read(str(mp3), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    out = asr({"raw": audio, "sampling_rate": sr}, return_timestamps="word", chunk_length_s=30, batch_size=8,
              generate_kwargs={"language": "ru", "task": "transcribe"})
    words = [{"w": c["text"].strip(), "s": c["timestamp"][0], "e": c["timestamp"][1]} for c in out["chunks"]]
    (dst / f"{mp3.stem}.words.json").write_text(json.dumps({"duration": len(audio) / sr, "words": words}, ensure_ascii=False))
    print(mp3.name, len(words), "words", flush=True)
