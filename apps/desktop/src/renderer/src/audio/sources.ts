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

/** Turn a getUserMedia failure into words a person can act on. */
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
