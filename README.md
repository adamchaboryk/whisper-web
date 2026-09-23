# Transcribe

This is a web application that allows you to transcribe sound and video files to text completely locally in your web browser.

## Acknowledgements
This repository is a fork of [PierreMesure/whisper-web](https://github.com/PierreMesure/whisper-web), which is also a fork of [Xenova/whisper-web](https://github.com/xenova/whisper-web).

Speaker diarization uses [PyAnnote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0) (MIT) and [WeSpeaker ResNet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM) (CC BY 4.0) through ONNX Community conversions and Transformers.js.

## Features

- Up-to-date dependencies, including transformers.js
- Added NVIDIA's Parakeet model as default model.
- Export to SRT, TXT, and Copy to Clipboard.
- Summary generation feature powered by Summarizer API.
- Ability to edit transcript.
- Ability to upload and preview videos.
- Find and replace utility.
- Text replacement dictionary.