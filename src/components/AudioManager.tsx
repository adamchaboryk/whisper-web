import React, {
  useEffect,
  useState,
  useCallback,
  JSX,
  useMemo,
  useRef,
} from "react";
import axios from "axios";
import { checkSupport } from "parakeet.wgsl";
import Modal from "./modal/Modal";
import { UrlInput } from "./modal/UrlInput";
import AudioPlayer from "./AudioPlayer";
import { TranscribeButton } from "./TranscribeButton";
import Constants, {
  AudioSource,
  DTYPES,
  LANGUAGES,
  MODELS,
} from "../utils/Constants";
import { Transcriber, TranscriberData } from "../hooks/useTranscriber";
import AudioRecorder from "./AudioRecorder";
import { AnchorIcon, FolderIcon, MicrophoneIcon, SpeakerWaveIcon, InfoIcon, ThemeIcon, SettingsIcon } from '../utils/Icons';

const INVALID_AUDIO_LINK = "INVALID_AUDIO_LINK";

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

function isKnownNonAudioLink(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return NON_AUDIO_HOSTNAMES.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function getAudioUrlErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === INVALID_AUDIO_LINK) {
    return "That link doesn't point to a direct audio file (e.g., YouTube and other video site links aren't supported). Please use a direct link to an audio file, such as one ending in .mp3 or .wav.";
  }

  if (error instanceof DOMException) {
    return "The file at that URL couldn't be decoded as audio. Please check the link points directly to a valid audio file.";
  }

  if (axios.isAxiosError(error)) {
    if (error.response) {
      return error.response.status === 404
        ? "No file could be found at that URL. Please double-check the link and try again."
        : `Failed to download the audio (server responded with status ${error.response.status}).`;
    }
    return "Could not reach that URL. It may be blocked by the site (CORS) or the link may be incorrect.";
  }

  return "Something went wrong while loading the audio. Please check the URL and try again.";
}

