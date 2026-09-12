import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  memo,
  useCallback,
} from "react";
import {
  FloatingArrow,
  FloatingPortal,
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
import {
  SummaryData,
  TranscriptChunk,
  TranscriberData,
} from "../hooks/useTranscriber";
import {
  formatAudioTimestamp,
  formatSrtTimeRange,
  parseAudioTimestamp,
} from "../utils/AudioUtils";
import {
  MAX_LINE_CHARACTERS,
  extractPlainText,
  escapeHtmlText,
  sanitizeHTML,
} from "../utils/SubtitleUtils";
import {
  findMatches,
  replaceAllMatches,
  replaceMatchesInChunk,
} from "../utils/FindReplaceUtils";
import { resolveLanguageAndDirection } from "../utils/LanguageUtils";
import { Spinner } from "./TranscribeButton";
import FindReplacePanel from "./FindReplacePanel";

interface Props {
  transcribedData: TranscriberData | undefined;
  chunks?: TranscriberData["chunks"];
  language?: string;
  onChunkUpdate?: (
    index: number,
    updatedChunk: TranscriptChunk,
  ) => void;
  onSplitSegment?: (
    index: number,
    before: string,
    after: string,
    beforeWordCount: number,
  ) => void;
  onDeleteSegment?: (index: number) => void;
  onSeekTo?: (time: number) => void;
  isEditing?: boolean;
  onStartEditing?: () => void;
  onSaveEdits?: () => void;
  onCancelEdits?: () => void;
  summary?: SummaryData;
  onGenerateSummary?: () => void;
  supportsSummarizer?: boolean;
  currentTime?: number;
  subscribeToTimeUpdate?: (subscriber: (time: number) => void) => () => void;
  isAutoScrollSettingEnabled?: boolean;
  setIsAutoScrollSettingEnabled?: (enabled: boolean) => void;
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  onChunksReplace?: (chunks: TranscriptChunk[]) => void;
  mediaTitle?: string;
}

function formatTranscriptionDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(0)} seconds`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${remainingSeconds.toFixed(0)} seconds`;
}

const AUTO_SCROLL_RESUME_DELAY = 5000;

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

