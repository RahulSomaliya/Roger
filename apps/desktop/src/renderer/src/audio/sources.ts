/** Opening the two MediaStreams. Nothing else in the renderer talks to getUserMedia. */

/** The default input: no device id, so a reopen after a device change follows the default. */
export function openMicrophoneStream(mediaDevices: MediaDevices): Promise<MediaStream> {
  // Raw audio: Chromium's processing adds latency and distorts speech. Echo handling is M2's job.
  return mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  });
}

/**
 * System audio through Chromium's desktop capture. On macOS 14.2+ Chromium uses a Core Audio tap
 * for this; the video track is a required part of the request and is stopped immediately.
 */
export async function openSystemAudioStream(
  sourceId: string,
  mediaDevices: MediaDevices,
): Promise<MediaStream> {
  // `mandatory` / chromeMediaSource are Chromium extensions absent from lib.dom.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
  } as unknown as MediaStreamConstraints;
  const stream = await mediaDevices.getUserMedia(constraints);
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error('Chromium returned no system audio track');
  }
  return stream;
}

/**
 * Why the microphone did not start, as the banner says it: what happened, then what to do, and
 * never the browser's own text (the banner once read "Microphone: NotSupportedError: ..."; docs/
 * design.md, Words from main). The raw text is describeMediaError's, for main's Details row and
 * the page's reportError.
 */
export function describeMicrophoneFailure(error: unknown): string {
  const name = error instanceof DOMException ? error.name : null;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Roger may not use the microphone. Allow Roger under System Settings, Privacy & Security, Microphone, then Start notes again.';
    case 'NotFoundError':
      return 'Roger found no microphone. Connect one, then Start notes again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone could not start; another app may be using it. Close that app, then Start notes again.';
    case 'OverconstrainedError':
      return 'The microphone does not take the sound settings Roger asks for. Choose another input under System Settings, Sound, then Start notes again.';
    default:
      return 'The microphone could not start. Start notes again; if it keeps happening, tell the Roger team.';
  }
}

/**
 * A getUserMedia failure in a few words, the browser's own text included for an unknown one:
 * what main keeps as the source's message (Details) when the renderer reports it. Never the
 * banner's words: those are describeMicrophoneFailure's.
 */
export function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return 'Permission denied. Allow Roger in System Settings → Privacy & Security.';
      case 'NotFoundError':
        return 'No audio device found.';
      case 'NotReadableError':
        return 'The audio device could not be started. Is another app using it?';
      case 'OverconstrainedError':
        return 'The audio device does not support the requested settings.';
      default:
        return `${error.name}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
