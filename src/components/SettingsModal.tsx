import { useEffect, useMemo, useState } from "react";
import { checkSupport } from "parakeet.wgsl";
import Constants, { LANGUAGES, MODELS, isIOS } from "../utils/Constants";
import { Transcriber } from "../hooks/useTranscriber";
import Modal from "./modal/Modal";

function titleCase(str: string) {
  str = str.toLowerCase();
  return (str.match(/\w+.?/g) || [])
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

export interface SettingsModalProps {
  show: boolean;
  onSubmit: (url: string) => void;
  onClose: () => void;
  transcriber: Transcriber;
  isAutoScrollEnabled: boolean;
  setIsAutoScrollEnabled: (enabled: boolean) => void;
}

export default function SettingsModal(props: SettingsModalProps) {
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
      setTimeout(() => {
        setIsWebgpuAvailable(false);
        setHasCheckedWebgpu(true);
      }, 0);
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
    if (hasCheckedWebgpu && (!IS_WEBGPU_AVAILABLE || isIOS) && props.transcriber.gpu) {
      props.transcriber.setGPU(false);
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (hasCheckedWebgpu && !IS_WEBGPU_AVAILABLE && props.transcriber.model === "parakeet.wgsl") {
      props.transcriber.setModel("onnx-community/whisper-base");
    }
  }, [hasCheckedWebgpu, IS_WEBGPU_AVAILABLE, props.transcriber]);

  useEffect(() => {
    if (hasCheckedWebgpu && (!IS_WEBGPU_AVAILABLE || isIOS) && props.transcriber.dtype === "fp16") {
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

