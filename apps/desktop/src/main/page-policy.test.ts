import { describe, expect, it } from 'vitest';
import { isAppPageUrl, isPermissionAllowed, type AppPage } from './page-policy';

const RENDERER_DIR = '/Applications/Roger.app/Contents/Resources/app.asar/out/renderer';
const PAGE_URL = `file://${RENDERER_DIR}/index.html`;
const packaged: AppPage = { devServerUrl: null, rendererDir: RENDERER_DIR };
const dev: AppPage = { devServerUrl: 'http://localhost:5173/', rendererDir: RENDERER_DIR };

describe('isAppPageUrl', () => {
  it('accepts the bundled page when packaged, and nothing outside its folder', () => {
    expect(isAppPageUrl(PAGE_URL, packaged)).toBe(true);
    expect(isAppPageUrl(`file://${RENDERER_DIR}/index.html#/x`, packaged)).toBe(true);
    expect(isAppPageUrl('file:///Users/someone/Downloads/evil.html', packaged)).toBe(false);
    expect(isAppPageUrl(`file://${RENDERER_DIR}-evil/index.html`, packaged)).toBe(false);
    expect(isAppPageUrl(`file://${RENDERER_DIR}/../../../evil.html`, packaged)).toBe(false);
    expect(isAppPageUrl('http://localhost:5173/', packaged)).toBe(false);
  });

  it('accepts only the dev server origin in development', () => {
    expect(isAppPageUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isAppPageUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isAppPageUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppPageUrl(PAGE_URL, dev)).toBe(false);
  });

  it('rejects foreign origins and junk', () => {
    expect(isAppPageUrl('https://evil.example/', packaged)).toBe(false);
    expect(isAppPageUrl('https://evil.example/', dev)).toBe(false);
    expect(isAppPageUrl('not a url', packaged)).toBe(false);
    expect(isAppPageUrl('', packaged)).toBe(false);
  });
});

describe('isPermissionAllowed', () => {
  it('allows the microphone for the app page', () => {
    const mic = { permission: 'media', url: PAGE_URL, mediaTypes: ['audio'] };
    expect(isPermissionAllowed(mic, packaged)).toBe(true);
    expect(isPermissionAllowed({ ...mic, url: 'http://localhost:5173/' }, dev)).toBe(true);
  });

  it('allows desktop capture (system audio with its required video track) for the app page', () => {
    // Electron 44 lists only real devices: chromeMediaSource "desktop" arrives with no types.
    const desktop = { permission: 'media', url: PAGE_URL, mediaTypes: [] };
    expect(isPermissionAllowed(desktop, packaged)).toBe(true);
  });

  it('denies the camera, which capture never asks for, even to the app page', () => {
    for (const mediaTypes of [['video'], ['audio', 'video']]) {
      expect(
        isPermissionAllowed({ permission: 'media', url: PAGE_URL, mediaTypes }, packaged),
      ).toBe(false);
    }
    const cameraCheck = { permission: 'media', url: PAGE_URL, mediaTypes: ['video'] };
    expect(isPermissionAllowed(cameraCheck, packaged)).toBe(false);
  });

  it('allows media permission checks, which Electron may type as unknown', () => {
    const check = { permission: 'media', url: PAGE_URL, mediaTypes: ['unknown'] };
    expect(isPermissionAllowed(check, packaged)).toBe(true);
  });

  it('denies every other permission, even for the app page', () => {
    // Electron 45 sends desktop capture as display-capture: see page-policy.ts before upgrading.
    for (const permission of [
      'display-capture',
      'notifications',
      'geolocation',
      'clipboard-read',
      'clipboard-sanitized-write',
      'openExternal',
      'fullscreen',
      'speaker-selection',
      'midi',
      'unknown',
    ]) {
      expect(isPermissionAllowed({ permission, url: PAGE_URL, mediaTypes: [] }, packaged)).toBe(
        false,
      );
    }
  });

  it('denies media to a foreign origin or an unrecognised media type', () => {
    const foreign = { permission: 'media', url: 'https://evil.example/', mediaTypes: ['audio'] };
    expect(isPermissionAllowed(foreign, packaged)).toBe(false);
    expect(isPermissionAllowed(foreign, dev)).toBe(false);
    expect(
      isPermissionAllowed({ permission: 'media', url: PAGE_URL, mediaTypes: ['screen'] }, packaged),
    ).toBe(false);
  });
});
