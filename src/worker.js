import { pipeline, WhisperTextStreamer } from "@huggingface/transformers";
import { createTranscriber, DEFAULT_MODEL_URLS } from "parakeet.wgsl";

// Cryptographically pinned SHA-256 manifest endpoints for Parakeet TDT 0.6B V2
const PARAKEET_MODEL_URLS = Object.freeze({
  fp16: "https://parakeet-wgsl-models.narcotic.sh/v1/fp16/11a359db3d050fd82b002c745b24a5280f3ff13a76834b548df671c95c786c65/manifest.json",
  fp32: "https://parakeet-wgsl-models.narcotic.sh/v1/fp32/28dee836aefc2bfb01236fda6d10e1df7447724d2489040168549999ea267b1b/manifest.json",
});

// Supply chain integrity check: ensure parakeet.wgsl package URLs match pinned SHA-256 hashes
if (
  DEFAULT_MODEL_URLS.fp16 !== PARAKEET_MODEL_URLS.fp16 ||
  DEFAULT_MODEL_URLS.fp32 !== PARAKEET_MODEL_URLS.fp32
) {
  throw new Error("Parakeet model URL integrity check failed: manifest URLs do not match pinned SHA-256 hashes.");
}

let parakeetTranscriber = null;

const createCanonicalWav = (audio, sampleRate = 16000) => {
  const bytesPerSample = 2;
  const dataLength = audio.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < audio.length; index++) {
    const sample = Math.max(-1, Math.min(1, audio[index]));
    view.setInt16(44 + index * bytesPerSample, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
};

const MAX_LINE_CHARACTERS = 42;
const MAX_LINES_PER_EVENT = 2;
const MIN_SUBTITLE_DURATION = 1.0;
const TECHNICAL_FLOOR_DURATION = 0.2;
const MAX_SUBTITLE_DURATION = 7.0;
const INTER_SUBTITLE_GAP = 0.084;
const TARGET_CPS = 16.0;
const MAX_CPS = 20.0;

const CONJUNCTIONS = new Set([
  "and", "but", "or", "nor", "for", "yet", "so",
  "because", "although", "though", "while", "since",
  "unless", "whereas", "which", "that", "who", "whom", "whose",
  "when", "whenever", "where", "wherever", "if", "whether", "as"
]);

const PREPOSITIONS = new Set([
  "in", "on", "at", "to", "from", "with", "by", "about",
  "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "over", "of", "off", "out"
]);

const ARTICLES_AND_DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those"
]);

const POSSESSIVES = new Set([
  "my", "your", "his", "her", "its", "our", "their"
]);

const HONORIFICS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st."
]);

const AUXILIARY_VERBS = new Set([
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must"
]);