function buildHighlightedHtml(
  plainText: string,
  ranges: { start: number; end: number; isActive: boolean }[],
): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let html = "";
  let cursor = 0;
  for (const range of sorted) {
    html += escapeHtmlText(plainText.slice(cursor, range.start));
    html += `<mark class="find-match${range.isActive ? " find-match-active" : ""}">${escapeHtmlText(plainText.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  html += escapeHtmlText(plainText.slice(cursor));
  return html;
}

function EditableChunk(props: {
  text: string;
  label: string;
  dir?: "rtl" | "ltr";
  lang?: string;
  onTextChange?: (text: string) => void;
  onSplit?: (before: string, after: string, beforeWordCount: number) => void;
  onDeleteEmpty?: () => void;
  shouldFocus?: boolean;
  focusAtEnd?: boolean;
  highlightRanges?: { start: number; end: number; isActive: boolean }[];
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isDeletingRef = useRef(false);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && document.activeElement !== editor) {
      const html = props.highlightRanges?.length
        ? buildHighlightedHtml(extractPlainText(props.text), props.highlightRanges)
        : sanitizeHTML(props.text);
      if (editor.innerHTML !== html) {
        editor.innerHTML = html;
      }
    }
  }, [props.text, props.highlightRanges]);

  useEffect(() => {
    if (props.shouldFocus) {
      const editor = editorRef.current;
      editor?.focus();
      if (editor && props.focusAtEnd) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }, [props.shouldFocus, props.focusAtEnd]);

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!document.execCommand("insertText", false, text)) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount) {
        selection.deleteFromDocument();
        selection
          .getRangeAt(0)
          .insertNode(document.createTextNode(text));
        selection.collapseToEnd();
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      editor &&
      selection?.isCollapsed &&
      editor.contains(selection.anchorNode) &&
      !editor.textContent?.trim()
    ) {
      event.preventDefault();
      isDeletingRef.current = true;
      props.onDeleteEmpty?.();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;

    if (
      !editor ||
      !selection ||
      !selection.rangeCount ||
      !editor.contains(selection.anchorNode)
    ) {
      return;
    }

    if ((editor.innerText.match(/\n/g) ?? []).length < 1) return;

    event.preventDefault();
    const range = selection.getRangeAt(0);
    const toHtml = (sourceRange: Range) => {
      const container = document.createElement("div");
      container.append(sourceRange.cloneContents());
      return sanitizeHTML(container.innerHTML);
    };
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editor);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = range.cloneRange();
    afterRange.selectNodeContents(editor);
    afterRange.setStart(range.endContainer, range.endOffset);
    const before = toHtml(beforeRange);
    const after = toHtml(afterRange);

    editor.innerHTML = before;
    props.onSplit?.(
      before,
      after,
      extractPlainText(before).trim().split(/\s+/).filter(Boolean).length,
    );
  };

  return (
    <div
      ref={editorRef}
      dir={props.dir}
      lang={props.lang}
      className='flex-1 whitespace-pre-wrap rounded border border-dashed border-blue-300 bg-blue-50/60 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-solid dark:border-blue-400/50 dark:bg-blue-950/30'
      contentEditable
      suppressContentEditableWarning
      role='textbox'
      aria-multiline='true'
      aria-label={props.label}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onBlur={(event) =>
        !isDeletingRef.current &&
        props.onTextChange?.(sanitizeHTML(event.currentTarget.innerHTML))
      }
    />
  );
}

function EditableTimestamp(props: {
  timestamp: number;
  label?: string;
  onTimestampChange?: (newTimestamp: number) => void;
}) {
  const [prevTimestamp, setPrevTimestamp] = useState(props.timestamp);
  const [value, setValue] = useState(() =>
    formatAudioTimestamp(props.timestamp),
  );

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
      type='text'
      dir='ltr'
      aria-label={props.label}
      inputMode='numeric'
      className='me-5 self-stretch shrink-0 w-20 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500 rounded border border-dashed border-blue-300 bg-blue-50/60 px-1 py-1 dark:border-blue-400/50 dark:bg-blue-950/30'
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

function TimestampButton({
  timestamp,
  onClick,
  onKeyDown,
  tabIndex,
  onMount,
  onHover,
}: {
  timestamp: number;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  tabIndex: number;
  onMount?: (element: HTMLButtonElement | null) => void;
  onHover?: (element: HTMLElement | null) => void;
}) {
  return (
    <button
      ref={onMount}
      type='button'
      dir='ltr'
      className='timestamp-pill me-5 shrink-0 text-left tabular-nums'
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      aria-label={`Play from ${formatAudioTimestamp(timestamp)}`}
      onMouseEnter={(e) => onHover?.(e.currentTarget)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={(e) => onHover?.(e.currentTarget)}
      onBlur={() => onHover?.(null)}
    >
      {formatAudioTimestamp(timestamp)}
    </button>
  );
}

interface TranscriptSegmentProps {
  chunk: TranscriptChunk;
  index: number;
  isActive: boolean;
  isEditing: boolean;
  tabIndex: number;
  lang?: string;
  dir?: "rtl" | "ltr";
  onChunkUpdate?: (
    index: number,
    updatedChunk: TranscriptChunk,
  ) => void;
  onSplitSegment?: (
    index: number,
    before: string,
    after: string,
    beforeWordCount: number,
  ) => void;
  onDeleteSegment?: (index: number) => void;
  shouldFocusEditor: boolean;
  focusEditorAtEnd: boolean;
  onSeekTo?: (time: number) => void;
  onKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => void;
  onButtonMount: (element: HTMLButtonElement | null, index: number) => void;
  onContainerMount: (element: HTMLDivElement | null, index: number) => void;
  onTimestampHover?: (element: HTMLElement | null) => void;
  highlightRanges?: { start: number; end: number; isActive: boolean }[];
}

const TranscriptSegment = memo(function TranscriptSegment({
  chunk,
  index,
  isActive,
  isEditing,
  tabIndex,
  lang,
  dir,
  onChunkUpdate,
  onSplitSegment,
  onDeleteSegment,
  shouldFocusEditor,
  focusEditorAtEnd,
  onSeekTo,
  onKeyDown,
  onButtonMount,
  onContainerMount,
  onTimestampHover,
  highlightRanges,
}: TranscriptSegmentProps) {
  const sanitizedText = useMemo(
    () => sanitizeHTML(chunk.text).trimStart(),
    [chunk.text],
  );
  const hasLongLine = useMemo(
    () =>
      extractPlainText(sanitizedText)
        .split(/\r?\n/)
        .some((line) => line.length > MAX_LINE_CHARACTERS),
    [sanitizedText],
  );

  return (
    <div
      ref={(el) => onContainerMount(el, index)}
      className={`transcript-segment ${isActive ? "active-segment" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      {isEditing && hasLongLine && (
        <div
          className='mb-2 flex w-full items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300'
          role='note'
        >
          <svg
            aria-hidden='true'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            className='h-4 w-4 shrink-0'
          >
            <path d='M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z' />
            <path d='M12 9v4M12 17h.01' />
          </svg>
          <span>One or more lines are over {MAX_LINE_CHARACTERS} characters, which can cut off words or block the video. To fix this, insert a line break at a natural grammatical pause or split the dialogue into two separate captions.</span>
        </div>
      )}
      <div
        className={`flex w-full min-w-0 ${isEditing ? "items-stretch" : "items-start"}`}
      >
        {isEditing ? (
          <>
            <EditableTimestamp
              timestamp={chunk.timestamp[0]}
              label={`Start time ${index + 1}`}
              onTimestampChange={(newTimestamp) => {
                onChunkUpdate?.(index, {
                  ...chunk,
                  timestamp: [newTimestamp, chunk.timestamp[1]],
                });
              }}
            />
            <EditableChunk
              text={chunk.text.trimStart()}
              label={`Text ${index + 1}`}
              lang={lang}
              dir={dir}
              onTextChange={(text) =>
                onChunkUpdate?.(index, { ...chunk, text })
              }
              onSplit={(before, after, beforeWordCount) =>
                onSplitSegment?.(index, before, after, beforeWordCount)
              }
              onDeleteEmpty={() => onDeleteSegment?.(index)}
              shouldFocus={shouldFocusEditor}
              focusAtEnd={focusEditorAtEnd}
              highlightRanges={highlightRanges}
            />
          </>
        ) : (
          <>
            <TimestampButton
              onMount={(element) => onButtonMount(element, index)}
              timestamp={chunk.timestamp[0]}
              onClick={() => onSeekTo?.(chunk.timestamp[0])}
              onKeyDown={(e) => onKeyDown(e, index)}
              tabIndex={tabIndex}
              onHover={onTimestampHover}
            />
            <div
              className='flex-1 whitespace-pre-wrap'
              dangerouslySetInnerHTML={{ __html: sanitizedText }}
            />
          </>
        )}
      </div>
    </div>
  );
});

