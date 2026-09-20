# AuK

**Speech generation and editing on Apple Silicon — with a local web studio.**

AuK runs [Tencent Hunyuan's AuK](https://github.com/Tencent-Hunyuan/AuK), a 1.5B
foundation model for speech, on PyTorch's `mps` backend: zero-shot and instruct
TTS, content and acoustic editing, paralinguistic editing, speech enhancement
and source separation — every one of them driven by the same natural-language
instruction, with no task-specific model to swap in.

This fork adds **AuK studio**: a browser UI over every task in the
[Cookbook](docs/COOKBOOK.md), built as a
[helmstudio](https://github.com/janishar/helmstudio) studio, so sessions,
reference clips, takes and render logs are kept for you instead of piling up in
the working directory. Nothing is sent off your machine.

[![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![PyTorch](https://img.shields.io/badge/PyTorch-2.7-EE4C2C?logo=pytorch&logoColor=white)](pyproject.toml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%28Apple%20Silicon%29-lightgrey?logo=apple)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Upstream's own README — demos, benchmark tables, ComfyUI, the Gradio demo and
> the Prompt Enhancer — is kept verbatim at [AUK.md](AUK.md). This one covers
> running it here.

## Motivation

AuK ships as a CLI and a Gradio demo. Both reload 14-25 GB of weights per
invocation and leave their outputs as loose files, so iterating on a voice means
re-running long command lines and then working out which `out_3.wav` came from
which instruction.

AuK studio keeps one model resident and records every take with the instruction
and sampling parameters that produced it. Measured in this repo on a MacBook Pro
(M5 Pro), AuK-Flash on `mps`/bf16:

| | Before upstream's fp32 fix | After |
| --- | --- | --- |
| Resident memory | 21.3 GB | **13.8 GB** |
| Model load | 15.9 s | **8.3 s** |

The saving is the Qwen encoder no longer being upcast to fp32 alongside the DiT
— only the DiT needs it. Warm, a 3.5 s clip then generates in about 2.4 s on
AuK-Flash.

## Table of contents

- [Motivation](#motivation)
- [Requirements](#requirements)
- [Installation](#installation)
- [Downloading the weights](#downloading-the-weights)
- [Usage](#usage)
  - [Web studio](#web-studio)
  - [Command line](#command-line)
  - [Python API](#python-api)
- [Supported tasks](#supported-tasks)
- [Sessions and state](#sessions-and-state)
- [Model variants](#model-variants)
- [Fine-tuning](#fine-tuning)
- [Limits](#limits)
- [Contributing](#contributing)
- [Citation](#citation)
- [License](#license)

## Requirements

### Hardware and OS

- **Apple Silicon Mac.** Verified on the `mps` backend. The engine has CUDA and
  CPU paths too; neither is exercised here.
- **Unified memory:** 32 GB is comfortable. AuK-Flash is ~13.8 GB resident on
  `mps`/bf16, AuK base is larger, and generation adds latents on top.
- **Disk:** ~11 GB for the Qwen encoder, plus ~7 GB per checkpoint.

### Toolchain

- **Python 3.12+** and **[uv](https://docs.astral.sh/uv/)**. 3.10 is no longer
  supported: scipy's last 3.10 wheel does not load on recent macOS, and
  `qwen-omni-utils` reaches it through librosa.
- **[helmstudio](https://github.com/janishar/helmstudio)** for the studio —
  either helmstudio itself, or its `helm` CLI to run the studio on its own.
- **Hugging Face CLI** (`hf`) to download weights by hand.

## Installation

```bash
git clone https://github.com/janishar/AuK.git
cd AuK
uv venv --python 3.12
uv pip install -e . -r web/requirements.txt
```

That installs the `auk` package and its `auk-infer` command, plus helmstudio's
runtime SDK for the studio. Add `uv pip install -e ".[train]"` for fine-tuning.

> The `[gradio]` and `[comfyui]` extras pull in `WeTextProcessing`, whose
> `pynini` dependency needs OpenFst (`brew install openfst`) before it builds.
> Neither extra is needed for the studio or the CLI.

## Downloading the weights

helmstudio fetches the weights from the manifest, so skip this if you are using
the studio through the launcher. To place them by hand, or to use the CLI:

```bash
hf download Qwen/Qwen2.5-Omni-3B --local-dir ./ckpts/Qwen2.5-Omni-3B   # encoder, always needed
hf download tencent/AuK-Flash    --local-dir ./ckpts/AuK-Flash         # 4-step distilled
hf download tencent/AuK          --local-dir ./ckpts/AuK               # base
```

Either checkpoint is enough on its own; both need the encoder. ModelScope
mirrors are listed in [AUK.md](AUK.md#download-the-weights).

## Usage

### Web studio

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/janishar/helmstudio/main/installer/install.sh)"   # helm, once
AUK_MODELS=./ckpts bash web/run.sh
```

`web/run.sh` runs the studio under helmstudio's `helm dev`, linking whichever
weights it finds under `AUK_MODELS` and keeping everything in `./.helm`.
helmstudio can also install and start it from
[`helmstudio.yaml`](helmstudio.yaml).

The page writes the instruction for you: pick a task, fill only the fields that
task needs, and the Cookbook's template is assembled in EN or 中文 — still a
plain textarea, so anything the form doesn't cover can be typed directly.
Reference clips can be dropped, browsed for or recorded from the mic, and
picking a take out of the gallery makes it the reference for the next edit.

**There is no authentication.** See [Limits](#limits) before binding it to
anything but `127.0.0.1`. [web/README.md](web/README.md) is the full studio
guide: running it, debugging it, and where everything is kept.

### Command line

The CLI is unchanged from upstream and reads `ckpts/` directly. Every task is
the same call — an instruction, optional audio, and a target length only where
the output isn't the same length as the input:

```bash
# Zero-shot TTS: say something new in the reference voice
auk-infer --device mps \
    --audio assets/demo-input-audio/zero-shot-tts/ref.wav \
    --instruction "Say the following with the same voice: 'Ladies and gentlemen.'" \
    --gen_seconds 6.0 --output out_tts.wav

# Content editing: change what was said
auk-infer --device mps \
    --audio assets/demo-input-audio/content-edit/content.wav \
    --instruction "Replace 'but accepting what we cannot have' with 'and living well with dreams unmet'." \
    --gen_seconds 7.0 --output out_edit.wav

# Enhancement: say what to keep or remove; length follows the source
auk-infer --device mps \
    --audio assets/demo-input-audio/se/se-zh-1-input.wav \
    --instruction "Preserve all speakers, remove noise and reverberation, and output clean speech of the same length." \
    --output out_clean.wav
```

Pass `--device mps` — the CLI's own auto-detection looks for CUDA and otherwise
falls back to CPU. Add `--ckpt ckpts/AuK-Flash/auk_flash.safetensors` for the
distilled model, `--cpu_offload` (CUDA only) to trade speed for memory. Full
flags: `auk-infer --help`.

### Python API

```python
from auk.infer.infer_auk import AukInfer, save_audio

engine = AukInfer("ckpts/AuK/config.yaml", "ckpts/AuK/auk_base.safetensors", device="mps")

messages = [{"role": "user", "content": [
    {"type": "text", "text": "Change the emotion to happy."},
    {"type": "audio", "audio": "assets/demo-input-audio/emotion-edit/en-1-input.wav"},
]}]

audio, sr = engine.generate(messages)
save_audio(audio, sr, "out_happy.wav")
```

Per-task templates and examples: [docs/COOKBOOK.md](docs/COOKBOOK.md).

## Supported tasks

All sixteen go through the same instruction interface, and the studio renders a
form for each. The [Cookbook](docs/COOKBOOK.md) has the EN and CN templates.

| Category | Tasks |
| --- | --- |
| **Speech generation** | Zero-shot TTS · Instruct TTS |
| **Content editing** | Speech content editing · Lyric editing |
| **Acoustic editing** | Pitch · Speed · Volume |
| **Paralinguistic editing** | Emotion · Timbre · De-accent · Nonverbal · Whisper conversion |
| **Enhancement & separation** | Speech enhancement · Speech separation · Music separation · Target speaker extraction |

![AuK performance across speech generation, editing, enhancement, and separation benchmarks](assets/performance.png)

## Sessions and state

The studio keeps nothing of its own. Sessions and the reference clips they hold,
every take with the parameters that made it, and each render's log are kept by
helmstudio through its runtime SDK — see
[web/README.md](web/README.md#where-things-are-kept). The CLI, by contrast,
writes wherever `--output` points.

## Model variants

| Model | Sampling | Use it for |
| --- | --- | --- |
| **AuK** | configurable NFE/CFG, 32 steps by default | highest quality |
| **AuK-Flash** | fixed 4-step, CFG off | fast iteration |

AuK-Flash is a distilled student with guidance baked in, so the engine pins its
recipe and ignores `--nfe`/`--cfg`; re-adding CFG clips the output hard. Each
variant is 14-25 GB resident, so the studio holds one at a time and helmstudio
owns which one that is.

![Model architecture](assets/arch.png)

## Fine-tuning

A lightweight pipeline over JSONL pairs of instruction, optional source audio
and target audio, driven by [`scripts/train.sh`](scripts/train.sh). Data format,
dynamic batching, EMA, checkpoints and resuming are in
[docs/FINETUNING.md](docs/FINETUNING.md).

## Limits

- **No authentication** in the studio. It binds `127.0.0.1` and assumes the
  machine is yours; do not expose it.
- **A generation cannot be cancelled** once it starts, and AuK's sampler exposes
  no per-step callback, so progress is the render log rather than a bar.
- **One model at a time.** Switching variants unloads and reloads.
- **Uploaded audio is decoded by torchaudio** — WAV always works; other formats
  depend on your build's codecs.
- The CLI's device auto-detection does not know about `mps`; pass `--device mps`.

## Contributing

Bug reports, documentation, tests and fixes are welcome — see the
[Contributing Guide](docs/CONTRIBUTING.md) and
[Code of Conduct](docs/CODE_OF_CONDUCT.md). Upstream is
[Tencent-Hunyuan/AuK](https://github.com/Tencent-Hunyuan/AuK); model-level
changes belong there.

## Citation

```bibtex
@misc{ma2026auktechnicalreportopensource,
  title         = {AuK Technical Report: An Open-Source Foundational Model for Speech Generation and Editing},
  author        = {Ziyang Ma and Zhikang Niu and Wenming Tu and Tianrui Wang and Ruiqi Yan and Junxi Liu and Yanru Huo and Nickk Huang and Yang Liu and Qicong Xie and Zeyu Xie and Hui Wang and Haitao Li and Zixuan Jiang and Yalin Li and Jie Fang and Yifan Duan and Zeyue Tian and Guangzheng Li and Haina Zhu and Shuyi Wang and Jinwen Wang and Mingyu Cui and Tian Tan and Auden and Sen Liang and Steve Yves and Shan Yang and Liefeng Bo and Zilong Zheng and Kai Yu and Eng-Siong Chng and Xie Chen},
  year          = {2026},
  eprint        = {2609.08936},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SD},
  url           = {https://arxiv.org/abs/2609.08936}
}
```

## License

MIT — see [LICENSE](LICENSE). Model weights carry their own terms on Hugging
Face.
