"""AuK studio — a local web control surface for AuK, run by helmstudio.

Wraps ``AukInfer`` in a small FastAPI app: it keeps one model variant resident
across requests (loading it is the slow part — 10-30s), and serves the page
that drives it.

AuK studio keeps nothing of its own. Sessions with their settings, the
reference clips they hold, every generated take and the log of the render that
made it all go through helmstudio's runtime SDK; :func:`connect` refuses to
start without it. That holds on its own too: a Python studio runs standalone
under ``helm dev``, whose embedded provider keeps the same things in ``./.helm``
— see web/run.sh. The SDK's same-origin proxy is mounted at ``/helm/``, through
which the page reaches helm-css, the browser runtime and the components without
ever holding the token.

The task catalog (instruction templates, per-task fields, duration semantics)
lives entirely in the frontend, static/tasks.js, and never reaches this server,
which only ever receives a finished instruction string — exactly like
``auk-infer`` itself.

Usage:
    helm dev -f helmstudio.yaml -venv .venv     (see web/run.sh)
"""

from __future__ import annotations

import argparse
import gc
import logging
import os
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

import torch
import torchaudio
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from auk.infer.infer_auk import AukInfer, get_gen_duration, save_audio


try:
    from helm_runtime_sdk import from_env
    from helm_runtime_sdk.proxy import PREFIX, Proxy
except ImportError:  # connect() says what is missing
    from_env = None
    PREFIX = "/helm/"
    Proxy = None

WEB_DIR = Path(__file__).resolve().parent
STATIC_DIR = WEB_DIR / "static"

#: Where the page reads an asset: the studio API, through the proxy.
ASSETS = f"{PREFIX}api/v1/assets/"

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("auk_studio")


# ------------------------------------------------------------------ helmstudio


class UnavailableError(RuntimeError):
    """AuK studio was started without helmstudio, or without its runtime SDK."""


def connect():
    """helmstudio's client and same-origin proxy, from the environment it starts AuK studio with."""
    if from_env is None:
        raise UnavailableError(
            "helm-runtime-sdk is not installed in this environment; AuK studio keeps everything through it. "
            "Install it with `uv pip install -r web/requirements.txt`."
        )
    if not os.environ.get("HELM_API"):
        raise UnavailableError(
            "helmstudio did not start AuK studio. Start it from helmstudio, or on its own with "
            "`helm dev -f helmstudio.yaml` (web/run.sh), which keeps what it stores in ./.helm"
        )
    return from_env(), Proxy.from_env()


def asset_url(asset_id: str) -> str:
    return f"{ASSETS}{asset_id}"


def stage_dir() -> Path:
    """Where a file waits to be adopted: helmstudio's stage for this studio."""
    stage = os.environ.get("HELM_STAGE_DIR")
    path = Path(stage) if stage else Path(tempfile.gettempdir()) / "auk-studio-stage"
    path.mkdir(parents=True, exist_ok=True)
    return path


