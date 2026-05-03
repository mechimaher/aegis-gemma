#!/bin/bash
# ═══════════════════════════════════════════════════════
#  AEGIS-GEMMA: Air-Gapped Crisis Coordinator
#  Startup Script — single command deployment
# ═══════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════"
echo "  AEGIS-GEMMA Crisis Coordinator"
echo "  Air-Gapped Cognitive Intelligence Server"
echo "═══════════════════════════════════════════"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] Python 3 is required but not installed."
    exit 1
fi

# Create virtual environment if needed
if [ ! -d "venv" ]; then
    echo "[SETUP] Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install dependencies
echo "[SETUP] Installing dependencies..."
pip install -q -r requirements.txt

# Install llama-cpp-python if not present
if ! python3 -c "import llama_cpp" 2>/dev/null; then
    echo "[SETUP] Installing llama-cpp-python (CPU)..."
    pip install -q llama-cpp-python
fi

# Check for model
MODEL_DIR="$SCRIPT_DIR/models"
mkdir -p "$MODEL_DIR"
GGUF_COUNT=$(find "$MODEL_DIR" -name "*.gguf" 2>/dev/null | wc -l)

if [ "$GGUF_COUNT" -eq 0 ]; then
    echo ""
    echo "[WARNING] No GGUF model found in models/ directory."
    echo "   The server will run in FALLBACK mode (keyword-based analysis)."
    echo ""
    echo "   To enable Gemma AI inference, download a model:"
    echo "   pip install huggingface-hub"
    echo "   hf download bartowski/google_gemma-4-E2B-it-GGUF google_gemma-4-E2B-it-Q4_K_M.gguf --local-dir ./models/"
    echo ""
else
    echo "[OK] Model found: $(ls "$MODEL_DIR"/*.gguf)"
fi

# Check for GPU/CUDA
if python3 -c "
import os
try:
    import llama_cpp
    lib_dir = os.path.join(os.path.dirname(llama_cpp.__file__), 'lib')
    has_cuda = any('cuda' in f.lower() for f in os.listdir(lib_dir))
    print('CUDA' if has_cuda else 'CPU')
except:
    print('CPU')
" 2>/dev/null | grep -q "CUDA"; then
    echo "[OK] CUDA backend detected — GPU acceleration enabled"
else
    echo "[OK] CPU-only mode (install nvidia-cuda-toolkit + rebuild for GPU)"
fi

# Check for cached tiles
TILE_COUNT=$(find "$SCRIPT_DIR/tiles" -name "*.png" 2>/dev/null | wc -l)
if [ "$TILE_COUNT" -eq 0 ]; then
    echo "[WARNING] No cached map tiles found. Run: python3 cache_tiles.py"
else
    echo "[OK] Cached tiles: $TILE_COUNT tiles available offline"
fi

# Create data directory
mkdir -p "$SCRIPT_DIR/data"

echo ""
echo "[START] Server running on http://0.0.0.0:8080"
echo "   Press Ctrl+C to stop."
echo ""

# Start the server
python3 -m uvicorn backend.server:app \
    --host 0.0.0.0 \
    --port 8080 \
    --reload \
    --log-level info
