import { describe, expect, it } from 'vitest';
import { featureChannels } from '../src/shared/ipc';
import {
  fromApi,
  installPreviewControl,
  PREFS_GET_ALL_CHANNEL,
  PreviewHub,
  reachesApi,
} from './control';
import { FakeHub } from './fakes/hub';
import { parsePreviewQuery, previewSearch } from './scenarios';

/** A frame in Node: the next macrotask, after every pending microtask. */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('the preview query', () => {
  it('reads the scenario and the forced theme, and writes them back the same way', () => {
    expect(parsePreviewQuery('?scenario=live-call&theme=dark')).toEqual({
      scenario: 'live-call',
      theme: 'dark',
    });
    expect(parsePreviewQuery('')).toEqual({ scenario: 'empty-mac', theme: null });
    for (const query of [
      { scenario: 'api-offline', theme: 'light' },
      { scenario: 'past-meeting', theme: null },
    ] as const) {
      expect(parsePreviewQuery(previewSearch(query))).toEqual(query);
    }
  });

  it('refuses an unknown scenario or theme, naming the valid ones', () => {
    expect(() => parsePreviewQuery('?scenario=demo')).toThrow(
      'Unknown preview scenario "demo": use one of empty-mac, past-meeting, live-call, api-offline',
    );
    expect(() => parsePreviewQuery('?theme=sepia')).toThrow(
      'Unknown preview theme "sepia": use light or dark, or leave it out to follow the system',
    );
  });
});

describe('PreviewHub', () => {
  it('fails the next request with the error main threw, as ipcRenderer.invoke reports it', async () => {
    const hub = new PreviewHub();
    hub.failNextRequest('Term is too long', 'ApiError');
    await expect(hub.request('vocabulary:set', () => 'saved')).rejects.toThrow(
      "Error invoking remote method 'vocabulary:set': ApiError: Term is too long",
    );
    hub.failNextRequest('disk full');
    await expect(hub.request('capture:start', () => 'started')).rejects.toThrow(
      "Error invoking remote method 'capture:start': Error: disk full",
    );
    await expect(hub.request('capture:start', () => 'started')).resolves.toBe('started');
  });

  it('fails only API requests while the API is offline, until it is back', async () => {
    const hub = new PreviewHub();
    hub.setApiOffline(true);
    await expect(hub.request('chat:send', () => 'answer')).rejects.toThrow(
      "Error invoking remote method 'chat:send': ApiError: chat:send failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    await expect(hub.request('capture:get-status', () => 'idle')).resolves.toBe('idle');
    hub.setApiOffline(false);
    await expect(hub.request('chat:send', () => 'answer')).resolves.toBe('answer');
  });

  // The seam with M4-T13's notes fake: main keeps the notes themselves in notes.sqlite, but the
  // template list the "Which kind of call was this?" card shows comes only from the API.
  it('fails an answer a fake marks as coming from the API while offline, naming its route', async () => {
    const hub = new PreviewHub();
    const templates = fromApi('GET /v1/note-templates', () => ['general', 'standup']);
    await expect(hub.request('notes:templates', templates)).resolves.toEqual([
      'general',
      'standup',
    ]);
    hub.setApiOffline(true);
    await expect(hub.request('notes:templates', templates)).rejects.toThrow(
      "Error invoking remote method 'notes:templates': ApiError: GET /v1/note-templates failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    await expect(hub.request('notes:save', () => 'saved')).resolves.toBe('saved');
    // Outside the preview (a fake's own tests run on FakeHub), the mark changes nothing.
    await expect(new FakeHub().request('notes:templates', templates)).resolves.toEqual([
      'general',
      'standup',
    ]);
  });

  // The seam with M3-T8 and M4-T13: the offline scenario knows their channels by name only.
  it('treats every vocabulary and chat channel as an API request', () => {
    expect(reachesApi('vocabulary:get')).toBe(true);
    expect(reachesApi('notes:save')).toBe(false);
    const channels = [
      ...Object.values<string>(featureChannels.vocabulary),
      ...Object.values<string>(featureChannels.chat),
    ];
    expect(channels.filter((channel) => !reachesApi(channel))).toEqual([]);
  });

  it('answers prefs:get-all with the forced theme, as if preferences.json held it', async () => {
    const hub = new PreviewHub({ forcedTheme: 'dark' });
    await expect(
      hub.request(PREFS_GET_ALL_CHANNEL, () => ({ theme: 'system', 'notice.enabled': true })),
    ).resolves.toEqual({ theme: 'dark', 'notice.enabled': true });
    await expect(hub.request('prefs:set', () => ({ theme: 'system' }))).resolves.toEqual({
      theme: 'system',
    });
    await expect(new PreviewHub().request(PREFS_GET_ALL_CHANNEL, () => ({}))).resolves.toEqual({});
  });

  // The seam with M4-S2: once its prefs channels exist, the forced theme must ride on one of them.
  it('forces the theme on a channel of the prefs feature', () => {
    const prefs = Object.values<string>(featureChannels.prefs);
    if (prefs.length > 0) expect(prefs).toContain(PREFS_GET_ALL_CHANNEL);
    expect(PREFS_GET_ALL_CHANNEL).toBe('prefs:get-all');
  });

  it('settles once no request is in flight', async () => {
    const hub = new PreviewHub({ nextFrame: nextTask });
    let answered = false;
    void hub.request('capture:get-status', () => {
      answered = true;
    });
    await hub.settled();
    expect(answered).toBe(true);
  });

  // The app subscribes in effects that can run a frame after it renders, before any request: a
  // scenario started then sends its lines to nobody (the live call's transcript came out empty).
  it('does not settle while the page is still subscribing', async () => {
    let frames = 0;
    const subscribed: string[] = [];
    const hub: PreviewHub = new PreviewHub({
      nextFrame: () => {
        frames += 1;
        if (frames === 2) {
          hub.on('transcript:segment', () => subscribed.push('late'));
        }
        return nextTask();
      },
    });
    await hub.settled();
    hub.emit('transcript:segment', 'line');
    expect(subscribed).toEqual(['late']);
    expect(frames).toBe(4);
  });

  it('refuses to settle while requests keep starting', async () => {
    // A page that asks main for something on every frame.
    const hub: PreviewHub = new PreviewHub({
      nextFrame: () => {
        void hub.request('capture:get-status', () => 'idle');
        return nextTask();
      },
    });
    await expect(hub.settled()).rejects.toThrow('kept starting for 100 frames');
  });
});

describe('window.__rogerPreview', () => {
  it('pushes events, fails requests and stops the scenario for a script', async () => {
    const hub = new PreviewHub();
    const target: Pick<Window, '__rogerPreview'> = {};
    let stopped = 0;
    installPreviewControl(target, {
      hub,
      scenario: 'live-call',
      stop: () => {
        stopped += 1;
      },
    });
    const control = target.__rogerPreview;
    if (control === undefined) throw new Error('installPreviewControl set nothing');
    expect(control.scenario).toBe('live-call');

    const seen: unknown[] = [];
    hub.on('transcript:segment', (payload: unknown) => seen.push(payload));
    control.emit('transcript:segment', { id: 'line' });
    expect(seen).toEqual([{ id: 'line' }]);

    control.failNextRequest('offline', 'ApiError');
    await expect(hub.request('vocabulary:get', () => [])).rejects.toThrow('ApiError: offline');

    control.setApiOffline(true);
    await expect(hub.request('vocabulary:get', () => [])).rejects.toThrow('ApiError');

    control.stopScenario();
    expect(stopped).toBe(1);
  });
});
