# AuK Studio

A local web control surface for AuK — a guided, cookbook-driven UI over every
task in [docs/COOKBOOK.md](../docs/COOKBOOK.md) (zero-shot/instruct TTS,
content/acoustic/paralinguistic editing, enhancement, separation), without
needing to hand-write instruction strings.

It's a small FastAPI server (`server.py`) plus a no-build-step vanilla JS
frontend (`static/`). The server keeps one `AukInfer` model resident in memory
across requests (loading it is the slow part — reloading per-request the way
`auk-infer` does would make the UI painful to iterate in), streams its logs to
the browser's terminal panel over SSE, and persists generations into named
sessions on disk under `web/sessions/<name>/`.

The task catalog (instruction templates, EN/CN wording, which fields each task
needs, duration semantics) lives entirely in `static/tasks.js` and never
touches the server — `server.py` only ever receives a finished instruction
string, exactly like `auk-infer` itself. Add a task by editing that one file.

## Setup

Install into the **same environment** you already set up for AuK core
(`pip install -e .` from the repo root) — the server imports `auk.infer.infer_auk`
directly:

```bash
source .venv/bin/activate   # from repo root
pip install -r web/requirements.txt
```

## Running

```bash
bash web/run.sh --port 8420
```

Or from VS Code: **Run and Debug → "AuK Studio: Run server"** (or the
`--reload` variant), defined in [`.vscode/launch.json`](../.vscode/launch.json)
— it uses the repo's `.venv` interpreter directly, so no extra setup beyond
the steps above.

Then open `http://127.0.0.1:8420`. Pass `--reload` while editing the frontend
to auto-restart on server-side changes (`static/` is served live either way —
just refresh the browser).

The server expects the usual `ckpts/AuK`, `ckpts/AuK-Flash`, and
`ckpts/Qwen2.5-Omni-3B` layout at the repo root (symlinks are fine). Whichever
variants are actually found are shown in the model picker; the rest are
greyed out.

## Using it

1. Pick a **task** on the left — grouped exactly like the Cookbook's five
   categories. Each task renders only the fields it actually needs (e.g.
   Speed Editing asks for a speed factor; De-accent asks for nothing).
2. The **instruction** textarea is built automatically from those fields as
   you type, in the language (EN/中文) you've selected — but it's a normal
   textarea, so you can freely hand-edit it for anything the guided form
   doesn't cover; it just stops auto-updating once you touch it.
3. Drop, browse for, or **record** (via your mic, encoded to WAV entirely in
   the browser — no server round-trip needed to capture it) the source /
   reference audio a task needs. Everything you add is saved into the
   session's **Reference library** on the right so you can reuse the same
   voice across many tasks without re-uploading.
4. **Duration** controls adapt per task: same-length tasks (enhancement,
   pitch, emotion, …) just match the source; TTS/speed/content-edits ask for
   an explicit target (with a source-derived suggestion prefilled); Zero-shot
   TTS additionally offers "estimate from text", mirroring `--ref_text`/
   `--gen_text` in the CLI.
5. Choose the **model** (only downloaded variants are selectable), device,
   dtype, and CPU offload (CUDA-only, matching the core engine's own
   constraint). AuK-Flash automatically locks the advanced sampling knobs,
   same as the CLI.
6. Hit **Generate**. The model loads on first use (or click **Load model**
   ahead of time) — the terminal panel on the right mirrors the real
   `AukInfer` log lines so model loading isn't a silent black box.
7. Every generation lands in the **Generations** gallery with its own player,
   download, delete, and **Reuse settings** (which restores the task, fields,
   model, and sampling knobs — including the exact realized seed — so you can
   iterate).

## Sessions

Sessions are just directories:

```
web/sessions/<name>/
  inputs/          uploaded/recorded reference audio + a small .json sidecar
  outputs/         generated wavs, one history.json entry each
  history.json     full generation history for the session (params + results)
```

Switch, create, duplicate, or delete them from the top bar — duplicating
copies a session's reference audio and history so you can branch an
experiment without losing the original.

## Notes & honest limitations

- AuK's sampler has no per-diffusion-step callback, so there's no live
  step-by-step progress bar — the progress panel is an elapsed-time indicator,
  and the terminal panel's log lines (`Loading Qwen…`, `Loaded EMA weights…`,
  `Saved output …`) are the real signal of what phase is running.
- Generation can't be cancelled mid-run once started (same constraint as the
  CLI) — there's deliberately no "Cancel" button that would lie about that.
- Only one model variant is kept resident at a time; switching variants
  unloads and reloads (each is ~15-25GB, unlikely to both fit in memory at
  once on most machines anyway).
- Uploaded audio is decoded with `torchaudio` — WAV is guaranteed to work;
  other formats depend on the codecs available to your torchaudio build.
