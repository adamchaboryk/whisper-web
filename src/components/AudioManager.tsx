import React, {
  useEffect,
  useState,
  useCallback,
  JSX,
  useMemo,
  useRef,
} from "react";
import { parseSubtitleFile } from "../utils/SubtitleUtils";
import Modal from "./modal/Modal";
import AudioPlayer from "./AudioPlayer";
import { TranscribeButton } from "./TranscribeButton";
import Constants, { AudioSource, isMobileOrTablet } from "../utils/Constants";
import { Transcriber, TranscriberData } from "../hooks/useTranscriber";
import {
  AnchorIcon,
  FolderIcon,
  MicrophoneIcon,
  InfoIcon,
  ThemeIcon,
  SettingsIcon,
} from "../utils/Icons";
import { isPrivateOrLocalHost } from "../utils/AudioUtils";
import {
  AudioBufferSink,
  BlobSource,
  Input,
  MP4,
} from "mediabunny";

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const RecordModal = React.lazy(() => import("./RecordModal"));
const UrlModal = React.lazy(() => import("./UrlModal"));
const INVALID_AUDIO_LINK = "INVALID_AUDIO_LINK";
const INVALID_URL_SCHEME = "INVALID_URL_SCHEME";
const INVALID_URL_FORMAT = "INVALID_URL_FORMAT";
const INVALID_PRIVATE_URL = "INVALID_PRIVATE_URL";
const AUDIO_TOO_LONG = "AUDIO_TOO_LONG";
const SUSPECTED_DECOMPRESSION_BOMB = "SUSPECTED_DECOMPRESSION_BOMB";
const MAX_AUDIO_DURATION_SECONDS = 4 * 60 * 60; // 4 hours maximum
const MIN_BYTES_PER_SECOND = 1000; // ~8 kbps minimum for long audio (>30m)

// Sites known to serve web pages (not direct audio files) at their URLs, which would
// otherwise surface as a confusing CORS/network error instead of an explanation.
const NON_AUDIO_HOSTNAMES = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "tiktok.com",
  "twitch.tv",
  "dailymotion.com",
  "facebook.com",
  "instagram.com",
  "soundcloud.com",
  "spotify.com",
];

function validateAudioUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(INVALID_URL_FORMAT);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(INVALID_URL_FORMAT);
  }

  // Only allow HTTP and HTTPS protocols
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(INVALID_URL_SCHEME);
  }

  // Allow same-origin resources (e.g. sample audio and sample video)
  if (parsedUrl.origin !== window.location.origin) {
    if (isPrivateOrLocalHost(parsedUrl.hostname)) {
      throw new Error(INVALID_PRIVATE_URL);
    }
  }

  return parsedUrl;
}

function isKnownNonAudioLink(parsedUrl: URL): boolean {
  const hostname = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  return NON_AUDIO_HOSTNAMES.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function getAudioUrlErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "";
    }
    if (error.message === AUDIO_TOO_LONG) {
      return "The audio duration exceeds the maximum allowed length (4 hours). Please use a shorter file or split the audio first.";
    }
    if (error.message === SUSPECTED_DECOMPRESSION_BOMB) {
      return "The audio file has an abnormally high compression ratio and cannot be safely decoded in the browser.";
    }
    if (error.message === INVALID_AUDIO_LINK) {
      return "That link doesn't point to a direct audio file (e.g., YouTube and other video site links aren't supported). Please use a direct link to an audio file, such as one ending in .mp3 or .wav.";
    }
    if (error.message === INVALID_URL_SCHEME) {
      return "Only HTTP and HTTPS URLs are supported (e.g., https://example.com/audio.mp3).";
    }
    if (error.message === INVALID_URL_FORMAT) {
      return "Please enter a valid, complete URL including http:// or https:// (e.g., https://example.com/audio.mp3).";
    }
    if (error.message === INVALID_PRIVATE_URL) {
      return "Local and private network URLs (such as localhost or internal IP addresses) cannot be accessed.";
    }
    if (error.message === "HTTP_404") {
      return "No file could be found at that URL. Please double-check the link and try again.";
    }
    if (error.message.startsWith("HTTP_")) {
      const status = error.message.replace("HTTP_", "");
      return `Failed to download the audio (server responded with status ${status}).`;
    }
    if (error.name === "TypeError") {
      return "Could not reach that URL. It may be blocked by the site (CORS) or the link may be incorrect.";
    }
  }

  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") {
      return "The file is too large for the browser's available memory. Try extracting the audio track (e.g. to MP3 or WAV) first.";
    }
    return "The file at that URL couldn't be decoded as audio. Please check the link points directly to a valid audio file.";
  }

  return "Something went wrong while loading the audio. Please check the URL and try again.";
}

/**
 * Probes the audio container header to determine duration without decompressing
 * the full audio samples into memory, preventing decompression bomb OOM crashes.
 */
