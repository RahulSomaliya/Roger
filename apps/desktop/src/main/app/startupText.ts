/**
 * Words main shows outside the window: the About panel and the box shown when Roger cannot start.
 * No Electron import, so they test under Node; index.ts passes them to Electron.
 */

/** `app.setAboutPanelOptions`. Name, version and the copyright line: nothing else (sweep M9). */
export function aboutPanelOptions(version: string): {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  version: string;
} {
  // `version` is the build number line macOS appends in brackets; left equal it is dropped.
  return {
    applicationName: 'Roger',
    applicationVersion: version,
    version,
    copyright: '\u00a9 2026 Linkt',
  };
}

/**
 * The box's text when main() throws before the window opens: what happened, the one next step, then
 * the detail for the Roger team (sweep D2). A packaged app opened from Finder has no terminal.
 */
export function fatalStartText(detail: string): string {
  return [
    'Roger could not start. Quit it and open it again.',
    'If it keeps failing, send the text below to the Roger team.',
    '',
    detail,
  ].join('\n');
}