class Render:
    """One generation, reported to helmstudio as a task job whose log the page's terminal streams.

    helmstudio refusing a line must never fail the render, so every call here
    is best-effort: a refusal is logged and the generation goes on.
    """

    #: The job of the render running now, which /api/health reports so the page's
    #: terminal can stream it from the moment it starts rather than when it ends.
    current: str | None = None

    def __init__(self, helm, session_id: str | None):
        self.helm = helm
        self.id: str | None = None
        try:
            job = helm.jobs.create({"state": "running", "subject_kind": "generation", "progress_den": 3})
            self.id = job.get("id")
        except Exception as exc:  # noqa: BLE001 — a job is telemetry; the render matters more
            logger.warning(f"[studio] helmstudio refused a job: {exc}")
        Render.current = self.id
        if session_id:
            self.log(f"session {session_id}")

    def log(self, line: str) -> None:
        logger.info(f"[render] {line}")
        if not self.id:
            return
        try:
            self.helm.jobs.append_log(self.id, {"lines": [line]})
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[studio] helmstudio refused a log line: {exc}")

    def progress(self, num: int) -> None:
        self._update({"progress_num": num})

    def finish(self, state: str, message: str = "") -> None:
        body: dict = {"state": state}
        if state == "failed" and message:
            body["last_error"] = {"code": "generate_failed", "message": message[:4000]}
        self._update(body)

    def _update(self, body: dict) -> None:
        if not self.id:
            return
        try:
            self.helm.jobs.update(self.id, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[studio] helmstudio refused a job update: {exc}")


# ------------------------------------------------------------------ engine


class EngineManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.engine: AukInfer | None = None
        self.variant: str | None = None
        self.device: str | None = None
        self.dtype: str | None = None
        self.cpu_offload: bool = False
        self.load_seconds: float | None = None
        #: True while a generation holds the engine, which /api/health reports as busy.
        self.busy: bool = False

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

    def ensure_loaded(self, variant: str, device: str, dtype: str, cpu_offload: bool, render: Render | None = None):
        with self.lock:
            if self._matches(variant, device, dtype, cpu_offload):
                return self.engine
            self._unload_locked()
            spec = VARIANTS.get(variant)
            if not spec or not spec["ckpt"].is_file():
                raise HTTPException(400, f"model variant not found on disk: {variant}")
            line = f"loading {variant} on {device} ({dtype}, cpu_offload={cpu_offload})"
            logger.info(f"[studio] {line} ...")
            if render:
                render.log(line)
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
            ready = f"{variant} ready in {self.load_seconds:.1f}s"
            logger.info(f"[studio] {ready}")
            if render:
                render.log(ready)
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
        self.load_seconds = None
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "mps":
            torch.mps.empty_cache()

    def generate(self, **kwargs):
        with self.lock:
            if self.engine is None:
                raise HTTPException(409, "no model loaded")
            self.busy = True
            try:
                return self.engine.generate(**kwargs)
            finally:
                self.busy = False


engines = EngineManager()

#: Set from the command line, which helmstudio fills in from the manifest's weights.
VARIANTS: dict[str, dict] = {}
QWEN_PATH: Path = Path()
HELM = None
PROXY = None


def _default_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ------------------------------------------------------------------ sessions, through helmstudio


def session_state(session: dict) -> dict:
    return session.get("state") or {}


def session_inputs(session: dict) -> list[dict]:
    return list(session_state(session).get("inputs") or [])


def open_session(session_id: str) -> dict:
    try:
        return HELM.sessions.get(session_id)
    except Exception as exc:  # noqa: BLE001 — surfaced to the page as a 404
        raise HTTPException(404, f"session not found: {exc}")


def decode_to_wav(upload: UploadFile, dest: Path) -> float:
    """Save an uploaded file and transcode it to ``dest``; its duration in seconds.

    Keeps the original extension on the temp file — torchaudio's backends sniff
    format from the suffix, so an extension-less temp file fails to decode.
    """
    suffix = Path(upload.filename or "").suffix or ".wav"
    tmp = dest.with_name(f"{dest.stem}.upload{suffix}")
    with open(tmp, "wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    try:
        wav, sr = torchaudio.load(str(tmp))
    finally:
        tmp.unlink(missing_ok=True)
    torchaudio.save(str(dest), wav, sr)
    return wav.shape[-1] / sr


# ------------------------------------------------------------------ app


app = FastAPI(title="AuK Studio")


@app.get("/api/health")
async def health():
    """Health and the busy contract in one: helmstudio probes this for both."""
    busy = engines.busy
    variants = {name: {"found": spec["ckpt"].is_file() and spec["config"].is_file()} for name, spec in VARIANTS.items()}
    return {
        "state": "busy" if busy else "idle",
        "loaded": engines.engine is not None,
        "message": f"generating with {engines.variant}" if busy else "",
        "job_id": Render.current,
        "cuda_available": torch.cuda.is_available(),
        "mps_available": torch.backends.mps.is_available(),
        "default_device": _default_device(),
        "variants": variants,
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


# --------------------------------------------------------------- sessions API


@app.get("/api/sessions")
async def api_list_sessions():
    page = await run_in_threadpool(HELM.sessions.list)
    return {"sessions": [{"id": s["id"], "name": s["name"]} for s in page.get("items", [])]}


@app.post("/api/sessions")
async def api_create_session(name: str = Form(...)):
    session = await run_in_threadpool(HELM.sessions.create, {"name": name, "state": {"inputs": []}})
    return {"id": session["id"], "name": session["name"]}


@app.post("/api/sessions/{session_id}/duplicate")
async def api_duplicate_session(session_id: str, new_name: str = Form(...)):
    session = await run_in_threadpool(HELM.sessions.duplicate, session_id, {"name": new_name})
    return {"id": session["id"], "name": session["name"]}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    await run_in_threadpool(HELM.sessions.delete, session_id)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/activate")
async def api_activate_session(session_id: str):
    await run_in_threadpool(HELM.sessions.activate, session_id)
    return {"ok": True}


@app.get("/api/sessions/{session_id}/history")
async def api_history(session_id: str):
    """This session's takes, as helmstudio's gallery holds them."""
    page = await run_in_threadpool(lambda: HELM.gallery.query(scope="self", session_id=session_id, limit=200))
    history = []
    for item in page.get("items", []):
        params = item.get("params") or {}
        asset = item.get("asset") or {}
        history.append(
            {
                "id": item["id"],
                "created_at": item.get("created_at"),
                "task_id": params.get("task_id", ""),
                "task_label": params.get("task_label", ""),
                "instruction": params.get("instruction", ""),
                "lang": params.get("lang", "en"),
                "variant": params.get("variant"),
                "device": params.get("device"),
                "dtype": params.get("dtype"),
                "cpu_offload": params.get("cpu_offload", False),
                "duration_mode": params.get("duration_mode"),
                "gen_seconds": params.get("gen_seconds"),
                "nfe": params.get("nfe"),
                "cfg": params.get("cfg"),
                "sway": params.get("sway"),
                "seed": params.get("seed"),
                "elapsed_seconds": params.get("elapsed_seconds"),
                "input": params.get("input"),
                "job_id": params.get("job_id"),
                "output": {
                    "asset_id": item["asset_id"],
                    "url": asset_url(item["asset_id"]),
                    "duration_seconds": asset.get("duration_s"),
                    "sample_rate": params.get("sample_rate"),
                },
            }
        )
    return {"history": history}


@app.delete("/api/sessions/{session_id}/history/{item_id}")
async def api_delete_history_entry(session_id: str, item_id: str):
    await run_in_threadpool(HELM.gallery.delete, item_id)
    return {"ok": True}


@app.get("/api/sessions/{session_id}/inputs")
async def api_list_inputs(session_id: str):
    session = await run_in_threadpool(open_session, session_id)
    return {"inputs": [dict(item, url=asset_url(item["id"])) for item in session_inputs(session)]}


@app.post("/api/sessions/{session_id}/inputs")
async def api_upload_input(session_id: str, audio: UploadFile = File(...)):  # noqa: B008 — FastAPI DI idiom
    session = await run_in_threadpool(open_session, session_id)
    dest = stage_dir() / f"{uuid.uuid4().hex[:12]}.wav"

    def _store() -> dict:
        duration = decode_to_wav(audio, dest)
        asset = HELM.assets.adopt({"path": str(dest), "kind": "audio", "duration_s": duration})
        return {"id": asset["id"], "filename": audio.filename or dest.name, "duration_seconds": duration}

    try:
        entry = await run_in_threadpool(_store)
    except Exception as exc:  # noqa: BLE001 — torchaudio's backends raise varying exception types
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"could not decode audio: {exc}")

    inputs = [item for item in session_inputs(session) if item["id"] != entry["id"]]
    inputs.insert(0, entry)
    await run_in_threadpool(HELM.sessions.update, session_id, {"state": {"inputs": inputs}})
    return dict(entry, url=asset_url(entry["id"]))


@app.post("/api/sessions/{session_id}/inputs:adopt")
async def api_adopt_input(
    session_id: str,
    asset_id: str = Form(...),
    filename: str = Form(""),
    duration_seconds: str = Form(""),
):
    """Use an asset helmstudio already holds — a take picked in the gallery — as this session's reference clip.

    The gallery item the page picked already carries the asset's metadata, so it
    is sent along rather than read back.
    """
    session = await run_in_threadpool(open_session, session_id)
    entry = {
        "id": asset_id,
        "filename": filename or f"take-{asset_id[:8]}.wav",
        "duration_seconds": _parse_float(duration_seconds),
    }
    inputs = [item for item in session_inputs(session) if item["id"] != asset_id]
    inputs.insert(0, entry)
    await run_in_threadpool(HELM.sessions.update, session_id, {"state": {"inputs": inputs}})
    return dict(entry, url=asset_url(asset_id))


@app.delete("/api/sessions/{session_id}/inputs/{asset_id}")
async def api_delete_input(session_id: str, asset_id: str):
    """Forget a clip in this session. Its bytes stay in helmstudio, which owns them."""
    session = await run_in_threadpool(open_session, session_id)
    inputs = [item for item in session_inputs(session) if item["id"] != asset_id]
    await run_in_threadpool(HELM.sessions.update, session_id, {"state": {"inputs": inputs}})
    return {"ok": True}


# --------------------------------------------------------------- generate


def _parse_float(s: str) -> float | None:
    s = (s or "").strip()
    return float(s) if s else None


def _parse_int(s: str) -> int | None:
    s = (s or "").strip()
    return int(s) if s else None


def _run_generation(
    *,
    session_id: str,
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
    input_asset: dict | None,
) -> dict:
    render = Render(HELM, session_id)
    ref_path: Path | None = None
    out_path = stage_dir() / f"{uuid.uuid4().hex[:12]}.wav"
    try:
        engines.ensure_loaded(variant, device, dtype, cpu_offload, render)
        render.progress(1)

        # The reference clip lives in helmstudio; AukInfer reads a path, so its
        # bytes come back to the stage for the length of this render.
        if input_asset:
            ref_path = stage_dir() / f"ref-{uuid.uuid4().hex[:12]}.wav"
            raw = HELM.assets.read(input_asset["id"])
            ref_path.write_bytes(raw.read() if hasattr(raw, "read") else bytes(raw))
            render.log(f"reference {input_asset.get('filename', input_asset['id'])}")

        resolved_seconds = gen_seconds
        if duration_mode == "estimate" and ref_path is not None:
            resolved_seconds = get_gen_duration(
                audio=str(ref_path), ref_text=ref_text or None, gen_text=gen_text or None, gen_seconds=None
            )
        elif duration_mode == "source":
            resolved_seconds = None

        realized_seed = seed if seed is not None else secrets.randbelow(2**31 - 1)
        content: list[dict] = [{"type": "text", "text": instruction}]
        if ref_path is not None:
            content.append({"type": "audio", "audio": str(ref_path)})
        messages = [{"role": "user", "content": content}]

        render.log(f"generating: {instruction[:200]}")
        render.progress(2)
        t0 = time.time()
        audio_out, sr = engines.generate(
            messages=messages,
            audio=str(ref_path) if ref_path else None,
            gen_seconds=resolved_seconds,
            nfe=nfe,
            cfg_strength=cfg,
            sway_sampling_coef=sway,
            t_grid=t_grid,
            seed=realized_seed,
        )
        elapsed = time.time() - t0

        save_audio(audio_out, sr, str(out_path))
        out_duration = audio_out.shape[-1] / sr
        asset = HELM.assets.adopt({"path": str(out_path), "kind": "audio", "duration_s": out_duration})
        render.log(f"done in {elapsed:.1f}s — {out_duration:.2f}s at {sr} Hz, seed {realized_seed}")

        params = {
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
            "sample_rate": sr,
            "input": input_asset,
            "job_id": render.id,
        }
        item = HELM.gallery.add(
            {
                "kind": "audio",
                "asset_id": asset["id"],
                "session_id": session_id,
                "title": task_label or "AuK",
                "params": params,
                "inputs": [{"asset_id": input_asset["id"], "role": "reference"}] if input_asset else [],
            }
        )
        render.progress(3)
        render.finish("succeeded")
        return {
            "id": item["id"],
            "created_at": item.get("created_at"),
            **params,
            "output": {
                "asset_id": asset["id"],
                "url": asset_url(asset["id"]),
                "duration_seconds": out_duration,
                "sample_rate": sr,
            },
        }
    except HTTPException as exc:
        render.log(f"failed: {exc.detail}")
        render.finish("failed", str(exc.detail))
        raise
    except Exception as exc:  # noqa: BLE001 — every failure is reported, then surfaced
        logger.exception("[studio] generation failed")
        render.log(f"failed: {exc}")
        render.finish("failed", str(exc))
        raise HTTPException(500, f"generation failed: {exc}")
    finally:
        if ref_path is not None:
            ref_path.unlink(missing_ok=True)
        out_path.unlink(missing_ok=True)


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
):
    if not instruction.strip():
        raise HTTPException(400, "instruction is required")
    device = device or _default_device()
    if cpu_offload and device != "cuda":
        raise HTTPException(400, "cpu_offload requires device=cuda")

    stored = await run_in_threadpool(open_session, session)
    input_asset = None
    if input_id:
        input_asset = next((item for item in session_inputs(stored) if item["id"] == input_id), None)
        if input_asset is None:
            raise HTTPException(404, "referenced input not found in this session")

    entry = await run_in_threadpool(
        _run_generation,
        session_id=session,
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
        t_grid=[float(x) for x in t_grid.split(",")] if t_grid.strip() else None,
        seed=_parse_int(seed),
        input_asset=input_asset,
    )
    return JSONResponse(entry)


# --------------------------------------------------------------- helmstudio's proxy


@app.api_route(
    "/helm/{path:path}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def helm_proxy(path: str, request: Request):
    """Everything the page reads from helmstudio, same-origin, without a token.

    The SDK's proxy decides what may be forwarded; this only carries the request
    to it and its answer back.
    """
    body = await request.body()
    status, headers, chunks = await run_in_threadpool(
        PROXY.respond,
        request.method,
        request.url.path,
        request.url.query,
        dict(request.headers),
        body or None,
    )
    # Streamed, never joined here: the body is read from a blocking socket, and
    # an event stream (a running render's log) never ends — draining it on the
    # event loop would stop the whole server.
    return StreamingResponse(chunks, status_code=status, headers=dict(headers))


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def main():
    p = argparse.ArgumentParser(description="AuK Studio web UI, run by helmstudio")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8420)
    p.add_argument("--checkpoint", default="", help="the chosen checkpoint directory ({models.selected})")
    p.add_argument("--qwen", default="", help="Qwen2.5-Omni-3B snapshot directory")
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()

    global HELM, PROXY, VARIANTS, QWEN_PATH
    try:
        HELM, PROXY = connect()
    except UnavailableError as exc:
        raise SystemExit(f"AuK studio: {exc}")

    QWEN_PATH = Path(args.qwen).expanduser().resolve()
    VARIANTS = _variants(args.checkpoint)
    found = [name for name, spec in VARIANTS.items() if spec["ckpt"].is_file()]
    logger.info(f"[studio] checkpoint: {', '.join(found) if found else 'none found'}")
    if not QWEN_PATH.is_dir():
        logger.warning(f"[studio] the Qwen encoder is not at {QWEN_PATH}; generation will fail until it is")

    import uvicorn

    if args.reload:
        uvicorn.run("server:app", host=args.host, port=args.port, reload=True)
    else:
        uvicorn.run(app, host=args.host, port=args.port)


def _variants(directory: str) -> dict[str, dict]:
    """The one checkpoint helmstudio chose, under the name it calls itself.

    AuK and AuK-Flash are selectable weights, so exactly one arrives; which one
    is read from the ``model.name`` in the config.yaml beside it, falling back
    to the checkpoint's own filename.
    """
    if not directory:
        return {}
    base = Path(directory).expanduser().resolve()
    config = base / "config.yaml"
    ckpt = next(iter(sorted(base.glob("*.safetensors"))), base / "auk_base.safetensors")
    # vae.safetensors ships beside the checkpoint; it is not the checkpoint.
    for candidate in sorted(base.glob("*.safetensors")):
        if candidate.name != "vae.safetensors":
            ckpt = candidate
            break
    name = "AuK-Flash" if "flash" in ckpt.name.lower() else "AuK"
    if config.is_file():
        try:
            from omegaconf import OmegaConf

            declared = OmegaConf.load(config).model.get("name")
            if declared:
                name = str(declared)
        except Exception as exc:  # noqa: BLE001 — the filename already named it
            logger.warning(f"[studio] could not read {config}: {exc}")
    return {name: {"ckpt": ckpt, "config": config}}


if __name__ == "__main__":
    main()
