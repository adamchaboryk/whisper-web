import { useCallback, useEffect, useRef, useState } from "react";
import { ApplicationControls, AudioManager } from "./components/AudioManager";
import Transcript from "./components/Transcript";
import { useEncryptedDictionary } from "./hooks/useEncryptedDictionary";
import {
  TranscriptChunk,
  TranscriberData,
  useTranscriber,
} from "./hooks/useTranscriber";
import { hasWebGpuSupport, isSupportedBrowser } from "./utils/Constants";
import { WarningIcon } from "./utils/Icons";

function App() {
  const transcriber = useTranscriber();
  const dictionary = useEncryptedDictionary();
  const { entries, replaceTranscript } = dictionary;
  const { output, setTranscript } = transcriber;
  const isApplyingDictionaryRef = useRef(false);
  useEffect(() => {
    if (!output || output.isBusy || !entries.length) return;
    if (isApplyingDictionaryRef.current) {
      isApplyingDictionaryRef.current = false;
      return;
    }

    isApplyingDictionaryRef.current = true;
    void replaceTranscript(output.text, output.chunks).then((result) => {
      setTranscript({ ...output, text: result.text, chunks: result.chunks });
    }).catch(() => {
      isApplyingDictionaryRef.current = false;
    });
  }, [entries, output, replaceTranscript, setTranscript]);
  const mediaSeekRef = useRef<((time: number) => void) | undefined>(undefined);
  const [savedTranscript, setSavedTranscript] = useState<{
    source: TranscriberData;
    chunks: TranscriberData["chunks"];
  }>();
  const [draftTranscript, setDraftTranscript] = useState<{
    source: TranscriberData;
    chunks: TranscriberData["chunks"];
  }>();
  const draftTranscriptRef = useRef(draftTranscript);
  const undoStackRef = useRef<TranscriptChunk[][]>([]);
  const redoStackRef = useRef<TranscriptChunk[][]>([]);
  const MAX_HISTORY = 100;
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

    const draft = { source: output, chunks: savedChunks ?? output.chunks };
    draftTranscriptRef.current = draft;
    setDraftTranscript(draft);
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [transcriber.output, savedChunks]);

  const updateDraftChunks = useCallback(
    (
      update: (chunks: TranscriptChunk[]) => TranscriptChunk[],
      options?: { recordHistory?: boolean },
    ) => {
      const output = transcriber.output;
      if (!output || output.isBusy) return;

      const currentDraft = draftTranscriptRef.current;
      const chunks =
        currentDraft?.source === output ? currentDraft.chunks : output.chunks;
      const nextChunks = update(chunks);

      if (options?.recordHistory !== false) {
        undoStackRef.current.push(chunks);
        if (undoStackRef.current.length > MAX_HISTORY) {
          undoStackRef.current.shift();
        }
        redoStackRef.current = [];
      }

      const next = { source: output, chunks: nextChunks };
      draftTranscriptRef.current = next;
      setDraftTranscript(next);
    },
    [transcriber.output],
  );

  const handleChunkUpdate = useCallback(
    (index: number, updatedChunk: TranscriptChunk) => {
      updateDraftChunks((chunks) =>
        chunks.map((chunk, chunkIndex) =>
          chunkIndex === index ? updatedChunk : chunk,
        ),
      );
    },
    [updateDraftChunks],
  );

  const handleChunksReplace = useCallback(
    (updatedChunks: TranscriptChunk[]) => {
      updateDraftChunks(() => updatedChunks);
    },
    [updateDraftChunks],
  );

  const undo = useCallback(() => {
    const output = transcriber.output;
    const currentDraft = draftTranscriptRef.current;
    if (!output || !currentDraft || currentDraft.source !== output) return;

    const previous = undoStackRef.current.pop();
    if (!previous) return;

    redoStackRef.current.push(currentDraft.chunks);
    const next = { source: output, chunks: previous };
    draftTranscriptRef.current = next;
    setDraftTranscript(next);
  }, [transcriber.output]);

  const redo = useCallback(() => {
    const output = transcriber.output;
    const currentDraft = draftTranscriptRef.current;
    if (!output || !currentDraft || currentDraft.source !== output) return;

    const next = redoStackRef.current.pop();
    if (!next) return;

    undoStackRef.current.push(currentDraft.chunks);
    const nextDraft = { source: output, chunks: next };
    draftTranscriptRef.current = nextDraft;
    setDraftTranscript(nextDraft);
  }, [transcriber.output]);

  const handleSplitSegment = useCallback(
    (
      index: number,
      before: string,
      after: string,
      beforeWordCount: number,
    ) => {
      updateDraftChunks((chunks) => {
        const current = chunks[index];
        const leftWords = current.words?.slice(0, beforeWordCount);
        const rightWords = current.words?.slice(beforeWordCount);
        const sourceStart = current.timestamp[0];
        const sourceEnd = current.timestamp[1] ?? sourceStart + 1;
        const precedingEnd =
          leftWords?.[leftWords.length - 1]?.timestamp[1] ?? sourceStart;
        const followingStart = rightWords?.[0]?.timestamp[0] ?? sourceEnd;
        const wordBoundary = (precedingEnd + followingStart) / 2;
        const adjacentStart =
          chunks[index + 1]?.timestamp[0] > sourceStart
            ? chunks[index + 1].timestamp[0]
            : Math.max(sourceEnd, sourceStart + 0.084);
        const splitStart = (sourceStart + adjacentStart) / 2;
        const halfGap = Math.min(0.042, (sourceEnd - sourceStart) / 4);
        const leftEnd = Math.max(
          sourceStart,
          Math.min(wordBoundary - halfGap, splitStart - halfGap),
        );
        const rightEnd = Math.max(
          current.timestamp[1] ?? sourceEnd,
          splitStart + halfGap,
        );
        const left: TranscriptChunk = {
          ...current,
          text: before,
          timestamp: [sourceStart, leftEnd],
          words: leftWords,
        };
        const right: TranscriptChunk = {
          text: after,
          timestamp: [splitStart, rightEnd],
          words: rightWords,
        };
        return [...chunks.slice(0, index), left, right, ...chunks.slice(index + 1)];
      });
    },
    [updateDraftChunks],
  );

  const handleDeleteSegment = useCallback(
    (index: number) => {
      updateDraftChunks((chunks) =>
        chunks.filter((_, chunkIndex) => chunkIndex !== index),
      );
    },
    [updateDraftChunks],
  );

  const saveEdits = useCallback(() => {
    const currentDraft = draftTranscriptRef.current;
    if (currentDraft && currentDraft.source === transcriber.output) {
      setSavedTranscript({
        source: currentDraft.source,
        chunks: currentDraft.chunks,
      });
    }
    draftTranscriptRef.current = undefined;
    setDraftTranscript(undefined);
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [transcriber.output]);

  const cancelEdits = useCallback(() => {
    draftTranscriptRef.current = undefined;
    setDraftTranscript(undefined);
    undoStackRef.current = [];
    redoStackRef.current = [];
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

  const isEditingDraft = Boolean(draftChunks);

  useEffect(() => {
    const handleUndoRedoKeyDown = (event: KeyboardEvent) => {
      if (!isEditingDraft || !(event.metaKey || event.ctrlKey)) return;

      // Let native contentEditable undo/redo handle typing history;
      // only intercept the global stack when focus is outside an editor.
      const activeElement = document.activeElement;
      if (activeElement?.closest('[contenteditable="true"]')) return;

      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", handleUndoRedoKeyDown);
    return () => {
      window.removeEventListener("keydown", handleUndoRedoKeyDown);
    };
  }, [isEditingDraft, undo, redo]);

  return (
    <div className='app-layout'>
      <main className='app-main'>
        <div className='container flex flex-col justify-center items-center'>
          <h1 className='text-5xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 sm:text-7xl text-center'>
            Transcribe
          </h1>
          <h2 className='mt-3 mb-5 px-4 text-center text-1xl font-semibold text-slate-900 dark:text-slate-300 sm:text-2xl'>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="inline-block h-[1em] w-[1em] align-[-0.15em] mr-1" viewBox="0 0 16 16">
              <path d="M8 0a4 4 0 0 1 4 4v2.05a2.5 2.5 0 0 1 2 2.45v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 13.5v-5a2.5 2.5 0 0 1 2-2.45V4a4 4 0 0 1 4-4m0 1a3 3 0 0 0-3 3v2h6V4a3 3 0 0 0-3-3" />
            </svg> Transcribe audio and caption videos directly in your browser. Fully local, 100% private.
          </h2>
          <AudioManager
            transcriber={transcriber}
            onGenerateSummary={handleGenerateSummary}
            transcriptChunks={previewChunks}
            onSeekReady={handleSeekReady}
            onTimeUpdate={handleTimeUpdate}
            playbackRate={playbackRate}
            isEditing={Boolean(draftChunks)}
            onChunksReplace={handleChunksReplace}
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
            onSplitSegment={handleSplitSegment}
            onDeleteSegment={handleDeleteSegment}
            onChunksReplace={handleChunksReplace}
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
          transcriptChunks={previewChunks}
          onChunksReplace={handleChunksReplace}
        />
      </aside>

      {(!isSupportedBrowser || !hasWebGpuSupport) && (
        <footer>
          <p className='mt-2 inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'>
            <WarningIcon className='inline-block h-[2em] w-[2em] shrink-0 align-[-0.15em]' />
            <span><strong>Note:</strong> This website works best in Google Chrome or Microsoft Edge on a desktop. Mobile and older computers may experience slower processing or reduced features.</span>
          </p>
        </footer>
      )}
    </div>
  );
}

export default App;
