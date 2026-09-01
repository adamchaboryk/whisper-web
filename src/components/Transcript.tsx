import { useRef, useEffect, useLayoutEffect, useState, useMemo } from "react";
import {
  FloatingArrow,
  autoUpdate,
  arrow,
  flip,
  offset,
  shift,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
} from "@floating-ui/react";
import { SummaryData, TranscriberData } from "../hooks/useTranscriber";
import { formatAudioTimestamp, formatSrtTimeRange, parseAudioTimestamp } from "../utils/AudioUtils";
import { formatSrtChunks } from "../utils/SubtitleUtils";
import { Spinner } from "./TranscribeButton";

interface Props {
  transcribedData: TranscriberData | undefined;
  chunks?: TranscriberData["chunks"];
  onChunkUpdate?: (index: number, updatedChunk: { text: string; timestamp: [number, number | null] }) => void;
  onSeekTo?: (time: number) => void;
  isEditing?: boolean;
  onStartEditing?: () => void;
  onSaveEdits?: () => void;
  onCancelEdits?: () => void;
  summary?: SummaryData;
  onGenerateSummary?: () => void;
  supportsSummarizer?: boolean;
  currentTime?: number;
  isAutoScrollSettingEnabled?: boolean;
  setIsAutoScrollSettingEnabled?: (enabled: boolean) => void;
}

function formatTranscriptionDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(0)} seconds`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${remainingSeconds.toFixed(0)} seconds`;
}

function ClipboardIcon(props: { className?: string }) {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={props.className}
    >
      <rect x='8' y='2' width='8' height='4' rx='1' />
      <path d='M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2' />
    </svg>
  );
}

function DocumentTextIcon(props: { className?: string }) {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={props.className}
    >
      <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' />
      <path d='M14 2v6h6M8 13h8M8 17h8M8 9h2' />
    </svg>
  );
}

function FilmIcon(props: { className?: string }) {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={props.className}
    >
      <rect x='2.5' y='4' width='19' height='16' rx='2' />
      <path d='M7 4v16M17 4v16M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5' />
    </svg>
  );
}

const sanitizeHTML = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      let inner = "";
      for (const child of Array.from(el.childNodes)) {
        inner += walk(child);
      }

      if (tag === "b" || tag === "strong") {
        return `<b>${inner}</b>`;
      }
      if (tag === "i" || tag === "em") {
        return `<i>${inner}</i>`;
      }
      if (tag === "u") {
        return `<u>${inner}</u>`;
      }
      if (tag === "br") {
        return `\n`;
      }
      if (tag === "div" || tag === "p") {
        return inner ? `\n${inner}` : `\n`;
      }
      if (tag === "span" || tag === "font") {
        if (el.style.fontWeight === "bold" || el.style.fontWeight >= "700") {
          inner = `<b>${inner}</b>`;
        }
        if (el.style.fontStyle === "italic") {
          inner = `<i>${inner}</i>`;
        }
        if (el.style.textDecoration.includes("underline")) {
          inner = `<u>${inner}</u>`;
        }
        return inner;
      }

      return inner;
    }
    return "";
  };

  let result = "";
  for (const child of Array.from(doc.body.childNodes)) {
    result += walk(child);
  }

  return result;
};

function EditableChunk(props: {
  text: string;
  label: string;
  onTextChange?: (text: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && document.activeElement !== editor && editor.innerHTML !== props.text) {
      editor.innerHTML = props.text;
    }
  }, [props.text]);

  const handleInput = (event: React.FormEvent<HTMLDivElement>) => {
    const html = event.currentTarget.innerHTML;
    const sanitized = sanitizeHTML(html);
    props.onTextChange?.(sanitized);
  };

  return (
    <div
      ref={editorRef}
      className='flex-1 whitespace-pre-wrap rounded border border-dashed border-blue-300 bg-blue-50/60 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-solid dark:border-blue-400/50 dark:bg-blue-950/30'
      contentEditable
      suppressContentEditableWarning
      role='textbox'
      aria-label={props.label}
      onInput={handleInput}
    />
  );
}