async function probeAudioMetadata(blob: Blob): Promise<{ duration: number }> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve({ duration: 0 });
      return;
    }
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const objectUrl = URL.createObjectURL(blob);

    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ duration: 0 });
    }, 3000);

    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const duration = audio.duration;
      cleanup();
      resolve({
        duration:
          Number.isFinite(duration) && duration > 0 ? duration : 0,
      });
    };

    audio.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ duration: 0 });
    };

    audio.src = objectUrl;
  });
}

function validateAudioMetadata(duration: number, byteLength: number): void {
  if (duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error(AUDIO_TOO_LONG);
  }
  if (duration > 1800 && byteLength / duration < MIN_BYTES_PER_SECOND) {
    throw new Error(SUSPECTED_DECOMPRESSION_BOMB);
  }
}

async function decodeAudioBuffer(
  data: Blob | ArrayBuffer,
  mimeType = "",
  onProgress?: (progress: number) => void,
): Promise<AudioBuffer> {
  if (mimeType === "video/mp4" || mimeType === "application/mp4") {
    const blob = data instanceof Blob
      ? data
      : new Blob([data], { type: mimeType });
    const input = new Input({
      source: new BlobSource(blob),
      formats: [MP4],
    });

    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) {
        throw new Error("The video does not contain an audio track.");
      }
      if (!(await audioTrack.canDecode())) {
        throw new Error("This browser cannot decode the video's audio codec.");
      }

      const duration = await input.computeDuration([audioTrack]);
      const sink = new AudioBufferSink(audioTrack);
      const chunks: Float32Array[] = [];
      let totalLength = 0;
      let sampleRate = Constants.SAMPLING_RATE;

      for await (const wrapped of sink.buffers()) {
        const chunk = wrapped.buffer;
        const channelCount = Math.max(1, chunk.numberOfChannels);
        const channelData = Array.from(
          { length: channelCount },
          (_, channel) => chunk.getChannelData(channel),
        );
        const mono = new Float32Array(chunk.length);
        for (let index = 0; index < chunk.length; index++) {
          for (const channel of channelData) {
            mono[index] += channel[index] / channelCount;
          }
        }
        chunks.push(mono);
        totalLength += mono.length;
        sampleRate = chunk.sampleRate;
        if (duration > 0) {
          onProgress?.(
            Math.min(1, (wrapped.timestamp + wrapped.duration) / duration),
          );
        }
      }

      if (chunks.length === 0 || totalLength === 0) {
        throw new Error("The video does not contain decodable audio.");
      }

      const outputContext = new AudioContext({ sampleRate });
      try {
        const output = outputContext.createBuffer(1, totalLength, sampleRate);
        const samples = output.getChannelData(0);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        return output;
      } finally {
        void outputContext.close().catch(() => undefined);
      }
    } finally {
      input.dispose();
    }
  }

  const arrayBuffer =
    data instanceof Blob ? await data.arrayBuffer() : data;
  const audioCTX =
    typeof OfflineAudioContext !== "undefined"
      ? new OfflineAudioContext(1, 1, Constants.SAMPLING_RATE)
      : new AudioContext({ sampleRate: Constants.SAMPLING_RATE });
  try {
    return await audioCTX.decodeAudioData(arrayBuffer);
  } finally {
    if ("close" in audioCTX && typeof audioCTX.close === "function") {
      void audioCTX.close().catch(() => undefined);
    }
  }
}

function getModelSize(model: string, dtype: string): string {
  let baseMB = 0;
  if (model === "parakeet.wgsl") baseMB = 405;
  else if (model.includes("base")) baseMB = 75;
  else if (model.includes("small")) baseMB = 240;
  else if (model.includes("large")) baseMB = 1500;
  else baseMB = 75; // tiny or default

  if (model !== "parakeet.wgsl") {
    if (dtype === "q8") baseMB *= 2;
    else if (dtype === "fp16") baseMB *= 4;
  }

  if (baseMB >= 1000) {
    return (baseMB / 1000).toFixed(1) + " GB";
  }
  return baseMB + " MB";
}

