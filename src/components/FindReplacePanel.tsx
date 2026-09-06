import { useEffect, useRef, useState } from "react";
import {
  FloatingArrow,
  FloatingFocusManager,
  FloatingPortal,
  arrow,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useHover,
  useFocus,
  useInteractions,
} from "@floating-ui/react";

interface FindReplacePanelProps {
  open: boolean;
  mode: "find" | "replace";
  onModeChange: (mode: "find" | "replace") => void;
  onClose: () => void;
  referenceElement: HTMLElement | null;
  query: string;
  onQueryChange: (value: string) => void;
  replaceValue: string;
  onReplaceValueChange: (value: string) => void;
  matchCase: boolean;
  onMatchCaseChange: (value: boolean) => void;
  wholeWord: boolean;
  onWholeWordChange: (value: boolean) => void;
  matchCount: number;
  activeMatchNumber: number;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
}

function ToggleChip(props: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <label className='find-replace-checkbox-label'>
      <input
        type='checkbox'
        checked={props.pressed}
        onChange={props.onClick}
      />
      {props.label}
    </label>
  );
}

const replaceShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  ? "Command + H"
  : "Ctrl + H";

function ReplaceModeButton(props: { onClick: () => void }) {
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
      <button
        ref={refs.setReference}
        type='button'
        className='find-replace-mode-link'
        onClick={props.onClick}
        aria-keyshortcuts='Meta+H Control+H'
        {...getReferenceProps()}
      >
        Replace...
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
          {replaceShortcut}
        </span>
      )}
    </>
  );
}

export default function FindReplacePanel(props: FindReplacePanelProps) {
  const queryInputRef = useRef<HTMLInputElement>(null);
  const arrowRef = useRef<SVGSVGElement>(null);

  const { refs, floatingStyles, context } = useFloating({
    open: props.open,
    onOpenChange: (open) => {
      if (!open) props.onClose();
    },
    elements: { reference: props.referenceElement },
    placement: "top",
    middleware: [
      offset(12),
      flip(),
      shift({ padding: 8 }),
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const dismiss = useDismiss(context, {
    outsidePressEvent: "mousedown",
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    if (props.open) {
      queryInputRef.current?.focus();
      queryInputRef.current?.select();
    }
  }, [props.open]);

  if (!props.open) return null;

  const matchCountLabel =
    props.matchCount === 0
      ? props.query
        ? "No results"
        : ""
      : `Match ${props.activeMatchNumber} of ${props.matchCount}`;

  const handleQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        props.onFindPrevious();
      } else {
        props.onFindNext();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={0}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className='find-replace-panel'
          role='dialog'
          aria-label={
            props.mode === "replace" ? "Find and replace" : "Find"
          }
          {...getFloatingProps()}
        >
          <FloatingArrow
            ref={arrowRef}
            context={context}
            stroke='var(--border-strong)'
            strokeWidth={1}
            className='fill-white dark:fill-slate-800'
          />
          <div className='find-replace-field'>
            <label htmlFor='find-replace-query' className='find-replace-label'>
              Find
            </label>
            <div className='find-replace-row'>
              <input
                id='find-replace-query'
                ref={queryInputRef}
                type='text'
                value={props.query}
                onChange={(e) => props.onQueryChange(e.target.value)}
                onKeyDown={handleQueryKeyDown}
                className='find-replace-input'
              />
              <span
                className='find-replace-count'
                role='status'
                aria-live='polite'
              >
                {matchCountLabel}
              </span>
              <button
                type='button'
                className='find-replace-icon-button'
                onClick={props.onFindPrevious}
                disabled={props.matchCount === 0}
                aria-label='Find previous'
                title='Find previous (Shift+Enter)'
              >
                <svg
                  aria-hidden='true'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                  className='h-6 w-6'
                >
                  <path
                    fillRule='evenodd'
                    d='M14.78 12.78a.75.75 0 0 1-1.06 0L10 9.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06Z'
                    clipRule='evenodd'
                  />
                </svg>
              </button>
              <button
                type='button'
                className='find-replace-icon-button'
                onClick={props.onFindNext}
                disabled={props.matchCount === 0}
                aria-label='Find next'
                title='Find next (Enter)'
              >
                <svg
                  aria-hidden='true'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                  className='h-6 w-6'
                >
                  <path
                    fillRule='evenodd'
                    d='M5.22 7.22a.75.75 0 0 1 1.06 0L10 10.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.28a.75.75 0 0 1 0-1.06Z'
                    clipRule='evenodd'
                  />
                </svg>
              </button>
              <button
                type='button'
                className='find-replace-icon-button'
                onClick={props.onClose}
                aria-label='Close find and replace'
                title='Close (Esc)'
              >
                <svg
                  aria-hidden='true'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                  className='h-6 w-6'
                >
                  <path d='M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z' />
                </svg>
              </button>
            </div>
          </div>

          {props.mode === "replace" && (
            <div className='find-replace-field'>
              <label
                htmlFor='find-replace-value'
                className='find-replace-label'
              >
                Replace with
              </label>
              <div className='find-replace-row'>
                <input
                  id='find-replace-value'
                  type='text'
                  value={props.replaceValue}
                  onChange={(e) => props.onReplaceValueChange(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      props.onReplace();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      props.onClose();
                    }
                  }}
                  className='find-replace-input'
                />
                <button
                  type='button'
                  className='find-replace-button'
                  onClick={props.onReplace}
                  disabled={props.matchCount === 0}
                >
                  Replace
                </button>
                <button
                  type='button'
                  className='find-replace-button'
                  onClick={props.onReplaceAll}
                  disabled={props.matchCount === 0}
                >
                  Replace All
                </button>
              </div>
            </div>
          )}

          <div className='find-replace-row find-replace-row--modifiers'>
            <ToggleChip
              label='Match Case'
              pressed={props.matchCase}
              onClick={() => props.onMatchCaseChange(!props.matchCase)}
            />
            <ToggleChip
              label='Match Whole Word'
              pressed={props.wholeWord}
              onClick={() => props.onWholeWordChange(!props.wholeWord)}
            />
            {props.mode === "find" ? (
              <ReplaceModeButton onClick={() => props.onModeChange("replace")} />
            ) : (
              <button
                type='button'
                className='find-replace-mode-link'
                onClick={() => props.onModeChange("find")}
              >
                Find only
              </button>
            )}
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