function EditableTimestamp(props: {
  timestamp: number;
  onTimestampChange?: (newTimestamp: number) => void;
}) {
  const [prevTimestamp, setPrevTimestamp] = useState(props.timestamp);
  const [value, setValue] = useState(() => formatAudioTimestamp(props.timestamp));

  // Sync value when props.timestamp changes from outside
  if (props.timestamp !== prevTimestamp) {
    setPrevTimestamp(props.timestamp);
    setValue(formatAudioTimestamp(props.timestamp));
  }

  const handleBlur = () => {
    const parsed = parseAudioTimestamp(value);
    if (parsed !== null && parsed !== props.timestamp) {
      props.onTimestampChange?.(parsed);
      setValue(formatAudioTimestamp(parsed));
    } else {
      // Revert if invalid or unchanged
      setValue(formatAudioTimestamp(props.timestamp));
    }
  };

  return (
    <input
      type="text"
      className='mr-5 shrink-0 w-20 text-left tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500 rounded border border-dashed border-blue-300 bg-blue-50/60 px-1 py-1 dark:border-blue-400/50 dark:bg-blue-950/30'
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function SaveButton(props: { onSave?: () => void; shortcut: string }) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    // Floating UI reads this ref after render to calculate arrow placement.
    // eslint-disable-next-line react-hooks/refs
    middleware: [offset(10), flip(), shift({ padding: 8 }), arrow({ element: arrowRef })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, delay: { open: 500, close: 0 } });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus]);

  return (
    <>
      <button
        ref={refs.setReference}
        type='button'
        className='export-button gap-1.5'
        onClick={props.onSave}
        aria-keyshortcuts='Meta+S Control+S'
        {...getReferenceProps()}
      >
        <svg
          aria-hidden='true'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.75'
          strokeLinecap='round'
          strokeLinejoin='round'
          className='h-4 w-4'
        >
          <path d='M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z' />
          <path d='M17 21v-8H7v8M7 3v5h8' />
        </svg>
        Save
      </button>
      {isTooltipOpen && (
        <span
          // Floating UI requires this callback ref to position the tooltip.
          // eslint-disable-next-line react-hooks/refs
          ref={refs.setFloating}
          style={floatingStyles}
          className='z-20 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-100 dark:text-slate-900'
          {...getFloatingProps({ role: "tooltip" })}
        >
          <FloatingArrow
            ref={arrowRef}
            context={context}
            className='fill-slate-900 dark:fill-slate-100'
          />
          {props.shortcut}
        </span>
      )}
    </>
  );
}

const extractPlainText = (html: string) => {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
};

const decodeSrtText = (html: string) => {
  const tmp = document.createElement("textarea");
  tmp.innerHTML = html;
  return tmp.value;
};