export const AudioManager = React.memo(function AudioManager(props: {
  transcriber: Transcriber;
  onGenerateSummary?: () => void;
  transcriptChunks?: TranscriberData["chunks"];
  onSeekReady?: (seekTo: (time: number) => void) => void;
  onTimeUpdate?: (time: number) => void;
  playbackRate?: number;
  isEditing?: boolean;
}) {
  const [isAudioProcessing, setIsAudioProcessing] = useState(false);
  const [audioProcessingProgress, setAudioProcessingProgress] =
    useState<number | null>(null);
  const [audioReadyAnnouncement, setAudioReadyAnnouncement] = useState("");
  const [audioError, setAudioError] = useState<string | null>(null);
  const transcribeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [audioData, setAudioData] = useState<
    | {
      buffer: AudioBuffer;
      blob: Blob;
      sourceName: string;
      url: string;
      source: AudioSource;
      mimeType: string;
      isSampleVideo?: boolean;
    }
    | undefined
  >(undefined);

  // Automatically revoke previous object URLs when audioData changes or component unmounts
  useEffect(() => {
    return () => {
      if (audioData?.url && audioData.url.startsWith("blob:")) {
        URL.revokeObjectURL(audioData.url);
      }
    };
  }, [audioData]);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  const [showWarningModal, setShowWarningModal] = useState(false);
  const [isHoveringFile, setIsHoveringFile] = useState(false);
  const transcriptFileInputRef = useRef<HTMLInputElement>(null);

  const checkAndResetIfMismatched = useCallback(
    (audioDuration: number) => {
      const chunks = props.transcriptChunks;
      if (!chunks?.length || !audioDuration) return;

      const lastChunk = chunks[chunks.length - 1];
      const transcriptDuration =
        lastChunk.timestamp[1] ?? lastChunk.timestamp[0] ?? 0;
      const diff = Math.abs(transcriptDuration - audioDuration);

      if (diff > Math.max(10, audioDuration * 0.1)) {
        props.transcriber.onInputChange();
      }
    },
    [props.transcriptChunks, props.transcriber],
  );

  const startTranscription = useCallback(() => {
    if (audioData) {
      props.transcriber.start(
        audioData.buffer,
        audioData.blob,
        audioData.sourceName,
        true, // formatForCaptions
      );
    }
  }, [audioData, props.transcriber]);

  const handleTranscribeClick = useCallback(() => {
    if (!localStorage.getItem("hasAcceptedTranscriptionWarning")) {
      setShowWarningModal(true);
    } else {
      startTranscription();
    }
  }, [startTranscription]);

  const handleTranscriptImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      const extension = file.name.split(".").pop()?.toLowerCase();
      if (extension !== "srt" && extension !== "vtt") {
        setAudioError("Choose an SRT or VTT transcript file.");
        return;
      }

      const parsed = parseSubtitleFile(await file.text(), extension);
      if (!parsed.chunks.length) {
        setAudioError("The transcript file does not contain any subtitle cues.");
        return;
      }

      props.transcriber.setTranscript({
        isBusy: false,
        text: parsed.text,
        chunks: parsed.chunks,
        progress: 100,
      });
      setAudioError(null);
    },
    [props.transcriber],
  );

  const isTranscriptLengthMismatched = useMemo(() => {
    if (!props.transcriptChunks?.length || !audioData?.buffer?.duration)
      return false;

    const lastChunk =
      props.transcriptChunks[props.transcriptChunks.length - 1];
    const transcriptDuration =
      lastChunk.timestamp[1] ?? lastChunk.timestamp[0] ?? 0;
    const audioDuration = audioData.buffer.duration;

    const diff = Math.abs(transcriptDuration - audioDuration);
    // Consider significantly different if the difference is more than 10% of the audio duration
    // AND at least 10 seconds.
    return diff > Math.max(10, audioDuration * 0.1);
  }, [props.transcriptChunks, audioData]);

  const isModelChanged = Boolean(
    props.transcriber.output &&
    !props.transcriber.isBusy &&
    props.transcriber.output.model &&
    props.transcriber.output.model !== props.transcriber.model,
  );

  // Combine all in-flight model file downloads into a single byte-weighted percentage.
  const overallModelLoadProgress = useMemo(() => {
    const items = props.transcriber.progressItems;
    if (items.length === 0) {
      return 0;
    }

    const totalBytes = items.reduce(
      (sum, item) => sum + (item.total || 0),
      0,
    );
    if (totalBytes > 0) {
      const loadedBytes = items.reduce(
        (sum, item) => sum + (item.loaded || 0),
        0,
      );
      return (loadedBytes / totalBytes) * 100;
    }

    const totalProgress = items.reduce(
      (sum, item) => sum + (item.progress || 0),
      0,
    );
    return totalProgress / items.length;
  }, [props.transcriber.progressItems]);

  const resetAudio = () => {
    setAudioData(undefined);
    setAudioError(null);

    if (requestAbortControllerRef.current) {
      requestAbortControllerRef.current.abort();
      requestAbortControllerRef.current = null;
    }
  };

  const sampleAudioUrl = useMemo(
    () =>
      new URL(
        "test.wav",
        `${window.location.origin}${import.meta.env.BASE_URL}`,
      ).toString(),
    [],
  );

  const sampleVideoUrl = useMemo(
    () =>
      new URL(
        "sample-video.mp4",
        `${window.location.origin}${import.meta.env.BASE_URL}`,
      ).toString(),
    [],
  );

  const setAudioFromDownload = useCallback(
    async (data: ArrayBuffer, mimeType: string, isSampleVideo = false) => {
      const blob = new Blob([data], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const { duration } = await probeAudioMetadata(blob);
        if (duration > 0) {
          validateAudioMetadata(duration, blob.size);
        }
        const decoded = await decodeAudioBuffer(blob, mimeType);
        validateAudioMetadata(decoded.duration, blob.size);
        checkAndResetIfMismatched(decoded.duration);
        setAudioData({
          buffer: decoded,
          blob: blob,
          sourceName: `source.${mimeType.split("/")[1]?.split(";")[0] || (mimeType.startsWith("video/") ? "webm" : "wav")}`,
          url: blobUrl,
          source: AudioSource.URL,
          mimeType: mimeType,
          isSampleVideo,
        });
      } catch (error) {
        URL.revokeObjectURL(blobUrl);
        throw error;
      }
    },
    [checkAndResetIfMismatched],
  );

  const setAudioFromRecording = async (data: Blob) => {
    resetAudio();
    const blobUrl = URL.createObjectURL(data);
    try {
      const decoded = await decodeAudioBuffer(data, data.type);
      checkAndResetIfMismatched(decoded.duration);
      setAudioData({
        buffer: decoded,
        blob: data,
        sourceName: `recording.${data.type.split("/")[1]?.split(";")[0] || "webm"}`,
        url: blobUrl,
        source: AudioSource.RECORDING,
        mimeType: data.type,
      });
    } catch (error) {
      URL.revokeObjectURL(blobUrl);
      console.error("Failed to decode recording:", error);
      setAudioError("Failed to decode the microphone recording.");
    }
  };

  const downloadAudioFromUrl = useCallback(
    async (requestAbortController: AbortController, url: string) => {
      try {
        setAudioData(undefined);
        setAudioError(null);
        setIsAudioProcessing(true);

        const parsedUrl = validateAudioUrl(url);

        if (isKnownNonAudioLink(parsedUrl)) {
          throw new Error(INVALID_AUDIO_LINK);
        }

        const response = await fetch(parsedUrl.href, {
          signal: requestAbortController.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP_${response.status}`);
        }

        let mimeType = response.headers.get("content-type") || "";
        if (mimeType.startsWith("text/html")) {
          throw new Error(INVALID_AUDIO_LINK);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          const buffer = await response.arrayBuffer();
          if (!mimeType || mimeType === "audio/wave") {
            const pathname = parsedUrl.pathname.toLowerCase();
            if (pathname.endsWith(".webm")) {
              mimeType = "video/webm";
            } else if (pathname.endsWith(".mp4")) {
              mimeType = "video/mp4";
            } else {
              mimeType = "audio/wav";
            }
          }
          const isSampleVideo =
            parsedUrl.href === sampleVideoUrl ||
            parsedUrl.pathname.includes("sample-video.mp4") ||
            parsedUrl.pathname.includes("video-demo.webm");
          await setAudioFromDownload(buffer, mimeType, isSampleVideo);
          return;
        }

        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const blob = new Blob(chunks as BlobPart[], {
          type: mimeType,
        });
        const data = await blob.arrayBuffer();

        if (!mimeType || mimeType === "audio/wave") {
          const pathname = parsedUrl.pathname.toLowerCase();
          if (pathname.endsWith(".webm")) {
            mimeType = "video/webm";
          } else if (pathname.endsWith(".mp4")) {
            mimeType = "video/mp4";
          } else {
            mimeType = "audio/wav";
          }
        }
        const isSampleVideo =
          parsedUrl.href === sampleVideoUrl ||
          parsedUrl.pathname.includes("sample-video.mp4") ||
          parsedUrl.pathname.includes("video-demo.webm");
        await setAudioFromDownload(data, mimeType, isSampleVideo);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.error("Failed to load audio from URL", error);
        setAudioError(getAudioUrlErrorMessage(error));
      } finally {
        setIsAudioProcessing(false);
      }
    },
    [sampleVideoUrl, setAudioFromDownload],
  );

  useEffect(() => {
    if (!audioData) {
      const frame = window.requestAnimationFrame(() => {
        setAudioReadyAnnouncement("");
      });
      return () => window.cancelAnimationFrame(frame);
    }

    let frame2: number;
    const frame1 = window.requestAnimationFrame(() => {
      setAudioReadyAnnouncement("");
      frame2 = window.requestAnimationFrame(() => {
        setAudioReadyAnnouncement("Audio upload completed.");
        transcribeButtonRef.current?.focus();
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      if (frame2 !== undefined) window.cancelAnimationFrame(frame2);
    };
  }, [audioData]);

  useEffect(() => {
    return () => {
      if (requestAbortControllerRef.current) {
        requestAbortControllerRef.current.abort();
      }
    };
  }, []);

  const handleUrlUpdate = useCallback(
    (url: string) => {
      if (requestAbortControllerRef.current) {
        requestAbortControllerRef.current.abort();
      }

      const requestAbortController = new AbortController();
      requestAbortControllerRef.current = requestAbortController;
      downloadAudioFromUrl(requestAbortController, url);
    },
    [downloadAudioFromUrl],
  );

  return (
    <>
      <div className='relative flex flex-col items-center'>
        <div
          id='upload-toolbar'
          className='flex flex-col justify-center items-center rounded-lg bg-white dark:bg-slate-800 shadow-xl shadow-black/5 relative'
        >
          <div className='flex flex-row space-x-3 py-2 w-full px-2'>
            <UrlTile
              icon={<AnchorIcon />}
              text='From URL'
              onUrlUpdate={handleUrlUpdate}
            />
            <VerticalBar />
            <FileTile
              icon={<FolderIcon />}
              text='From file'
              ariaDescribedBy='file-upload-ribbon'
              onMouseEnter={() => setIsHoveringFile(true)}
              onMouseLeave={() => setIsHoveringFile(false)}
              onFocus={() => setIsHoveringFile(true)}
              onBlur={() => setIsHoveringFile(false)}
              onProcessingChange={(isProcessing) => {
                setIsAudioProcessing(isProcessing);
                if (!isProcessing) setAudioProcessingProgress(null);
              }}
              onProcessingProgress={setAudioProcessingProgress}
              onFileError={(error) => {
                console.error("Failed to load file:", error);
                setAudioError(
                  error instanceof Error &&
                    error.message === AUDIO_TOO_LONG
                    ? "The audio duration exceeds the maximum allowed length (4 hours). Please use a shorter file or split the audio first."
                    : error instanceof Error &&
                      error.message ===
                      SUSPECTED_DECOMPRESSION_BOMB
                      ? "The audio file has an abnormally high compression ratio and cannot be safely decoded in the browser."
                      : error instanceof DOMException &&
                        error.name ===
                        "QuotaExceededError"
                        ? "The file is too large for the browser's available memory. Try extracting the audio track (e.g. to MP3 or WAV) first."
                        : "The file could not be decoded as audio. Please check that it is a supported audio or video format.",
                );
              }}
              onFileUpdate={async (
                decoded,
                blob,
                sourceName,
                blobUrl,
                mimeType,
              ) => {
                setAudioError(null);

                if (
                  !decoded &&
                  (mimeType === "text/srt" ||
                    mimeType === "text/vtt" ||
                    sourceName.endsWith(".srt") ||
                    sourceName.endsWith(".vtt"))
                ) {
                  const text = await blob.text();
                  const type = sourceName.endsWith(".vtt")
                    ? "vtt"
                    : "srt";
                  const parsed = parseSubtitleFile(
                    text,
                    type,
                  );

                  props.transcriber.setTranscript({
                    isBusy: false,
                    text: parsed.text,
                    chunks: parsed.chunks,
                    progress: 100,
                  });
                  setAudioData(undefined); // No audio to play
                } else if (decoded) {
                  checkAndResetIfMismatched(decoded.duration);
                  setAudioData({
                    buffer: decoded,
                    blob,
                    sourceName,
                    url: blobUrl,
                    source: AudioSource.FILE,
                    mimeType: mimeType,
                    isSampleVideo:
                      sourceName === "sample-video.mp4" ||
                      sourceName === "video-demo.webm",
                  });
                }
              }}
            />
            {navigator.mediaDevices && (
              <>
                <VerticalBar />
                <RecordTile
                  icon={<MicrophoneIcon />}
                  text='Record'
                  setAudioData={(e) => {
                    setAudioError(null);
                    setAudioFromRecording(e);
                  }}
                />
              </>
            )}
          </div>
        </div>
        <div
          className={`absolute top-full left-1/2 -translate-x-1/2 flex justify-center transition-all duration-300 ${isHoveringFile ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0 pointer-events-none"}`}
        >
          <div id='file-upload-ribbon' className='file-upload-ribbon'>
            Add audio or video from your device.
          </div>
        </div>
      </div>

      <div className='demo-container'>
        Try
        <button
          type='button'
          className='demo'
          onClick={() => handleUrlUpdate(sampleAudioUrl)}
        >
          sample audio
        </button>
        <span>or</span>
        <button
          type='button'
          className='demo'
          onClick={() => handleUrlUpdate(sampleVideoUrl)}
        >
          sample video.
        </button>
      </div>

      <p
        className='sr-only'
        role='status'
        aria-live='polite'
        aria-atomic='true'
      >
        {audioReadyAnnouncement}
      </p>
      {isAudioProcessing && (
        <div className='audio-processing-status'>
          <span className='audio-processing-status__spinner' />
          {audioProcessingProgress === null
            ? "Processing audio…"
            : `Processing audio… ${Math.min(100, Math.round(audioProcessingProgress * 100))}%`}
        </div>
      )}
      {audioError && (
        <div
          role='alert'
          className='max-w-md mt-3 px-3 py-2 text-sm font-medium text-red-800 bg-red-100 border border-red-200 rounded-lg dark:bg-red-900/40 dark:text-red-200 dark:border-red-800'
        >
          {audioError}
        </div>
      )}
      {audioData && (
        <>
          <AudioPlayer
            audioUrl={audioData.url}
            mimeType={audioData.mimeType}
            isTranscribing={props.transcriber.isBusy}
            transcriptChunks={props.transcriptChunks}
            language={
              props.transcriber.output?.language ||
              (props.transcriber.subtask === "translate"
                ? "en"
                : props.transcriber.language)
            }
            onSeekReady={props.onSeekReady}
            onTimeUpdate={props.onTimeUpdate}
            playbackRate={props.playbackRate}
            isEditing={props.isEditing}
          />

          {audioData.isSampleVideo && (
            <p className='text-xs text-slate-500 dark:text-slate-400 text-center -mt-2 mb-2'>
              (Video source:{" "}
              <a
                href='https://svs.gsfc.nasa.gov/15089/'
                target='_blank'
                rel='noreferrer'
                className='text-blue-600 dark:text-blue-400 underline hover:no-underline'
              >
                NASA
              </a>
              )
            </p>
          )}

          <div className='relative w-full flex flex-col justify-center items-center mt-2 gap-1'>
            <input
              ref={transcriptFileInputRef}
              type='file'
              accept='.srt,.vtt,text/srt,text/vtt'
              className='sr-only'
              tabIndex={-1}
              aria-hidden='true'
              onChange={handleTranscriptImport}
            />
            {(!props.transcriber.output ||
              props.transcriber.isBusy ||
              isTranscriptLengthMismatched ||
              isModelChanged) && (
                <>
                  <TranscribeButton
                    ref={transcribeButtonRef}
                    onClick={handleTranscribeClick}
                    isModelLoading={
                      props.transcriber.isModelLoading
                    }
                    modelLoadingProgress={overallModelLoadProgress}
                    isTranscribing={props.transcriber.isBusy}
                    transcribingProgress={
                      props.transcriber.output?.progress
                    }
                  />
                  {audioData.mimeType.startsWith("video/") && (
                    <p className='text-sm text-slate-600 dark:text-slate-300'>
                      ...or add{" "}
                      <button
                        type='button'
                        onClick={() => transcriptFileInputRef.current?.click()}
                        className='demo'
                      >
                        existing transcript.
                      </button>
                    </p>
                  )}
                </>
              )}
          </div>

          {props.transcriber.errorMessage && (
            <div
              role='alert'
              aria-live='assertive'
              className='w-full max-w-xl mx-auto mt-4 p-4 flex items-start justify-between gap-3 text-sm font-medium text-red-900 bg-red-50 border border-red-200 rounded-xl dark:bg-red-950/70 dark:text-red-200 dark:border-red-800 shadow-sm'
            >
              <div className='flex items-start gap-3 min-w-0'>
                <svg
                  className='w-5 h-5 shrink-0 text-red-600 dark:text-red-400 mt-0.5'
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                  aria-hidden='true'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                  />
                </svg>
                <div className='min-w-0 flex-1'>
                  <p className='font-semibold text-red-950 dark:text-red-100'>
                    Transcription failed
                  </p>
                  <p className='mt-0.5 text-red-800 dark:text-red-300 font-normal break-words'>
                    {props.transcriber.errorMessage}
                  </p>
                </div>
              </div>
              <button
                type='button'
                onClick={() =>
                  props.transcriber.setErrorMessage(undefined)
                }
                aria-label='Dismiss error'
                className='inline-flex shrink-0 p-1.5 rounded-lg text-red-700 hover:bg-red-200/50 dark:text-red-300 dark:hover:bg-red-900/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 transition-colors'
              >
                <svg
                  className='w-4 h-4'
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                  aria-hidden='true'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M6 18L18 6M6 6l12 12'
                  />
                </svg>
              </button>
            </div>
          )}
        </>
      )}

      {showWarningModal && (
        <Modal
          show={showWarningModal}
          title='Download required'
          content={
            <div className='text-slate-700 dark:text-slate-300'>
              <p className='mb-4'>
                Transcription runs privately in your browser.
                Proceeding will save a{" "}
                {getModelSize(
                  props.transcriber.model,
                  props.transcriber.dtype,
                )}{" "}
                model to your browser's temporary storage so it
                works offline. You can change models anytime in{" "}
                <em>Settings.</em>
              </p>
              {isMobileOrTablet && (
                <p className='mb-4 text-sm bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 p-3 rounded-md'>
                  <strong>⚠️ Mobile device detected:</strong>{" "}
                  A lighter model was selected by default as
                  it is less likely to crash due to hardware
                  limits. Transcription may not be as
                  accurate.
                </p>
              )}
              {typeof navigator !== "undefined" &&
                (
                  navigator as unknown as {
                    connection?: { type?: string };
                  }
                ).connection?.type === "cellular" && (
                  <p className='mt-4 font-semibold text-amber-600 dark:text-amber-500'>
                    ⚠️ It does not appear you are connected
                    to Wi-Fi. Downloading the model over
                    cellular data may incur charges.
                  </p>
                )}
            </div>
          }
          onClose={() => setShowWarningModal(false)}
          submitText='Proceed'
          submitEnabled={true}
          onSubmit={() => {
            localStorage.setItem(
              "hasAcceptedTranscriptionWarning",
              "true",
            );
            setShowWarningModal(false);
            startTranscription();
          }}
        />
      )}
    </>
  );
});

export const ApplicationControls = React.memo(
  function ApplicationControls(props: {
    transcriber: Transcriber;
    isDark: boolean;
    onThemeToggle: () => void;
    isAutoScrollEnabled: boolean;
    setIsAutoScrollEnabled: (enabled: boolean) => void;
  }) {
    return (
      <>
        <nav
          aria-label='Application controls'
          className='control-toolbar'
        >
          <InfoTile
            icon={<InfoIcon />}
            title='About this tool'
            text='About'
            isApplicationControl
            content={
              <>
                <h3>Local transcription</h3>
                <p>
                  Transcription happens locally in your
                  browser using OpenAI’s Whisper models or
                  NVIDIA’s Parakeet model. Parakeet requires a
                  WebGPU-capable browser. The selected model
                  is downloaded and cached the first time you
                  use it. Your files never leave your
                  computer.
                </p>

                <h3>AI summarization</h3>
                <p>
                  Summaries are generated locally using a
                  experimental built-in browser AI (Google
                  Gemini Nano). This feature is currently only
                  supported in Google Chrome.
                </p>

                <h3>Acknowledgements</h3>
                <p>
                  Maintained by Adam Chaboryk, Digital Media
                  Projects, Computing and Communications
                  Services at Toronto Metropolitan University.
                </p>

                <p>
                  This tool is a customized fork of{" "}
                  <a
                    href='https://huggingface.co/Xenova'
                    target='_blank'
                    rel='noopener noreferrer'
                  >
                    Joshua Lochner's Whisper Web project.
                  </a>{" "}
                  This project also incorporates{" "}
                  <a
                    href='https://github.com/narcotic-sh/parakeet.wgsl'
                    target='_blank'
                    rel='noopener noreferrer'
                  >
                    Hamza Qayyum's parakeet.wgsl project.
                  </a>
                </p>

                <h3>Open source</h3>
                <p>
                  Email feedback to{" "}
                  <a href='mailto:adam.chaboryk@torontomu.ca'>
                    adam.chaboryk@torontomu.ca
                  </a>{" "}
                  or view{" "}
                  <a
                    href='https://github.com/adamchaboryk/whisper-web'
                    target='_blank'
                    rel='noopener noreferrer'
                  >
                    source code on GitHub.
                  </a>
                </p>
              </>
            }
          />
          <Tile
            icon={<ThemeIcon isDark={props.isDark} />}
            text='Theme'
            isApplicationControl
            ariaLabel={
              props.isDark
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            title={
              props.isDark
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            onClick={props.onThemeToggle}
          />
          <SettingsTile
            transcriber={props.transcriber}
            icon={<SettingsIcon />}
            text='Settings'
            isApplicationControl
            isAutoScrollEnabled={props.isAutoScrollEnabled}
            setIsAutoScrollEnabled={props.setIsAutoScrollEnabled}
          />
        </nav>
      </>
    );
  },
);

function InfoTile(props: {
  icon: JSX.Element;
  title: string;
  text?: string;
  content: string | JSX.Element;
  isApplicationControl?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);

  const onClick = () => {
    setShowModal(true);
  };

  const onClose = () => {
    setShowModal(false);
  };

  return (
    <>
      <Tile
        icon={props.icon}
        text={props.text}
        ariaLabel={props.title}
        title={props.title}
        onClick={onClick}
        isApplicationControl={props.isApplicationControl}
      />
      <Modal
        show={showModal}
        submitEnabled={false}
        onClose={onClose}
        title={props.title}
        content={props.content}
      />
    </>
  );
}

function SettingsTile(props: {
  icon: JSX.Element;
  transcriber: Transcriber;
  text?: string;
  isApplicationControl?: boolean;
  isAutoScrollEnabled: boolean;
  setIsAutoScrollEnabled: (enabled: boolean) => void;
}) {
  const [showModal, setShowModal] = useState(false);

  const onClick = () => {
    setShowModal(true);
  };

  const onClose = () => {
    setShowModal(false);
  };

  const onSubmit = () => {
    onClose();
  };

  return (
    <>
      <Tile
        icon={props.icon}
        text={props.text}
        ariaLabel='Settings'
        title='Settings'
        onClick={onClick}
        isApplicationControl={props.isApplicationControl}
      />
      {showModal && (
        <React.Suspense fallback={null}>
          <SettingsModal
            show={showModal}
            onSubmit={onSubmit}
            onClose={onClose}
            transcriber={props.transcriber}
            isAutoScrollEnabled={props.isAutoScrollEnabled}
            setIsAutoScrollEnabled={props.setIsAutoScrollEnabled}
          />
        </React.Suspense>
      )}
    </>
  );
}

function VerticalBar() {
  return <div className='w-[1px] bg-[#334155] dark:bg-[#94a3b8]'></div>;
}

function UrlTile(props: {
  icon: JSX.Element;
  text: string;
  onUrlUpdate: (url: string) => void;
}) {
  const [showModal, setShowModal] = useState(false);

  const onClick = () => {
    setShowModal(true);
  };

  const onClose = () => {
    setShowModal(false);
  };

  const onSubmit = (url: string) => {
    props.onUrlUpdate(url);
    onClose();
  };
  return (
    <>
      <Tile
        icon={props.icon}
        text={props.text}
        onClick={onClick}
        isUploadButton
      />
      {showModal && (
        <React.Suspense fallback={null}>
          <UrlModal
            show={showModal}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        </React.Suspense>
      )}
    </>
  );
}

function FileTile(props: {
  icon: JSX.Element;
  text: string;
  onProcessingChange: (isProcessing: boolean) => void;
  onProcessingProgress?: (progress: number) => void;
  onFileError?: (error: unknown) => void;
  onFileUpdate: (
    decoded: AudioBuffer | undefined,
    blob: Blob,
    sourceName: string,
    blobUrl: string,
    mimeType: string,
  ) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  ariaDescribedBy?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Make sure we have files to use
    const files = event.target.files;
    if (!files || !files[0]) return;

    const file = files[0];

    const isAudioVideo =
      file.type.startsWith("audio/") || file.type.startsWith("video/");
    const isSubtitle =
      file.name.endsWith(".srt") || file.name.endsWith(".vtt");

    if (!isAudioVideo && !isSubtitle) return;

    // Only create an object URL for audio/video media (subtitles do not play media)
    const urlObj = isAudioVideo ? URL.createObjectURL(file) : "";
    const mimeType =
      file.type || (file.name.endsWith(".srt") ? "text/srt" : "text/vtt");

    props.onProcessingChange(true);

    const processAudioFile = async () => {
      try {
        const { duration } = await probeAudioMetadata(file);
        if (duration > 0) {
          validateAudioMetadata(duration, file.size);
        }

        const decoded = await decodeAudioBuffer(
          file,
          mimeType,
          props.onProcessingProgress,
        );
        validateAudioMetadata(decoded.duration, file.size);
        props.onFileUpdate(
          decoded,
          file,
          file.name,
          urlObj,
          mimeType,
        );
      } catch (error) {
        if (urlObj) URL.revokeObjectURL(urlObj);
        props.onFileError?.(error);
      } finally {
        props.onProcessingChange(false);
      }
    };

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      props.onFileUpdate(undefined, file, file.name, "", mimeType);
      props.onProcessingChange(false);
    });

    reader.addEventListener("error", () => {
      if (urlObj) URL.revokeObjectURL(urlObj);
      props.onFileError?.(reader.error);
      props.onProcessingChange(false);
    });

    if (isSubtitle) reader.readAsText(file);
    else void processAudioFile();

    // Reset files
    event.target.value = "";
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type='file'
        accept='audio/*,video/*,.srt,.vtt'
        className='sr-only'
        tabIndex={-1}
        aria-hidden='true'
        onChange={handleFileInput}
      />
      <Tile
        icon={props.icon}
        text={props.text}
        isUploadButton
        onClick={() => fileInputRef.current?.click()}
        onMouseEnter={props.onMouseEnter}
        onMouseLeave={props.onMouseLeave}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        ariaDescribedBy={props.ariaDescribedBy}
      />
    </>
  );
}

function RecordTile(props: {
  icon: JSX.Element;
  text: string;
  setAudioData: (data: Blob) => void;
}) {
  const [showModal, setShowModal] = useState(false);

  const onClick = () => {
    setShowModal(true);
  };

  const onClose = () => {
    setShowModal(false);
  };

  const onSubmit = (data: Blob | undefined) => {
    if (data) {
      props.setAudioData(data);
      onClose();
    }
  };

  return (
    <>
      <Tile
        icon={props.icon}
        text={props.text}
        onClick={onClick}
        isUploadButton
      />
      {showModal && (
        <React.Suspense fallback={null}>
          <RecordModal
            show={showModal}
            onSubmit={onSubmit}
            onProgress={() => { }}
            onClose={onClose}
          />
        </React.Suspense>
      )}
    </>
  );
}

function Tile(props: {
  icon: JSX.Element;
  text?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  title?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  isApplicationControl?: boolean;
  isUploadButton?: boolean;
}) {
  return (
    <button
      type='button'
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      aria-label={props.ariaLabel ?? props.text}
      aria-describedby={props.ariaDescribedBy}
      className={
        props.isApplicationControl
          ? "control-button"
          : props.isUploadButton
            ? "upload-button"
            : "flex items-center justify-center rounded-lg p-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-white hover:bg-blue-600 transition-all duration-200"
      }
    >
      <div className='w-7 h-7 tile-button__icon'>{props.icon}</div>
      {props.text && (
        <div
          className={
            props.isApplicationControl
              ? "control-button__label"
              : "ml-2 break-text text-center text-md mw-30"
          }
        >
          {props.text}
        </div>
      )}
    </button>
  );
}
