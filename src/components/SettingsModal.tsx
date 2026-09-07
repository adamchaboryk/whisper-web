import { useEffect, useMemo, useRef, useState } from "react";
import {
  FloatingArrow,
  FloatingPortal,
  arrow,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
} from "@floating-ui/react";
import Constants, {
  LANGUAGES,
  MODELS,
  isIOS,
  getCachedWebGpuSupport,
} from "../utils/Constants";
import { Transcriber } from "../hooks/useTranscriber";
import Modal, { ClearCacheButton } from "./modal/Modal";
import { useEncryptedDictionary } from "../hooks/useEncryptedDictionary";
import { TranscriptChunk } from "../hooks/useTranscriber";

function titleCase(str: string) {
  str = str.toLowerCase();
  return (str.match(/\w+.?/g) || [])
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

function DictionaryAddButton() {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isTooltipOpen,
    onOpenChange: setIsTooltipOpen,
    placement: "top",
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 8 }),
      // eslint-disable-next-line react-hooks/refs
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false });
  const focus = useFocus(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus]);

  return (
    <>
      <button
        ref={refs.setReference}
        type='submit'
        className='dictionary-add-button'
        aria-label='Add rule'
        {...getReferenceProps()}
      >
        <svg className='dictionary-add-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' aria-hidden='true'>
          <path strokeLinecap='round' d='M12 5v14M5 12h14' />
        </svg>
      </button>
      {isTooltipOpen && (
        <FloatingPortal>
          <span
            // Floating UI requires this callback ref to position the tooltip.
            // eslint-disable-next-line react-hooks/refs
            ref={refs.setFloating}
            style={floatingStyles}
            className='dictionary-tooltip'
            {...getFloatingProps({ role: "tooltip" })}
          >
            <FloatingArrow ref={arrowRef} context={context} className='dictionary-tooltip-arrow' />
            Add rule
          </span>
        </FloatingPortal>
      )}
    </>
  );
}

interface DictionaryDeleteButtonProps {
  targetWord: string;
  buttonRef: (element: HTMLButtonElement | null) => void;
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}

function DictionaryDeleteButton({
  targetWord,
  buttonRef,
  tabIndex,
  onFocus,
  onKeyDown,
  onClick,
}: DictionaryDeleteButtonProps) {
  return (
    <button
      ref={buttonRef}
      type='button'
      tabIndex={tabIndex}
      className='dictionary-delete-button'
      aria-label={`Delete ${targetWord} rule`}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <svg className='dictionary-delete-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' aria-hidden='true'>
        <path strokeLinecap='round' strokeLinejoin='round' d='M4 7h16m-10 4v5m4-5v5M9 7V5h6v2m-9 0 1 13h10l1-13' />
      </svg>
    </button>
  );
}

export interface SettingsModalProps {
  show: boolean;
  onSubmit: (url: string) => void;
  onClose: () => void;
  transcriber: Transcriber;
  isAutoScrollEnabled: boolean;
  setIsAutoScrollEnabled: (enabled: boolean) => void;
  transcriptChunks?: TranscriptChunk[];
  onChunksReplace?: (chunks: TranscriptChunk[]) => void;
}