export default function Transcript({
  transcribedData,
  chunks: editedChunks,
  onChunkUpdate,
  onSeekTo,
  isEditing,
  onStartEditing,
  onSaveEdits,
  onCancelEdits,
  summary,
  onGenerateSummary,
  supportsSummarizer,
  currentTime,
  isAutoScrollSettingEnabled = true,
  setIsAutoScrollSettingEnabled,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const timestampRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const chunks = useMemo(
    () => editedChunks ?? transcribedData?.chunks ?? [],
    [editedChunks, transcribedData?.chunks],
  );
  const saveShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "Command + S" : "Ctrl + S";

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportTXT = () => {
    const text = chunks
      .map((chunk) => extractPlainText(chunk.text))
      .join(" ")
      .trim();

    const blob = new Blob([text], { type: "text/plain" });
    saveBlob(blob, "transcript.txt");
  };

  /*
  const exportJSON = () => {
    let jsonData = JSON.stringify(transcribedData?.chunks ?? [], null, 2);

    // post-process the JSON to make it more readable
    const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
    jsonData = jsonData.replace(regex, "$1[$2 $3]");

    const blob = new Blob([jsonData], { type: "application/json" });
    saveBlob(blob, "transcript.json");
  }; */

  const exportSRT = () => {
    let srt = "";

    // Ensure chunks are formatted before export just in case
    const formattedChunks = formatSrtChunks(chunks);

    for (let i = 0; i < formattedChunks.length; i++) {
      srt += `${i + 1}\n`;
      srt += `${formatSrtTimeRange(formattedChunks[i].timestamp[0], formattedChunks[i].timestamp[1] ?? formattedChunks[i].timestamp[0])}\n`;
      srt += `${decodeSrtText(formattedChunks[i].text)}\n\n`;
    }
    const blob = new Blob([srt], { type: "text/plain" });
    saveBlob(blob, "transcript.srt");
  };

  const copyToClipboard = async () => {
    let text = chunks
      .map((chunk) => extractPlainText(chunk.text))
      .join(" ")
      .trim();

    // Use regex to add double line breaks around any [bracketed] text
    // and absorb surrounding spaces so lines start cleanly
    text = text
      .replace(/\s*(\[.*?\])\s*/g, "\n\n$1\n\n")
      .replace(/\n{3,}/g, "\n\n") // Clean up excess newlines if multiple brackets are next to each other
      .trim();

    try {
      await navigator.clipboard.writeText(text);
      alert("Transcript copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy text: ", err);
      alert("Failed to copy to clipboard. Please try exporting as TXT instead.");
    }
  };

  const exportButtons = [
    { name: "Copy to Clipboard", onClick: copyToClipboard, icon: <ClipboardIcon className='h-4 w-4' /> },
    { name: "Export to TXT", onClick: exportTXT, icon: <DocumentTextIcon className='h-4 w-4' /> },
    { name: "Export to SRT", onClick: exportSRT, icon: <FilmIcon className='h-4 w-4' /> },
    // { name: "Export to JSON", onClick: exportJSON },
  ];

  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const summaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const prevIsBusyRef = useRef<boolean | undefined>(undefined);
  const prevSummaryRef = useRef<string | undefined>(undefined);
  const scrollRafRef = useRef<number | null>(null);
  const [lastAnnouncedProgress, setLastAnnouncedProgress] = useState<number | null>(null);

  useEffect(() => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
    }

    scrollRafRef.current = requestAnimationFrame(() => {
      endOfMessagesRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });

    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, [transcribedData?.chunks]);

  useEffect(() => {
    const isBusy = transcribedData?.isBusy;
    // If we transitioned from busy -> not busy, focus the heading
    if (prevIsBusyRef.current === true && isBusy === false) {
      headingRef.current?.focus();
    }
    prevIsBusyRef.current = isBusy;
  }, [transcribedData?.isBusy]);

  useEffect(() => {
    const nextSummary = summary?.summary;
    if (prevSummaryRef.current === undefined && nextSummary) {
      summaryHeadingRef.current?.focus();
    }
    prevSummaryRef.current = nextSummary;
  }, [summary?.summary]);

  useEffect(() => {
    if (!transcribedData?.isBusy || transcribedData.progress === undefined) {
      return;
    }

    const milestoneProgress = Math.floor(transcribedData.progress / 20) * 20;
    if (milestoneProgress >= 20 && milestoneProgress > (lastAnnouncedProgress ?? -20)) {
      setTimeout(() => {
        setLastAnnouncedProgress(milestoneProgress);
      }, 0);
    }
  }, [transcribedData?.isBusy, transcribedData?.progress, lastAnnouncedProgress]);

  useEffect(() => {
    if (transcribedData?.transcriptionSeconds !== undefined) {
      console.warn(`Transcribed in ${formatTranscriptionDuration(transcribedData.transcriptionSeconds)}.`);
    }
  }, [transcribedData?.transcriptionSeconds]);

  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const chunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeChunkIndexRef = useRef<number>(-1);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const prevTimeRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Detect audio seek (time jumped by more than 1.5 seconds)
    if (currentTime !== undefined && prevTimeRef.current !== undefined) {
      if (Math.abs(currentTime - prevTimeRef.current) > 1.5) {
        setAutoScrollPaused(false);
      }
    }
    prevTimeRef.current = currentTime;

    if (!chunks) return;

    const activeIndex = chunks.findIndex((chunk, i) => {
      return currentTime !== undefined && currentTime >= chunk.timestamp[0] && currentTime < (chunk.timestamp[1] ?? (chunks[i + 1]?.timestamp[0] ?? chunk.timestamp[0] + 5));
    });

    if (activeIndex !== -1 && activeIndex !== activeChunkIndexRef.current) {
      activeChunkIndexRef.current = activeIndex;

      if (isAutoScrollSettingEnabled && !autoScrollPaused && transcriptContainerRef.current && chunkRefs.current[activeIndex]) {
        const container = transcriptContainerRef.current;
        const chunkElement = chunkRefs.current[activeIndex];

        if (chunkElement) {
          const containerCenter = container.clientHeight / 2;
          const chunkCenter = chunkElement.clientHeight / 2;
          const scrollTop = chunkElement.offsetTop - containerCenter + chunkCenter;
          container.scrollTo({ top: scrollTop, behavior: 'smooth' });
        }
      }
    }
  }, [currentTime, chunks, isAutoScrollSettingEnabled, autoScrollPaused]);

  useEffect(() => {
    if (!autoScrollPaused && isAutoScrollSettingEnabled && activeChunkIndexRef.current !== -1) {
      const container = transcriptContainerRef.current;
      const chunkElement = chunkRefs.current[activeChunkIndexRef.current];

      if (container && chunkElement) {
        const containerCenter = container.clientHeight / 2;
        const chunkCenter = chunkElement.clientHeight / 2;
        const scrollTop = chunkElement.offsetTop - containerCenter + chunkCenter;
        container.scrollTo({ top: scrollTop, behavior: 'smooth' });
      }
    }
  }, [autoScrollPaused, isAutoScrollSettingEnabled]);

  return (
    <div
      ref={divRef}
      className='w-full flex flex-col p-4 overflow-y-auto'
    >
      {lastAnnouncedProgress !== null && transcribedData?.isBusy && (
        <p className='sr-only' role='status' aria-live='polite' aria-atomic='true'>
          {lastAnnouncedProgress}% complete.
        </p>
      )}
      {transcribedData && !transcribedData.isBusy && transcribedData.chunks && (
        <>
          <div className='w-full flex items-center justify-between gap-3'>
            <h2
              className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl"
              tabIndex={-1}
              id="transcript-complete"
              ref={headingRef}
            >
              Transcript
            </h2>
            {isEditing ? (
              <div className='flex items-center gap-3'>
                <SaveButton onSave={onSaveEdits} shortcut={saveShortcut} />
                <button
                  type='button'
                  className='inline-flex items-center justify-center gap-2 rounded-md border-2 border-solid bg-red-100 px-4 py-2 text-sm font-semibold text-red-900 hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 transition-all duration-300'
                  onClick={onCancelEdits}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button type='button' className='export-button gap-1.5' onClick={onStartEditing}>
                <svg
                  aria-hidden='true'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                  className='h-4 w-4'
                >
                  <path d='m13.69 2.84 3.47 3.47-9.82 9.82-4.04.57.57-4.04 9.82-9.82Zm1.41-1.41a2 2 0 0 1 2.83 0l.64.64a2 2 0 0 1 0 2.83l-.71.71-3.47-3.47.71-.71Z' />
                </svg>
                Edit
              </button>
            )}
          </div>

          <div
            className={`relative w-full mt-3 mb-2 rounded-lg overflow-hidden ${isEditing
              ? "border-2 border-dashed border-blue-400 dark:border-blue-400/70"
              : "border border-slate-200 dark:border-slate-700"
              }`}
          >
            <div
              ref={transcriptContainerRef}
              className='max-h-[400px] overflow-y-auto bg-white dark:bg-slate-800 p-3 sm:p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500'
              tabIndex={0}
              role='region'
              aria-label='Transcript content'
              onWheel={() => { setAutoScrollPaused(true); }}
              onTouchMove={() => { setAutoScrollPaused(true); }}
              onMouseLeave={() => { setAutoScrollPaused(false); }}
              onKeyDown={(event) => {
                if (isEditing && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onCancelEdits?.();
                } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
                  setAutoScrollPaused(true);
                }
              }}
            >
              {chunks.map((chunk, i) => {
                const isActive = currentTime !== undefined && currentTime >= chunk.timestamp[0] && currentTime < (chunk.timestamp[1] ?? (chunks[i + 1]?.timestamp[0] ?? chunk.timestamp[0] + 5));
                return (
                  <div
                    key={`${transcribedData.text}-${i}`}
                    ref={(el) => { chunkRefs.current[i] = el; }}
                    className={`transcript-segment ${isActive ? "active-segment" : ""}`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    {isEditing ? (
                      <>
                        <EditableTimestamp
                          timestamp={chunk.timestamp[0]}
                          onTimestampChange={(newTimestamp) => {
                            onChunkUpdate?.(i, { ...chunk, timestamp: [newTimestamp, chunk.timestamp[1]] });
                          }}
                        />
                        <EditableChunk
                          text={chunk.text.trimStart()}
                          label={`Transcript segment at ${formatAudioTimestamp(chunk.timestamp[0])}`}
                          onTextChange={(text) => onChunkUpdate?.(i, { ...chunk, text })}
                        />
                      </>
                    ) : (
                      <>
                        <button
                          ref={(element) => { timestampRefs.current[i] = element; }}
                          type='button'
                          className='mr-5 shrink-0 text-left tabular-nums hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded dark:hover:text-blue-300'
                          onClick={() => {
                            setAutoScrollPaused(false);
                            onSeekTo?.(chunk.timestamp[0]);
                          }}
                          onKeyDown={(event) => {
                            const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                            if (offset) {
                              event.preventDefault();
                              timestampRefs.current[i + offset]?.focus();
                            }
                          }}
                          tabIndex={i > 0 ? -1 : 0}
                          aria-label={`Play from ${formatAudioTimestamp(chunk.timestamp[0])}`}
                        >
                          {formatAudioTimestamp(chunk.timestamp[0])}
                        </button>
                        <div
                          className='flex-1 whitespace-pre-wrap'
                          dangerouslySetInnerHTML={{ __html: sanitizeHTML(chunk.text).trimStart() }}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {/* fade cue hinting the panel is scrollable */}
            <div
              aria-hidden='true'
              className='pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/10 via-black/5 to-transparent dark:from-black/30 dark:via-black/15'
            />
          </div>

          <div className='w-full flex justify-end mb-5 pr-2'>
            <label className='flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 cursor-pointer' htmlFor="auto-scroll">
              <input
                id="auto-scroll"
                type='checkbox'
                checked={isAutoScrollSettingEnabled}
                onChange={(e) => setIsAutoScrollSettingEnabled?.(e.target.checked)}
                className='rounded border-slate-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 bg-slate-50 dark:bg-slate-700 dark:border-slate-500'
              />
              Auto-scroll transcript
            </label>
          </div>

          <div className='w-full mt-2 flex flex-wrap items-center justify-center gap-3'>
            {exportButtons.map((button, i) => (
              <button
                key={i}
                onClick={button.onClick}
                className='export-button gap-1.5'
              >
                {button.icon}
                {button.name}
              </button>
            ))}
          </div>

          {supportsSummarizer && !summary?.summary && (
            <div className='w-full mt-2 flex flex-wrap items-center justify-center'>
              <button
                type='button'
                onClick={onGenerateSummary}
                disabled={summary?.isBusy}
                className='export-button gap-1.5'
              >
                {summary?.isBusy ? (
                  <Spinner text='Generating Summary...' />
                ) : (
                  <>
                    <svg
                      className='h-5 w-5'
                      viewBox='0 0 20 20'
                      fill='currentColor'
                      aria-hidden='true'
                    >
                      <path d='M10 2a1 1 0 0 1 .967.744L11.99 6.9l4.156 1.023a1 1 0 0 1 0 1.942L11.99 10.9l-1.023 4.156a1 1 0 0 1-1.934 0L7.99 10.9l-4.156-1.023a1 1 0 0 1 0-1.942L7.99 6.9l1.043-4.156A1 1 0 0 1 10 2Z' />
                      <path d='M4.5 14a.75.75 0 0 1 .728.568l.316 1.264 1.264.316a.75.75 0 0 1 0 1.456l-1.264.316-.316 1.264a.75.75 0 0 1-1.456 0l-.316-1.264-1.264-.316a.75.75 0 0 1 0-1.456l1.264-.316.316-1.264A.75.75 0 0 1 4.5 14Z' />
                    </svg>
                    Generate Summary
                  </>
                )}
              </button>
            </div>
          )}

          {summary?.summary && (
            <div className='w-full mt-6'>
              <h2
                ref={summaryHeadingRef}
                tabIndex={-1}
                className="mt-5 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl"
              >
                Summary
              </h2>
              <p className='whitespace-pre-wrap text-slate-700 dark:text-slate-300'>{summary.summary}</p>
            </div>
          )}
        </>
      )}

      {/*transcribedData?.isBusy && transcribedData?.tps && (
        <div className='status-row'>
          <span className='status-pill status-pill--metric'>
            <svg
              aria-hidden='true'
              viewBox='0 0 20 20'
              fill='currentColor'
              className='status-pill__icon'
            >
              <path d='M11.983 1.907a.75.75 0 0 0-1.395-.29L4.5 11.25a.75.75 0 0 0 .646 1.143h4.11l-1.234 5.79a.75.75 0 0 0 1.395.29l6.088-9.633a.75.75 0 0 0-.646-1.143h-4.11l1.234-5.79Z' />
            </svg>
            {transcribedData.tps.toFixed(2)} tokens/second
          </span>
        </div>
      )*/}
      <div ref={endOfMessagesRef} />
    </div>
  );
}