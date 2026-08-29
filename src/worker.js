import { pipeline, WhisperTextStreamer } from "@huggingface/transformers";
import { createTranscriber } from "parakeet.wgsl";

let parakeetTranscriber = null;

const isMobile =
  typeof navigator !== "undefined" &&
  /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

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

const toCaptionChunks = (chunks) => {
  const captionChunks = [];
  const MAX_LINE_CHARACTERS = 40;

  for (const chunk of chunks) {
    const words = chunk.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const sourceStart = chunk.timestamp[0];
    const sourceEnd = chunk.timestamp[1] ?? sourceStart;
    const sourceDuration = sourceEnd - sourceStart;
    const sourceLength = words.join(" ").length;
    let currentText = "";
    let currentStartOffset = 0;

    const pushChunk = (text, endOffset) => {
      const start = sourceStart + (sourceDuration * currentStartOffset) / sourceLength;
      const end = sourceStart + (sourceDuration * endOffset) / sourceLength;
      captionChunks.push({
        text,
        timestamp: [start, end],
      });
      currentText = "";
      currentStartOffset = endOffset + 1;
    };

    for (const [wordIndex, word] of words.entries()) {
      const candidate = currentText ? `${currentText} ${word}` : word;
      const lineLengths = currentText.split("\n").map((line) => line.length);
      const lineLength = lineLengths.at(-1) ?? 0;
      const hasRoomOnCurrentLine = lineLength + (currentText ? 1 : 0) + word.length <= MAX_LINE_CHARACTERS;
      const hasRoomForSecondLine = lineLengths.length < 2;

      if (currentText && !hasRoomOnCurrentLine && !hasRoomForSecondLine) {
        pushChunk(currentText, currentStartOffset + currentText.length - 1);
      }

      if (!currentText) {
        currentText = word;
      } else if (hasRoomOnCurrentLine) {
        currentText = candidate;
      } else {
        currentText = `${currentText}\n${word}`;
      }

      if (/[.!?]$/.test(word)) {
        const wordOffset = words.slice(0, wordIndex + 1).join(" ").length - 1;
        pushChunk(currentText, wordOffset);
      }
    }

    if (currentText) {
      pushChunk(currentText, sourceLength - 1);
    }
  }

  return captionChunks;
};

