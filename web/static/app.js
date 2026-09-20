(() => {
  "use strict";

  // ------------------------------------------------------------- state
  const state = {
    health: null,
    session: null,
    sessions: [],
    history: [],
    inputs: [],
    category: AUK_CATEGORIES[0],
    task: null,
    values: {},
    lang: "en",
    instructionEdited: false,
    source: null, // {id, url, duration_seconds, filename}
    durationMode: null,
    recording: false,
    mediaRecorder: null,
    recordChunks: [],
    recordStart: 0,
    recordTimerHandle: null,
    genStart: 0,
    genTimerHandle: null,
    jobPollHandle: null,
    pendingUploadFile: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmtSec = (s) => (s == null ? "—" : `${s.toFixed(2)}s`);

  // ------------------------------------------------------------- api helpers
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }
  const apiForm = (path, formData, method = "POST") => api(path, { method, body: formData });
  const apiJson = (path, obj, method = "POST") => {
    const fd = new FormData();
    Object.entries(obj).forEach(([k, v]) => fd.append(k, v));
    return apiForm(path, fd, method);
  };

  // ------------------------------------------------------------- health / engine
  async function loadHealth() {
    state.health = await api("/api/health");
    renderEnginePills();
    renderVariantSeg();
    renderDeviceSelect();
    renderEngineStatus();
  }

  function renderEnginePills() {
    const wrap = $("enginePills");
    wrap.innerHTML = "";
    const h = state.health;
    if (!h) return;
    Object.entries(h.variants).forEach(([name, info]) => {
      const active = h.engine.loaded && h.engine.variant === name;
      const pill = el("span", `engine-pill ${info.found ? "found" : ""} ${active ? "active" : ""}`, name);
      if (!info.found) pill.title = "not found under ckpts/";
      else if (active) pill.title = `loaded on ${h.engine.device}`;
      wrap.appendChild(pill);
    });
  }

  function renderVariantSeg() {
    const seg = $("variantSeg");
    seg.innerHTML = "";
    const current = seg.dataset.value || Object.keys(state.health.variants).find((v) => state.health.variants[v].found);
    Object.entries(state.health.variants).forEach(([name, info]) => {
      const btn = el("button", name === current ? "active" : "", name);
      btn.disabled = !info.found;
      btn.onclick = () => { seg.dataset.value = name; renderVariantSeg(); onVariantChange(); };
      seg.appendChild(btn);
    });
    seg.dataset.value = current;
    onVariantChange();
  }

  function onVariantChange() {
    const isFlash = $("variantSeg").dataset.value === "AuK-Flash";
    ["nfeInput", "cfgInput", "swayInput"].forEach((id) => { $(id).disabled = isFlash; });
    $("flashNote").classList.toggle("hidden", !isFlash);
  }

  function renderDeviceSelect() {
    const sel = $("deviceSelect");
    sel.innerHTML = "";
    const opts = [];
    if (state.health.cuda_available) opts.push("cuda");
    if (state.health.mps_available) opts.push("mps");
    opts.push("cpu");
    opts.forEach((d) => sel.appendChild(el("option", null, d)).value = d);
    sel.value = state.health.default_device;
    sel.onchange = onDeviceChange;
    onDeviceChange();
  }

  function onDeviceChange() {
    const isCuda = $("deviceSelect").value === "cuda";
    $("cpuOffloadInput").disabled = !isCuda;
    if (!isCuda) $("cpuOffloadInput").checked = false;
  }

  function renderEngineStatus() {
    const e = state.health.engine;
    $("engineStatusText").textContent = e.loaded
      ? `${e.variant} loaded on ${e.device}/${e.dtype}${e.cpu_offload ? " +cpu_offload" : ""} (${e.load_seconds.toFixed(1)}s load)`
      : "no model loaded";
    $("loadModelBtn").disabled = e.loaded;
    $("unloadModelBtn").disabled = !e.loaded;
  }

  $("loadModelBtn").onclick = async () => {
    $("loadModelBtn").disabled = true;
    try {
      await apiJson("/api/models/load", currentEngineParams());
    } catch (e) { alert(`Load failed: ${e.message}`); }
    await loadHealth();
  };
  $("unloadModelBtn").onclick = async () => {
    await api("/api/models/unload", { method: "POST" });
    await loadHealth();
  };

  function currentEngineParams() {
    return {
      variant: $("variantSeg").dataset.value,
      device: $("deviceSelect").value,
      dtype: $("dtypeSelect").value,
      cpu_offload: $("cpuOffloadInput").checked,
    };
  }

  // ------------------------------------------------------------- task picker
  function renderCategoryTabs() {
    const wrap = $("categoryTabs");
    wrap.innerHTML = "";
    AUK_CATEGORIES.forEach((cat) => {
      const btn = el("button", cat === state.category ? "active" : "", cat);
      btn.onclick = () => { state.category = cat; renderCategoryTabs(); renderTaskGrid(); };
      wrap.appendChild(btn);
    });
  }

  function renderTaskGrid() {
    const wrap = $("taskGrid");
    wrap.innerHTML = "";
    AUK_TASKS.filter((t) => t.category === state.category).forEach((task) => {
      const btn = el("button", `task-btn ${state.task && state.task.id === task.id ? "active" : ""}`);
      btn.appendChild(el("span", null, task.label));
      btn.appendChild(el("span", "task-btn-desc", task.description));
      btn.onclick = () => selectTask(task);
      wrap.appendChild(btn);
    });
  }

  function selectTask(task) {
    state.task = task;
    state.values = {};
    task.fields.forEach((f) => { if (f.default !== undefined) state.values[f.key] = String(f.default); });
    state.instructionEdited = false;
    state.durationMode = task.defaultMode;
    renderTaskGrid();
    $("taskDetail").classList.remove("hidden");
    $("taskTitle").textContent = task.label;
    $("taskDesc").textContent = task.description;
    $("cookbookTemplate").textContent = `${task.templateNote}\n\n→ docs/${task.cookbookRef}`;
    const hint = $("inputHint");
    if (task.inputHint) { hint.textContent = task.inputHint; hint.style.display = "block"; } else { hint.style.display = "none"; }
    $("sourceReq").textContent = task.audio === "required" ? "(required)" : "(not used for this task)";
    renderFields();
    renderDurationControl();
    updateInstructionPreview();
    validateForm();
  }

  function fieldVisible(f) {
    if (!f.when) return true;
    for (const [k, v] of Object.entries(f.when)) {
      if (k === "if") continue;
      if (state.values[k] !== v) return false;
    }
    if (f.when.if && !f.when.if(state.values)) return false;
    return true;
  }

  function renderFields() {
    const wrap = $("fieldContainer");
    wrap.innerHTML = "";
    state.task.fields.forEach((f) => {
      if (!fieldVisible(f)) return;
      const row = el("div", "field-row");
      const label = el("label", "field-label", f.label);
      row.appendChild(label);
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        f.options.forEach((o) => {
          const opt = el("option", null, o.label);
          opt.value = o.value;
          input.appendChild(opt);
        });
        input.value = state.values[f.key] ?? f.default ?? f.options[0].value;
      } else if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = f.rows || 4;
        input.placeholder = f.placeholder || "";
        input.value = state.values[f.key] ?? "";
      } else {
        input = document.createElement("input");
        input.type = f.type === "number" ? "number" : "text";
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.step !== undefined) input.step = f.step;
        input.placeholder = f.placeholder || "";
        input.value = state.values[f.key] ?? "";
      }
      input.oninput = input.onchange = () => {
        state.values[f.key] = input.value;
        // Only selects gate other fields' visibility (via `when`), so only they
        // need a structural re-render — rebuilding on every keystroke would tear
        // down and recreate the focused text/textarea input, dropping focus.
        if (f.type === "select") renderFields();
        renderDurationControl();
        state.instructionEdited = false;
        updateInstructionPreview();
        validateForm();
      };
      row.appendChild(input);
      wrap.appendChild(row);
    });
  }

  function updateInstructionPreview() {
    if (!state.task) return;
    if (!state.instructionEdited) {
      const text = buildInstruction(state.task, state.values, state.lang);
      $("instructionPreview").value = text;
    }
  }

  $("instructionPreview").addEventListener("input", () => { state.instructionEdited = true; validateForm(); });

  $("langToggle").querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      state.lang = btn.dataset.lang;
      $("langToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.instructionEdited = false;
      updateInstructionPreview();
    };
  });

  // ------------------------------------------------------------- duration control
  function renderDurationControl() {
    const wrap = $("durationControl");
    wrap.innerHTML = "";
    if (!state.task) return;
    const modes = state.task.durationModes;
    const labels = { source: "Match source", explicit: "Explicit seconds", estimate: "Estimate from text" };
    const row = el("div", "duration-modes");
    modes.forEach((m) => {
      const disabled = m === "estimate" && !state.source;
      const btn = el("button", m === state.durationMode ? "active" : "", labels[m]);
      btn.disabled = disabled;
      btn.onclick = () => { state.durationMode = m; renderDurationControl(); validateForm(); };
      row.appendChild(btn);
    });
    wrap.appendChild(row);

    if (state.durationMode === "source") {
      wrap.appendChild(el("div", "hint", state.source
        ? `Output will match the source clip (${fmtSec(state.source.duration_seconds)}).`
        : "Output will match the source clip's length."));
    } else if (state.durationMode === "explicit") {
      const inputRow = el("div", "field-row");
      const input = document.createElement("input");
      input.type = "number"; input.min = "0.1"; input.step = "0.1"; input.id = "genSecondsInput";
      input.placeholder = "target seconds";
      let suggested = null;
      if (state.task.autoDuration === "speed" && state.source) {
        const factor = state.values.factor === "custom" ? parseFloat(state.values.customFactor || "1.5") : parseFloat(state.values.factor || "1.5");
        if (factor > 0) suggested = state.source.duration_seconds / factor;
      } else if (state.source && !state.values.__gen_seconds_dirty) {
        suggested = state.source.duration_seconds;
      }
      // Until the user edits it (__gen_seconds_dirty), keep the field's value in
      // sync with the live suggestion — both on screen AND in state, so what's
      // displayed is actually what validation checks and what gets submitted.
      if (!state.values.__gen_seconds_dirty) {
        state.values.__gen_seconds = suggested != null ? suggested.toFixed(2) : "";
      }
      input.value = state.values.__gen_seconds ?? "";
      input.oninput = () => { state.values.__gen_seconds = input.value; state.values.__gen_seconds_dirty = true; validateForm(); };
      inputRow.appendChild(input);
      wrap.appendChild(inputRow);
      if (suggested != null) wrap.appendChild(el("div", "hint", `Suggested from source: ${suggested.toFixed(2)}s`));
    } else if (state.durationMode === "estimate") {
      const refRow = el("div", "field-row");
      refRow.appendChild(el("label", "field-label", "Reference transcript (what the source audio says)"));
      const refInput = document.createElement("textarea");
      refInput.rows = 2;
      refInput.value = state.values.__ref_text ?? "";
      refInput.oninput = () => { state.values.__ref_text = refInput.value; };
      refRow.appendChild(refInput);
      wrap.appendChild(refRow);
      wrap.appendChild(el("div", "hint", "Target duration is estimated from the ratio of target-text length to this transcript's length, scaled by the source clip's duration."));
    }
  }

  function currentGenSeconds() {
    if (state.durationMode !== "explicit") return "";
    return state.values.__gen_seconds || "";
  }

  // ------------------------------------------------------------- source audio (upload / record / library)
  function describeUploadError(err) {
    // fetch() itself (not an HTTP error response) rejects with a generic,
    // browser-specific message on any network failure — "Load failed" in
    // Safari, "Failed to fetch" in Chrome — most commonly because the local
    // server isn't reachable (stopped, restarting). Give that a clear,
    // actionable message instead of the raw browser wording.
    const looksLikeNetworkError = err instanceof TypeError || /load failed|failed to fetch|networkerror/i.test(err.message || "");
    if (looksLikeNetworkError) {
      return "Couldn't reach the AuK Studio server (it may be stopped or restarting). Your recording wasn't lost — retry once it's back up.";
    }
    return `Upload failed: ${err.message}`;
  }

  function showUploadError(file, err) {
    state.pendingUploadFile = file;
    $("uploadRetryBtn").hidden = !file;
    $("uploadErrorText").textContent = describeUploadError(err);
    $("uploadErrorBanner").classList.remove("hidden");
  }

  function clearUploadError() {
    state.pendingUploadFile = null;
    $("uploadErrorBanner").classList.add("hidden");
  }

  async function uploadToLibrary(file) {
    try {
      const fd = new FormData();
      fd.append("audio", file, file.name);
      const res = await apiForm(`/api/sessions/${state.session}/inputs`, fd);
      await refreshInputs();
      setSource(res);
      clearUploadError();
    } catch (err) {
      showUploadError(file, err);
    }
  }

  $("uploadRetryBtn").onclick = () => {
    if (state.pendingUploadFile) uploadToLibrary(state.pendingUploadFile);
  };

  function setSource(src) {
    state.source = src;
    $("sourcePreview").classList.remove("hidden");
    $("sourceAudioEl").src = src.url;
    $("sourceMeta").textContent = `${src.filename} · ${fmtSec(src.duration_seconds)}`;
    renderRefGallery();
    renderDurationControl();
    validateForm();
  }

  $("sourceClearBtn").onclick = () => {
    state.source = null;
    $("sourcePreview").classList.add("hidden");
    clearUploadError();
    renderRefGallery();
    renderDurationControl();
    validateForm();
  };

  const dropZone = $("dropZone");
  dropZone.onclick = () => $("fileInput").click();
  ["dragover", "dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.toggle("drag", evt === "dragover");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) uploadToLibrary(f);
  });
  $("fileInput").onchange = (e) => {
    const f = e.target.files[0];
    if (f) uploadToLibrary(f);
  };

  // --- microphone recording, encoded to WAV entirely client-side ---
  function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
    const bytesPerSample = 2, blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const bufOut = new ArrayBuffer(44 + dataSize);
    const view = new DataView(bufOut);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, dataSize, true);
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([bufOut], { type: "audio/wav" });
  }

  $("recordBtn").onclick = async () => {
    if (state.recording) { state.mediaRecorder.stop(); return; }
    let stream;
    // Undefined rather than denied when the page has no microphone permission
    // at all — an embedding frame without allow="microphone", or a non-secure
    // origin. Dropping a file still works, so say which it is.
    if (!navigator.mediaDevices) {
      alert("Recording is not available here: this page was given no microphone permission. Open the studio in a tab, or drop a file instead.");
      return;
    }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert(`Microphone access denied: ${e.message}`); return; }
    state.recordChunks = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => state.recordChunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      state.recording = false;
      $("recordBtn").classList.remove("recording");
      $("recordBtn").textContent = "● Record";
      $("recordTimer").classList.add("hidden");
      clearInterval(state.recordTimerHandle);
      const blob = new Blob(state.recordChunks, { type: mr.mimeType });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const arrBuf = await blob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrBuf);
      const wavBlob = audioBufferToWav(audioBuf);
      const file = new File([wavBlob], `recording-${Date.now()}.wav`, { type: "audio/wav" });
      uploadToLibrary(file);
    };
    state.mediaRecorder = mr;
    state.recording = true;
    state.recordStart = Date.now();
    mr.start();
    $("recordBtn").classList.add("recording");
    $("recordBtn").textContent = "■ Stop";
    $("recordTimer").classList.remove("hidden");
    state.recordTimerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - state.recordStart) / 1000);
      $("recordTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
  };

  // ------------------------------------------------------------- reference library (right panel)
  async function refreshInputs() {
    const res = await api(`/api/sessions/${state.session}/inputs`);
    state.inputs = res.inputs;
    renderRefGallery();
  }

  function renderRefGallery() {
    $("refCount").textContent = state.inputs.length ? `(${state.inputs.length})` : "";
    const wrap = $("refGallery");
    wrap.innerHTML = "";
    if (!state.inputs.length) { wrap.appendChild(el("div", "hint", "No saved audio yet. Drop a file or record on the left.")); return; }
    state.inputs.forEach((inp) => {
      const item = el("div", `ref-item ${state.source && state.source.id === inp.id ? "selected" : ""}`);
      const top = el("div", "ref-item-top");
      top.appendChild(el("span", "ref-item-name", `${inp.filename} · ${fmtSec(inp.duration_seconds)}`));
      const del = el("button", "ref-del", "✕");
      del.onclick = async (e) => {
        e.stopPropagation();
        await api(`/api/sessions/${state.session}/inputs/${inp.id}`, { method: "DELETE" });
        if (state.source && state.source.id === inp.id) { state.source = null; $("sourcePreview").classList.add("hidden"); }
        await refreshInputs();
        renderDurationControl();
        validateForm();
      };
      top.appendChild(del);
      item.appendChild(top);
      item.onclick = () => setSource(inp);
      wrap.appendChild(item);
    });
  }

  // ------------------------------------------------------------- validation
  function validationErrors() {
    const errs = [];
    if (!state.task) errs.push("Choose a task.");
    else {
      if (state.task.audio === "required" && !state.source) errs.push("This task needs source/reference audio.");
      if (!state.instructionEdited) {
        state.task.fields.forEach((f) => {
          if (f.optional || f.type === "select" || f.type === "number" || !fieldVisible(f)) return;
          if (!q(state.values[f.key])) errs.push(`Fill in "${f.label}".`);
        });
      }
      if (!$("instructionPreview").value.trim()) errs.push("Instruction is empty.");
      if (state.durationMode === "explicit" && !currentGenSeconds()) errs.push("Set a target duration.");
      if (!state.health || !state.health.variants[$("variantSeg").dataset.value]?.found) errs.push("Selected model isn't downloaded.");
    }
    return errs;
  }

  function q(s) { return (s || "").trim(); }

  function validateForm() {
    const errs = validationErrors();
    const box = $("validationErrors");
    if (errs.length) {
      box.classList.remove("hidden");
      box.innerHTML = `<ul>${errs.map((e) => `<li>${e}</li>`).join("")}</ul>`;
    } else {
      box.classList.add("hidden");
    }
    $("generateBtn").disabled = errs.length > 0;
    return errs.length === 0;
  }

  // ------------------------------------------------------------- generate
  $("generateBtn").onclick = async () => {
    if (!validateForm()) return;
    const btn = $("generateBtn");
    btn.disabled = true;
    $("progressSection").classList.remove("hidden");
    state.genStart = Date.now();
    state.genTimerHandle = setInterval(() => {
      $("progressTimer").textContent = `${((Date.now() - state.genStart) / 1000).toFixed(1)}s`;
    }, 100);
    state.jobPollHandle = setInterval(async () => {
      try {
        const h = await api("/api/health");
        if (h.job_id) showJob(h.job_id);
      } catch (_) {}
    }, 1000);

    const params = currentEngineParams();
    const fd = new FormData();
    fd.append("session", state.session);
    fd.append("task_id", state.task.id);
    fd.append("task_label", state.task.label);
    fd.append("instruction", $("instructionPreview").value);
    fd.append("lang", state.lang);
    fd.append("variant", params.variant);
    fd.append("device", params.device);
    fd.append("dtype", params.dtype);
    fd.append("cpu_offload", params.cpu_offload);
    fd.append("duration_mode", state.durationMode);
    fd.append("gen_seconds", currentGenSeconds());
    fd.append("ref_text", state.values.__ref_text || "");
    fd.append("gen_text", state.values.text || state.values.new || "");
    fd.append("nfe", $("nfeInput").value);
    fd.append("cfg", $("cfgInput").value);
    fd.append("sway", $("swayInput").value);
    fd.append("seed", $("seedInput").value);
    if (state.source) fd.append("input_id", state.source.id);

    try {
      const entry = await apiForm("/api/generate", fd);
      if (entry.job_id) showJob(entry.job_id);
      state.history.unshift(entry);
      renderGallery();
      showOutput(entry);
    } catch (e) {
      alert(`Generation failed: ${e.message}`);
    } finally {
      clearInterval(state.genTimerHandle);
      clearInterval(state.jobPollHandle);
      $("progressSection").classList.add("hidden");
      validateForm();
      loadHealth();
    }
  };

  function showOutput(entry) {
    $("outputCard").classList.remove("hidden");
    $("outputAudioEl").src = entry.output.url;
    $("outputMeta").innerHTML = `
      <span>${entry.task_label}</span>
      <span>${fmtSec(entry.output.duration_seconds)} @ ${entry.output.sample_rate}Hz</span>
      <span>seed ${entry.seed}</span>
      <span>${entry.elapsed_seconds.toFixed(1)}s</span>`;
  }

  function renderGallery() {
    $("takeCount").textContent = state.history.length ? `(${state.history.length})` : "";
    const wrap = $("gallery");
    wrap.innerHTML = "";
    if (!state.history.length) { wrap.appendChild(el("div", "hint", "No generations yet in this session.")); return; }
    state.history.forEach((entry) => {
      const card = el("div", "take");
      const top = el("div", "take-top");
      top.appendChild(el("span", "take-task", entry.task_label || entry.task_id || "—"));
      top.appendChild(el("span", "take-time", new Date(entry.created_at).toLocaleTimeString()));
      card.appendChild(top);
      card.appendChild(el("div", "take-instruction", entry.instruction));
      const audio = document.createElement("audio");
      audio.controls = true; audio.src = entry.output.url;
      card.appendChild(audio);
      const actions = el("div", "take-actions");
      const reuseBtn = el("button", null, "Reuse settings");
      reuseBtn.onclick = () => reuseEntry(entry);
      const dlBtn = el("button", null, "Download");
      dlBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = entry.output.url; a.download = `${entry.task_id || "auk"}-${entry.id}.wav`;
        document.body.appendChild(a); a.click(); a.remove();
      };
      const delBtn = el("button", null, "Delete");
      delBtn.onclick = async () => {
        await api(`/api/sessions/${state.session}/history/${entry.id}`, { method: "DELETE" });
        state.history = state.history.filter((h) => h.id !== entry.id);
        renderGallery();
      };
      actions.append(reuseBtn, dlBtn, delBtn);
      card.appendChild(actions);
      wrap.appendChild(card);
    });
  }

  function reuseEntry(entry) {
    const task = AUK_TASKS.find((t) => t.id === entry.task_id);
    if (task) {
      state.category = task.category;
      renderCategoryTabs(); renderTaskGrid();
      selectTask(task);
    }
    state.instructionEdited = true;
    $("instructionPreview").value = entry.instruction;
    state.lang = entry.lang || "en";
    $("langToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));
    $("variantSeg").dataset.value = entry.variant; renderVariantSeg();
    $("deviceSelect").value = entry.device; onDeviceChange();
    $("dtypeSelect").value = entry.dtype;
    $("cpuOffloadInput").checked = entry.cpu_offload;
    $("nfeInput").value = entry.nfe;
    $("cfgInput").value = entry.cfg;
    $("swayInput").value = entry.sway;
    $("seedInput").value = entry.seed ?? "";
    state.durationMode = entry.duration_mode;
    state.values.__gen_seconds = entry.gen_seconds ?? "";
    state.values.__gen_seconds_dirty = true;
    if (entry.input && state.inputs.find((i) => i.id === entry.input.id)) setSource(state.inputs.find((i) => i.id === entry.input.id));
    renderDurationControl();
    validateForm();
    document.querySelector(".left-panel").scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------------- sessions (helmstudio's)
  async function refreshSessions() {
    const res = await api("/api/sessions");
    state.sessions = res.sessions;
    const sel = $("sessionSelect");
    sel.innerHTML = "";
    state.sessions.forEach((s) => { const o = el("option", null, s.name); o.value = s.id; sel.appendChild(o); });
    if (!state.sessions.length) {
      // helmstudio holds the sessions, so a studio opened for the first time has none.
      const made = await apiJson("/api/sessions", { name: "default" });
      state.sessions = [made];
      const o = el("option", null, made.name); o.value = made.id; sel.appendChild(o);
    }
    if (!state.session || !state.sessions.some((s) => s.id === state.session)) state.session = state.sessions[0].id;
    sel.value = state.session;
  }

  function sessionName(id) {
    const found = state.sessions.find((s) => s.id === id);
    return found ? found.name : id;
  }

  async function switchSession(id) {
    state.session = id;
    $("sessionSelect").value = id;
    state.source = null;
    $("sourcePreview").classList.add("hidden");
    clearUploadError();
    // Tell helmstudio which session is open, so its own screens agree with the page.
    api(`/api/sessions/${id}/activate`, { method: "POST" }).catch(() => {});
    const [hist, inputs] = await Promise.all([
      api(`/api/sessions/${id}/history`),
      api(`/api/sessions/${id}/inputs`),
    ]);
    state.history = hist.history;
    state.inputs = inputs.inputs;
    renderGallery();
    renderRefGallery();
    renderDurationControl();
    validateForm();
  }

  $("sessionSelect").onchange = (e) => switchSession(e.target.value);

  function openPromptModal({ title, onSave }) {
    $("sessionNameModalTitle").textContent = title;
    $("sessionNameInput").value = "";
    $("sessionNameModalError").classList.add("hidden");
    $("sessionNameModal").classList.remove("hidden");
    $("sessionNameInput").focus();
    $("sessionNameModalSave").onclick = async () => {
      const name = $("sessionNameInput").value.trim();
      if (!name) return;
      try {
        await onSave(name);
        $("sessionNameModal").classList.add("hidden");
      } catch (err) {
        $("sessionNameModalError").textContent = err.message;
        $("sessionNameModalError").classList.remove("hidden");
      }
    };
  }
  $("sessionNameModalCancel").onclick = () => $("sessionNameModal").classList.add("hidden");

  $("sessionNewBtn").onclick = () => openPromptModal({
    title: "New session",
    onSave: async (name) => {
      const made = await apiJson("/api/sessions", { name });
      await refreshSessions();
      await switchSession(made.id);
    },
  });
  $("sessionDupBtn").onclick = () => openPromptModal({
    title: `Duplicate "${sessionName(state.session)}" as…`,
    onSave: async (name) => {
      const made = await apiJson(`/api/sessions/${state.session}/duplicate`, { new_name: name });
      await refreshSessions();
      await switchSession(made.id);
    },
  });
  $("sessionDelBtn").onclick = () => {
    $("confirmModalTitle").textContent = "Delete session?";
    $("confirmModalMessage").textContent =
      `This deletes "${sessionName(state.session)}" and its settings. Takes it made stay in helmstudio's gallery.`;
    $("confirmModal").classList.remove("hidden");
    $("confirmModalOk").onclick = async () => {
      await api(`/api/sessions/${state.session}`, { method: "DELETE" });
      $("confirmModal").classList.add("hidden");
      state.session = null;
      await refreshSessions();
      await switchSession(state.session);
    };
  };
  $("confirmModalCancel").onclick = () => $("confirmModal").classList.add("hidden");

  // ------------------------------------------------------------- helmstudio: runtime, components, theme
  const HELM_SDK = "/helm/sdk/v1";

  /** The terminal streams one render's log, which helmstudio keeps as a task job. */
  function showJob(jobId) {
    const terminal = $("terminal");
    if (!terminal) return;
    if (!jobId) terminal.removeAttribute("job");
    else if (terminal.getAttribute("job") !== jobId) terminal.setAttribute("job", jobId);
  }

  async function connectHelmstudio() {
    const { connect, themeBridge } = await import(`${HELM_SDK}/helm-runtime.js`);
    await import(`${HELM_SDK}/helm-ui.js`);
    themeBridge();
    const helm = (window.helm = connect());
    $("terminal").client = helm;

    const dialog = $("galleryDialog");
    const gallery = $("helmGallery");
    gallery.client = helm;
    const button = $("helmGalleryBtn");
    button.hidden = false;
    button.addEventListener("click", () => dialog.showModal());
    $("galleryCloseBtn").addEventListener("click", () => dialog.close());

    // Picking a take in the gallery makes it this session's reference clip, so an
    // edit can be chained onto something already generated. helmstudio owns the
    // bytes either way; this only adopts the asset into the open session.
    gallery.addEventListener("pick", async (event) => {
      const item = event.detail && event.detail.item;
      if (!item) return;
      dialog.close();
      try {
        const asset = item.asset || {};
        const added = await apiJson(`/api/sessions/${state.session}/inputs:adopt`, {
          asset_id: item.asset_id,
          filename: item.title || `take-${String(item.asset_id).slice(0, 8)}.wav`,
          duration_seconds: asset.duration_s ?? "",
        });
        await refreshInputs();
        setSource(added);
      } catch (err) {
        showUploadError(null, err);
      }
    });

    $("connStatus").className = "dot on";
    $("connLabel").textContent = "helmstudio";
  }

  // ------------------------------------------------------------- boot
  async function init() {
    renderCategoryTabs();
    renderTaskGrid();
    await loadHealth();
    await refreshSessions();
    await switchSession(state.session);
    selectTask(AUK_TASKS.find((t) => t.category === state.category));
    await connectHelmstudio();
    setInterval(loadHealth, 15000);
  }

  init().catch((e) => console.error(e));
})();
