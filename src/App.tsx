import { useCallback, useEffect, useRef, useState } from "react";
import { ApplicationControls, AudioManager } from "./components/AudioManager";
import Transcript from "./components/Transcript";
import { TranscriberData, useTranscriber } from "./hooks/useTranscriber";
import { formatSrtChunks } from "./utils/SubtitleUtils";

function App() {
  const transcriber = useTranscriber();
  const mediaSeekRef = useRef<((time: number) => void) | undefined>(undefined);
  const [savedTranscript, setSavedTranscript] = useState<{
    source: TranscriberData;
    chunks: TranscriberData["chunks"];
  }>();
  const [draftTranscript, setDraftTranscript] = useState<{
    source: TranscriberData;
    chunks: TranscriberData["chunks"];
  }>();
  const timeSubscribersRef = useRef<Set<(time: number) => void>>(new Set());
  const handleTimeUpdate = useCallback((time: number) => {
    for (const subscriber of timeSubscribersRef.current) {
      subscriber(time);
    }
  }, []);
  const subscribeToTimeUpdate = useCallback(
    (subscriber: (time: number) => void) => {
      timeSubscribersRef.current.add(subscriber);
      return () => {
        timeSubscribersRef.current.delete(subscriber);
      };
    },
    [],
  );
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(() => {
    const stored = window.localStorage.getItem("whisper-web-autoscroll");
    return stored ? stored === "true" : true;
  });
  const [isDark, setIsDark] = useState(() => {
    const storedTheme = window.localStorage.getItem("whisper-web-theme");
    return storedTheme ? storedTheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    window.localStorage.setItem("whisper-web-autoscroll", isAutoScrollEnabled.toString());
  }, [isAutoScrollEnabled]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    window.localStorage.setItem("whisper-web-theme", isDark ? "dark" : "light");
  }, [isDark]);

  const handleThemeToggle = useCallback(() => {
    setIsDark((current) => !current);
  }, []);

  const savedChunks =
    savedTranscript && savedTranscript.source === transcriber.output
      ? savedTranscript.chunks
      : transcriber.output?.chunks;
  const draftChunks =
    draftTranscript && draftTranscript.source === transcriber.output
      ? draftTranscript.chunks
      : undefined;
  const previewChunks = draftChunks ?? savedChunks;

  const startEditing = useCallback(() => {
    const output = transcriber.output;
    if (!output || output.isBusy) {
      return;
    }

    setDraftTranscript({ source: output, chunks: savedChunks ?? output.chunks });
  }, [transcriber.output, savedChunks]);

  const handleChunkUpdate = useCallback(
    (
      index: number,
      updatedChunk: { text: string; timestamp: [number, number | null] },
    ) => {
      const output = transcriber.output;
      if (!output || output.isBusy) {
        return;
      }

      setDraftTranscript((current) => {
        const chunks =
          current?.source === output ? current.chunks : output.chunks;
        return {
          source: output,
          chunks: chunks.map((chunk, chunkIndex) =>
            chunkIndex === index ? updatedChunk : chunk,
          ),
        };
      });
    },
    [transcriber.output],
  );

  const saveEdits = useCallback(() => {
    if (draftTranscript && draftTranscript.source === transcriber.output) {
      setSavedTranscript({
        source: draftTranscript.source,
        chunks: formatSrtChunks(draftTranscript.chunks),
      });
    }
    setDraftTranscript(undefined);
  }, [draftTranscript, transcriber.output]);

  const cancelEdits = useCallback(() => {
    setDraftTranscript(undefined);
  }, []);

  const handleSeekReady = useCallback((seekTo: (time: number) => void) => {
    mediaSeekRef.current = seekTo;
  }, []);

  const handleSeekTo = useCallback((time: number) => {
    mediaSeekRef.current?.(time);
  }, []);

  const handleGenerateSummary = useCallback(() => {
    const text = savedChunks
      ?.map((chunk) => chunk.text)
      .join(" ")
      .trim();

    if (text) {
      transcriber.summarize(text);
    }
  }, [savedChunks, transcriber]);

  return (
    <div className='app-layout'>
      <main className='app-main'>
        <div className='container flex flex-col justify-center items-center'>
          <h1 className='text-5xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 sm:text-7xl text-center'>
            Transcribe audio
          </h1>
          <h2 className='mt-3 mb-5 px-4 text-center text-1xl font-semibold text-slate-900 dark:text-slate-300 sm:text-2xl'>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="inline-block h-[1em] w-[1em] align-[-0.15em] mr-1" viewBox="0 0 16 16">
              <path d="M8 0a4 4 0 0 1 4 4v2.05a2.5 2.5 0 0 1 2 2.45v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 13.5v-5a2.5 2.5 0 0 1 2-2.45V4a4 4 0 0 1 4-4m0 1a3 3 0 0 0-3 3v2h6V4a3 3 0 0 0-3-3" />
            </svg> Directly in your browser, locally on your device.
          </h2>
          <AudioManager
            transcriber={transcriber}
            onGenerateSummary={handleGenerateSummary}
            transcriptChunks={previewChunks}
            onSeekReady={handleSeekReady}
            onTimeUpdate={handleTimeUpdate}
            playbackRate={playbackRate}
            isEditing={Boolean(draftChunks)}
          />
          <Transcript
            transcribedData={transcriber.output}
            chunks={previewChunks}
            language={
              transcriber.output?.language ||
              (transcriber.subtask === "translate"
                ? "en"
                : transcriber.language)
            }
            onChunkUpdate={handleChunkUpdate}
            onSeekTo={handleSeekTo}
            isEditing={Boolean(draftChunks)}
            onStartEditing={startEditing}
            onSaveEdits={saveEdits}
            onCancelEdits={cancelEdits}
            summary={transcriber.summary}
            onGenerateSummary={handleGenerateSummary}
            supportsSummarizer={transcriber.supportsSummarizer}
            subscribeToTimeUpdate={subscribeToTimeUpdate}
            isAutoScrollSettingEnabled={isAutoScrollEnabled}
            setIsAutoScrollSettingEnabled={setIsAutoScrollEnabled}
            playbackRate={playbackRate}
            onPlaybackRateChange={setPlaybackRate}
          />
        </div>
      </main >
      <aside>
        <ApplicationControls
          isDark={isDark}
          onThemeToggle={handleThemeToggle}
          transcriber={transcriber}
          isAutoScrollEnabled={isAutoScrollEnabled}
          setIsAutoScrollEnabled={setIsAutoScrollEnabled}
        />
      </aside>
      <footer>
        <p>Transcription is powered by machine learning models downloaded directly to your browser's local memory. Processing speed depends on your device's processing power. You can explore and switch models in <em>Settings.</em></p>
        <p><strong>Note:</strong> This website works best in Google Chrome or Microsoft Edge on a desktop. Mobile devices may offer limited functionality.</p>
      </footer>
    </div >
  );
}

export default App;
