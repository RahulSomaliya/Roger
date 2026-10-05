import { systemPreferences } from 'electron';

export type MicrophoneAccess = 'granted' | 'denied';

/**
 * macOS needs the main process to ask for microphone access before `getUserMedia` in the renderer
 * will work under the hardened runtime. Other platforms have no such gate.
 */
export async function ensureMicrophoneAccess(
  platform: NodeJS.Platform = process.platform,
): Promise<MicrophoneAccess> {
  if (platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') {
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  }
  return 'denied';
}
