// AuK task catalog — mirrors docs/COOKBOOK.md exactly (categories, templates,
// EN/CN wording, duration semantics). This file only ever produces a plain
// instruction string; the server has no idea "tasks" exist, so this catalog
// can grow without ever touching server.py.
//
// Field types: text, textarea, number, select
// durationModes: subset of ['source', 'explicit', 'estimate'] — which duration
//   controls the UI offers for this task; defaultMode is preselected.
// audio: 'required' | 'none'

const EMOTION_ZH = {
  happy: "开心", angry: "愤怒", sad: "悲伤", fearful: "恐惧",
  surprised: "惊讶", disgusted: "厌恶", calm: "平静", excited: "兴奋",
};
const DEFECT_ZH = {
  "telephone effect": "电话感", muffling: "闷声", clipping: "削波", dropouts: "丢包",
};
const ORDINAL_EN = ["first", "second", "third", "fourth", "fifth", "sixth"];

function q(s) { return (s || "").trim(); }

const AUK_TASKS = [
  {
    id: "zero_shot_tts",
    category: "Speech Generation",
    label: "Zero-shot TTS",
    description: "Speak the target text in the voice of the reference audio.",
    audio: "required",
    durationModes: ["explicit", "estimate", "source"],
    defaultMode: "explicit",
    cookbookRef: "COOKBOOK.md#11-zero-shot-tts",
    templateNote: "EN & CN: Say the following with the same voice: \"{text}\"",
    fields: [
      { key: "text", label: "Text to speak", type: "textarea", rows: 6,
        placeholder: "Ladies and gentlemen, it's an honor to have the opportunity to address such a distinguished audience" },
    ],
    build(v) {
      const text = q(v.text);
      return `Say the following with the same voice: '${text}'`;
    },
  },
  {
    id: "instruct_tts",
    category: "Speech Generation",
    label: "Instruct TTS",
    description: "Generate speech from a voice description alone — no reference audio.",
    audio: "none",
    durationModes: ["explicit"],
    defaultMode: "explicit",
    cookbookRef: "COOKBOOK.md#12-instruct-tts",
    templateNote: 'EN: Generate speech based on the following description: "{voice description}". The content to speak is: "{text}".\nCN: 请基于下面的描述: "{声音描述}",生成语音内容"{文本}".',
    fields: [
      { key: "desc", label: "Voice description", type: "textarea", rows: 6,
        placeholder: "a warm, gentle female voice in her twenties, speaking slowly and affectionately" },
      { key: "text", label: "Content to speak", type: "textarea", rows: 4, placeholder: "Welcome home, how was work today?" },
    ],
    build(v, lang) {
      const desc = q(v.desc), text = q(v.text);
      if (lang === "zh") return `请基于下面的描述: "${desc}",生成语音内容"${text}".`;
      return `Generate speech based on the following description: "${desc}". The content to speak is: "${text}".`;
    },
  },
  {
    id: "content_edit",
    category: "Content Editing",
    label: "Speech Content Editing",
    description: "Rewrite what is said — replace, insert, or remove text.",
    audio: "required",
    durationModes: ["explicit", "source"],
    defaultMode: "explicit",
    cookbookRef: "COOKBOOK.md#21-speech-content-editing",
    templateNote: "Replace: '{original}' → '{new}'.  Insert: before/after an anchor.  Remove: a phrase, optionally anchored.",
    fields: [
      { key: "mode", label: "Edit type", type: "select", default: "replace",
        options: [{ value: "replace", label: "Replace" }, { value: "insert", label: "Insert" }, { value: "remove", label: "Remove" }] },
      { key: "original", label: "Original text", type: "text", placeholder: "but accepting what we cannot have", when: { mode: "replace" } },
      { key: "new", label: "New text", type: "text", placeholder: "and living well with dreams unmet", when: { mode: "replace" } },
      { key: "insertText", label: "Text to insert", type: "text", placeholder: "truly", when: { mode: "insert" } },
      { key: "insertAnchor", label: "Anchor phrase", type: "text", placeholder: "we tested", when: { mode: "insert" } },
      { key: "insertPos", label: "Position", type: "select", default: "before",
        options: [{ value: "before", label: "Before anchor" }, { value: "after", label: "After anchor" }], when: { mode: "insert" } },
      { key: "removeText", label: "Text to remove", type: "text", placeholder: "the humming", when: { mode: "remove" } },
      { key: "removeAnchor", label: "Anchor phrase (optional)", type: "text", placeholder: "", optional: true, when: { mode: "remove" } },
      { key: "removePos", label: "Anchor position", type: "select", default: "before",
        options: [{ value: "before", label: "Before anchor" }, { value: "after", label: "After anchor" }], when: { mode: "remove", if: (v) => !!q(v.removeAnchor) } },
    ],
    build(v, lang) {
      const mode = v.mode || "replace";
      if (mode === "replace") {
        const o = q(v.original), n = q(v.new);
        return lang === "zh" ? `把‘${o}’改成‘${n}’` : `Replace '${o}' with '${n}'.`;
      }
      if (mode === "insert") {
        const t = q(v.insertText), a = q(v.insertAnchor), before = v.insertPos !== "after";
        if (lang === "zh") return before ? `在‘${a}’前面加上‘${t}’` : `在‘${a}’后面加上‘${t}’`;
        return before ? `Add '${t}' before '${a}'.` : `Add '${t}' after '${a}'.`;
      }
      const t = q(v.removeText), a = q(v.removeAnchor), before = v.removePos !== "after";
      if (!a) return lang === "zh" ? `删掉‘${t}’` : `Remove '${t}'.`;
      if (lang === "zh") return before ? `删掉‘${a}’前面的‘${t}’` : `删掉‘${a}’后面的‘${t}’`;
      return before ? `Remove '${t}' before '${a}'.` : `Remove '${t}' after '${a}'.`;
    },
  },
  {
    id: "lyric_edit",
    category: "Content Editing",
    label: "Lyric Editing",
    description: "Rewrite lyrics in a singing recording while preserving the melody and voice.",
    audio: "required",
    durationModes: ["source", "explicit"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#22-lyric-editing",
    templateNote: 'EN: Change "{original lyrics}" to "{new lyrics}" in the vocal recording.\nCN: 把这段歌词中的"{原歌词}"改成"{新歌词}"。',
    inputHint: "Input must be an a cappella (isolated vocals) recording. Use Music Separation first if it has instrumental backing.",
    fields: [
      { key: "original", label: "Original lyrics", type: "text", placeholder: "rear view" },
      { key: "new", label: "New lyrics", type: "text", placeholder: "like you" },
    ],
    build(v, lang) {
      const o = q(v.original), n = q(v.new);
      return lang === "zh" ? `把这段歌词中的“${o}”改成“${n}”。` : `Change "${o}" to "${n}" in the vocal recording.`;
    },
  },
  {
    id: "pitch_edit",
    category: "Acoustic Editing",
    label: "Pitch Editing",
    description: "Raise or lower the pitch by semitones.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#31-pitch-editing",
    templateNote: "EN: Raise/Lower the pitch by {N} semitones.\nCN: 将音调升高/降低{N}个半音。",
    fields: [
      { key: "direction", label: "Direction", type: "select", default: "raise",
        options: [{ value: "raise", label: "Raise" }, { value: "lower", label: "Lower" }] },
      { key: "semitones", label: "Semitones", type: "number", default: 2, min: 1, max: 12, step: 1 },
    ],
    build(v, lang) {
      const up = v.direction !== "lower", n = v.semitones || 2;
      return lang === "zh" ? `将音调${up ? "升高" : "降低"}${n}个半音。` : `${up ? "Raise" : "Lower"} the pitch by ${n} semitones.`;
    },
  },
  {
    id: "speed_edit",
    category: "Acoustic Editing",
    label: "Speed Editing",
    description: "Adjust the speaking rate; output length scales with the speed factor.",
    audio: "required",
    durationModes: ["explicit"],
    defaultMode: "explicit",
    autoDuration: "speed",
    cookbookRef: "COOKBOOK.md#32-speed-editing",
    templateNote: "EN: Adjust the speech speed to {x}x.\nCN: 将语速调整为{x}倍。",
    fields: [
      { key: "factor", label: "Speed factor", type: "select", default: "1.5",
        options: ["0.5", "0.75", "1.25", "1.5", "2.0"].map((v) => ({ value: v, label: `${v}x` })).concat([{ value: "custom", label: "Custom…" }]) },
      { key: "customFactor", label: "Custom factor", type: "number", default: 1.5, min: 0.25, max: 3, step: 0.05, when: { factor: "custom" } },
    ],
    build(v) {
      const factor = v.factor === "custom" ? (v.customFactor || 1.5) : (v.factor || "1.5");
      return { en: `Adjust the speech speed to ${factor}x.`, zh: `将语速调整为${factor}倍。` };
    },
  },
  {
    id: "volume_edit",
    category: "Acoustic Editing",
    label: "Volume Editing",
    description: "Raise or lower the volume by decibels.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#33-volume-editing",
    templateNote: "EN: Increase/Decrease the volume by {N} dB.\nCN: 将音量升高/降低{N}分贝。",
    fields: [
      { key: "direction", label: "Direction", type: "select", default: "increase",
        options: [{ value: "increase", label: "Increase" }, { value: "decrease", label: "Decrease" }] },
      { key: "db", label: "Decibels", type: "number", default: 10, min: 1, max: 30, step: 1 },
    ],
    build(v, lang) {
      const up = v.direction !== "decrease", n = v.db || 10;
      return lang === "zh" ? `将音量${up ? "升高" : "降低"}${n}分贝。` : `${up ? "Increase" : "Decrease"} the volume by ${n} dB.`;
    },
  },
  {
    id: "emotion_edit",
    category: "Paralinguistic Editing",
    label: "Emotion",
    description: "Change the emotion while preserving content and voice.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#41-emotion",
    templateNote: "EN: Change the emotion to {emotion}.\nCN: 将情感转变为{情感}。",
    fields: [
      { key: "emotion", label: "Emotion", type: "select", default: "happy",
        options: Object.keys(EMOTION_ZH).map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) })) },
    ],
    build(v, lang) {
      const e = v.emotion || "happy";
      return lang === "zh" ? `将情感转变为${EMOTION_ZH[e] || e}。` : `Change the emotion to ${e}.`;
    },
  },
  {
    id: "timbre_edit",
    category: "Paralinguistic Editing",
    label: "Timbre",
    description: "Change the timbre to a description while keeping the content unchanged.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#42-timbre",
    templateNote: 'EN: Keep the spoken content unchanged and change the timbre to: "{description}".\nCN: 请将这段音频的音色修改为符合以下描述的声音："{音色描述}"。',
    fields: [
      { key: "description", label: "Timbre description", type: "textarea", rows: 4, placeholder: "a deep, calm male voice" },
    ],
    build(v, lang) {
      const d = q(v.description);
      return lang === "zh" ? `请将这段音频的音色修改为符合以下描述的声音："${d}"。` : `Keep the spoken content unchanged and change the timbre to: "${d}".`;
    },
  },
  {
    id: "deaccent",
    category: "Paralinguistic Editing",
    label: "De-accent",
    description: "Remove a regional accent while preserving the speaker's voice and content.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#43-de-accent",
    templateNote: "EN: Remove the regional accent while preserving the speaker's voice and content.\nCN: 请去掉这段语音里的方言口音，保持说话人音色一致。",
    fields: [],
    build(v, lang) {
      return lang === "zh"
        ? "请去掉这段语音里的方言口音，保持说话人音色一致。"
        : "Remove the regional accent while preserving the speaker's voice and content.";
    },
  },
  {
    id: "nonverbal_edit",
    category: "Paralinguistic Editing",
    label: "Nonverbal Editing",
    description: "Remove or add nonverbal sounds such as breaths, laughs, or coughs.",
    audio: "required",
    durationModes: ["explicit", "source"],
    defaultMode: "explicit",
    cookbookRef: "COOKBOOK.md#44-nonverbal-editing",
    templateNote: "Remove: 'Remove all {sound} from the audio.'  Add: at the beginning/end, or anchored before/after a phrase.",
    fields: [
      { key: "mode", label: "Edit type", type: "select", default: "remove",
        options: [{ value: "remove", label: "Remove" }, { value: "add", label: "Add" }] },
      { key: "sound", label: "Sound", type: "text", placeholder: "breaths, laughs, coughs, humming…" },
      { key: "position", label: "Position", type: "select", default: "beginning",
        options: [{ value: "beginning", label: "Beginning" }, { value: "end", label: "End" }, { value: "before", label: "Before phrase" }, { value: "after", label: "After phrase" }],
        when: { mode: "add" } },
      { key: "anchor", label: "Anchor phrase", type: "text", placeholder: "We tested", when: { mode: "add", if: (v) => v.position === "before" || v.position === "after" } },
    ],
    build(v, lang) {
      const sound = q(v.sound);
      if (v.mode !== "add") {
        return lang === "zh" ? `删除音频中所有的${sound}。` : `Remove all ${sound} from the audio.`;
      }
      const pos = v.position || "beginning", anchor = q(v.anchor);
      if (pos === "beginning") return lang === "zh" ? `在语音开头增加${sound}。` : `Add a ${sound} at the beginning of the speech.`;
      if (pos === "end") return lang === "zh" ? `在语音结尾增加${sound}。` : `Add a ${sound} at the end of the speech.`;
      const before = pos === "before";
      if (lang === "zh") return before ? `在‘${anchor}’前面加上${sound}声。` : `在‘${anchor}’后面加上${sound}声。`;
      return before ? `Add a ${sound} before '${anchor}'` : `Add a ${sound} after '${anchor}'`;
    },
  },
  {
    id: "whisper_convert",
    category: "Paralinguistic Editing",
    label: "Whisper Conversion",
    description: "Convert between normal speech and whisper while preserving speaker and content.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#45-whisper-conversion",
    templateNote: "To whisper / from whisper, EN & CN wording.",
    fields: [
      { key: "direction", label: "Direction", type: "select", default: "to_whisper",
        options: [{ value: "to_whisper", label: "Normal → Whisper" }, { value: "from_whisper", label: "Whisper → Normal" }] },
    ],
    build(v, lang) {
      const toWhisper = v.direction !== "from_whisper";
      if (lang === "zh") return toWhisper ? "用小声耳语的方式把这段话说出来。" : "把这段耳语转换成正常说话的声音。";
      return toWhisper
        ? "Convert this speech into a soft whisper while preserving the speaker and content."
        : "Convert this whispered speech into a normal speaking voice while preserving the speaker and content.";
    },
  },
  {
    id: "speech_enhance",
    category: "Enhancement & Separation",
    label: "Speech Enhancement",
    description: "Denoise, dereverberate, or restore natural, clear speech.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#51-speech-enhancement",
    templateNote: "Denoise / Dereverberate / Full enhancement / Quality restoration.",
    fields: [
      { key: "mode", label: "Mode", type: "select", default: "full",
        options: [
          { value: "denoise", label: "Denoise only" },
          { value: "dereverb", label: "Dereverberate only" },
          { value: "full", label: "Full enhancement" },
          { value: "quality", label: "Quality restoration" },
        ] },
      { key: "defect", label: "Defect to repair", type: "select", default: "telephone effect",
        options: Object.keys(DEFECT_ZH).map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) })),
        when: { mode: "quality" } },
    ],
    build(v, lang) {
      const mode = v.mode || "full";
      if (mode === "denoise") return lang === "zh" ? "请只去除背景噪声，保留其他内容，输出等长结果。" : "Remove only the background noise, preserve everything else, and output audio of the same length.";
      if (mode === "dereverb") return lang === "zh" ? "请只去除房间混响，保留其他内容，输出等长结果。" : "Remove only the room reverberation, preserve everything else, and output audio of the same length.";
      if (mode === "quality") {
        const d = v.defect || "telephone effect";
        return lang === "zh" ? `请修复这段音频的${DEFECT_ZH[d] || d}，恢复自然清晰的人声。` : `Repair the ${d} and restore natural, clear speech.`;
      }
      return lang === "zh" ? "请保留所有说话人，去除噪声和混响，输出等长的纯净语音。" : "Preserve all speakers, remove noise and reverberation, and output clean speech of the same length.";
    },
  },
  {
    id: "speech_separation",
    category: "Enhancement & Separation",
    label: "Speech Separation",
    description: "Keep one speaker by talking order and remove the others.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#52-speech-separation",
    templateNote: "EN: Keep only the {Nth} speaker to start talking and remove all other speakers.\nCN: 只保留第{N}个开始说话的人，去掉其余说话人。",
    fields: [
      { key: "ordinal", label: "Speaker (by talking order)", type: "select", default: "1",
        options: ORDINAL_EN.map((label, i) => ({ value: String(i + 1), label: `${label[0].toUpperCase()}${label.slice(1)} to speak` })) },
    ],
    build(v, lang) {
      const idx = parseInt(v.ordinal || "1", 10);
      const en = ORDINAL_EN[idx - 1] || `${idx}th`;
      return lang === "zh" ? `只保留第${idx}个开始说话的人，去掉其余说话人。` : `Keep only the ${en} speaker to start talking and remove all other speakers.`;
    },
  },
  {
    id: "music_separation",
    category: "Enhancement & Separation",
    label: "Music Separation",
    description: "Extract the singing voice from a mix, or keep all human voices.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#53-music-separation",
    templateNote: "Singing only / All human voices.",
    fields: [
      { key: "mode", label: "Keep", type: "select", default: "singing",
        options: [{ value: "singing", label: "Singing voice only" }, { value: "all_voices", label: "All human voices" }] },
    ],
    build(v, lang) {
      if (v.mode === "all_voices") return lang === "zh" ? "请保留所有人声，包括说话和歌唱，其余声音都去掉。" : "Keep all human voices, including speech and singing, and remove everything else.";
      return lang === "zh" ? "请只保留歌声，其余声音都去掉。" : "Keep only the singing voice and remove everything else.";
    },
  },
  {
    id: "target_speaker_extraction",
    category: "Enhancement & Separation",
    label: "Target Speaker Extraction",
    description: "Keep the target speaker identified by what they say.",
    audio: "required",
    durationModes: ["source"],
    defaultMode: "source",
    cookbookRef: "COOKBOOK.md#54-target-speaker-extraction",
    templateNote: 'EN: Keep only the speaker who says "{content}" and remove all other speakers.\nCN: 请只保留说"{内容}"的人，去掉其他说话人。',
    fields: [
      { key: "content", label: "What the target speaker says", type: "text", placeholder: "get what" },
    ],
    build(v, lang) {
      const c = q(v.content);
      return lang === "zh" ? `请只保留说"${c}"的人，去掉其他说话人。` : `Keep only the speaker who says "${c}" and remove all other speakers.`;
    },
  },
];

const AUK_CATEGORIES = [...new Set(AUK_TASKS.map((t) => t.category))];

function buildInstruction(task, values, lang) {
  const out = task.build(values, lang);
  if (typeof out === "string") return out;
  return lang === "zh" ? out.zh : out.en;
}
