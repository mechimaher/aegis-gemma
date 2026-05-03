"""
Aegis-Gemma: Local Gemma Inference Engine
Wraps llama-cpp-python for air-gapped, zero-trust LLM inference.
Produces structured crisis-response JSON from unstructured field reports.

Auto-detects CUDA for GPU offloading, falls back to CPU. Thread-safe, streaming.
"""

import json
import os
import re
import time
import logging
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, AsyncGenerator, Callable

logger = logging.getLogger("aegis.gemma")

# ─── Auto-configure CUDA runtime library paths ──────────
# If nvidia-cuda-runtime-cu12 / nvidia-cublas-cu12 are pip-installed,
# add their lib dirs to LD_LIBRARY_PATH so llama-cpp can find them.
def _setup_cuda_library_paths():
    lib_dirs = []
    for pkg in ["nvidia.cuda_runtime", "nvidia.cublas", "nvidia.cuda_nvrtc"]:
        try:
            mod = __import__(pkg, fromlist=[""])
            lib_dir = os.path.join(mod.__path__[0], "lib")
            if os.path.isdir(lib_dir):
                lib_dirs.append(lib_dir)
        except ImportError:
            pass
    if lib_dirs:
        existing = os.environ.get("LD_LIBRARY_PATH", "")
        new_paths = ":".join(lib_dirs)
        os.environ["LD_LIBRARY_PATH"] = f"{new_paths}:{existing}" if existing else new_paths
        import ctypes
        for d in lib_dirs:
            for f in os.listdir(d):
                if f.endswith(".so") or ".so." in f:
                    try:
                        ctypes.CDLL(os.path.join(d, f), mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
        logger.info(f"CUDA runtime paths injected: {lib_dirs}")

_setup_cuda_library_paths()

# ─── Global State ────────────────────────────────────────
_llm = None
_model_loaded = False
_gpu_layers_offloaded = 0
_inference_lock = threading.Lock()  # Serialize model access
_thread_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gemma")


def get_model_path() -> str:
    """Resolve the path to the GGUF model file."""
    models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
    # Search for any .gguf file in the models directory
    if os.path.exists(models_dir):
        for f in sorted(os.listdir(models_dir)):
            if f.endswith(".gguf"):
                return os.path.join(models_dir, f)
    return os.path.join(models_dir, "gemma-4-e2b-it.gguf")


def _detect_cuda_backend() -> bool:
    """Check if llama-cpp-python was compiled with CUDA support."""
    try:
        import llama_cpp
        lib_dir = os.path.join(os.path.dirname(llama_cpp.__file__), "lib")
        if os.path.isdir(lib_dir):
            for f in os.listdir(lib_dir):
                if "cuda" in f.lower() or "cublas" in f.lower():
                    return True
        return False
    except Exception:
        return False


def load_model(model_path: str = None) -> bool:
    """
    Load the Gemma GGUF model into memory.
    Attempts GPU offloading first, falls back to CPU-only if unavailable.
    """
    global _llm, _model_loaded, _gpu_layers_offloaded

    if _model_loaded and _llm is not None:
        logger.info("Model already loaded, skipping.")
        return True

    if model_path is None:
        model_path = get_model_path()

    if not os.path.exists(model_path):
        logger.error(f"Model file not found: {model_path}")
        logger.info("Please download a Gemma GGUF model and place it in the 'models/' directory.")
        logger.info("Example: hf download bartowski/google_gemma-4-E2B-it-GGUF --local-dir ./models/")
        _model_loaded = False
        return False

    # Detect available CPU threads
    cpu_count = os.cpu_count() or 4
    n_threads = max(4, cpu_count - 2)  # Leave 2 threads for OS/server

    has_cuda = _detect_cuda_backend()
    gpu_layers = 99 if has_cuda else 0
    if has_cuda:
        logger.info("CUDA backend detected — requesting GPU layer offloading")
    else:
        logger.warning("No CUDA backend in llama-cpp-python — running CPU-only")

    # Progressive GPU layer attempts: try full offload, then reduce if VRAM is tight
    gpu_attempts = [99, 24, 16, 10, 0] if has_cuda else [0]

    from llama_cpp import Llama

    for attempt_layers in gpu_attempts:
        try:
            logger.info(f"Loading model: {os.path.basename(model_path)}")
            logger.info(f"Attempting GPU layers: {attempt_layers}, Threads: {n_threads}, Context: 2048, Batch: 256")

            start = time.time()
            _llm = Llama(
                model_path=model_path,
                n_gpu_layers=attempt_layers,
                n_ctx=2048,
                n_threads=n_threads,
                n_batch=256,
                flash_attn=False,
                use_mmap=True,
                use_mlock=False,
                verbose=True,
            )
            elapsed = time.time() - start
            _gpu_layers_offloaded = attempt_layers
            if attempt_layers > 0:
                mode = f"GPU ({attempt_layers} layers) + CPU"
            else:
                mode = "CPU-only"
            logger.info(f"Model loaded in {elapsed:.1f}s ({mode})")
            _model_loaded = True
            return True

        except Exception as e:
            logger.warning(f"Failed with {attempt_layers} GPU layers: {e}")
            _llm = None
            continue

    logger.error("All load attempts failed")
    _model_loaded = False
    return False


def is_model_loaded() -> bool:
    """Check if the model is currently loaded."""
    return _model_loaded and _llm is not None


# ─── Prompt Builder ──────────────────────────────────────
def _build_prompt(report_text: str, latitude: float = 0.0,
                  longitude: float = 0.0) -> str:
    """Build a minimal, high-signal prompt for fast inference."""
    loc = ""
    if latitude != 0.0 or longitude != 0.0:
        loc = f" [{latitude:.4f},{longitude:.4f}]"

    return (
        f"You are AEGIS crisis AI. Analyze this report. "
        f"Reply ONLY with JSON.\n\n"
        f"Report{loc}: \"{report_text}\"\n\n"
        f"JSON format: "
        f"{{\"severity\":\"critical/high/medium/low\","
        f"\"priority\":1-10 (10=most urgent),"
        f"\"category\":\"medical/infrastructure/fire/flood/earthquake/evacuation/other\","
        f"\"affected_estimate\":number,"
        f"\"summary\":\"2 sentence summary\","
        f"\"recommended_action\":\"action\","
        f"\"resource_needs\":[\"r1\",\"r2\"],"
        f"\"risk_factors\":[\"risk1\"],"
        f"\"evacuation_needed\":true/false}}"
    )


# ─── Synchronous Inference (runs in thread pool) ─────────
def _run_inference_sync(report_text: str, latitude: float,
                        longitude: float) -> dict:
    """
    Run model inference synchronously.
    Thread-safe via _inference_lock — serializes concurrent requests.
    """
    prompt = _build_prompt(report_text, latitude, longitude)

    with _inference_lock:
        start = time.time()
        response = _llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=256,
            temperature=0.1,
            top_p=0.85,
            repeat_penalty=1.15,
        )
        elapsed = time.time() - start

    raw_text = response["choices"][0]["message"]["content"].strip()
    tokens = response.get("usage", {})
    prompt_tokens = tokens.get("prompt_tokens", 0)
    completion_tokens = tokens.get("completion_tokens", 0)
    total_tokens = tokens.get("total_tokens", 0)

    logger.info(
        f"Inference: {elapsed:.1f}s | "
        f"prompt={prompt_tokens} eval={completion_tokens} total={total_tokens} | "
        f"{completion_tokens / elapsed:.1f} tok/s"
    )

    if not raw_text:
        logger.warning("Model returned empty response, using fallback")
        result = _fallback_analysis(report_text, note="Empty model response")
        result["inference_time_ms"] = int(elapsed * 1000)
        result["model_used"] = "gemma-4-e2b-it-local (empty)"
        return result

    analysis = _parse_crisis_json(raw_text)
    analysis["inference_time_ms"] = int(elapsed * 1000)
    analysis["model_used"] = "gemma-4-e2b-it-local"
    analysis["tokens_used"] = total_tokens
    return analysis