function SaveButton(props: { onSave?: () => void; shortcut: string }) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // Floating UI reads this ref after render to calculate arrow placement.
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 800, close: 0 },
  });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
  ]);

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

function EditButton(props: { onEdit?: () => void; shortcut: string }) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // Floating UI reads this ref after render to calculate arrow placement.
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 800, close: 0 },
  });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
  ]);

  return (
    <>
      <button
        ref={refs.setReference}
        type='button'
        className='export-button gap-1.5'
        onClick={props.onEdit}
        aria-keyshortcuts='Meta+E Control+E'
        {...getReferenceProps()}
      >
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

function CancelButton(props: { onCancel?: () => void; shortcut: string }) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // Floating UI reads this ref after render to calculate arrow placement.
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 800, close: 0 },
  });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
  ]);

  return (
    <>
      <button
        ref={refs.setReference}
        type='button'
        className='inline-flex items-center justify-center gap-2 rounded-md border-2 border-solid bg-red-100 px-4 py-2 text-sm font-semibold text-red-900 hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 transition-all duration-300'
        onClick={props.onCancel}
        aria-keyshortcuts='Escape'
        {...getReferenceProps()}
      >
        Cancel
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

function FindButton(props: {
  isOpen: boolean;
  onToggle: () => void;
  shortcut: string;
  onButtonRef?: (el: HTMLButtonElement | null) => void;
}) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen && !props.isOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // Floating UI reads this ref after render to calculate arrow placement.
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 800, close: 0 },
  });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
  ]);

  return (
    <>
      <button
        ref={(el) => {
          refs.setReference(el);
          props.onButtonRef?.(el);
        }}
        type='button'
        className='export-button gap-1.5'
        onClick={() => {
          setIsTooltipOpen(false);
          props.onToggle();
        }}
        aria-keyshortcuts='Meta+F Control+F'
        aria-expanded={props.isOpen}
        {...getReferenceProps()}
      >
        <svg
          aria-hidden='true'
          viewBox='0 0 20 20'
          fill='currentColor'
          className='h-4 w-4'
        >
          <path
            fillRule='evenodd'
            d='M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.6 4.2l3.1 3.1a.75.75 0 1 1-1.06 1.06l-3.1-3.1A7 7 0 0 1 2 9Z'
            clipRule='evenodd'
          />
        </svg>
        Find
      </button>
      {isTooltipOpen && !props.isOpen && (
        <span
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

function PlaybackSpeedSelect(props: {
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
}) {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 800, close: 0 },
  });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
  ]);

  return (
    <>
      <select
        ref={refs.setReference}
        className='form-select w-auto py-2 cursor-pointer'
        value={props.playbackRate}
        id='playback'
        onChange={(e) =>
          props.onPlaybackRateChange(Number(e.target.value))
        }
        aria-label='Playback speed'
        {...getReferenceProps()}
      >
        <option value={0.5}>0.5x</option>
        <option value={0.75}>0.75x</option>
        <option value={1}>1x</option>
        <option value={1.25}>1.25x</option>
        <option value={1.5}>1.5x</option>
        <option value={2}>2x</option>
      </select>
      {isTooltipOpen && (
        <FloatingPortal>
          <span
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
            Playback speed
          </span>
        </FloatingPortal>
      )}
    </>
  );
}

const decodeSrtText = (html: string) => {
  const sanitized = sanitizeHTML(html);
  const tmp = document.createElement("textarea");
  tmp.innerHTML = sanitized;
  return tmp.value;
};