function titleCase(str: string) {
  str = str.toLowerCase();
  return (str.match(/\w+.?/g) || [])
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

export function AudioManager(props: {
  transcriber: Transcriber;
  onGenerateSummary?: () => void;
  transcriptChunks?: TranscriberData["chunks"];
  onSeekReady?: (seekTo: (time: number) => void) => void;
}) {
  const [isAudioProcessing, setIsAudioProcessing] = useState(false);
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
    }
    | undefined
  >(undefined);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  // Combine all in-flight model file downloads into a single byte-weighted percentage.
  const overallModelLoadProgress = useMemo(() => {
    const items = props.transcriber.progressItems;
    if (items.length === 0) {
      return 0;
    }

    const totalBytes = items.reduce((sum, item) => sum + (item.total || 0), 0);
    if (totalBytes > 0) {
      const loadedBytes = items.reduce((sum, item) => sum + (item.loaded || 0), 0);
      return (loadedBytes / totalBytes) * 100;
    }

    const totalProgress = items.reduce((sum, item) => sum + (item.progress || 0), 0);
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

  const setAudioFromDownload = async (
    data: ArrayBuffer,
    mimeType: string,
  ) => {
    const audioCTX = new AudioContext({
      sampleRate: Constants.SAMPLING_RATE,
    });
    const blobUrl = URL.createObjectURL(
      new Blob([data], { type: "audio/*" }),
    );
    const decoded = await audioCTX.decodeAudioData(data);
    setAudioData({
      buffer: decoded,
      blob: new Blob([data], { type: mimeType }),
      sourceName: `source.${mimeType.split("/")[1]?.split(";")[0] || "wav"}`,
      url: blobUrl,
      source: AudioSource.URL,
      mimeType: mimeType,
    });
  };

  const setAudioFromRecording = async (data: Blob) => {
    resetAudio();
    const blobUrl = URL.createObjectURL(data);
    const fileReader = new FileReader();
    fileReader.onloadend = async () => {
      const audioCTX = new AudioContext({
        sampleRate: Constants.SAMPLING_RATE,
      });
      const arrayBuffer = fileReader.result as ArrayBuffer;
      const decoded = await audioCTX.decodeAudioData(arrayBuffer);
      setAudioData({
        buffer: decoded,
        blob: data,
        sourceName: `recording.${data.type.split("/")[1]?.split(";")[0] || "webm"}`,
        url: blobUrl,
        source: AudioSource.RECORDING,
        mimeType: data.type,
      });
    };
    fileReader.readAsArrayBuffer(data);
  };

  const downloadAudioFromUrl = useCallback(
    async (requestAbortController: AbortController, url: string) => {
      try {
        setAudioData(undefined);
        setAudioError(null);
        setIsAudioProcessing(true);

        if (isKnownNonAudioLink(url)) {
          throw new Error(INVALID_AUDIO_LINK);
        }

        const { data, headers } = (await axios.get(url, {
          signal: requestAbortController.signal,
          responseType: "arraybuffer",
        })) as {
          data: ArrayBuffer;
          headers: { "content-type": string };
        };

        let mimeType = headers["content-type"];
        if (mimeType && mimeType.startsWith("text/html")) {
          throw new Error(INVALID_AUDIO_LINK);
        }
        if (!mimeType || mimeType === "audio/wave") {
          mimeType = "audio/wav";
        }
        await setAudioFromDownload(data, mimeType);
      } catch (error) {
        if (axios.isCancel(error)) {
          return;
        }

        console.error("Failed to load audio from URL", error);
        setAudioError(getAudioUrlErrorMessage(error));
      } finally {
        setIsAudioProcessing(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!audioData) {
      setAudioReadyAnnouncement("");
      return;
    }

    setAudioReadyAnnouncement("");
    const frame = window.requestAnimationFrame(() => {
      setAudioReadyAnnouncement("Audio upload completed.");
      transcribeButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [audioData?.url]);

  useEffect(() => {
    return () => {
      if (requestAbortControllerRef.current) {
        requestAbortControllerRef.current.abort();
      }
    };
  }, []);

  const handleUrlUpdate = useCallback(
    (url: string) => {
      props.transcriber.onInputChange();

      if (requestAbortControllerRef.current) {
        requestAbortControllerRef.current.abort();
      }

      const requestAbortController = new AbortController();
      requestAbortControllerRef.current = requestAbortController;
      downloadAudioFromUrl(requestAbortController, url);
    },
    [downloadAudioFromUrl, props.transcriber],
  );

  return (
    <>
      <div id='upload-toolbar' className='flex flex-col justify-center items-center rounded-lg bg-white dark:bg-slate-800 shadow-xl shadow-black/5'>
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
            onProcessingChange={setIsAudioProcessing}
            onFileUpdate={(decoded, blob, sourceName, blobUrl, mimeType) => {
              props.transcriber.onInputChange();
              setAudioError(null);
              setAudioData({
                buffer: decoded,
                blob,
                sourceName,
                url: blobUrl,
                source: AudioSource.FILE,
                mimeType: mimeType,
              });
            }}
          />
          {navigator.mediaDevices && (
            <>
              <VerticalBar />
              <RecordTile
                icon={<MicrophoneIcon />}
                text='Record'
                setAudioData={(e) => {
                  props.transcriber.onInputChange();
                  setAudioError(null);
                  setAudioFromRecording(e);
                }}
              />
            </>
          )}
        </div>
      </div>

      <button
        type='button'
        className='demo'
        onClick={() => handleUrlUpdate(Constants.getDefaultAudioUrl("en"))}
      >
        <SpeakerWaveIcon className='w-4 h-4' />
        Try sample audio
      </button>

      <p className='sr-only' role='status' aria-live='polite' aria-atomic='true'>
        {audioReadyAnnouncement}
      </p>
      {isAudioProcessing && (
        <div className='audio-processing-status'>
          <span className='audio-processing-status__spinner' />
          Processing audio…
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
            onSeekReady={props.onSeekReady}
          />

          <div className='relative w-full flex justify-center items-center mt-2 gap-3'>
            {(!props.transcriber.output || props.transcriber.isBusy) && (
              <TranscribeButton
                ref={transcribeButtonRef}
                onClick={() => {
                  props.transcriber.start(
                    audioData.buffer,
                    audioData.blob,
                    audioData.sourceName,
                    audioData.mimeType === "video/mp4",
                  );
                }}
                isModelLoading={props.transcriber.isModelLoading}
                modelLoadingProgress={overallModelLoadProgress}
                isTranscribing={props.transcriber.isBusy}
                transcribingProgress={props.transcriber.output?.progress}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

export function ApplicationControls(props: {
  transcriber: Transcriber;
  isDark: boolean;
  onThemeToggle: () => void;
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
          content=
          {<>
            <h3>Local transcription</h3>
            <p>Transcription happens locally in your browser using OpenAI’s Whisper models or NVIDIA’s Parakeet model. Parakeet requires a WebGPU-capable browser. The selected model is downloaded and cached the first time you use it. Your files never leave your computer.</p>

            <h3>AI summarization</h3>
            <p>Summaries are generated locally using a experimental built-in browser AI (Google Gemini Nano). This feature is currently only supported in Google Chrome.</p>

            <h3>Acknowledgements</h3>
            <p>Maintained by <a href='mailto:adam.chaboryk@torontomu.ca'>Adam Chaboryk,</a> Digital Media Projects, Computing and Communications Services at Toronto Metropolitan University.</p>

            <p>This tool is a customized fork of <a href='https://huggingface.co/Xenova'>Joshua Lochner's Whisper Web project.</a> This project also incorporates <a href="https://github.com/narcotic-sh/parakeet.wgsl">Hamza Qayyum's parakeet.wgsl project.</a></p>
          </>}
        />
        <Tile
          icon={<ThemeIcon isDark={props.isDark} />}
          text='Theme'
          isApplicationControl
          ariaLabel={props.isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={props.isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={props.onThemeToggle}
        />
        <SettingsTile transcriber={props.transcriber} icon={<SettingsIcon />} text='Settings' isApplicationControl />
      </nav>
    </>
  );
}

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
      <Tile icon={props.icon} text={props.text} ariaLabel={props.title} title={props.title} onClick={onClick} isApplicationControl={props.isApplicationControl} />
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
      <Tile icon={props.icon} text={props.text} ariaLabel='Settings' title='Settings' onClick={onClick} isApplicationControl={props.isApplicationControl} />
      <SettingsModal
        show={showModal}
        onSubmit={onSubmit}
        onClose={onClose}
        transcriber={props.transcriber}
      />
    </>
  );
}

function SettingsModal(props: {
  show: boolean;
  onSubmit: (url: string) => void;
  onClose: () => void;
  transcriber: Transcriber;
}) {
  const names = Object.values(LANGUAGES).map(titleCase);
  const isParakeet = props.transcriber.model === "parakeet.wgsl";

  const isMultilingual = useMemo(() => {
    const model = props.transcriber.model;
    return (
      !model.endsWith(".en") && MODELS[model] && MODELS[model][1] === ""
    );
  }, [props.transcriber.model]);

  const HAS_WEBGPU_API = "gpu" in navigator && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  const [IS_WEBGPU_AVAILABLE, setIsWebgpuAvailable] = useState(false);
  // Tracks whether the async WebGPU support check has finished, so we don't
  // prematurely reset settings based on the initial "unavailable" default.
  const [hasCheckedWebgpu, setHasCheckedWebgpu] = useState(false);
  const availableModels = Object.entries(MODELS).filter(
    ([modelKey]) => modelKey !== "parakeet.wgsl" || IS_WEBGPU_AVAILABLE,
  );

  useEffect(() => {
    if (!HAS_WEBGPU_API) {
      setIsWebgpuAvailable(false);
      setHasCheckedWebgpu(true);
      return;
    }

    let cancelled = false;
    checkSupport()
      .then((result) => {
        if (!cancelled) {
          setIsWebgpuAvailable(result.supported);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsWebgpuAvailable(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHasCheckedWebgpu(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [HAS_WEBGPU_API]);

  useEffect(() => {
    if (hasCheckedWebgpu && !IS_WEBGPU_AVAILABLE && props.transcriber.gpu) {
      props.transcriber.setGPU(false);
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (hasCheckedWebgpu && !IS_WEBGPU_AVAILABLE && props.transcriber.model === "parakeet.wgsl") {
      props.transcriber.setModel("onnx-community/whisper-base");
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (hasCheckedWebgpu && !IS_WEBGPU_AVAILABLE && props.transcriber.dtype === "fp16") {
      props.transcriber.setDtype(Constants.DEFAULT_DTYPE);
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  const [cacheSize, setCacheSize] = useState<number>(0);

  async function fetchCacheSize() {
    if ("storage" in navigator && "estimate" in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      const usage = Number(estimate.usage);
      setCacheSize(~~(usage / 1000000));
    } else {
      setCacheSize(-1);
    }
  }

  fetchCacheSize();

  // Get the language code of the selected model
  const getModelLanguage = () => {
    if (props.transcriber.model in MODELS) {
      const [, lang] = MODELS[props.transcriber.model];
      return lang || props.transcriber.language;
    }
    return props.transcriber.language;
  };

  return (
    <Modal
      show={props.show}
      title='Settings'
      content={
        <>
          <label htmlFor='model-select' className='form-label'>Model</label>
          <span className='text-gray-600 dark:text-slate-400 block'>Some models are bigger than others, so your browser may cache up to about 1.5 GB.</span>
          <select
            id='model-select'
            className='form-select mt-1 mb-3'
            value={props.transcriber.model}
            onChange={(e) => {
              props.transcriber.setModel(e.target.value);
            }}
          >
            <optgroup label='Multilingual'>
              {availableModels
                .filter(([, [, language]]) => language === "")
                .map(([modelKey, [displayName]]) => (
                  <option key={modelKey} value={modelKey}>
                    {displayName}
                  </option>
                ))}
            </optgroup>
            <optgroup label='English Only'>
              {availableModels
                .filter(([, [, language]]) => language === "en")
                .map(([modelKey, [displayName]]) => (
                  <option key={modelKey} value={modelKey}>
                    {displayName}
                  </option>
                ))}
            </optgroup>
          </select>

          {!isParakeet && (
            <>
              <label htmlFor='dtype-select' className='form-label'>
                Performance mode
              </label>
              <span className='mb-2 text-gray-600 dark:text-slate-400 block'>Choose a faster or more accurate setting depending on your device.</span>
              <select
                id='dtype-select'
                className='form-select mt-1 mb-1'
                defaultValue={props.transcriber.dtype}
                onChange={(e) => {
                  props.transcriber.setDtype(e.target.value);
                }}
              >
                {Object.entries(DTYPES)
                  .filter(([value]) => value !== "fp16" || IS_WEBGPU_AVAILABLE)
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
              {IS_WEBGPU_AVAILABLE && (
                <div className='flex justify-between items-center mb-3 px-1'>
                  <div className='flex'>
                    <input
                      id='gpu'
                      type='checkbox'
                      checked={props.transcriber.gpu}
                      onChange={(e) => {
                        props.transcriber.setGPU(e.target.checked);
                      }}
                    ></input>
                    <label htmlFor='gpu' className='form-label form-label--checkbox'>
                      Enable GPU acceleration
                    </label>
                  </div>
                </div>
              )}

              <label htmlFor='selectLang' className='form-label'>Source language</label>
              <select
                id='selectLang'
                className='form-select mt-1 mb-3'
                value={
                  isMultilingual
                    ? props.transcriber.language
                    : getModelLanguage()
                }
                onChange={(e) => {
                  props.transcriber.setLanguage(e.target.value);
                }}
                disabled={!isMultilingual}
              >
                {Object.keys(LANGUAGES).map((key, i) => (
                  <option key={key} value={key}>
                    {names[i]}
                  </option>
                ))}
              </select>

              <label htmlFor='selectTask' className='form-label'>Task</label>
              <select
                id='selectTask'
                className='form-select mt-1 mb-3'
                value={
                  isMultilingual
                    ? props.transcriber.subtask
                    : "transcribe"
                }
                onChange={(e) => {
                  props.transcriber.setSubtask(e.target.value);
                }}
                disabled={!isMultilingual}
              >
                <option value={"transcribe"}>Transcribe</option>
                <option value={"translate"}>Translate</option>
              </select>
            </>
          )}
        </>
      }
      onClose={props.onClose}
      onSubmit={() => { }}
      cacheSize={cacheSize}
    />
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
      <Tile icon={props.icon} text={props.text} onClick={onClick} isUploadButton />
      <UrlModal show={showModal} onSubmit={onSubmit} onClose={onClose} />
    </>
  );
}

function UrlModal(props: {
  show: boolean;
  onSubmit: (url: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(event.target.value);
  };

  const onSubmit = () => {
    props.onSubmit(url);
  };

  return (
    <Modal
      show={props.show}
      title='From URL'
      content={
        <>
          <UrlInput onChange={onChange} value={url} placeholder='https://example.com/audio.mp3' />
        </>
      }
      onClose={props.onClose}
      submitText='Submit'
      submitEnabled={url.trim().length > 0}
      onSubmit={onSubmit}
    />
  );
}

function FileTile(props: {
  icon: JSX.Element;
  text: string;
  onProcessingChange: (isProcessing: boolean) => void;
  onFileUpdate: (
    decoded: AudioBuffer,
    blob: Blob,
    sourceName: string,
    blobUrl: string,
    mimeType: string,
  ) => void;
}) {
  // Create hidden input element
  const elem = document.createElement("input");
  elem.type = "file";
  elem.accept = "audio/*,video/*";
  elem.oninput = (event) => {
    // Make sure we have files to use
    const files = (event.target as HTMLInputElement).files;
    if (!files) return;

    const file = files[0];
    if (
      !file ||
      (!file.type.startsWith("audio/") && !file.type.startsWith("video/"))
    ) return;

    // Create a blob that we can use as an src for our audio element
    const urlObj = URL.createObjectURL(file);
    const mimeType = file.type;

    props.onProcessingChange(true);

    const reader = new FileReader();
    reader.addEventListener("load", async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer; // Get the ArrayBuffer
        if (!arrayBuffer) return;

        const audioCTX = new AudioContext({
          sampleRate: Constants.SAMPLING_RATE,
        });

        const decoded = await audioCTX.decodeAudioData(arrayBuffer);

        props.onFileUpdate(decoded, file, file.name, urlObj, mimeType);
      } finally {
        props.onProcessingChange(false);
      }
    });
    reader.addEventListener("error", () => props.onProcessingChange(false));
    reader.readAsArrayBuffer(file);

    // Reset files
    elem.value = "";
  };

  return (
    <Tile
      icon={props.icon}
      text={props.text}
      isUploadButton
      onClick={() => elem.click()}
    />
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
      <Tile icon={props.icon} text={props.text} onClick={onClick} isUploadButton />
      <RecordModal
        show={showModal}
        onSubmit={onSubmit}
        onProgress={() => { }}
        onClose={onClose}
      />
    </>
  );
}

function RecordModal(props: {
  show: boolean;
  onProgress: (data: Blob | undefined) => void;
  onSubmit: (data: Blob | undefined) => void;
  onClose: () => void;
}) {
  const [audioBlob, setAudioBlob] = useState<Blob>();

  const onRecordingComplete = (blob: Blob) => {
    setAudioBlob(blob);
  };

  const onSubmit = () => {
    props.onSubmit(audioBlob);
    setAudioBlob(undefined);
  };

  const onClose = () => {
    props.onClose();
    setAudioBlob(undefined);
  };

  return (
    <Modal
      show={props.show}
      title='Record'
      content={
        <>
          Record audio using your microphone. Please make sure you have permission from everyone involved before you start recording.
          <AudioRecorder
            onRecordingProgress={(blob) => {
              props.onProgress(blob);
            }}
            onRecordingComplete={onRecordingComplete}
          />
        </>
      }
      onClose={onClose}
      submitText='Submit'
      submitEnabled={audioBlob !== undefined}
      onSubmit={onSubmit}
    />
  );
}

function Tile(props: {
  icon: JSX.Element;
  text?: string;
  ariaLabel?: string;
  title?: string;
  onClick?: () => void;
  isApplicationControl?: boolean;
  isUploadButton?: boolean;
}) {
  return (
    <button
      type='button'
      onClick={props.onClick}
      aria-label={props.ariaLabel ?? props.text}
      className={props.isApplicationControl
        ? 'control-button'
        : props.isUploadButton
          ? 'upload-button'
          : 'flex items-center justify-center rounded-lg p-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-white hover:bg-blue-600 transition-all duration-200'}
    >
      <div className='w-7 h-7'>{props.icon}</div>
      {props.text && (
        <div className={props.isApplicationControl ? 'control-button__label' : 'ml-2 break-text text-center text-md mw-30'}>
          {props.text}
        </div>
      )}
    </button>
  );
}