# ─── Streaming Inference (runs in thread pool) ───────────
def _run_inference_streaming(report_text: str, latitude: float,
                             longitude: float,
                             on_token: Callable[[str], None]) -> dict:
    """
    Run model inference with per-token streaming callback.
    Allows progressive UI updates during generation.
    """
    prompt = _build_prompt(report_text, latitude, longitude)
    chunks = []

    with _inference_lock:
        start = time.time()
        stream = _llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=256,
            temperature=0.1,
            top_p=0.85,
            repeat_penalty=1.15,
            stream=True,
        )
        for chunk in stream:
            delta = chunk["choices"][0].get("delta", {})
            token = delta.get("content", "")
            if token:
                chunks.append(token)
                on_token(token)
        elapsed = time.time() - start

    raw_text = "".join(chunks).strip()
    logger.info(f"Streaming inference: {elapsed:.1f}s | {len(chunks)} chunks")

    if not raw_text:
        result = _fallback_analysis(report_text, note="Empty streamed response")
        result["inference_time_ms"] = int(elapsed * 1000)
        return result

    analysis = _parse_crisis_json(raw_text)
    analysis["inference_time_ms"] = int(elapsed * 1000)
    analysis["model_used"] = "gemma-4-e2b-it-local"
    analysis["tokens_used"] = len(chunks)
    return analysis


