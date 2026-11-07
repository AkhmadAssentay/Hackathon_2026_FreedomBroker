#!/bin/bash
# Word timestamps for the call recordings (Whisper large-v3-turbo). Node-local env, nothing kept in home but results.
#SBATCH -J cqa-whisper
#SBATCH -p ws-ia
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=28G
#SBATCH --time=01:00:00
#SBATCH -o /home/%u/cqa/logs/%x-%j.log
set -euo pipefail
BASE=/tmp/$USER/cqa-whisper
mkdir -p "$BASE"
export UV_CACHE_DIR=$BASE/uvcache HF_HOME=$BASE/hf PATH=$BASE/bin:$PATH
[ -x "$BASE/bin/uv" ] || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BASE/bin" UV_NO_MODIFY_PATH=1 sh
[ -x "$BASE/venv/bin/python" ] || { uv venv -q -p 3.12 "$BASE/venv"; uv pip install -q -p "$BASE/venv" torch transformers accelerate soundfile --torch-backend=cu128; }
"$BASE/venv/bin/python" "$HOME/cqa/whisper_words.py" "$HOME/cqa/audio" "$HOME/cqa/words"
echo done