export default function SettingsModal(props: SettingsModalProps) {
  const dictionary = useEncryptedDictionary();
  const [targetWord, setTargetWord] = useState("");
  const [replacementWord, setReplacementWord] = useState("");
  const [dictionaryMessage, setDictionaryMessage] = useState("");
  const [activeDeleteIndex, setActiveDeleteIndex] = useState(0);
  const deleteButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const importInputRef = useRef<HTMLInputElement>(null);
  const names = Object.values(LANGUAGES).map(titleCase);
  const isParakeet = props.transcriber.model === "parakeet.wgsl";

  const isMultilingual = useMemo(() => {
    const model = props.transcriber.model;
    return (
      !model.endsWith(".en") && MODELS[model] && MODELS[model][1] === ""
    );
  }, [props.transcriber.model]);

  const HAS_WEBGPU_API =
    "gpu" in navigator &&
    !!(navigator as Navigator & { gpu?: unknown }).gpu;
  const [IS_WEBGPU_AVAILABLE, setIsWebgpuAvailable] = useState(false);
  // Tracks whether the async WebGPU support check has finished, so we don't
  // prematurely reset settings based on the initial "unavailable" default.
  const [hasCheckedWebgpu, setHasCheckedWebgpu] = useState(false);
  const availableModels = Object.entries(MODELS).filter(
    ([modelKey]) => modelKey !== "parakeet.wgsl" || IS_WEBGPU_AVAILABLE,
  );

  useEffect(() => {
    if (!HAS_WEBGPU_API) {
      setTimeout(() => {
        setIsWebgpuAvailable(false);
        setHasCheckedWebgpu(true);
      }, 0);
      return;
    }

    let cancelled = false;
    getCachedWebGpuSupport()
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
    if (
      hasCheckedWebgpu &&
      (!IS_WEBGPU_AVAILABLE || isIOS) &&
      props.transcriber.gpu
    ) {
      props.transcriber.setGPU(false);
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (
      hasCheckedWebgpu &&
      !IS_WEBGPU_AVAILABLE &&
      props.transcriber.model === "parakeet.wgsl"
    ) {
      props.transcriber.setModel("onnx-community/whisper-base");
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (
      hasCheckedWebgpu &&
      (!IS_WEBGPU_AVAILABLE || isIOS) &&
      props.transcriber.dtype === "fp16"
    ) {
      props.transcriber.setDtype(Constants.DEFAULT_DTYPE);
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  const [cacheSize, setCacheSize] = useState<number>(0);

  useEffect(() => {
    if (!props.show) return;

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
  }, [props.show]);

  // Get the language code of the selected model
  const getModelLanguage = () => {
    if (props.transcriber.model in MODELS) {
      const [, lang] = MODELS[props.transcriber.model];
      return lang || props.transcriber.language;
    }
    return props.transcriber.language;
  };

  const importCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const importedEntries = dictionary.importEntries(String(reader.result));
        if (props.transcriptChunks?.length && props.onChunksReplace) {
          void dictionary.replaceChunks(props.transcriptChunks, importedEntries).then(props.onChunksReplace);
        }
        setDictionaryMessage("Dictionary imported.");
      } catch (error) {
        setDictionaryMessage(error instanceof Error ? error.message : "Could not import CSV.");
      }
    };
    reader.readAsText(file);
  };

  const addDictionaryRule = () => {
    if (!targetWord.trim()) return;
    dictionary.addEntry(targetWord, replacementWord);
    setTargetWord("");
    setReplacementWord("");
  };

  const handleDeleteEntry = (id: string, index: number) => {
    dictionary.deleteEntry(id);
    setActiveDeleteIndex((current) =>
      Math.min(current, Math.max(dictionary.entries.length - 2, 0)),
    );
    deleteButtonRefs.current.splice(index, 1);
  };

  return (
    <Modal
      show={props.show}
      title='Settings'
      content={
        <>
          <label htmlFor='model-select' className='form-label'>
            Model
          </label>
          <span className='text-gray-600 dark:text-slate-400 block'>
            Some models are bigger than others, so your browser may
            cache up to about 1.5 GB.
          </span>
          <select
            id='model-select'
            className='form-select mt-3 mb-3'
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
          <ClearCacheButton cacheSize={cacheSize} onClose={props.onClose} />

          {!isParakeet && (
            <>
              {/* Optional Performance mode (quantization / dtype) selector.
                  Commented out for a simpler UI. Remove comment tags to restore:
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
                {Object.entries(Constants.DTYPES)
                  .filter(([value]) => value !== "fp16" || (IS_WEBGPU_AVAILABLE && !isIOS))
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
              */}
              {IS_WEBGPU_AVAILABLE && !isIOS && (
                <div className='flex justify-between items-center mb-3 px-1'>
                  <div className='flex'>
                    <input
                      id='gpu'
                      type='checkbox'
                      checked={props.transcriber.gpu}
                      onChange={(e) => {
                        props.transcriber.setGPU(
                          e.target.checked,
                        );
                      }}
                    ></input>
                    <label
                      htmlFor='gpu'
                      className='form-label form-label--checkbox'
                    >
                      Enable GPU acceleration
                    </label>
                  </div>
                </div>
              )}

              <label htmlFor='selectLang' className='form-label'>
                Source language
              </label>
              <select
                id='selectLang'
                className='form-select mt-1 mb-3'
                value={
                  isMultilingual
                    ? props.transcriber.language
                    : getModelLanguage()
                }
                onChange={(e) => {
                  props.transcriber.setLanguage(
                    e.target.value,
                  );
                }}
                disabled={!isMultilingual}
              >
                {Object.keys(LANGUAGES).map((key, i) => (
                  <option key={key} value={key}>
                    {names[i]}
                  </option>
                ))}
              </select>

              <label htmlFor='selectTask' className='form-label'>
                Task
              </label>
              <select
                id='selectTask'
                className='form-select mt-1 mb-3'
                value={
                  isMultilingual
                    ? props.transcriber.subtask
                    : "transcribe"
                }
                onChange={(e) => {
                  props.transcriber.setSubtask(
                    e.target.value,
                  );
                }}
                disabled={!isMultilingual}
              >
                <option value={"transcribe"}>Transcribe</option>
                <option value={"translate"}>Translate</option>
              </select>
            </>
          )}
          <section className='dictionary-section'>
            <h3 className='dictionary-title'>
              Text Replacement Dictionary
            </h3>
            <p className='dictionary-description'>
              Automatically applies word replacements during caption generation. You can also{" "}
              <button type='button' className='demo' onClick={() => importInputRef.current?.click()}>
                import
              </button>{" "}
              or{" "}
              <button type='button' className='demo' onClick={dictionary.exportEntries}>
                export
              </button>{" "}
              dictionary entries as a CSV file.
              <input ref={importInputRef} type='file' accept='.csv,text/csv' className='dictionary-file-input' onChange={(event) => { const file = event.target.files?.[0]; if (file) importCsv(file); event.target.value = ""; }} />
            </p>
            <form
              className='dictionary-form'
              onSubmit={(event) => {
                event.preventDefault();
                addDictionaryRule();
              }}
            >
              <div className='dictionary-entry-row'>
                <div className='dictionary-entry-fields'>
                  <label htmlFor='dictionary-target-word' className='dictionary-field'>
                    <span className='form-label'>Target Word</span>
                    <input id='dictionary-target-word' className='dictionary-input' value={targetWord} onChange={(event) => setTargetWord(event.target.value)} />
                  </label>
                  <label htmlFor='dictionary-replacement-word' className='dictionary-field'>
                    <span className='form-label'>Replacement Word</span>
                    <input id='dictionary-replacement-word' className='dictionary-input' value={replacementWord} onChange={(event) => setReplacementWord(event.target.value)} />
                  </label>
                </div>
                <DictionaryAddButton />
              </div>
            </form>
            {dictionaryMessage && <p className='dictionary-message' role='status'>{dictionaryMessage}</p>}
            {dictionary.entries.length > 0 && (
              <div className='dictionary-table-container'>
                <table className='dictionary-table'>
                  <colgroup>
                    <col />
                    <col />
                    <col />
                  </colgroup>
                  <thead><tr><th><span className='dictionary-visually-hidden'>Target Word</span></th><th><span className='dictionary-visually-hidden'>Replacement Word</span></th><th><span className='dictionary-visually-hidden'>Delete</span></th></tr></thead>
                  <tbody>{dictionary.entries.map((entry, index) => <tr key={entry.id}><td>{entry.targetWord}</td><td>{entry.replacementWord}</td><td className='dictionary-delete-cell'><DictionaryDeleteButton
                    targetWord={entry.targetWord}
                    buttonRef={(element) => { deleteButtonRefs.current[index] = element; }}
                    tabIndex={index === activeDeleteIndex ? 0 : -1}
                    onFocus={() => setActiveDeleteIndex(index)}
                    onKeyDown={(event) => {
                      const lastIndex = dictionary.entries.length - 1;
                      let nextIndex = index;
                      if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, lastIndex);
                      if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
                      if (event.key === "Home") nextIndex = 0;
                      if (event.key === "End") nextIndex = lastIndex;
                      if (nextIndex !== index) {
                        event.preventDefault();
                        setActiveDeleteIndex(nextIndex);
                        deleteButtonRefs.current[nextIndex]?.focus();
                      }
                    }}
                    onClick={() => handleDeleteEntry(entry.id, index)}
                  /></td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      }
      onClose={props.onClose}
      onSubmit={() => { }}
      cacheSize={0}
    />
  );
}