# ─── Async Wrappers ──────────────────────────────────────
async def analyze_crisis_report(report_text: str, latitude: float = 0.0,
                                longitude: float = 0.0) -> dict:
    """
    Non-blocking async inference — runs in thread pool to avoid
    blocking the FastAPI event loop.
    """
    if not is_model_loaded():
        return _fallback_analysis(report_text)

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _thread_pool,
            _run_inference_sync,
            report_text, latitude, longitude,
        )
        return result
    except Exception as e:
        logger.error(f"Inference failed: {e}", exc_info=True)
        return _fallback_analysis(report_text)


async def analyze_crisis_report_streaming(
    report_text: str,
    latitude: float,
    longitude: float,
    on_token: Callable[[str], None],
) -> dict:
    """
    Non-blocking async streaming inference.
    Calls on_token(str) for each generated token.
    """
    if not is_model_loaded():
        return _fallback_analysis(report_text)

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _thread_pool,
            _run_inference_streaming,
            report_text, latitude, longitude, on_token,
        )
        return result
    except Exception as e:
        logger.error(f"Streaming inference failed: {e}", exc_info=True)
        return _fallback_analysis(report_text)


# ─── JSON Parser ─────────────────────────────────────────
def _parse_crisis_json(raw_text: str) -> dict:
    """
    Robustly parse the model's JSON output.
    Handles common LLM output quirks (markdown wrappers, trailing text).
    """
    text = raw_text.strip()

    # Strip markdown code fences
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()

    # Direct parse attempt
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Extract JSON object from surrounding text
    match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    # Bracket matching fallback
    start_idx = text.find("{")
    if start_idx != -1:
        depth = 0
        for i in range(start_idx, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start_idx:i + 1])
                    except json.JSONDecodeError:
                        break

    logger.warning(f"Could not parse model output as JSON: {raw_text[:200]}")
    return _fallback_analysis(raw_text, note="Invalid JSON from model")


# ─── Keyword Fallback Engine ─────────────────────────────
def _fallback_analysis(report_text: str, note: str = "Model not loaded") -> dict:
    """
    Generate a rule-based fallback analysis when the model is unavailable.
    Uses keyword matching to provide basic triage.
    """
    text_lower = report_text.lower()

    # Keyword-based severity detection
    critical_keywords = ["dead", "death", "killed", "collapsed", "trapped", "explosion",
                         "active shooter", "mass casualty", "critical", "crush",
                         "gas leak", "pipeline rupture", "chemical", "toxic"]
    high_keywords = ["injured", "fire", "flooding", "blocked", "missing", "severe",
                     "emergency", "urgent", "rescue", "stranded", "blackout",
                     "power failure", "grid failure", "hospital", "evacuated",
                     "aftershock", "ignition"]
    medium_keywords = ["damaged", "displaced", "shelter", "supplies", "power outage",
                       "debris", "road closed", "leak", "disruption"]

    if any(kw in text_lower for kw in critical_keywords):
        severity = "critical"
        priority = 10
    elif any(kw in text_lower for kw in high_keywords):
        severity = "high"
        priority = 7
    elif any(kw in text_lower for kw in medium_keywords):
        severity = "medium"
        priority = 4
    else:
        severity = "low"
        priority = 2

    # Category detection
    category = "general"
    if any(kw in text_lower for kw in ["injured", "medical", "hospital", "ambulance", "casualty"]):
        category = "medical"
    elif any(kw in text_lower for kw in ["fire", "burn", "smoke"]):
        category = "fire"
    elif any(kw in text_lower for kw in ["flood", "water", "rain", "dam"]):
        category = "flood"
    elif any(kw in text_lower for kw in ["earthquake", "quake", "tremor", "seismic"]):
        category = "earthquake"
    elif any(kw in text_lower for kw in ["road", "bridge", "building", "infrastructure", "collapsed"]):
        category = "infrastructure"
    elif any(kw in text_lower for kw in ["evacuate", "evacuation", "shelter"]):
        category = "evacuation"

    return {
        "severity": severity,
        "priority": priority,
        "category": category,
        "affected_estimate": 0,
        "summary": f"Field report received. Automated triage: {severity} severity. {note}.",
        "recommended_action": "Dispatch assessment team to verify report and provide situation update.",
        "resource_needs": ["assessment_team", "communications"],
        "risk_factors": ["unverified_report"],
        "evacuation_needed": severity == "critical",
        "inference_time_ms": 0,
        "model_used": "fallback-keyword-engine",
        "tokens_used": 0,
    }


def get_model_status() -> dict:
    """Return current model status for the dashboard."""
    if _model_loaded:
        mode = "gpu-accelerated" if _gpu_layers_offloaded > 0 else "cpu-only"
    else:
        mode = "offline"
    return {
        "loaded": _model_loaded,
        "model_path": get_model_path() if _model_loaded else None,
        "engine": "llama.cpp (llama-cpp-python)",
        "mode": mode,
        "gpu_layers": _gpu_layers_offloaded,
        "cuda_available": _detect_cuda_backend(),
    }