function findActiveChunkIndex(
  chunks: { timestamp: [number, number | null] }[],
  currentTime: number | undefined,
): number {
  if (currentTime === undefined || !chunks.length) return -1;
  let low = 0;
  let high = chunks.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = chunks[mid].timestamp[0];
    const end =
      chunks[mid].timestamp[1] ??
      chunks[mid + 1]?.timestamp[0] ??
      start + 5;
    if (currentTime < start) {
      high = mid - 1;
    } else if (currentTime >= end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

const Transcript = memo(function Transcript({
  transcribedData,
  chunks: editedChunks,
  language,
  onChunkUpdate,
  onSplitSegment,
  onDeleteSegment,
  onSeekTo,
  isEditing,
  onStartEditing,
  onSaveEdits,
  onCancelEdits,
  summary,
  onGenerateSummary,
  supportsSummarizer,
  currentTime,
  subscribeToTimeUpdate,
  isAutoScrollSettingEnabled = true,
  setIsAutoScrollSettingEnabled,
  playbackRate = 1,
  onPlaybackRateChange,
  onChunksReplace,
  mediaTitle,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const timestampRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const chunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeChunkIndexRef = useRef<number>(-1);
  const lastActiveChunkIndexRef = useRef<number>(-1);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const prevTimeRef = useRef<number | undefined>(undefined);
  const autoScrollResumeTimerRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const [findButtonEl, setFindButtonEl] = useState<HTMLButtonElement | null>(
    null,
  );
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findReplaceMode, setFindReplaceMode] = useState<"find" | "replace">(
    "find",
  );
  const [findQuery, setFindQuery] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const chunks = useMemo(
    () => editedChunks ?? transcribedData?.chunks ?? [],
    [editedChunks, transcribedData?.chunks],
  );

  const findMatchOptions = useMemo(
    () => ({ matchCase, wholeWord }),
    [matchCase, wholeWord],
  );
  const matches = useMemo(
    () =>
      isEditing && findReplaceOpen
        ? findMatches(chunks, findQuery, findMatchOptions)
        : [],
    [isEditing, findReplaceOpen, chunks, findQuery, findMatchOptions],
  );
  const clampedActiveMatchIndex = matches.length
    ? Math.min(activeMatchIndex, matches.length - 1)
    : 0;

  const highlightRangesByChunk = useMemo(() => {
    const map = new Map<
      number,
      { start: number; end: number; isActive: boolean }[]
    >();
    matches.forEach((match, i) => {
      const ranges = map.get(match.chunkIndex) ?? [];
      ranges.push({
        start: match.start,
        end: match.end,
        isActive: i === clampedActiveMatchIndex,
      });
      map.set(match.chunkIndex, ranges);
    });
    return map;
  }, [matches, clampedActiveMatchIndex]);

  const scrollChunkIntoViewForFind = useCallback((index: number) => {
    chunkRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, []);

  useEffect(() => {
    const match = matches[clampedActiveMatchIndex];
    if (match) {
      scrollChunkIntoViewForFind(match.chunkIndex);
    }
  }, [matches, clampedActiveMatchIndex, scrollChunkIntoViewForFind]);

  const handleFindNext = useCallback(() => {
    if (!matches.length) return;
    setActiveMatchIndex((clampedActiveMatchIndex + 1) % matches.length);
  }, [matches.length, clampedActiveMatchIndex]);

  const handleFindPrevious = useCallback(() => {
    if (!matches.length) return;
    setActiveMatchIndex(
      (clampedActiveMatchIndex - 1 + matches.length) % matches.length,
    );
  }, [matches.length, clampedActiveMatchIndex]);

  const handleReplaceCurrent = useCallback(() => {
    const match = matches[clampedActiveMatchIndex];
    if (!match) return;
    const updatedChunk = replaceMatchesInChunk(
      chunks[match.chunkIndex],
      [match],
      replaceValue,
    );
    onChunkUpdate?.(match.chunkIndex, updatedChunk);
  }, [matches, clampedActiveMatchIndex, chunks, replaceValue, onChunkUpdate]);

  const handleReplaceAll = useCallback(() => {
    if (!matches.length) return;
    const updatedChunks = replaceAllMatches(chunks, matches, replaceValue);
    onChunksReplace?.(updatedChunks);
  }, [matches, chunks, replaceValue, onChunksReplace]);

  const openFindReplace = useCallback((mode: "find" | "replace") => {
    setFindReplaceMode(mode);
    setFindReplaceOpen(true);
  }, []);

  const closeFindReplace = useCallback(() => {
    setFindReplaceOpen(false);
  }, []);

  const [internalActiveIndex, setInternalActiveIndex] = useState<number>(() =>
    findActiveChunkIndex(chunks, currentTime),
  );
  const activeIndex =
    subscribeToTimeUpdate !== undefined
      ? internalActiveIndex
      : findActiveChunkIndex(chunks, currentTime);

  const chunksRef = useRef(chunks);
  const activeIndexRef = useRef(activeIndex);
  const isAutoScrollSettingEnabledRef = useRef(isAutoScrollSettingEnabled);
  const isEditingRef = useRef(isEditing);
  const autoScrollPausedRef = useRef(autoScrollPaused);

  useLayoutEffect(() => {
    chunksRef.current = chunks;
    activeIndexRef.current = activeIndex;
    isAutoScrollSettingEnabledRef.current = isAutoScrollSettingEnabled;
    isEditingRef.current = isEditing;
    autoScrollPausedRef.current = autoScrollPaused;
  });

  const rawText = transcribedData?.text;
  const sampleTranscriptText = useMemo(() => {
    if (rawText) {
      return rawText.length > 1000 ? rawText.slice(0, 1000) : rawText;
    }
    if (chunks?.length) {
      let text = "";
      for (let i = 0; i < chunks.length && text.length < 1000; i++) {
        text += (text ? " " : "") + chunks[i].text;
      }
      return text;
    }
    return "";
  }, [rawText, chunks]);

  const transcribedLanguage = transcribedData?.language;
  const { language: transcriptLanguage, dir: transcriptDir } = useMemo(() => {
    return resolveLanguageAndDirection(
      sampleTranscriptText,
      language || transcribedLanguage,
    );
  }, [sampleTranscriptText, language, transcribedLanguage]);

  const { language: summaryLanguage, dir: summaryDir } = useMemo(() => {
    if (!summary?.summary) {
      return { language: transcriptLanguage, dir: transcriptDir };
    }
    return resolveLanguageAndDirection(summary.summary, transcriptLanguage);
  }, [summary, transcriptLanguage, transcriptDir]);
  const saveShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Command + S"
    : "Ctrl + S";
  const editShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Command + E"
    : "Ctrl + E";
  const cancelShortcut = "Escape";
  const findShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Command + F"
    : "Ctrl + F";

  const [tooltipTarget, setTooltipTarget] = useState<HTMLElement | null>(
    null,
  );
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: Boolean(tooltipTarget),
    elements: { reference: tooltipTarget },
    placement: "top",
    middleware: [
      offset(10),
      flip(),
      shift({ padding: 8 }),
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const offset =
        event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowUp"
            ? -1
            : 0;
      if (offset) {
        event.preventDefault();
        timestampRefs.current[index + offset]?.focus();
      }
    },
    [],
  );

  const handleButtonRef = useCallback(
    (element: HTMLButtonElement | null, index: number) => {
      timestampRefs.current[index] = element;
    },
    [],
  );

  const handleContainerRef = useCallback(
    (element: HTMLDivElement | null, index: number) => {
      chunkRefs.current[index] = element;
    },
    [],
  );

  const handleSeek = useCallback(
    (time: number) => {
      setAutoScrollPaused(false);
      onSeekTo?.(time);
    },
    [onSeekTo],
  );

  const pauseAutoScrollAfterUserScroll = useCallback(() => {
    if (autoScrollResumeTimerRef.current !== null) {
      window.clearTimeout(autoScrollResumeTimerRef.current);
    }

    setAutoScrollPaused(true);
    autoScrollResumeTimerRef.current = window.setTimeout(() => {
      autoScrollResumeTimerRef.current = null;
      setAutoScrollPaused(false);
    }, AUTO_SCROLL_RESUME_DELAY);
  }, []);

  const resumeAutoScrollOnPointerLeave = useCallback(() => {
    if (autoScrollResumeTimerRef.current !== null) {
      window.clearTimeout(autoScrollResumeTimerRef.current);
      autoScrollResumeTimerRef.current = null;
    }
    setAutoScrollPaused(false);
  }, []);

  useEffect(() => {
    return () => {
      if (autoScrollResumeTimerRef.current !== null) {
        window.clearTimeout(autoScrollResumeTimerRef.current);
      }
    };
  }, []);

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Turns a media title into a lowercase, dash-separated filename slug.
  const slugifyTitle = (title: string): string =>
    title
      .replace(/\.[^./]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const exportTXT = () => {
    const text = chunks
      .map((chunk) => extractPlainText(chunk.text))
      .join(" ")
      .trim();

    const slug = mediaTitle && slugifyTitle(mediaTitle);
    const blob = new Blob([text], { type: "text/plain" });
    saveBlob(blob, slug ? `transcript-${slug}.txt` : "transcript.txt");
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

    for (let i = 0; i < chunks.length; i++) {
      srt += `${i + 1}\n`;
      srt += `${formatSrtTimeRange(chunks[i].timestamp[0], chunks[i].timestamp[1] ?? chunks[i].timestamp[0])}\n`;
      srt += `${decodeSrtText(chunks[i].text)}\n\n`;
    }
    const slug = mediaTitle && slugifyTitle(mediaTitle);
    const blob = new Blob([srt], { type: "text/plain" });
    saveBlob(blob, slug ? `${slug}.srt` : "transcript.srt");
  };

  const [copiedState, setCopiedState] = useState<
    "idle" | "copied" | "failed"
  >("idle");

  useEffect(() => {
    if (copiedState === "idle") return;
    const timer = window.setTimeout(() => {
      setCopiedState("idle");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [copiedState]);

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
      setCopiedState("copied");
    } catch (err) {
      console.error("Failed to copy text: ", err);
      setCopiedState("failed");
    }
  };

  const exportButtons = [
    {
      name:
        copiedState === "copied"
          ? "Copied!"
          : copiedState === "failed"
            ? "Failed to copy"
            : "Copy to Clipboard",
      onClick: copyToClipboard,
      icon:
        copiedState === "copied" ? (
          <svg
            className='h-4 w-4 shrink-0'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
            aria-hidden='true'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2.5}
              d='M5 13l4 4L19 7'
            />
          </svg>
        ) : (
          <ClipboardIcon className='h-4 w-4 shrink-0' />
        ),
    },
    {
      name: "Export to TXT",
      onClick: exportTXT,
      icon: <DocumentTextIcon className='h-4 w-4 shrink-0' />,
    },
    {
      name: "Export to SRT",
      onClick: exportSRT,
      icon: <FilmIcon className='h-4 w-4 shrink-0' />,
    },
    // { name: "Export to JSON", onClick: exportJSON },
  ];

  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const summaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const prevIsBusyRef = useRef<boolean | undefined>(undefined);
  const prevSummaryRef = useRef<string | undefined>(undefined);
  const scrollRafRef = useRef<number | null>(null);
  const [lastAnnouncedProgress, setLastAnnouncedProgress] = useState<
    number | null
  >(null);
  const [editorFocus, setEditorFocus] = useState<{
    index: number;
    atEnd: boolean;
  } | null>(null);

  const handleSplitSegment = useCallback(
    (index: number, before: string, after: string, beforeWordCount: number) => {
      onSplitSegment?.(index, before, after, beforeWordCount);
      setEditorFocus({ index: index + 1, atEnd: false });
    },
    [onSplitSegment],
  );

  const handleDeleteSegment = useCallback(
    (index: number) => {
      onDeleteSegment?.(index);
      setEditorFocus({ index: Math.max(0, index - 1), atEnd: true });
    },
    [onDeleteSegment],
  );

  useEffect(() => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
    }

    scrollRafRef.current = requestAnimationFrame(() => {
      endOfMessagesRef.current?.scrollIntoView({
        behavior: "auto",
        block: "end",
      });
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
    if (
      !transcribedData?.isBusy ||
      transcribedData.progress === undefined
    ) {
      return;
    }

    const milestoneProgress =
      Math.floor(transcribedData.progress / 20) * 20;
    if (
      milestoneProgress >= 20 &&
      milestoneProgress > (lastAnnouncedProgress ?? -20)
    ) {
      setTimeout(() => {
        setLastAnnouncedProgress(milestoneProgress);
      }, 0);
    }
  }, [
    transcribedData?.isBusy,
    transcribedData?.progress,
    lastAnnouncedProgress,
  ]);

  useEffect(() => {
    if (transcribedData?.transcriptionSeconds !== undefined) {
      console.info(
        `Transcribed in ${formatTranscriptionDuration(transcribedData.transcriptionSeconds)}.`,
      );
    }
  }, [transcribedData?.transcriptionSeconds]);

  const scrollToChunk = useCallback((index: number) => {
    if (
      isAutoScrollSettingEnabledRef.current &&
      !isEditingRef.current &&
      !autoScrollPausedRef.current &&
      transcriptContainerRef.current &&
      chunkRefs.current[index]
    ) {
      const container = transcriptContainerRef.current;
      const chunkElement = chunkRefs.current[index];

      if (chunkElement) {
        programmaticScrollRef.current = true;
        requestAnimationFrame(() => {
          const containerCenter = container.clientHeight / 2;
          const chunkCenter = chunkElement.clientHeight / 2;
          const scrollTop =
            chunkElement.offsetTop -
            containerCenter +
            chunkCenter;
          container.scrollTo({
            top: scrollTop,
            behavior: "smooth",
          });
          window.setTimeout(() => {
            programmaticScrollRef.current = false;
          }, 1000);
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!subscribeToTimeUpdate) return;

    return subscribeToTimeUpdate((time: number) => {
      // Detect audio seek (time jumped by more than 1.5 seconds)
      if (
        prevTimeRef.current !== undefined &&
        Math.abs(time - prevTimeRef.current) > 1.5
      ) {
        setAutoScrollPaused(false);
      }
      prevTimeRef.current = time;

      const currentChunks = chunksRef.current;
      if (!currentChunks.length) return;

      const nextIndex = findActiveChunkIndex(currentChunks, time);
      if (nextIndex !== -1 && nextIndex !== activeIndexRef.current) {
        activeIndexRef.current = nextIndex;
        lastActiveChunkIndexRef.current = nextIndex;
        setInternalActiveIndex(nextIndex);
        scrollToChunk(nextIndex);
      } else if (nextIndex === -1 && activeIndexRef.current !== -1) {
        activeIndexRef.current = -1;
        setInternalActiveIndex(-1);
      }
    });
  }, [subscribeToTimeUpdate, scrollToChunk]);

  useEffect(() => {
    if (
      subscribeToTimeUpdate &&
      chunks.length === 0 &&
      activeIndexRef.current !== -1
    ) {
      activeIndexRef.current = -1;
      setInternalActiveIndex(-1);
    }
  }, [chunks.length, subscribeToTimeUpdate]);

  useEffect(() => {
    if (subscribeToTimeUpdate) return;

    // Detect audio seek (time jumped by more than 1.5 seconds)
    if (currentTime !== undefined && prevTimeRef.current !== undefined) {
      if (Math.abs(currentTime - prevTimeRef.current) > 1.5) {
        setAutoScrollPaused(false);
      }
    }
    prevTimeRef.current = currentTime;

    if (!chunks.length) return;

    if (activeIndex !== -1 && activeIndex !== activeChunkIndexRef.current) {
      activeChunkIndexRef.current = activeIndex;
      lastActiveChunkIndexRef.current = activeIndex;
      scrollToChunk(activeIndex);
    }
  }, [
    currentTime,
    chunks.length,
    activeIndex,
    scrollToChunk,
    subscribeToTimeUpdate,
  ]);

  useEffect(() => {
    const currentActive = subscribeToTimeUpdate
      ? activeIndexRef.current
      : activeChunkIndexRef.current;
    if (
      !autoScrollPaused &&
      isAutoScrollSettingEnabled &&
      !isEditing &&
      currentActive !== -1
    ) {
      const container = transcriptContainerRef.current;
      const chunkElement = chunkRefs.current[currentActive];

      if (container && chunkElement) {
        requestAnimationFrame(() => {
          const containerCenter = container.clientHeight / 2;
          const chunkCenter = chunkElement.clientHeight / 2;
          const scrollTop =
            chunkElement.offsetTop - containerCenter + chunkCenter;
          container.scrollTo({ top: scrollTop, behavior: "smooth" });
        });
      }
    }
  }, [
    autoScrollPaused,
    isAutoScrollSettingEnabled,
    isEditing,
    subscribeToTimeUpdate,
  ]);

  const handleStartEditing = useCallback(() => {
    onStartEditing?.();
    if (chunks.length) {
      setEditorFocus({
        index:
          activeIndex === -1
            ? Math.min(
              Math.max(lastActiveChunkIndexRef.current, 0),
              chunks.length - 1,
            )
            : activeIndex,
        atEnd: false,
      });
    } else {
      requestAnimationFrame(() => {
        transcriptContainerRef.current?.focus();
      });
    }
  }, [onStartEditing, chunks.length, activeIndex]);

  useEffect(() => {
    if (isEditing || chunks.length) return;
    requestAnimationFrame(() => {
      transcriptContainerRef.current?.focus();
    });
  }, [isEditing, chunks.length]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (
        isEditing &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        openFindReplace("find");
      } else if (
        isEditing &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "h"
      ) {
        event.preventDefault();
        event.stopPropagation();
        openFindReplace("replace");
      } else if (
        isEditing &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        onSaveEdits?.();
      } else if (isEditing && findReplaceOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFindReplace();
      } else if (isEditing && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelEdits?.();
      } else if (
        !isEditing &&
        transcribedData &&
        !transcribedData.isBusy &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "e"
      ) {
        event.preventDefault();
        event.stopPropagation();
        handleStartEditing();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [
    isEditing,
    findReplaceOpen,
    openFindReplace,
    closeFindReplace,
    onSaveEdits,
    onCancelEdits,
    handleStartEditing,
    transcribedData,
  ]);

  return (
    <div ref={divRef} className='w-full flex flex-col p-4 overflow-y-auto'>
      {lastAnnouncedProgress !== null && transcribedData?.isBusy && (
        <p className='sr-only' role='status' aria-live='polite' aria-atomic='true'>
          {lastAnnouncedProgress}% complete.
        </p>
      )}
      {transcribedData && !transcribedData.isBusy && transcribedData.chunks && (
        <>
          <div className='w-full flex items-center justify-between gap-3'>
            <div className='flex items-center gap-4'>
              <h2
                className='text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl'
                tabIndex={-1}
                id='transcript-complete'
                ref={headingRef}
              >
                Transcript
              </h2>
              {onPlaybackRateChange && (
                <PlaybackSpeedSelect
                  playbackRate={playbackRate}
                  onPlaybackRateChange={onPlaybackRateChange}
                />
              )}
              {isEditing && (
                <FindButton
                  isOpen={findReplaceOpen}
                  onToggle={() =>
                    findReplaceOpen
                      ? closeFindReplace()
                      : openFindReplace("find")
                  }
                  shortcut={findShortcut}
                  onButtonRef={setFindButtonEl}
                />
              )}
            </div>
            <div className='flex items-center gap-3'>
              {isEditing ? (
                <>
                  <SaveButton
                    onSave={onSaveEdits}
                    shortcut={saveShortcut}
                  />
                  <CancelButton
                    onCancel={onCancelEdits}
                    shortcut={cancelShortcut}
                  />
                </>
              ) : (
                <EditButton
                  onEdit={handleStartEditing}
                  shortcut={editShortcut}
                />
              )}
            </div>
          </div >

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
              lang={transcriptLanguage}
              dir={transcriptDir}
              onScroll={() => {
                if (!programmaticScrollRef.current) {
                  pauseAutoScrollAfterUserScroll();
                }
              }}
              onMouseLeave={resumeAutoScrollOnPointerLeave}
              onKeyDown={(event) => {
                if (isEditing && findReplaceOpen && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeFindReplace();
                } else if (isEditing && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onCancelEdits?.();
                } else if (
                  isEditing &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  event.key.toLowerCase() === "f"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  openFindReplace("find");
                } else if (
                  isEditing &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  event.key.toLowerCase() === "h"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  openFindReplace("replace");
                } else if (
                  isEditing &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSaveEdits?.();
                } else if (
                  !isEditing &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  event.key.toLowerCase() === "e"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  handleStartEditing();
                } else if (
                  [
                    "ArrowUp",
                    "PageUp",
                    "PageDown",
                    "Home",
                    "End",
                    " ",
                  ].includes(event.key)
                ) {
                  pauseAutoScrollAfterUserScroll();
                }
              }}
            >
              {chunks.map((chunk, i) => (
                <TranscriptSegment
                  key={`segment-${chunk.timestamp[0]}-${chunk.timestamp[1]}-${chunk.text}`}
                  chunk={chunk}
                  index={i}
                  isActive={i === activeIndex}
                  isEditing={Boolean(isEditing)}
                  tabIndex={i > 0 ? -1 : 0}
                  lang={transcriptLanguage}
                  dir={transcriptDir}
                  onChunkUpdate={onChunkUpdate}
                  onSplitSegment={handleSplitSegment}
                  onDeleteSegment={handleDeleteSegment}
                  shouldFocusEditor={editorFocus?.index === i}
                  focusEditorAtEnd={editorFocus?.index === i && editorFocus.atEnd}
                  onSeekTo={handleSeek}
                  onKeyDown={handleKeyDown}
                  onButtonMount={handleButtonRef}
                  onContainerMount={handleContainerRef}
                  onTimestampHover={setTooltipTarget}
                  highlightRanges={highlightRangesByChunk.get(i)}
                />
              ))}
            </div>
            {/* fade cue hinting the panel is scrollable */}
            <div
              aria-hidden='true'
              className='pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/10 via-black/5 to-transparent dark:from-black/30 dark:via-black/15'
            />
          </div >

          {
            tooltipTarget && (
              <FloatingPortal>
                <span
                  ref={refs.setFloating}
                  style={floatingStyles}
                  className='z-20 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-100 dark:text-slate-900 pointer-events-none'
                  role='tooltip'
                >
                  <FloatingArrow
                    ref={arrowRef}
                    context={context}
                    className='fill-slate-900 dark:fill-slate-100'
                  />
                  Play from here
                </span>
              </FloatingPortal>
            )
          }

          <FindReplacePanel
            open={findReplaceOpen && Boolean(isEditing)}
            mode={findReplaceMode}
            onModeChange={setFindReplaceMode}
            onClose={closeFindReplace}
            referenceElement={findButtonEl}
            query={findQuery}
            onQueryChange={setFindQuery}
            replaceValue={replaceValue}
            onReplaceValueChange={setReplaceValue}
            matchCase={matchCase}
            onMatchCaseChange={setMatchCase}
            wholeWord={wholeWord}
            onWholeWordChange={setWholeWord}
            matchCount={matches.length}
            activeMatchNumber={matches.length ? clampedActiveMatchIndex + 1 : 0}
            onFindNext={handleFindNext}
            onFindPrevious={handleFindPrevious}
            onReplace={handleReplaceCurrent}
            onReplaceAll={handleReplaceAll}
          />

          <div className='w-full flex justify-end mb-5 pr-2'>
            <label
              className='flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 cursor-pointer'
              htmlFor='auto-scroll'
            >
              <input
                id='auto-scroll'
                type='checkbox'
                checked={isAutoScrollSettingEnabled}
                onChange={(e) =>
                  setIsAutoScrollSettingEnabled?.(
                    e.target.checked,
                  )
                }
                className='rounded border-slate-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 bg-slate-50 dark:bg-slate-700 dark:border-slate-500'
              />
              Auto-scroll transcript
            </label>
          </div>

          <div className='w-full mt-2 flex flex-wrap items-center justify-center gap-3'>
            <span
              className='sr-only'
              role='status'
              aria-live='polite'
              aria-atomic='true'
            >
              {copiedState === "copied"
                ? "Transcript copied to clipboard"
                : copiedState === "failed"
                  ? "Failed to copy transcript to clipboard"
                  : ""}
            </span>
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

          {
            supportsSummarizer && !summary?.summary && (
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
            )
          }

          {
            summary?.summary && (
              <div
                className='w-full mt-6'
                lang={summaryLanguage}
                dir={summaryDir}
              >
                <h2
                  ref={summaryHeadingRef}
                  tabIndex={-1}
                  className='mt-5 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl'
                >
                  Summary
                </h2>
                <p className='whitespace-pre-wrap text-slate-700 dark:text-slate-300'>
                  {summary.summary}
                </p>
              </div>
            )
          }
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
    </div >
  );
});

export default Transcript;