const splitTextIntoPyramidLines = (text) => {
  const clean = text.trim();
  if (!clean) return "";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return clean;

  if (words.join(" ").length <= MAX_LINE_CHARACTERS) {
    return clean;
  }

  let bestSplitIndex = -1;
  let bestScore = -Infinity;

  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(" ");
    const line2 = words.slice(i).join(" ");

    const len1 = line1.length;
    const len2 = line2.length;

    if (len1 > MAX_LINE_CHARACTERS || len2 > MAX_LINE_CHARACTERS) {
      continue;
    }

    let score = 0;
    if (len1 <= len2) {
      score += 40;
      const ratio = len1 / Math.max(1, len2);
      if (ratio >= 0.6 && ratio <= 0.95) {
        score += 25;
      }
    } else {
      score -= (len1 - len2) * 4;
    }

    const prevWord = words[i - 1];
    const prevWordLower = prevWord.toLowerCase().replace(/['"“”‘’]/g, "");
    const nextWord = words[i];
    const nextWordLower = nextWord.toLowerCase().replace(/['"“”‘’]/g, "");

    if (/[.!?]["'”)]?$/.test(prevWord)) {
      score += 100;
    } else if (/[,;:\u2014-]["'”)]?$/.test(prevWord)) {
      score += 70;
    }

    if (CONJUNCTIONS.has(nextWordLower)) score += 45;
    if (PREPOSITIONS.has(nextWordLower)) score += 25;

    if (ARTICLES_AND_DETERMINERS.has(prevWordLower)) score -= 80;
    if (POSSESSIVES.has(prevWordLower)) score -= 60;
    if (HONORIFICS.has(prevWordLower)) score -= 100;
    if (AUXILIARY_VERBS.has(prevWordLower)) score -= 45;
    if (prevWord.length === 1 && /[A-Z]/.test(prevWord)) score -= 80;

    if (score > bestScore) {
      bestScore = score;
      bestSplitIndex = i;
    }
  }

  if (bestSplitIndex !== -1) {
    return `${words.slice(0, bestSplitIndex).join(" ")}\n${words.slice(bestSplitIndex).join(" ")}`;
  }

  let line1 = "";
  let line2 = "";
  for (const word of words) {
    if (!line1 || `${line1} ${word}`.length <= MAX_LINE_CHARACTERS) {
      line1 = line1 ? `${line1} ${word}` : word;
    } else {
      line2 = line2 ? `${line2} ${word}` : word;
    }
  }
  return line2 ? `${line1}\n${line2}` : line1;
};

const toCaptionChunks = (chunks) => {
  if (!chunks.length) return [];

  const allWords = [];
  for (const chunk of chunks) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;

    const words = chunkText.split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const sourceStart = chunk.timestamp[0];
    const sourceEnd = chunk.timestamp[1] ?? (sourceStart + words.length * 0.4);
    const sourceDuration = Math.max(0.2, sourceEnd - sourceStart);
    const totalChars = words.join(" ").length;

    let charOffset = 0;
    for (const word of words) {
      const wordStart = sourceStart + (sourceDuration * charOffset) / Math.max(1, totalChars);
      charOffset += word.length;
      const wordEnd = sourceStart + (sourceDuration * charOffset) / Math.max(1, totalChars);
      charOffset += 1;
      allWords.push({ word, start: wordStart, end: wordEnd });
    }
  }

  if (!allWords.length) return [];

  const rawEvents = [];
  let currentWords = [];

  const flushEvent = () => {
    if (!currentWords.length) return;
    const text = currentWords.map((w) => w.word).join(" ");
    const start = currentWords[0].start;
    const end = currentWords[currentWords.length - 1].end;
    rawEvents.push({ text, start, end });
    currentWords = [];
  };

  const MAX_EVENT_CHARS = MAX_LINE_CHARACTERS * MAX_LINES_PER_EVENT;

  for (let i = 0; i < allWords.length; i++) {
    const wordObj = allWords[i];
    const candidateWords = [...currentWords, wordObj];
    const candidateText = candidateWords.map((w) => w.word).join(" ");
    const candidateLength = candidateText.length;
    const candidateDuration = wordObj.end - (currentWords[0]?.start ?? wordObj.start);

    const isTerminalPunctuation = /[.!?]["'”)]?$/.test(wordObj.word);
    const isClausePunctuation = /[,;:\u2014-]["'”)]?$/.test(wordObj.word);

    const exceedsLength = candidateLength > MAX_EVENT_CHARS;
    const exceedsDuration = candidateDuration > MAX_SUBTITLE_DURATION;

    if (currentWords.length > 0 && (exceedsLength || exceedsDuration)) {
      flushEvent();
      currentWords.push(wordObj);
    } else {
      currentWords.push(wordObj);
    }

    if (isTerminalPunctuation && candidateLength >= 20) {
      flushEvent();
    } else if (isClausePunctuation && candidateLength >= 45 && candidateDuration >= 3.0) {
      flushEvent();
    }
  }
  flushEvent();

  const formattedEvents = [];
  for (const ev of rawEvents) {
    const pyramidText = splitTextIntoPyramidLines(ev.text);
    const visibleLength = pyramidText.length;

    const minReadingDuration = visibleLength / MAX_CPS;
    const idealReadingDuration = visibleLength / TARGET_CPS;

    let duration = ev.end - ev.start;
    duration = Math.max(duration, MIN_SUBTITLE_DURATION, minReadingDuration);
    duration = Math.max(duration, Math.min(idealReadingDuration, MAX_SUBTITLE_DURATION));
    duration = Math.min(duration, MAX_SUBTITLE_DURATION);

    formattedEvents.push({
      text: pyramidText,
      timestamp: [ev.start, ev.start + duration],
    });
  }

  for (let i = 0; i < formattedEvents.length; i++) {
    const current = formattedEvents[i];
    const next = formattedEvents[i + 1];

    if (next) {
      const maxCurrentEnd = next.timestamp[0] - INTER_SUBTITLE_GAP;
      if (current.timestamp[1] > maxCurrentEnd) {
        if (maxCurrentEnd - current.timestamp[0] >= TECHNICAL_FLOOR_DURATION) {
          current.timestamp[1] = Math.max(current.timestamp[0] + TECHNICAL_FLOOR_DURATION, maxCurrentEnd);
        } else {
          current.timestamp[1] = current.timestamp[0] + TECHNICAL_FLOOR_DURATION;
          next.timestamp[0] = current.timestamp[1] + INTER_SUBTITLE_GAP;
          if (next.timestamp[1] < next.timestamp[0] + TECHNICAL_FLOOR_DURATION) {
            next.timestamp[1] = next.timestamp[0] + TECHNICAL_FLOOR_DURATION;
          }
        }
      }
    }
  }

  return formattedEvents;
};

const transcribeWithParakeet = async ({ audio, formatForCaptions, signal }) => {
  const audioBlob = createCanonicalWav(audio);
  audio = null;

  if (!parakeetTranscriber) {
    self.postMessage({
      status: "initiate",
      file: "parakeet.wgsl",
      loaded: 0,
      total: 0,
      progress: 0,
      name: "Parakeet TDT 0.6B",
    });

    parakeetTranscriber = createTranscriber({
      modelUrls: PARAKEET_MODEL_URLS,
      onLoadProgress: ({ phase, fraction, loadedBytes, totalBytes }) => {
        const payload = {
          status: phase === "ready" ? "ready" : "progress",
          file: "parakeet.wgsl",
          progress: fraction * 100,
          phase: phase,
        };
        if (loadedBytes !== undefined) payload.loaded = loadedBytes;
        if (totalBytes !== undefined) payload.total = totalBytes;

        self.postMessage(payload);
        if (phase === "ready") {
          self.postMessage({ status: "done", file: "parakeet.wgsl" });
        }
      },
    });
  }

  // The 40-char/2-line wrap only makes sense when producing on-screen caption
  // cues; applying it to plain transcript chunks fragments sentences into
  // tiny, choppy entries with rapidly jumping timestamps.
  const toChunks = (words, forCaptions) => {
    const chunks = [];
    let currentChunk = null;
    const MAX_CHUNK_DURATION_SECONDS = 30;
    const MAX_PAUSE_SECONDS = 1.5;
    const MAX_LINE_CHARACTERS = 42;
    const MIN_LINE_CHARACTERS = 32;

    const getLineLengths = (text) => text.split("\n").map((line) => line.length);

    const appendWord = (text, word) => {
      if (!forCaptions) {
        return `${text} ${word}`;
      }

      const lines = getLineLengths(text);
      const separator = lines.at(-1) > 0 ? 1 : 0;
      if (lines.at(-1) + separator + word.length <= MAX_LINE_CHARACTERS) {
        return `${text}${separator ? " " : ""}${word}`;
      }

      if (lines.length === 1) {
        return `${text}\n${word}`;
      }

      return null;
    };

    const shouldSplitForLineBalance = (text, nextWord) => {
      if (!forCaptions) {
        return false;
      }

      const lines = getLineLengths(text);
      if (lines.length !== 2 || lines[0] >= MIN_LINE_CHARACTERS) {
        return false;
      }

      const firstLineWithNextWord = `${text.split("\n")[0]} ${nextWord}`;
      return firstLineWithNextWord.length > MAX_LINE_CHARACTERS;
    };

    for (const word of words) {
      const text = word.text.trim();
      if (!text) continue;

      const startsNewChunk =
        currentChunk &&
        (word.startSeconds - currentChunk.timestamp[1] > MAX_PAUSE_SECONDS ||
          word.endSeconds - currentChunk.timestamp[0] > MAX_CHUNK_DURATION_SECONDS ||
          shouldSplitForLineBalance(currentChunk.text, text));

      if (startsNewChunk) {
        chunks.push(currentChunk);
        currentChunk = null;
      }

      if (!currentChunk) {
        currentChunk = {
          text,
          timestamp: [word.startSeconds, word.endSeconds],
        };
      } else {
        const nextText = appendWord(currentChunk.text, text);
        if (nextText === null) {
          chunks.push(currentChunk);
          currentChunk = {
            text,
            timestamp: [word.startSeconds, word.endSeconds],
          };
        } else {
          currentChunk.text = nextText;
          currentChunk.timestamp[1] = word.endSeconds;
        }
      }

      if (/[.!?]$/.test(text)) {
        chunks.push(currentChunk);
        currentChunk = null;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  };

  const result = await parakeetTranscriber.transcribe(audioBlob, {
    sourceName: "audio.wav",
    signal,
    onProgress: ({ fraction }) => {
      self.postMessage({
        status: "transcription_progress",
        data: {
          progress: fraction * 100,
        },
      });
    },
  });

  return {
    text: result.text,
    chunks: formatForCaptions
      ? toCaptionChunks(toChunks(result.words, true))
      : toChunks(result.words, false).map((chunk) => ({
        ...chunk,
        text: chunk.text.replace(/\n/g, " "),
      })),
    tps: result.metrics.speedFactor,
    duration: result.metrics.audioDurationSeconds,
  };
};

// Define model factories
// Ensures only one model is created of each type
class PipelineFactory {
  static task = null;
  static model = null;
  static revision = null;
  static dtype = null;
  static gpu = false;
  static instance = null;

  constructor(tokenizer, model, revision, dtype, gpu) {
    this.tokenizer = tokenizer;
    this.model = model;
    this.revision = revision;
    this.dtype = dtype;
    this.gpu = gpu;
  }

  static async getInstance(progress_callback = null) {
    if (this.instance === null) {
      const options = {
        dtype: this.dtype,
        device: this.gpu ? "webgpu" : "wasm",
        progress_callback,
      };
      if (this.revision) {
        options.revision = this.revision;
      }
      this.instance = pipeline(this.task, this.model, options);
    }

    return this.instance;
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data;

  const originalPostMessage = self.postMessage;

  try {
    const isParakeet = message.model === "parakeet.wgsl";
    // Parakeet needs external chunking to avoid "TDT output overflow" errors on
    // long audio, but the transcriber stays alive between chunks — no
    // dispose/recreate, so there's no model-reload overhead. If a chunk hits a
    // device-lost or overflow error, we simply skip that chunk and continue
    // We use a universal 5-minute chunk duration to keep memory usage low across all models.
    const CHUNK_DURATION_S = 5 * 60;
    const SAMPLE_RATE = 16000;
    const SAMPLES_PER_CHUNK = CHUNK_DURATION_S * SAMPLE_RATE;

    const fullAudio = message.audio;
    if (!fullAudio) return;

    let allChunks = [];
    let fullText = "";
    let globalTps = 0;
    const globalDuration = message.duration;

    const runChunk = async (audioChunk, offset, isSubChunk) => {
      const currentTimeOffset = offset / SAMPLE_RATE;
      const chunkMessage = {
        ...message,
        audio: audioChunk,
        duration: audioChunk.length / SAMPLE_RATE
      };

      let lastProgressTime = Date.now();
      const abortController = new AbortController();
      chunkMessage.signal = abortController.signal;

      self.postMessage = (msg) => {
        if (msg.status === "update" || msg.status === "transcription_progress" || msg.status === "progress" || msg.status === "initiate" || msg.status === "ready" || msg.status === "done") {
          lastProgressTime = Date.now();
        }
        if (msg.status === "update") {
          const shiftedChunks = msg.data.chunks.map(c => ({
            ...c,
            timestamp: [
              c.timestamp[0] !== null ? c.timestamp[0] + currentTimeOffset : null,
              c.timestamp[1] !== null ? c.timestamp[1] + currentTimeOffset : null
            ]
          }));
          originalPostMessage({
            status: "update",
            data: {
              text: fullText + (fullText ? " " : "") + msg.data.text,
              chunks: [...allChunks, ...shiftedChunks],
              tps: msg.data.tps,
              duration: globalDuration,
              progress: ((offset + audioChunk.length) / fullAudio.length) * 100
            }
          });
        } else if (msg.status === "transcription_progress") {
          const chunkProgress = msg.data.progress;
          const overallProgress = ((offset / fullAudio.length) * 100) + (chunkProgress * (audioChunk.length / fullAudio.length));
          originalPostMessage({
            status: "transcription_progress",
            data: { progress: overallProgress }
          });
        } else {
          originalPostMessage(msg);
        }
      };

      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressTime > 15000) {
          abortController.abort(new Error("watchdog_timeout"));
        }
      }, 1000);

      try {
        const chunkResult = await transcribe(chunkMessage);
        return chunkResult;
      } catch (error) {
        const errorMsg = error?.message ?? String(error);
        if (isParakeet && /watchdog_timeout|aborted|device.*lost|gpu.*lost|out.*memory|overflow|invalid.*token/i.test(errorMsg)) {
          console.warn(`[whisper-web] Chunk failed at offset ${offset} (${isSubChunk ? '30s sub-chunk' : '5m chunk'}):`, errorMsg);
          if (parakeetTranscriber) {
            try { parakeetTranscriber.dispose(); } catch { }
            parakeetTranscriber = null;
          }
          if (!isSubChunk) {
            return "RETRY_SUBCHUNKS";
          }
          // If a 30s sub-chunk fails, it's truly poisoned. Skip it.
          return { text: "", chunks: [], tps: 0, duration: chunkMessage.duration };
        }
        throw error;
      } finally {
        clearInterval(watchdog);
        self.postMessage = originalPostMessage;
      }
    };

    for (let offset = 0; offset < fullAudio.length; offset += SAMPLES_PER_CHUNK) {
      const audioChunk = fullAudio.subarray(offset, offset + SAMPLES_PER_CHUNK);

      const chunkResult = await runChunk(audioChunk, offset, false);

      if (chunkResult === "RETRY_SUBCHUNKS") {
        console.warn(`[whisper-web] Splitting 5-minute chunk into 30s sub-chunks to bypass poisoned audio...`);
        const SUBCHUNK_SAMPLES = 30 * SAMPLE_RATE;

        for (let sub = 0; sub < audioChunk.length; sub += SUBCHUNK_SAMPLES) {
          const subData = audioChunk.subarray(sub, sub + SUBCHUNK_SAMPLES);
          const subResult = await runChunk(subData, offset + sub, true);

          if (subResult && subResult.text) {
            const shiftedChunks = subResult.chunks.map(c => ({
              ...c,
              timestamp: [
                c.timestamp[0] !== null ? c.timestamp[0] + ((offset + sub) / SAMPLE_RATE) : null,
                c.timestamp[1] !== null ? c.timestamp[1] + ((offset + sub) / SAMPLE_RATE) : null
              ]
            }));
            allChunks.push(...shiftedChunks);
            fullText += (fullText ? " " : "") + subResult.text;
            if (subResult.tps) globalTps = subResult.tps;
          }

          if (sub + SUBCHUNK_SAMPLES < audioChunk.length) {
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }
      } else if (chunkResult) {
        const shiftedChunks = chunkResult.chunks.map(c => ({
          ...c,
          timestamp: [
            c.timestamp[0] !== null ? c.timestamp[0] + (offset / SAMPLE_RATE) : null,
            c.timestamp[1] !== null ? c.timestamp[1] + (offset / SAMPLE_RATE) : null
          ]
        }));
        allChunks.push(...shiftedChunks);
        fullText += (fullText ? " " : "") + chunkResult.text;
        if (chunkResult.tps) globalTps = chunkResult.tps;
      }

      if (offset + SAMPLES_PER_CHUNK < fullAudio.length) {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    }

    self.postMessage = originalPostMessage;

    self.postMessage({
      status: "complete",
      data: {
        text: fullText,
        chunks: allChunks,
        tps: globalTps,
        duration: globalDuration
      },
    });
  } catch (error) {
    console.error(error);
    if (self.postMessage !== originalPostMessage) {
      self.postMessage = originalPostMessage;
    }
    self.postMessage({
      status: "error",
      data: { message: error?.message ?? String(error) },
    });
  }
});

class AutomaticSpeechRecognitionPipelineFactory extends PipelineFactory {
  static task = "automatic-speech-recognition";
  static model = null;
  static revision = null;
  static dtype = null;
  static gpu = false;
}

const transcribe = async ({ audio, formatForCaptions, model, revision, dtype, gpu, subtask, language, duration, signal }) => {
  if (model === "parakeet.wgsl") {
    return transcribeWithParakeet({ audio, formatForCaptions, signal });
  }

  // Supply chain validation: ensure any model loaded from Hugging Face is pinned to an immutable 40-character commit SHA
  if (!revision || typeof revision !== "string" || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error(`Untrusted or unpinned model revision for "${model}". Model weights must be pinned to an immutable 40-character commit hash.`);
  }

  const isDistilWhisper = model.startsWith("distil-whisper/");

  const p = AutomaticSpeechRecognitionPipelineFactory;
  if (p.model !== model || p.revision !== revision || p.dtype !== dtype || p.gpu !== gpu) {
    // Invalidate model if different model, revision, dtype, or gpu setting
    p.model = model;
    p.revision = revision;
    p.dtype = dtype;
    p.gpu = gpu;

    if (p.instance !== null) {
      (await p.getInstance()).dispose();
      p.instance = null;
    }
  }

  // Load transcriber model
  const transcriber = await p.getInstance((data) => {
    self.postMessage(data);
  });

  const time_precision =
    transcriber.processor.feature_extractor.config.chunk_length /
    transcriber.model.config.max_source_positions;

  /** @type {{ text: string; offset: number, timestamp: [number, number | null] }[]} */
  const chunks = [];

  const chunk_length_s = isDistilWhisper ? 20 : 30;
  const stride_length_s = isDistilWhisper ? 3 : 5;

  let chunk_count = 0;
  let start_time;
  let num_tokens = 0;
  let tps;
  // Cloning the whole (ever-growing) chunks array on every single token is
  // expensive; throttle how often we post "update" messages to the main thread.
  const UPDATE_INTERVAL_MS = 250;
  let last_update_time = 0;
  const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
    time_precision,
    on_chunk_start: (x) => {
      const offset = (chunk_length_s - stride_length_s) * chunk_count;
      chunks.push({
        text: "",
        timestamp: [offset + x, null],
        finalised: false,
        offset,
      });
    },
    token_callback_function: (x) => {
      start_time ??= performance.now();
      if (num_tokens++ > 0) {
        tps = (num_tokens / (performance.now() - start_time)) * 1000;
      }
    },
    callback_function: (x) => {
      if (chunks.length === 0) return;
      chunks.at(-1).text += x;

      const now = performance.now();
      if (now - last_update_time < UPDATE_INTERVAL_MS) return;
      last_update_time = now;

      try {
        self.postMessage({
          status: "update",
          data: {
            text: "",
            chunks,
            tps,
            duration,
          },
        });
      } catch (error) {
        // Skip this update rather than letting a transient clone failure kill the worker.
        console.error(error);
      }
    },
    on_chunk_end: (x) => {
      const current = chunks.at(-1);
      current.timestamp[1] = x + current.offset;
      current.finalised = true;
    },
    on_finalize: () => {
      start_time = null;
      num_tokens = 0;
      ++chunk_count;
    },
  });

  const output = await transcriber(audio, {
    top_k: 0,
    do_sample: false,
    chunk_length_s,
    stride_length_s,
    language,
    task: subtask,
    return_timestamps: true,
    force_full_sequences: false,
    condition_on_previous_text: false, // Prevents Whisper from getting stuck in repetition loops
    no_repeat_ngram_size: 3,           // Further hallucination suppression
    streamer,
  }).catch((error) => {
    console.error(error);
    self.postMessage({
      status: "error",
      data: { message: error?.message ?? String(error) },
    });
    return null;
  });

  if (output === null) return null;

  return {
    tps,
    duration,
    ...output,
    chunks: formatForCaptions
      ? toCaptionChunks(output.chunks ?? chunks)
      : output.chunks ?? chunks,
  };
};