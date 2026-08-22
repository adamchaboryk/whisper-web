import { DetailedHTMLProps, InputHTMLAttributes } from "react";

export function UrlInput(
  props: DetailedHTMLProps<
    InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  >,
) {
  return (
    <div>
      <label htmlFor='url-input'>URL of audio file</label>
      <input
        {...props}
        id='url-input'
        type='url'
        className='my-2 bg-gray-50 dark:bg-slate-700 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:placeholder-gray-400 dark:focus:ring-blue-500 dark:focus:border-blue-500'
        placeholder={props.placeholder ?? 'www.example.com'}
        required
      />
    </div>
  );
}
