import { useCallback, useMemo, useRef, useState } from "react";
import { useWorker } from "./useWorker";
import Constants from "../utils/Constants";
import { checkSupport } from "parakeet.wgsl";

const SETTINGS_STORAGE_KEY = "whisper-web-settings";

function readStoredSetting<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }

    const settings = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const value = settings[key];
    return value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

function writeStoredSetting<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...existing, [key]: value };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors so the app still works when localStorage is unavailable.
  }
}

interface ProgressItem {
  file: string;
  loaded: number;
  progress: number;
  total: number;
  name: string;
  status: string;
}

interface TranscriberUpdateData {
  data: {
    text: string;
    chunks: { text: string; timestamp: [number, number | null] }[];
    tps: number;
    duration?: number;
    progress?: number;
  };
}

export interface TranscriberData {
  isBusy: boolean;
  tps?: number;
  progress?: number;
  estimatedRemainingSeconds?: number;
  transcriptionSeconds?: number;
  text: string;
  chunks: { text: string; timestamp: [number, number | null] }[];
}

export interface SummaryData {
  isBusy: boolean;
  summary?: string;
  error?: string;
}

const SUMMARY_CHUNK_CHAR_LIMIT = 8000;

export function splitTextIntoSummaryChunks(
  text: string,
  maxChars = SUMMARY_CHUNK_CHAR_LIMIT,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let currentChunk = "";

  const pushCurrentChunk = () => {
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
    }
  };

  const pushOverflowText = (value: string) => {
    let index = 0;
    while (index < value.length) {
      chunks.push(value.slice(index, index + maxChars).trim());
      index += maxChars;
    }
  };

  for (const paragraph of paragraphs) {
    const candidate = currentChunk ? `${currentChunk} ${paragraph}` : paragraph;

    if (candidate.length <= maxChars) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      pushCurrentChunk();
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [paragraph];
    let sentenceBuffer = "";

    for (const sentence of sentences) {
      const sanitizedSentence = sentence.trim();
      if (!sanitizedSentence) {
        continue;
      }

      const nextSentence = sentenceBuffer ? `${sentenceBuffer} ${sanitizedSentence}` : sanitizedSentence;

      if (nextSentence.length <= maxChars) {
        sentenceBuffer = nextSentence;
        continue;
      }

      if (sentenceBuffer) {
        chunks.push(sentenceBuffer.trim());
        sentenceBuffer = "";
      }

      if (sanitizedSentence.length <= maxChars) {
        sentenceBuffer = sanitizedSentence;
      } else {
        pushOverflowText(sanitizedSentence);
      }
    }

    if (sentenceBuffer) {
      currentChunk = sentenceBuffer;
    }
  }

  pushCurrentChunk();

  return chunks.filter(Boolean);
}

interface BrowserSummarizerInstance {
  summarize: (text: string) => Promise<string>;
}

interface BrowserLanguageDetectorResult {
  detectedLanguage: string;
  confidence: number;
}

interface BrowserLanguageDetectorInstance {
  detect: (text: string) => Promise<BrowserLanguageDetectorResult[]>;
}

interface BrowserLanguageDetectorConstructor {
  availability: () => Promise<"available" | "unavailable" | "downloadable" | "unsupported">;
  create: (options?: {
    expectedInputLanguages?: string[];
  }) => Promise<BrowserLanguageDetectorInstance>;
}

interface SummarizerOptions {
  type?: "tldr" | "key-points" | "teaser" | "headline";
  length?: "short" | "medium" | "long";
  format?: "plain-text" | "markdown";
  sharedContext?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
}

interface BrowserSummarizerConstructor {
  availability: (options?: SummarizerOptions) => Promise<"available" | "unavailable" | "downloadable" | "unsupported">;
  create: (options?: SummarizerOptions) => Promise<BrowserSummarizerInstance>;
}

export interface Transcriber {
  onInputChange: () => void;
  isBusy: boolean;
  isModelLoading: boolean;
  supportsSummarizer: boolean;
  progressItems: ProgressItem[];
  start: (
    audioData: AudioBuffer | undefined,
    audioBlob?: Blob,
    sourceName?: string,
    formatForCaptions?: boolean,
  ) => void;
  output?: TranscriberData;
  model: string;
  setModel: (model: string) => void;
  dtype: string;
  setDtype: (dtype: string) => void;
  gpu: boolean;
  setGPU: (gpu: boolean) => void;
  subtask: string;
  setSubtask: (subtask: string) => void;
  language?: string;
  setLanguage: (language: string) => void;
  summary?: SummaryData;
  summarize: (text: string) => void;
  setTranscript: (data: TranscriberData | undefined) => void;
}

