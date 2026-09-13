"""AuK Studio — a local web control surface for the AuK inference engine.

Wraps ``AukInfer`` in a small FastAPI app: keeps one model variant resident in
memory across requests (loading it fresh is the slow part — 10-30s), streams
its logs to the browser over SSE, and persists generations into named
sessions on disk. The task/instruction-template catalog lives entirely in the
frontend (static/tasks.js) — this server only ever sees a finished instruction
string plus generation parameters, exactly like ``auk-infer`` itself.
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import logging
import re
import secrets
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import torch
import torchaudio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from auk.infer.infer_auk import AukInfer, get_gen_duration, save_audio


ROOT = Path(__file__).resolve().parent.parent
CKPTS = ROOT / "ckpts"
SESSIONS_DIR = Path(__file__).resolve().parent / "sessions"
STATIC_DIR = Path(__file__).resolve().parent / "static"

VARIANTS = {
    "AuK": {"ckpt": CKPTS / "AuK" / "auk_base.safetensors", "config": CKPTS / "AuK" / "config.yaml"},
    "AuK-Flash": {"ckpt": CKPTS / "AuK-Flash" / "auk_flash.safetensors", "config": CKPTS / "AuK-Flash" / "config.yaml"},
}
QWEN_PATH = CKPTS / "Qwen2.5-Omni-3B"

SAFE_NAME = re.compile(r"^[A-Za-z0-9_\-.]{1,80}$")


def _default_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _sanitize(name: str) -> str:
    if not SAFE_NAME.match(name):
        raise HTTPException(400, f"invalid name: {name!r}")
    return name


# ------------------------------------------------------------------ log fan-out (SSE terminal panel)


class BroadcastLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.subscribers: list[asyncio.Queue] = []
        self.loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self.subscribers:
            self.subscribers.remove(q)

    def emit(self, record: logging.LogRecord):
        if not self.loop:
            return
        try:
            msg = self.format(record)
        except Exception:  # noqa: BLE001 — a logging handler must never raise
            return
        for q in list(self.subscribers):
            self.loop.call_soon_threadsafe(self._put_nowait, q, msg)

    @staticmethod
    def _put_nowait(q: asyncio.Queue, msg: str):
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(msg)


log_handler = BroadcastLogHandler()
log_handler.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))
logging.getLogger().addHandler(log_handler)
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("auk_studio")


# ------------------------------------------------------------------ engine manager


class EngineManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.engine: AukInfer | None = None
        self.variant: str | None = None
        self.device: str | None = None
        self.dtype: str | None = None
        self.cpu_offload: bool = False
        self.loaded_at: float | None = None
        self.load_seconds: float | None = None

    def status(self) -> dict:
        return {
            "loaded": self.engine is not None,
            "variant": self.variant,
            "device": self.device,
            "dtype": self.dtype,
            "cpu_offload": self.cpu_offload,
            "load_seconds": self.load_seconds,
        }

    def _matches(self, variant, device, dtype, cpu_offload) -> bool:
        return (
            self.engine is not None
            and self.variant == variant
            and self.device == device
            and self.dtype == dtype
            and self.cpu_offload == cpu_offload
        )

    def ensure_loaded(self, variant: str, device: str, dtype: str, cpu_offload: bool) -> AukInfer:
        with self.lock:
            if self._matches(variant, device, dtype, cpu_offload):
                return self.engine
            self._unload_locked()
            spec = VARIANTS.get(variant)
            if not spec or not spec["ckpt"].is_file():
                raise HTTPException(400, f"model variant not found on disk: {variant}")
            logger.info(f"[studio] loading {variant} on {device} ({dtype}, cpu_offload={cpu_offload}) ...")
            t0 = time.time()
            engine = AukInfer(
                str(spec["config"]),
                str(spec["ckpt"]),
                device=device,
                dtype=dtype,
                qwen_path=str(QWEN_PATH),
                cpu_offload=cpu_offload,
            )
            self.load_seconds = time.time() - t0
            self.engine, self.variant, self.device, self.dtype, self.cpu_offload = (
                engine,
                variant,
                device,
                dtype,
                cpu_offload,
            )
            self.loaded_at = time.time()
            logger.info(f"[studio] {variant} ready in {self.load_seconds:.1f}s")
            return engine

    def load(self, variant: str, device: str, dtype: str, cpu_offload: bool) -> dict:
        self.ensure_loaded(variant, device, dtype, cpu_offload)
        return self.status()

    def unload(self) -> dict:
        with self.lock:
            self._unload_locked()
        return self.status()

    def _unload_locked(self):
        if self.engine is None:
            return
        logger.info(f"[studio] unloading {self.variant} ...")
        device = self.device
        del self.engine
        self.engine = self.variant = self.device = self.dtype = None
        self.cpu_offload = False
        self.loaded_at = self.load_seconds = None
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "mps":
            torch.mps.empty_cache()

    def generate(self, **kwargs):
        with self.lock:
            if self.engine is None:
                raise HTTPException(409, "no model loaded")
            return self.engine.generate(**kwargs)


engines = EngineManager()


# ------------------------------------------------------------------ session storage


def session_dir(name: str) -> Path:
    return SESSIONS_DIR / _sanitize(name)


def ensure_session(name: str) -> Path:
    d = session_dir(name)
    (d / "inputs").mkdir(parents=True, exist_ok=True)
    (d / "outputs").mkdir(parents=True, exist_ok=True)
    history = d / "history.json"
    if not history.is_file():
        history.write_text("[]")
    return d


def list_sessions() -> list[str]:
    if not SESSIONS_DIR.is_dir():
        return []
    return sorted(p.name for p in SESSIONS_DIR.iterdir() if p.is_dir())


def read_history(name: str) -> list[dict]:
    f = session_dir(name) / "history.json"
    if not f.is_file():
        return []
    return json.loads(f.read_text())


def write_history_entry(name: str, entry: dict):
    f = session_dir(name) / "history.json"
    hist = read_history(name)
    hist.insert(0, entry)
    f.write_text(json.dumps(hist[:300], ensure_ascii=False, indent=2))


def decode_upload_to_wav(upload: UploadFile, dest_wav: Path) -> float:
    """Save an uploaded file and transcode it to ``dest_wav``.

    Keeps the original extension on the temp file — torchaudio's backends sniff
    format from the suffix, so a ``.raw``/extension-less temp file fails to decode.
    """
    orig_suffix = Path(upload.filename or "").suffix or ".wav"
    tmp = dest_wav.with_suffix(orig_suffix if orig_suffix != ".wav" else ".upload.wav")
    with open(tmp, "wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    try:
        wav, sr = torchaudio.load(str(tmp))
    finally:
        tmp.unlink(missing_ok=True)
    torchaudio.save(str(dest_wav), wav, sr)
    return wav.shape[-1] / sr


# ------------------------------------------------------------------ app


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log_handler.loop = asyncio.get_event_loop()
    if not list_sessions():
        ensure_session("default")
    yield


app = FastAPI(title="AuK Studio", lifespan=lifespan)


@app.get("/api/health")
async def health():
    def variant_info(spec):
        return {"found": spec["ckpt"].is_file() and spec["config"].is_file()}

    return {
        "cuda_available": torch.cuda.is_available(),
        "mps_available": torch.backends.mps.is_available(),
        "default_device": _default_device(),
        "variants": {name: variant_info(spec) for name, spec in VARIANTS.items()},
        "qwen_found": QWEN_PATH.is_dir(),
        "engine": engines.status(),
    }


@app.post("/api/models/load")
async def api_load_model(
    variant: str = Form(...),
    device: str = Form(""),
    dtype: str = Form("bf16"),
    cpu_offload: bool = Form(False),
):
    device = device or _default_device()
    if cpu_offload and device != "cuda":
        raise HTTPException(400, "cpu_offload requires device=cuda")
    return await run_in_threadpool(engines.load, variant, device, dtype, cpu_offload)


@app.post("/api/models/unload")
async def api_unload_model():
    return await run_in_threadpool(engines.unload)


@app.get("/api/logs/stream")
async def logs_stream():
    q = log_handler.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                msg = await q.get()
                yield f"data: {json.dumps(msg)}\n\n"
        finally:
            log_handler.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream")


# --------------------------------------------------------------- sessions API


@app.get("/api/sessions")
async def api_list_sessions():
    return {"sessions": list_sessions()}


@app.post("/api/sessions")
async def api_create_session(name: str = Form(...)):
    name = _sanitize(name)
    if (SESSIONS_DIR / name).is_dir():
        raise HTTPException(409, "session already exists")
    ensure_session(name)
    return {"name": name}


@app.post("/api/sessions/{name}/duplicate")
async def api_duplicate_session(name: str, new_name: str = Form(...)):
    src = session_dir(name)
    new_name = _sanitize(new_name)
    dst = SESSIONS_DIR / new_name
    if not src.is_dir():
        raise HTTPException(404, "session not found")
    if dst.is_dir():
        raise HTTPException(409, "session already exists")
    shutil.copytree(src, dst)
    return {"name": new_name}


@app.delete("/api/sessions/{name}")
async def api_delete_session(name: str):
    d = session_dir(name)
    if not d.is_dir():
        raise HTTPException(404, "session not found")
    remaining = [s for s in list_sessions() if s != name]
    shutil.rmtree(d)
    if not remaining:
        ensure_session("default")
    return {"ok": True}


@app.get("/api/sessions/{name}/history")
async def api_history(name: str):
    ensure_session(name)
    return {"history": read_history(name)}


@app.get("/api/sessions/{name}/inputs")
async def api_list_inputs(name: str):
    d = ensure_session(name) / "inputs"
    items = []
    for f in sorted(d.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta_f = f.with_suffix(".json")
        meta = json.loads(meta_f.read_text()) if meta_f.is_file() else {}
        items.append(
            {
                "id": f.stem,
                "filename": meta.get("original_name", f.name),
                "url": f"/media/{name}/inputs/{f.name}",
                "duration_seconds": meta.get("duration_seconds"),
            }
        )
    return {"inputs": items}


@app.post("/api/sessions/{name}/inputs")
async def api_upload_input(name: str, audio: UploadFile = File(...)):  # noqa: B008 — FastAPI DI idiom
    d = ensure_session(name) / "inputs"
    file_id = uuid.uuid4().hex[:12]
    dest = d / f"{file_id}.wav"

    def _save():
        duration = decode_upload_to_wav(audio, dest)
        (d / f"{file_id}.json").write_text(json.dumps({"original_name": audio.filename, "duration_seconds": duration}))
        return duration

    try:
        duration = await run_in_threadpool(_save)
    except Exception as e:  # noqa: BLE001 — torchaudio's backends raise varying exception types
        raise HTTPException(400, f"could not decode audio: {e}")

    return {
        "id": file_id,
        "filename": audio.filename,
        "url": f"/media/{name}/inputs/{file_id}.wav",
        "duration_seconds": duration,
    }


@app.delete("/api/sessions/{name}/inputs/{file_id}")
async def api_delete_input(name: str, file_id: str):
    d = session_dir(name) / "inputs"
    for f in d.glob(f"{_sanitize(file_id)}.*"):
        f.unlink()
    return {"ok": True}


@app.delete("/api/sessions/{name}/history/{entry_id}")
async def api_delete_history_entry(name: str, entry_id: str):
    d = session_dir(name)
    hist = read_history(name)
    keep, drop = [], []
    for e in hist:
        (drop if e.get("id") == entry_id else keep).append(e)
    (d / "history.json").write_text(json.dumps(keep, ensure_ascii=False, indent=2))
    for e in drop:
        out = e.get("output") or {}
        fn = out.get("filename")
        if fn:
            (d / "outputs" / fn).unlink(missing_ok=True)
            (d / "outputs" / f"{Path(fn).stem}.json").unlink(missing_ok=True)
    return {"ok": True}


@app.get("/media/{session}/{kind}/{filename}")
async def media(session: str, kind: str, filename: str):
    if kind not in ("inputs", "outputs"):
        raise HTTPException(404)
    _sanitize(session)
    if "/" in filename or ".." in filename:
        raise HTTPException(400)
    path = session_dir(session) / kind / filename
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav")


# --------------------------------------------------------------- generate


def _parse_float(s: str) -> float | None:
    s = (s or "").strip()
    return float(s) if s else None


def _parse_int(s: str) -> int | None:
    s = (s or "").strip()
    return int(s) if s else None


def _run_generation(
    *,
    session: str,
    task_id: str,
    task_label: str,
    instruction: str,
    lang: str,
    variant: str,
    device: str,
    dtype: str,
    cpu_offload: bool,
    duration_mode: str,
    gen_seconds: float | None,
    ref_text: str,
    gen_text: str,
    nfe: int,
    cfg: float,
    sway: float,
    t_grid: list[float] | None,
    seed: int | None,
    audio_path: Path | None,
    input_meta: dict | None,
) -> dict:
    engines.ensure_loaded(variant, device, dtype, cpu_offload)

    resolved_seconds = gen_seconds
    if duration_mode == "estimate" and audio_path is not None:
        resolved_seconds = get_gen_duration(
            audio=str(audio_path), ref_text=ref_text or None, gen_text=gen_text or None, gen_seconds=None
        )
    elif duration_mode == "source":
        resolved_seconds = None

    realized_seed = seed if seed is not None else secrets.randbelow(2**31 - 1)

    content = [{"type": "text", "text": instruction}]
    if audio_path is not None:
        content.append({"type": "audio", "audio": str(audio_path)})
    messages = [{"role": "user", "content": content}]

    t0 = time.time()
    try:
        audio_out, sr = engines.generate(
            messages=messages,
            audio=str(audio_path) if audio_path else None,
            gen_seconds=resolved_seconds,
            nfe=nfe,
            cfg_strength=cfg,
            sway_sampling_coef=sway,
            t_grid=t_grid,
            seed=realized_seed,
        )
    except Exception as e:
        logger.exception("[studio] generation failed")
        raise HTTPException(500, f"generation failed: {e}")
    elapsed = time.time() - t0

    out_dir = ensure_session(session) / "outputs"
    entry_id = uuid.uuid4().hex[:12]
    out_name = f"{entry_id}.wav"
    save_audio(audio_out, sr, str(out_dir / out_name))
    out_duration = audio_out.shape[-1] / sr

    entry = {
        "id": entry_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id,
        "task_label": task_label,
        "instruction": instruction,
        "lang": lang,
        "variant": variant,
        "device": device,
        "dtype": dtype,
        "cpu_offload": cpu_offload,
        "duration_mode": duration_mode,
        "gen_seconds": resolved_seconds,
        "nfe": nfe,
        "cfg": cfg,
        "sway": sway,
        "t_grid": t_grid,
        "seed": realized_seed,
        "elapsed_seconds": elapsed,
        "input": input_meta,
        "output": {
            "filename": out_name,
            "url": f"/media/{session}/outputs/{out_name}",
            "duration_seconds": out_duration,
            "sample_rate": sr,
        },
    }
    write_history_entry(session, entry)
    return entry


@app.post("/api/generate")
async def api_generate(
    session: str = Form(...),
    task_id: str = Form(""),
    task_label: str = Form(""),
    instruction: str = Form(...),
    lang: str = Form("en"),
    variant: str = Form(...),
    device: str = Form(""),
    dtype: str = Form("bf16"),
    cpu_offload: bool = Form(False),
    duration_mode: str = Form("source"),
    gen_seconds: str = Form(""),
    ref_text: str = Form(""),
    gen_text: str = Form(""),
    nfe: int = Form(32),
    cfg: float = Form(2.0),
    sway: float = Form(-1.0),
    t_grid: str = Form(""),
    seed: str = Form(""),
    input_id: str = Form(""),
    audio: UploadFile | None = File(None),  # noqa: B008 — FastAPI DI idiom
):
    if not instruction.strip():
        raise HTTPException(400, "instruction is required")
    device = device or _default_device()
    if cpu_offload and device != "cuda":
        raise HTTPException(400, "cpu_offload requires device=cuda")

    ensure_session(session)
    audio_path: Path | None = None
    input_meta: dict | None = None

    if audio is not None and audio.filename:
        d = session_dir(session) / "inputs"
        file_id = uuid.uuid4().hex[:12]
        dest = d / f"{file_id}.wav"

        duration = await run_in_threadpool(decode_upload_to_wav, audio, dest)
        (d / f"{file_id}.json").write_text(json.dumps({"original_name": audio.filename, "duration_seconds": duration}))
        audio_path = dest
        input_meta = {
            "id": file_id,
            "filename": audio.filename,
            "url": f"/media/{session}/inputs/{file_id}.wav",
            "duration_seconds": duration,
        }
    elif input_id:
        candidate = session_dir(session) / "inputs" / f"{_sanitize(input_id)}.wav"
        if not candidate.is_file():
            raise HTTPException(404, "referenced input not found")
        audio_path = candidate
        meta_f = candidate.with_suffix(".json")
        meta = json.loads(meta_f.read_text()) if meta_f.is_file() else {}
        input_meta = {
            "id": input_id,
            "filename": meta.get("original_name", candidate.name),
            "url": f"/media/{session}/inputs/{candidate.name}",
            "duration_seconds": meta.get("duration_seconds"),
        }

    t_grid_list = [float(x) for x in t_grid.split(",")] if t_grid.strip() else None

    entry = await run_in_threadpool(
        _run_generation,
        session=session,
        task_id=task_id,
        task_label=task_label,
        instruction=instruction,
        lang=lang,
        variant=variant,
        device=device,
        dtype=dtype,
        cpu_offload=cpu_offload,
        duration_mode=duration_mode,
        gen_seconds=_parse_float(gen_seconds),
        ref_text=ref_text,
        gen_text=gen_text,
        nfe=nfe,
        cfg=cfg,
        sway=sway,
        t_grid=t_grid_list,
        seed=_parse_int(seed),
        audio_path=audio_path,
        input_meta=input_meta,
    )
    return JSONResponse(entry)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def main():
    p = argparse.ArgumentParser(description="AuK Studio web UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8420)
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()

    import uvicorn

    if args.reload:
        uvicorn.run("server:app", host=args.host, port=args.port, reload=True)
    else:
        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