const transcribeWithParakeet = async ({ audio, formatForCaptions }) => {
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
      onLoadProgress: ({ phase, fraction, loadedBytes, totalBytes }) => {
        self.postMessage({
          status: phase === "ready" ? "ready" : "progress",
          file: "parakeet.wgsl",
          loaded: loadedBytes ?? 0,
          total: totalBytes ?? 0,
          progress: fraction * 100,
        });
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
    const MAX_LINE_CHARACTERS = 40;
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

  let lastSnapshot = null;
  const result = await parakeetTranscriber.transcribe(audioBlob, {
    sourceName: "audio.wav",
    onProgress: ({ fraction }) => {
      self.postMessage({
        status: "transcription_progress",
        data: {
          progress: fraction * 100,
        },
      });
    },
    onPartialResult: (snapshot) => {
      lastSnapshot = snapshot;
    }
  }).catch(error => {
    // If it crashed but we have a snapshot, return the partial progress.
    if (lastSnapshot && lastSnapshot.processedAudioSeconds > 0) {
      return {
        isPartial: true,
        error: error,
        text: lastSnapshot.text,
        words: lastSnapshot.words,
        metrics: {
          speedFactor: 0,
          audioDurationSeconds: lastSnapshot.processedAudioSeconds
        }
      };
    }
    throw error;
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
    isPartial: result.isPartial,
    error: result.error
  };
};

// Define model factories
// Ensures only one model is created of each type
class PipelineFactory {
  static task = null;
  static model = null;
  static dtype = null;
  static gpu = false;
  static instance = null;

  constructor(tokenizer, model, dtype, gpu) {
    this.tokenizer = tokenizer;
    this.model = model;
    this.dtype = dtype;
    this.gpu = gpu;
  }

  static async getInstance(progress_callback = null) {
    if (this.instance === null) {
      this.instance = pipeline(this.task, this.model, {
        dtype: this.dtype,
        device: this.gpu ? "webgpu" : "wasm",
        progress_callback,
      });
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
    // We no longer manually chunk the audio. Instead, we pass the remaining audio
    // to the model and let it transcribe natively. If it crashes (e.g. OOM on mobile),
    // we capture its exact partial progress, dispose it, and resume from the failure point.
    const SAMPLE_RATE = 16000;
    const fullAudio = message.audio;
    if (!fullAudio) return;

    let allChunks = [];
    let fullText = "";
    let globalTps = 0;
    const globalDuration = message.duration;

    let offset = 0;

    while (offset < fullAudio.length) {
      const audioChunk = fullAudio.subarray(offset);
      const currentTimeOffset = offset / SAMPLE_RATE;

      const chunkMessage = {
        ...message,
        audio: audioChunk,
        duration: audioChunk.length / SAMPLE_RATE
      };

      self.postMessage = (msg) => {
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
              progress: ((offset + (msg.data.progress / 100 * audioChunk.length)) / fullAudio.length) * 100
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

      let chunkResult = await transcribe(chunkMessage).catch(async (error) => {
        if (isParakeet && /device.*lost|gpu.*lost|out.*memory|overflow|invalid.*token/i.test(error?.message ?? String(error))) {
          console.warn("[whisper-web] WebGPU crashed during native transcription. Attempting to recover from partial snapshot.");

          if (parakeetTranscriber) {
            try { parakeetTranscriber.dispose(); } catch { }
            parakeetTranscriber = null;
            await new Promise(resolve => setTimeout(resolve, 2500));
          }

          // If the model crashed IMMEDIATELY (no partial snapshot was saved in transcribeWithParakeet),
          // we must skip a small segment of the "poison" audio (e.g. 15 seconds) to avoid an infinite crash loop.
          return {
            text: "",
            chunks: [],
            tps: 0,
            duration: 15,
            isCrashWithoutSnapshot: true
          };
        }
        throw error;
      });

      if (!chunkResult) {
        self.postMessage = originalPostMessage;
        return; // Abort on error
      }

      // If transcribeWithParakeet returned a partial result, it means it caught a crash,
      // saved the progress, but the underlying model is still poisoned. We MUST dispose it.
      if (chunkResult.isPartial && isParakeet && parakeetTranscriber) {
        console.warn("[whisper-web] Recovered partial snapshot. Disposing poisoned model.");
        try { parakeetTranscriber.dispose(); } catch { }
        parakeetTranscriber = null;
        await new Promise(resolve => setTimeout(resolve, 2500));
      }

      // Format the chunks from this iteration
      const shiftedChunks = chunkResult.chunks.map(c => ({
        ...c,
        timestamp: [
          c.timestamp[0] !== null ? c.timestamp[0] + currentTimeOffset : null,
          c.timestamp[1] !== null ? c.timestamp[1] + currentTimeOffset : null
        ]
      }));

      allChunks.push(...shiftedChunks);
      fullText += (fullText ? " " : "") + chunkResult.text;
      if (chunkResult.tps > 0) globalTps = chunkResult.tps;

      // Determine exactly how much audio was successfully processed before the crash (or completion)
      let processedSeconds = chunkResult.duration;
      if (chunkResult.isCrashWithoutSnapshot) {
        processedSeconds = 15; // Skip 15s to bypass the poison pill
      }

      // Advance the offset to resume precisely where we left off
      offset += Math.max(1, Math.floor(processedSeconds * SAMPLE_RATE));

      if (offset < fullAudio.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
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
  static dtype = null;
  static gpu = false;
}

const transcribe = async ({ audio, formatForCaptions, model, dtype, gpu, subtask, language, duration }) => {
  if (model === "parakeet.wgsl") {
    return transcribeWithParakeet({ audio, formatForCaptions });
  }

  const isDistilWhisper = model.startsWith("distil-whisper/");

  const p = AutomaticSpeechRecognitionPipelineFactory;
  if (p.model !== model || p.dtype !== dtype || p.gpu !== gpu) {
    // Invalidate model if different model, dtype, or gpu setting
    p.model = model;
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