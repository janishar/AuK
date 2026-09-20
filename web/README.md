# AuK studio

A local web control surface for AuK — a guided, cookbook-driven UI over every
task in [docs/COOKBOOK.md](../docs/COOKBOOK.md) (zero-shot/instruct TTS,
content/acoustic/paralinguistic editing, enhancement, separation), without
needing to hand-write instruction strings.

It is a **helmstudio studio**: a small FastAPI server (`server.py`) plus a
no-build-step vanilla JS page (`static/`), described by
[`helmstudio.yaml`](../helmstudio.yaml) in the repository root.

AuK studio keeps nothing of its own — see "Where things are kept" below.

## Running

Under helmstudio, either from the launcher or on its own:

```bash
AUK_MODELS=/path/to/models bash web/run.sh
```

That runs `helm dev`, whose embedded provider keeps everything in `./.helm`.
`AUK_MODELS` is a directory holding `AuK`, `AuK-Flash` and `Qwen2.5-Omni-3B`;
each that exists is linked as a weight, and without it `helm dev` downloads
them. `AUK_CHECKPOINT=auk|auk_flash` picks which checkpoint runs (default: the
one on disk). `bash web/run.sh stop` ends it.

Then open the URL `helm dev` prints (the studio itself listens on 8420).

Requires [`helm`](https://helmstudio.in/docs/install-helm/) and a `.venv` with
this repo and `web/requirements.txt` installed:

```bash
uv venv --python 3.12
uv pip install -e . -r web/requirements.txt
```

`server.py` refuses to start outside helmstudio, since that is where it keeps
everything.

## Where things are kept

Nothing is stored in this repository. Everything goes through helmstudio's
runtime SDK, which the manifest declares capabilities for:

| What | Where |
|---|---|
| Sessions, and which reference clips each holds | helmstudio sessions (`state`), which the kv capability backs |
| Reference clips, and every generated take | assets |
| Takes with the instruction and sampling parameters that made them | gallery |
| Each render's log | a task job, streamed by the page's `helm-terminal` |

The page reaches all of it through the SDK's same-origin proxy at `/helm/`, so
it never holds the token, and it is themed by helm-css's tokens plus the
studio's own hue.

## Using it

1. Pick a **task** on the left — the Cookbook's five categories. Each renders
   only the fields it needs.
2. The **instruction** is built from those fields as you type, in EN or 中文;
   it is a plain textarea, so you can hand-edit anything the form doesn't cover
   (it stops auto-updating once you do).
3. Drop, browse for, or **record** the reference audio a task needs. It is
   stored as an asset and listed in the session's **Reference library**.
   **Gallery** in the top bar browses everything this studio has made, and
   picking a take makes it the reference clip — so an edit can be chained onto
   a generation.
4. **Duration** adapts per task: same-length tasks match the source;
   TTS/speed/content edits ask for a target (prefilled from the source);
   Zero-shot TTS also offers "estimate from text", mirroring `--ref_text`/
   `--gen_text`.
5. Choose device and dtype. The checkpoint is whichever one helmstudio was
   given — AuK and AuK-Flash are selectable weights, and the studio runs one at
   a time because each is 14-25 GB resident. AuK-Flash locks the sampling
   knobs to its fixed 4-step / CFG-off recipe, same as the CLI.
6. Hit **Generate**. The model loads on first use; the **Terminal** streams
   that render's log live from helmstudio.
7. Every take lands in **Generations** with a player, download, delete and
   **Reuse settings** (which restores the task, model and sampling knobs,
   including the realized seed).

## Notes & honest limitations

- AuK's sampler has no per-step callback, so there is no step-by-step progress
  bar; the job's log lines are the real signal of what phase is running.
- A generation cannot be cancelled once started (same as the CLI), so there is
  deliberately no Cancel button that would lie about it.
- Uploaded audio is decoded with `torchaudio`: WAV always works, other formats
  depend on the codecs your torchaudio build has.
- Deleting a session removes it and its settings; the takes it made stay in
  helmstudio's gallery, which owns them.
