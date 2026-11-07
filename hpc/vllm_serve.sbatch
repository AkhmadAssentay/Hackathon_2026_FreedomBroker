#!/bin/bash
# Local LLM judge for CQA: vLLM OpenAI-compatible server on one RTX 5000 Ada (32 GB).
# Everything heavy (venv, uv cache, model weights) lives on node-local /tmp,
# so the job leaves nothing in the NFS home quota except logs and the host file.
#
# Submit:   sbatch hpc/vllm_serve.sbatch            (default model)
#           MODEL=Qwen/Qwen3.5-9B sbatch hpc/vllm_serve.sbatch
# Tunnel:   ssh -N -L 8001:$(cat ~/cqa/vllm_host):8000 student-lab
#SBATCH -J cqa-vllm
#SBATCH -p ws-ia
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=23:30:00
#SBATCH -o /home/%u/cqa/logs/%x-%j.log

set -uo pipefail
BASE=/tmp/$USER/cqa
mkdir -p "$BASE"
export UV_CACHE_DIR=$BASE/uvcache HF_HOME=$BASE/hf XDG_CACHE_HOME=$BASE/cache
export PATH=$BASE/bin:$PATH
export HF_HUB_ENABLE_HF_TRANSFER=1
# No nvcc on the nodes: FlashInfer's JIT sampler cannot compile -> use the PyTorch sampler.
export VLLM_USE_FLASHINFER_SAMPLER=0 FLASHINFER_WORKSPACE_BASE=$BASE/cache

MODEL=${MODEL:-Qwen/Qwen3.5-35B-A3B-GPTQ-Int4}
FALLBACK=${FALLBACK:-Qwen/Qwen3.5-9B}
KEY=$(cat "$HOME/cqa/vllm_key")

echo "[$(date)] node=$(hostname) model=$MODEL"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv

if [ ! -x "$BASE/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BASE/bin" UV_NO_MODIFY_PATH=1 sh
fi
# Driver 570 = CUDA 12.8: the default PyPI vLLM wheel needs CUDA 13, so pin the
# CUDA 12.9 build from the GitHub release (CUDA minor-version compatibility).
VLLM_VER=${VLLM_VER:-0.32.0}
VENV=$BASE/venv-$VLLM_VER
if [ ! -x "$VENV/bin/vllm" ]; then
  uv venv -q -p 3.12 "$VENV"
  uv pip install -q -p "$VENV" \
    "https://github.com/vllm-project/vllm/releases/download/v${VLLM_VER}/vllm-${VLLM_VER}+cu129-cp38-abi3-manylinux_2_28_x86_64.whl" \
    hf_transfer --torch-backend=cu129
fi
rm -rf "$BASE/venv"  # broken CUDA-13 env from the first attempt, if present
source "$VENV/bin/activate"
python -c "import torch, vllm; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'gpu', torch.cuda.is_available(), 'vllm', vllm.__version__)"

hostname > "$HOME/cqa/vllm_host"

serve() {
  vllm serve "$1" \
    --served-model-name local-judge \
    --host 0.0.0.0 --port 8000 --api-key "$KEY" \
    --max-model-len 16384 --max-num-seqs 16 \
    --gpu-memory-utilization 0.93 \
    --limit-mm-per-prompt '{"image":0,"video":0}' \
    --enable-prefix-caching
}

echo "[$(date)] starting $MODEL"
echo "$MODEL" > "$HOME/cqa/vllm_model"
serve "$MODEL"
echo "[$(date)] primary model exited ($?), trying fallback $FALLBACK"
echo "$FALLBACK" > "$HOME/cqa/vllm_model"
serve "$FALLBACK"
