import { useEffect, useMemo, useRef } from "react";
import { formatSrtTimeRange } from "../utils/AudioUtils";
import { formatSrtChunks } from "../utils/SubtitleUtils";

export default function AudioPlayer(props: {
  audioUrl: string;
  mimeType: string;
  isTranscribing: boolean;
  transcriptChunks?: { text: string; timestamp: [number, number | null] }[];
  onSeekReady?: (seekTo: (time: number) => void) => void;
  onTimeUpdate?: (time: number) => void;
  playbackRate?: number;
}) {
  const audioPlayer = useRef<HTMLAudioElement>(null);
  const videoPlayer = useRef<HTMLVideoElement>(null);
  const audioSource = useRef<HTMLSourceElement>(null);

  // Updates src when url changes
  useEffect(() => {
    const mediaPlayer = audioPlayer.current ?? videoPlayer.current;
    if (mediaPlayer && audioSource.current) {
      audioSource.current.src = props.audioUrl;
      mediaPlayer.load();
      if (props.playbackRate) {
        mediaPlayer.playbackRate = props.playbackRate;
      }
    }
  }, [props.audioUrl, props.playbackRate]);

  // Updates playback rate
  useEffect(() => {
    const mediaPlayer = audioPlayer.current ?? videoPlayer.current;
    if (mediaPlayer && props.playbackRate) {
      mediaPlayer.playbackRate = props.playbackRate;
    }
  }, [props.playbackRate]);

  const { onTimeUpdate } = props;
  useEffect(() => {
    const handleTimeUpdate = (e: Event) => {
      const media = e.target as HTMLMediaElement;
      onTimeUpdate?.(media.currentTime);
    };

    const audio = audioPlayer.current;
    const video = videoPlayer.current;

    audio?.addEventListener('timeupdate', handleTimeUpdate);
    video?.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      audio?.removeEventListener('timeupdate', handleTimeUpdate);
      video?.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [onTimeUpdate]);

  const { onSeekReady } = props;
  useEffect(() => {
    onSeekReady?.((time) => {
      const mediaPlayer = audioPlayer.current ?? videoPlayer.current;
      if (!mediaPlayer) {
        return;
      }

      mediaPlayer.currentTime = time;
      void mediaPlayer.play().catch(() => undefined);
    });
  }, [onSeekReady]);

  const subtitleUrl = useMemo(() => {
    if (!props.mimeType.startsWith("video/") || props.isTranscribing || !props.transcriptChunks?.length) {
      return undefined;
    }

    const formattedChunks = formatSrtChunks(props.transcriptChunks);
    const cues = formattedChunks
      .map((chunk, index) => {
        const start = chunk.timestamp[0];
        const end = chunk.timestamp[1] ?? start;
        return `${index + 1}\n${formatSrtTimeRange(start, end).replace(/,/g, ".")}\n${chunk.text.trim()}`;
      })
      .join("\n\n");

    return URL.createObjectURL(new Blob([`WEBVTT\n\n${cues}\n`], { type: "text/vtt" }));
  }, [props.isTranscribing, props.mimeType, props.transcriptChunks]);

  useEffect(() => {
    return () => {
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }
    };
  }, [subtitleUrl]);

  return (
    <div className='flex relative z-10 p-4 w-full mt-1'>
      {props.mimeType.startsWith("video/") ? (
        <video
          ref={videoPlayer}
          controls
          className='w-full max-h-96 rounded-lg bg-black shadow-xl shadow-black/5 ring-1 ring-slate-700/10 dark:ring-slate-500/30'
        >
          <source ref={audioSource} type={props.mimeType}></source>
          {subtitleUrl && (
            <track
              kind='captions'
              label='Transcript'
              src={subtitleUrl}
              srcLang='en'
              default
            />
          )}
        </video>
      ) : (
        <audio
          ref={audioPlayer}
          controls
          className='w-full h-14 rounded-lg bg-white dark:bg-slate-700 shadow-xl shadow-black/5 ring-1 ring-slate-700/10 dark:ring-slate-500/30'
        >
          <source ref={audioSource} type={props.mimeType}></source>
        </audio>
      )}
    </div>
  );
}
