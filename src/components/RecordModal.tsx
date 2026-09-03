import { useState } from "react";
import Modal from "./modal/Modal";
import AudioRecorder from "./AudioRecorder";

export interface RecordModalProps {
  show: boolean;
  onProgress: (data: Blob | undefined) => void;
  onSubmit: (data: Blob | undefined) => void;
  onClose: () => void;
}

export default function RecordModal(props: RecordModalProps) {
  const [audioBlob, setAudioBlob] = useState<Blob>();

  const onRecordingComplete = (blob: Blob) => {
    setAudioBlob(blob);
  };

  const onSubmit = () => {
    props.onSubmit(audioBlob);
    setAudioBlob(undefined);
  };

  const onClose = () => {
    props.onClose();
    setAudioBlob(undefined);
  };

  return (
    <Modal
      show={props.show}
      title='Record'
      content={
        <>
          Record audio using your microphone. Please make sure you have permission from everyone involved before you start recording.
          <AudioRecorder
            onRecordingProgress={(blob) => {
              props.onProgress(blob);
            }}
            onRecordingComplete={onRecordingComplete}
          />
        </>
      }
      onClose={onClose}
      submitText='Submit'
      submitEnabled={audioBlob !== undefined}
      onSubmit={onSubmit}
    />
  );
}

