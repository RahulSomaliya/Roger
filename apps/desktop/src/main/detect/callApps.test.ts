import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectCallApps, type MicUser, ROGER_BUNDLE_ID } from './callApps';

const NO_OWN: ReadonlySet<number> = new Set();

function user(fields: Partial<MicUser> & Pick<MicUser, 'pid'>): MicUser {
  return { bundleId: null, path: '/usr/bin/other', name: 'other', ...fields };
}

function app(pid: number, bundleId: string, name: string): MicUser {
  return { pid, bundleId, path: `/Applications/${name}.app`, name };
}

describe('detectCallApps', () => {
  it('names the call apps by their outermost app bundle', () => {
    const found = detectCallApps(
      [
        app(10, 'us.zoom.xos', 'zoom.us'),
        app(11, 'com.microsoft.teams2', 'Microsoft Teams'),
        app(12, 'com.tinyspeck.slackmacgap', 'Slack'),
        app(13, 'Cisco-Systems.Spark', 'Webex'),
        app(14, 'com.apple.FaceTime', 'FaceTime'),
      ],
      NO_OWN,
    );
    expect(found).toEqual([
      { bundleId: 'us.zoom.xos', name: 'Zoom', kind: 'native' },
      { bundleId: 'com.microsoft.teams2', name: 'Microsoft Teams', kind: 'native' },
      { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', kind: 'native' },
      { bundleId: 'Cisco-Systems.Spark', name: 'Webex', kind: 'native' },
      { bundleId: 'com.apple.FaceTime', name: 'FaceTime', kind: 'native' },
    ]);
  });

  it('marks browsers, whose mic use is a weaker signal (15 s, not 5 s)', () => {
    const found = detectCallApps(
      [
        app(20, 'com.google.Chrome', 'Google Chrome'),
        app(21, 'org.mozilla.firefox', 'Firefox'),
        app(22, 'com.microsoft.edgemac', 'Microsoft Edge'),
      ],
      NO_OWN,
    );
    expect(found.map((callApp) => [callApp.name, callApp.kind])).toEqual([
      ['Google Chrome', 'browser'],
      ['Firefox', 'browser'],
      ['Microsoft Edge', 'browser'],
    ]);
  });

  it('counts the FaceTime and phone call daemons, which have no app bundle around them', () => {
    const daemons = [
      user({ pid: 30, path: '/usr/libexec/avconferenced', name: 'avconferenced' }),
      user({
        pid: 31,
        path: '/System/Library/PrivateFrameworks/CallServices.framework/callservicesd',
        name: 'callservicesd',
      }),
    ];
    for (const daemon of daemons) {
      expect(detectCallApps([daemon], NO_OWN)).toEqual([
        { bundleId: 'com.apple.FaceTime', name: 'FaceTime or phone call', kind: 'native' },
      ]);
    }
  });

  it("reads Safari's mic use as WebKit's GPU process, by name and never by path", () => {
    const cryptex =
      '/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.GPU.xpc';
    const gpu = user({ pid: 40, path: cryptex, name: 'com.apple.WebKit.GPU' });
    const expected = [{ bundleId: 'com.apple.Safari', name: 'Safari', kind: 'browser' }];
    expect(detectCallApps([gpu], NO_OWN)).toEqual(expected);
    // The path `ps` shows (/System/Library/...) is not the one the helper reads: the name decides.
    const psPath = cryptex.replace('/System/Volumes/Preboot/Cryptexes/OS', '');
    expect(detectCallApps([{ ...gpu, path: psPath }], NO_OWN)).toEqual(expected);
    // A path that only looks like WebKit's, under another name, is not a call app.
    const lookalike = user({ pid: 41, path: cryptex, name: 'com.example.helper' });
    expect(detectCallApps([lookalike], NO_OWN)).toEqual([]);
  });

  it('ignores every other process that holds the mic', () => {
    const found = detectCallApps(
      [
        app(50, 'com.apple.VoiceMemos', 'Voice Memos'),
        app(51, 'com.apple.dt.Xcode', 'Xcode'),
        user({ pid: 52, path: '/usr/libexec/corespeechd', name: 'corespeechd' }),
      ],
      NO_OWN,
    );
    expect(found).toEqual([]);
  });

  it("never counts Roger's own processes, by pid or by bundle", () => {
    // Roger's renderer holds the mic for the whole recording; a browser pid of Roger's own would
    // otherwise offer a recording that is already running and keep auto-stop from ever firing.
    const found = detectCallApps(
      [
        app(60, 'com.google.Chrome', 'Google Chrome'),
        app(61, ROGER_BUNDLE_ID, 'Roger'),
        app(62, 'us.zoom.xos', 'zoom.us'),
      ],
      new Set([60]),
    );
    expect(found).toEqual([{ bundleId: 'us.zoom.xos', name: 'Zoom', kind: 'native' }]);
  });

  it('lists an app once, however many of its processes hold the mic', () => {
    const found = detectCallApps(
      [
        app(70, 'com.google.Chrome', 'Google Chrome'),
        app(71, 'com.google.Chrome', 'Google Chrome'),
        app(72, 'us.zoom.xos', 'zoom.us'),
        app(73, 'com.google.Chrome', 'Google Chrome'),
      ],
      NO_OWN,
    );
    expect(found.map((callApp) => callApp.name)).toEqual(['Google Chrome', 'Zoom']);
  });

  it('keeps the bundle id in step with the packaged app', () => {
    // ROGER_BUNDLE_ID is electron-builder.yml's appId (the helper's relaunch command names it too):
    // a renamed app that left this behind would count its own mic use as a call.
    const config = readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toMatch(new RegExp(`^appId: ${ROGER_BUNDLE_ID.replaceAll('.', '\\.')}$`, 'm'));
  });
});
