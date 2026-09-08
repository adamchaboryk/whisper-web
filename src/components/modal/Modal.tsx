import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from "@headlessui/react";
import { Fragment, JSX } from "react";

export interface Props {
  show: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  submitText?: string;
  submitEnabled?: boolean;
  title: string | JSX.Element;
  content: string | JSX.Element;
  cacheSize?: number;
}

export function ClearCacheButton({ cacheSize, onClose }: { cacheSize: number; onClose: () => void }) {
  const onClear = async () => {
    onClose();
    try {
      if (typeof caches !== 'undefined') {
        const cacheNames = await caches.keys();
        for (const cacheName of cacheNames) {
          if (cacheName === 'transformers-cache' || cacheName.startsWith('parakeet.wgsl:models:')) {
            try {
              const cache = await caches.open(cacheName);
              const requests = await cache.keys();
              await Promise.all(requests.map(req => cache.delete(req)));
            } catch (e) {
              console.warn("Failed to clear individual entries for", cacheName, e);
            }
            await caches.delete(cacheName);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to delete caches", e);
    }

    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('parakeet-wgsl-audio-decoding', { recursive: true });
      }
    } catch (e: unknown) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) {
        console.warn("Failed to delete OPFS cache", e);
      }
    }

    try {
      window.localStorage.removeItem('whisper-web-settings');
    } catch {
      // Ignore storage access failure if localStorage is unavailable.
    }
  };

  if (cacheSize === 0) return null;

  return (
    <button type='button' className='clear-cache-button' onClick={onClear}>
      <svg className='clear-cache-icon' viewBox='0 0 20 20' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
        <path d='M4 6h12' />
        <path d='M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6' />
        <path d='M5.5 6 6 16.5A1.5 1.5 0 0 0 7.5 18h5a1.5 1.5 0 0 0 1.5-1.5L14.5 6' />
        <path d='M8.5 9.5v5' />
        <path d='M11.5 9.5v5' />
      </svg>
      {cacheSize !== -1 ? `Clear Cache (${cacheSize} MB)` : 'Clear Cache'}
    </button>
  );
}

export default function Modal({
  show,
  onClose,
  onSubmit,
  title,
  content,
  submitText,
  submitEnabled = true,
  cacheSize = 0,
}: Props) {

  return (
    <Transition appear show={show} as={Fragment}>
      <Dialog as='div' className='relative z-10' onClose={onClose}>
        <TransitionChild
          as={Fragment}
          enter='ease-out duration-300'
          enterFrom='opacity-0'
          enterTo='opacity-100'
          leave='ease-in duration-200'
          leaveFrom='opacity-100'
          leaveTo='opacity-0'
        >
          <div className='fixed inset-0 bg-black bg-opacity-25' />
        </TransitionChild>

        <div className='fixed inset-0 overflow-y-auto'>
          <div className='flex min-h-full items-center justify-center p-4 text-center'>
            <TransitionChild
              as={Fragment}
              enter='ease-out duration-300'
              enterFrom='opacity-0 scale-95'
              enterTo='opacity-100 scale-100'
              leave='ease-in duration-200'
              leaveFrom='opacity-100 scale-100'
              leaveTo='opacity-0 scale-95'
            >
              <DialogPanel className='modal-panel w-full max-w-md transform overflow-hidden rounded-2xl bg-white dark:bg-slate-800 p-6 text-left align-middle shadow-xl transition-all'>
                <button type='button' className='modal-close-button' onClick={onClose} aria-label='Close'>
                  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden='true'>
                    <path strokeLinecap='round' d='M6 6l12 12M18 6 6 18' />
                  </svg>
                </button>
                <DialogTitle
                  as='h2'
                  className='text-lg font-medium leading-6 text-gray-900 dark:text-slate-100'
                >
                  {title}
                </DialogTitle>
                <div className='modal-content mt-3'>
                  {content}
                </div>

                <div className='mt-4 flex gap-3'>
                  {cacheSize != 0 && (
                    <ClearCacheButton cacheSize={cacheSize} onClose={onClose} />
                  )}
                  {submitText && (
                    <button
                      type='button'
                      disabled={!submitEnabled}
                      className={`inline-flex justify-center rounded-md border border-transparent ${submitEnabled
                        ? "bg-blue-600"
                        : "bg-grey-300"
                        } px-4 py-2 text-sm font-semibold text-blue-100 ${submitEnabled
                          ? "hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                          : ""
                        } transition-all duration-300`}
                      onClick={onSubmit}
                    >
                      {submitText}
                    </button>
                  )}
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