export function useTranscriber(): Transcriber {
  const [transcript, setTranscript] = useState<TranscriberData | undefined>(
    undefined,
  );
  const [isBusy, setIsBusy] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [summary, setSummary] = useState<SummaryData | undefined>(undefined);
  const jobStartRef = useRef<number | null>(null);
  // Tracks when actual transcription work begins, separate from model load time.
  const transcriptionStartRef = useRef<number | null>(null);
  const isModelLoadingRef = useRef(false);
  const awaitingModelLoadRef = useRef(false);
  const supportsSummarizer =
    typeof window !== "undefined" &&
    "Summarizer" in window;

  const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);

  const getProgressFromChunks = useCallback((chunks: { timestamp: [number, number | null] }[] | undefined, duration?: number) => {
    if (!duration || !chunks || !chunks.length) {
      return 0;
    }

    const latestTimestamp = chunks.reduce((max, chunk) => {
      const end = chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0;
      return Math.max(max, end);
    }, 0);

    return Math.min(Math.max((latestTimestamp / duration) * 100, 0), 100);
  }, []);

  const webWorker = useWorker((event) => {
    const message = event.data;
    // Update the state with the result
    switch (message.status) {
      case "progress":
        // Model file progress: update one of the progress items.
        setProgressItems((prev) =>
          prev.map((item) => {
            if (item.file === message.file) {
              return { ...item, progress: message.progress };
            }
            return item;
          }),
        );
        break;
      case "transcription_progress":
        setTranscript((prev) =>
          prev
            ? { ...prev, isBusy: true, progress: message.data.progress }
            : prev,
        );
        setIsBusy(true);
        break;
      case "update":
      case "complete": {
        const busy = message.status === "update";
        const updateMessage = message as TranscriberUpdateData;
        const duration = updateMessage.data.duration ?? 0;
        const progress = updateMessage.data.progress ?? getProgressFromChunks(
          updateMessage.data.chunks,
          duration,
        );
        const elapsedSeconds = jobStartRef.current
          ? (performance.now() - jobStartRef.current) / 1000
          : 0;
        const estimatedRemainingSeconds =
          progress > 0 && elapsedSeconds > 0 && duration > 0
            ? (elapsedSeconds * (100 - progress)) / progress
            : undefined;
        const transcriptionSeconds =
          !busy && transcriptionStartRef.current
            ? (performance.now() - transcriptionStartRef.current) / 1000
            : undefined;

        setTranscript({
          isBusy: busy,
          text: updateMessage.data.text,
          tps: updateMessage.data.tps,
          progress,
          estimatedRemainingSeconds,
          transcriptionSeconds,
          chunks: updateMessage.data.chunks ?? [],
        });
        setIsBusy(busy);
        break;
      }
      case "initiate":
        // Model file start load: add a new progress item to the list.
        setIsModelLoading(true);
        isModelLoadingRef.current = true;
        setProgressItems((prev) => [...prev, message]);
        break;
      case "ready":
        setIsModelLoading(false);
        isModelLoadingRef.current = false;
        // Model finished loading while we were waiting: transcription starts now.
        if (awaitingModelLoadRef.current) {
          transcriptionStartRef.current = performance.now();
          awaitingModelLoadRef.current = false;
        }
        break;
      case "error":
        setIsBusy(false);
        setIsModelLoading(false);
        setProgressItems([]);
        alert(
          `An error occurred: "${message.data.message}". Please file a bug report.`,
        );
        break;
      case "done":
        // Model file loaded: remove the progress item from the list.
        setProgressItems((prev) =>
          prev.filter((item) => item.file !== message.file),
        );
        break;
      case "summarize_complete":
        // Summarization complete
        setSummary({
          isBusy: false,
          summary: message.data.summary,
        });
        break;

      default:
        // initiate/download/done
        break;
    }
  });

  const [model, setModel] = useState<string>(() =>
    readStoredSetting("model", Constants.getDefaultModel("en")),
  );

  const [subtask, setSubtask] = useState<string>(() =>
    readStoredSetting("subtask", Constants.DEFAULT_SUBTASK),
  );
  const [dtype, setDtype] = useState<string>(() =>
    readStoredSetting("dtype", Constants.DEFAULT_DTYPE),
  );
  const [gpu, setGPU] = useState<boolean>(() =>
    readStoredSetting("gpu", Constants.DEFAULT_GPU),
  );
  const [language, setLanguage] = useState<string>(() =>
    readStoredSetting("language", Constants.getDefaultLanguage("en")),
  );

  const onInputChange = useCallback(() => {
    setTranscript(undefined);
    setSummary(undefined);
  }, []);

  const setStoredModel = useCallback((nextModel: string) => {
    setModel(nextModel);
    writeStoredSetting("model", nextModel);
  }, []);

  const setStoredDtype = useCallback((nextDtype: string) => {
    setDtype(nextDtype);
    writeStoredSetting("dtype", nextDtype);
  }, []);

  const setStoredGPU = useCallback((nextGPU: boolean) => {
    setGPU(nextGPU);
    writeStoredSetting("gpu", nextGPU);
  }, []);

  const setStoredSubtask = useCallback((nextSubtask: string) => {
    setSubtask(nextSubtask);
    writeStoredSetting("subtask", nextSubtask);
  }, []);

  const setStoredLanguage = useCallback((nextLanguage: string) => {
    setLanguage(nextLanguage);
    writeStoredSetting("language", nextLanguage);
  }, []);

  const postRequest = useCallback(
    async (
      audioData: AudioBuffer | undefined,
      audioBlob?: Blob,
      sourceName?: string,
      formatForCaptions?: boolean,
    ) => {
      if (audioData) {
        let requestModel = model;

        if (requestModel === "parakeet.wgsl") {
          let parakeetSupported = false;

          try {
            parakeetSupported =
              "gpu" in navigator && (await checkSupport()).supported;
          } catch {
            parakeetSupported = false;
          }

          if (!parakeetSupported) {
            requestModel = "onnx-community/whisper-base";
            setStoredModel(requestModel);
          }
        }

        setTranscript(undefined);
        setIsBusy(true);
        setTranscript({
          isBusy: true,
          text: "",
          progress: 0,
          chunks: [],
        });
        jobStartRef.current = performance.now();
        // If the model is already loaded, transcription starts immediately;
        // otherwise wait for the "ready" event so load time isn't counted.
        if (isModelLoadingRef.current) {
          awaitingModelLoadRef.current = true;
          transcriptionStartRef.current = null;
        } else {
          awaitingModelLoadRef.current = false;
          transcriptionStartRef.current = performance.now();
        }

        let audio;
        if (audioData.numberOfChannels === 2) {
          const SCALING_FACTOR = Math.sqrt(2);

          const left = audioData.getChannelData(0);
          const right = audioData.getChannelData(1);

          audio = new Float32Array(left.length);
          for (let i = 0; i < audioData.length; ++i) {
            audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
          }
        } else {
          // Copy (rather than reference) the channel data so its buffer can be
          // transferred below without detaching the AudioBuffer used for playback.
          audio = audioData.getChannelData(0).slice();
        }

        // Transfer the audio buffer instead of structured-cloning it, so it isn't
        // duplicated in memory across the main thread and the worker. This matters
        // for large files, where holding two copies for the whole job can push
        // memory usage high enough that the final result can't be cloned back.
        webWorker.postMessage(
          {
            audio,
            audioBlob: requestModel === "parakeet.wgsl" ? undefined : audioBlob,
            sourceName: requestModel === "parakeet.wgsl" ? undefined : sourceName,
            formatForCaptions,
            duration: audioData.duration,
            model: requestModel,
            dtype,
            gpu,
            subtask: !requestModel.endsWith(".en") ? subtask : null,
            language:
              !requestModel.endsWith(".en") && language !== "auto"
                ? language
                : null,
          },
          [audio.buffer],
        );
      }
    },
    [webWorker, model, dtype, gpu, subtask, language, setStoredModel],
  );

  const summarizeRequest = useCallback(
    async (text: string) => {
      if (typeof window === "undefined") {
        setSummary({
          isBusy: false,
          error: "Summary generation is only available in the browser.",
        });
        return;
      }

      const SummarizerCtor = (window as Window & {
        Summarizer?: BrowserSummarizerConstructor;
      }).Summarizer;
      const LanguageDetectorCtor = (window as Window & {
        LanguageDetector?: BrowserLanguageDetectorConstructor;
      }).LanguageDetector;

      if (!SummarizerCtor) {
        setSummary({
          isBusy: false,
          error: "This browser does not support the built-in Summarizer API.",
        });
        return;
      }

      setSummary({ isBusy: true });

      try {
        const normalizedText = text.trim();
        const supportedOutputLanguages = ["de", "en", "es", "fr", "ja"] as const;

        const resolveOutputLanguage = async (): Promise<(typeof supportedOutputLanguages)[number]> => {
          if (!LanguageDetectorCtor || normalizedText.length === 0) {
            return "en";
          }

          const detectorAvailability = await LanguageDetectorCtor.availability();
          if (detectorAvailability !== "available") {
            return "en";
          }

          try {
            const detector = await LanguageDetectorCtor.create({
              expectedInputLanguages: [...supportedOutputLanguages],
            });
            const results = await detector.detect(normalizedText);
            const detectedLanguage = results
              .map((result) => result.detectedLanguage)
              .find((languageCode) => {
                const normalizedCode = languageCode.split("-")[0];
                return supportedOutputLanguages.includes(
                  normalizedCode as (typeof supportedOutputLanguages)[number],
                );
              });

            if (!detectedLanguage) {
              return "en";
            }

            const normalizedCode = detectedLanguage.split("-")[0];
            if (supportedOutputLanguages.includes(normalizedCode as (typeof supportedOutputLanguages)[number])) {
              return normalizedCode as (typeof supportedOutputLanguages)[number];
            }
          } catch {
            // Fall back to English for unsupported or empty language detection results.
          }

          return "en";
        };

        const outputLanguage = await resolveOutputLanguage();

        const summarizerOptions: SummarizerOptions = {
          type: "tldr",
          length: "long",
          format: "plain-text",
          outputLanguage,
          expectedInputLanguages: [...supportedOutputLanguages],
          sharedContext:
            "Produce a concise summary that preserves the key points and main takeaways from the transcript. Use plain language.",
        };

        const availability = await SummarizerCtor.availability(summarizerOptions);

        if (availability === "unsupported" || availability === "unavailable") {
          throw new Error(
            `The built-in summary API is not supported or unavailable in this browser (status: ${availability}).`
          );
        }

        const summarizer = await SummarizerCtor.create(summarizerOptions);
        const summaryChunks = splitTextIntoSummaryChunks(normalizedText);

        const chunkSummaries = await Promise.all(
          summaryChunks.map(async (chunk) => {
            const summaryText = await summarizer.summarize(chunk);
            return summaryText.trim();
          }),
        );

        const filteredSummaries = chunkSummaries.filter(Boolean);
        const finalSummary = filteredSummaries.length
          ? filteredSummaries.join("\n\n")
          : "No summary was returned.";

        setSummary({
          isBusy: false,
          summary: finalSummary,
        });
      } catch (error) {
        setSummary({
          isBusy: false,
          error:
            error instanceof Error
              ? error.message
              : "An unknown error occurred while generating the summary.",
        });
      }
    },
    [],
  );

  const transcriber = useMemo(() => {
    return {
      onInputChange,
      isBusy,
      isModelLoading,
      supportsSummarizer,
      progressItems,
      start: postRequest,
      output: transcript,
      model,
      setModel: setStoredModel,
      dtype,
      setDtype: setStoredDtype,
      gpu,
      setGPU: setStoredGPU,
      subtask,
      setSubtask: setStoredSubtask,
      language,
      setLanguage: setStoredLanguage,
      summary,
      summarize: summarizeRequest,
      setTranscript,
    };
  }, [
    onInputChange,
    isBusy,
    isModelLoading,
    supportsSummarizer,
    progressItems,
    postRequest,
    transcript,
    model,
    dtype,
    gpu,
    subtask,
    language,
    setStoredModel,
    setStoredDtype,
    setStoredGPU,
    setStoredSubtask,
    setStoredLanguage,
    summary,
    summarizeRequest,
    setTranscript,
  ]);

  return transcriber;
}