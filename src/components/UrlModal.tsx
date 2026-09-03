import React, { useState } from "react";
import Modal from "./modal/Modal";
import { UrlInput } from "./modal/UrlInput";

const PRIVATE_HOST_REGEX =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/i;

function isValidHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.origin !== window.location.origin) {
      const hostname = parsed.hostname.toLowerCase();
      if (PRIVATE_HOST_REGEX.test(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface UrlModalProps {
  show: boolean;
  onSubmit: (url: string) => void;
  onClose: () => void;
}

export default function UrlModal(props: UrlModalProps) {
  const [url, setUrl] = useState("");

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(event.target.value);
  };

  const trimmed = url.trim();
  const isValid = isValidHttpUrl(trimmed);

  const onSubmit = () => {
    if (isValid) {
      props.onSubmit(trimmed);
    }
  };

  return (
    <Modal
      show={props.show}
      title='From URL'
      content={
        <>
          <UrlInput onChange={onChange} value={url} placeholder='https://example.com/audio.mp3' />
          {trimmed.length > 0 && !isValid && (
            <p className='mt-2 text-xs text-amber-600 dark:text-amber-400'>
              Please enter a valid URL starting with http:// or https://
            </p>
          )}
        </>
      }
      onClose={props.onClose}
      submitText='Submit'
      submitEnabled={isValid}
      onSubmit={onSubmit}
    />
  );
}

