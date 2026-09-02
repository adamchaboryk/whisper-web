import { DetailedHTMLProps, InputHTMLAttributes } from "react";

export function UrlInput(
  props: DetailedHTMLProps<
    InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  >,
) {
  return (
    <div>
      <label htmlFor='url-input' className='form-label'>URL of audio file</label>
      <input
        {...props}
        id='url-input'
        type='url'
        className='url-input'
        placeholder={props.placeholder ?? 'www.example.com'}
        required
      />
    </div>
  );
}
