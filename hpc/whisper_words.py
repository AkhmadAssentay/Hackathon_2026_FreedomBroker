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
    # segment timestamps (word-level DTW keeps attentions in host RAM and was OOM-killed);
    # each segment's time is spread over its words -> ~1 s precision, enough for seeking.
    out = asr({"raw": audio, "sampling_rate": sr}, return_timestamps=True, chunk_length_s=30, batch_size=2,
              generate_kwargs={"language": "ru", "task": "transcribe"})
    words = []
    for c in out["chunks"]:
        s0, s1 = c["timestamp"]
        toks = c["text"].split()
        if not toks or s0 is None:
            continue
        s1 = s1 if s1 is not None else s0 + 0.4 * len(toks)
        step = (s1 - s0) / len(toks)
        words += [{"w": w, "s": round(s0 + i * step, 2), "e": round(s0 + (i + 1) * step, 2)} for i, w in enumerate(toks)]
    (dst / f"{mp3.stem}.words.json").write_text(json.dumps({"duration": len(audio) / sr, "words": words}, ensure_ascii=False))
    print(mp3.name, len(words), "words", flush=True)
