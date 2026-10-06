import { describe, expect, it, vi } from 'vitest';
import type { NoteDoc } from '../../shared/notes';
import { ApiError } from './http';
import { NotesClient } from './notesClient';

const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const RUN = '7f3c9d1e-2a4b-4c6d-8e0f-1a2b3c4d5e6f';
const SEGMENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const QUESTION = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ANSWER = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';

const userDoc: NoteDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship beta Friday' }] }],
};

const aiDoc: NoteDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Beta ships Friday ' },
                {
                  type: 'citation',
                  attrs: { segmentIds: [SEGMENT], startMs: 192000, label: '03:12', support: 'ok' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const userNoteWire = {
  kind: 'user',
  doc: userDoc,
  version: 3,
  template_id: null,
  last_run_id: null,
  generated_version: null,
  updated_at: '2026-10-06T10:00:00Z',
};

const aiNoteWire = {
  kind: 'ai',
  doc: aiDoc,
  version: 2,
  template_id: 'standup',
  last_run_id: RUN,
  generated_version: 1,
  updated_at: '2026-10-06T10:05:00Z',
};

const runWire = {
  id: RUN,
  meeting_id: MEETING,
  kind: 'notes',
  status: 'succeeded',
  model: 'xiaomi/mimo-v2.6-pro',
  template_id: 'standup',
  error_code: null,
  error: null,
  dropped: [{ text: 'Revenue doubled', reason: 'no_refs' }],
  flagged_count: 1,
  from_notes_count: 2,
  input_tokens: 15000,
  output_tokens: 2000,
  cached_tokens: null,
  // Postgres `numeric` reaches JSON as a string when the API serialises it as a Decimal.
  cost_usd: '0.0083',
  started_at: '2026-10-06T10:04:00Z',
  finished_at: '2026-10-06T10:05:00Z',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch): NotesClient {
  return new NotesClient({ baseUrl: 'http://api.test', token: 'secret', fetchImpl });
}

function answering(status: number, body: unknown) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(jsonResponse(status, body)));
}

/** The client always sends JSON strings; anything else is a bug the test should surface. */
function bodyJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('expected a string body');
  return JSON.parse(init.body);
}

describe('NotesClient: templates', () => {
  it('lists the templates with the bearer token', async () => {
    const template = {
      id: 'standup',
      name: 'Standup',
      description: 'Progress, plans and blockers.',
      sections: [{ heading: 'Done', guidance: 'What each person finished.' }],
    };
    const fetchImpl = answering(200, { items: [template] });

    await expect(client(fetchImpl).listTemplates()).resolves.toEqual([template]);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://api.test/v1/note-templates');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret');
  });
});

describe('NotesClient: notes', () => {
  it("reads a meeting's notes and maps them to camelCase", async () => {
    const fetchImpl = answering(200, { user: userNoteWire, ai: aiNoteWire });

    await expect(client(fetchImpl).getNotes(MEETING)).resolves.toEqual({
      user: {
        kind: 'user',
        doc: userDoc,
        version: 3,
        templateId: null,
        lastRunId: null,
        generatedVersion: null,
        updatedAt: '2026-10-06T10:00:00Z',
      },
      ai: {
        kind: 'ai',
        doc: aiDoc,
        version: 2,
        templateId: 'standup',
        lastRunId: RUN,
        generatedVersion: 1,
        updatedAt: '2026-10-06T10:05:00Z',
      },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`http://api.test/v1/meetings/${MEETING}/notes`);
    expect(init?.method).toBe('GET');
  });

  it('keeps a missing doc as null', async () => {
    const fetchImpl = answering(200, { user: null, ai: null });
    await expect(client(fetchImpl).getNotes(MEETING)).resolves.toEqual({ user: null, ai: null });
  });

  it('puts a note with its base version and revision id, in snake_case', async () => {
    const fetchImpl = answering(200, { ...userNoteWire, version: 4 });
    const revisionId = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';

    const note = await client(fetchImpl).putNote(MEETING, 'user', {
      doc: userDoc,
      baseVersion: 3,
      revisionId,
    });

    expect(note).toMatchObject({ kind: 'user', version: 4, doc: userDoc });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`http://api.test/v1/meetings/${MEETING}/notes/user`);
    expect(init?.method).toBe('PUT');
    expect(bodyJson(init)).toEqual({ doc: userDoc, base_version: 3, revision_id: revisionId });
  });

  it('maps a stale base version to a 409 conflict and an unknown meeting to a 404', async () => {
    const stale = answering(409, {
      error: { code: 'conflict', message: 'Note version 4 is stored' },
    });
    const putError = await client(stale)
      .putNote(MEETING, 'ai', { doc: aiDoc, baseVersion: 1, revisionId: RUN })
      .catch((e: unknown) => e);
    expect(putError).toBeInstanceOf(ApiError);
    expect(putError).toMatchObject({ status: 409, code: 'conflict' });

    const missing = answering(404, {
      error: { code: 'not_found', message: `Meeting ${MEETING} not found` },
    });
    const getError = await client(missing)
      .getNotes(MEETING)
      .catch((e: unknown) => e);
    expect(getError).toBeInstanceOf(ApiError);
    expect((getError as ApiError).isNotFound).toBe(true);
  });

  it('refuses a doc from the API that the desktop would not store, naming the rule', async () => {
    const notADoc = answering(200, {
      user: { ...userNoteWire, doc: { type: 'paragraph' } },
      ai: null,
    });
    await expect(client(notADoc).getNotes(MEETING)).rejects.toMatchObject({
      code: 'invalid_response',
      message: `GET /v1/meetings/${MEETING}/notes returned a user note doc that is not a TipTap doc`,
    });

    // JSON.parse keeps a "__proto__" key as an own key, as a doc from the wire would carry it.
    const poisoned = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `{"kind":"user","doc":{"type":"doc","__proto__":{"x":1}},"version":4,"template_id":null,` +
            `"last_run_id":null,"generated_version":null,"updated_at":"2026-10-06T10:00:00Z"}`,
        ),
      );
    await expect(
      client(poisoned).putNote(MEETING, 'user', { doc: userDoc, baseVersion: 3, revisionId: RUN }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses a note of the wrong kind', async () => {
    const swapped = answering(200, { user: aiNoteWire, ai: null });
    await expect(client(swapped).getNotes(MEETING)).rejects.toMatchObject({
      code: 'invalid_response',
      message: `GET /v1/meetings/${MEETING}/notes returned a note of kind "ai" where the user note belongs`,
    });
  });
});

describe('NotesClient: runs', () => {
  it("lists a meeting's runs by kind and limit, without their docs", async () => {
    const fetchImpl = answering(200, { items: [runWire] });

    const runs = await client(fetchImpl).listRuns(MEETING, { kind: 'notes', limit: 10 });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `http://api.test/v1/meetings/${MEETING}/runs?kind=notes&limit=10`,
    );
    expect(runs).toEqual([
      {
        id: RUN,
        meetingId: MEETING,
        kind: 'notes',
        status: 'succeeded',
        model: 'xiaomi/mimo-v2.6-pro',
        templateId: 'standup',
        errorCode: null,
        error: null,
        dropped: [{ text: 'Revenue doubled', reason: 'no_refs' }],
        flaggedCount: 1,
        fromNotesCount: 2,
        inputTokens: 15000,
        outputTokens: 2000,
        cachedTokens: null,
        costUsd: 0.0083,
        startedAt: '2026-10-06T10:04:00Z',
        finishedAt: '2026-10-06T10:05:00Z',
      },
    ]);
  });

  it('asks for every run when no filter is given', async () => {
    const fetchImpl = answering(200, { items: [] });
    await client(fetchImpl).listRuns(MEETING);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`http://api.test/v1/meetings/${MEETING}/runs`);
  });

  it('reads one run with its output and replaced docs', async () => {
    const fetchImpl = answering(200, { ...runWire, output_doc: aiDoc, replaced_doc: null });

    const run = await client(fetchImpl).getRun(MEETING, RUN);

    expect(fetchImpl.mock.calls[0]![0]).toBe(`http://api.test/v1/meetings/${MEETING}/runs/${RUN}`);
    expect(run).toMatchObject({ id: RUN, outputDoc: aiDoc, replacedDoc: null, costUsd: 0.0083 });
  });

  it('keeps a missing cost and missing dropped lines apart from zero', async () => {
    const fetchImpl = answering(200, {
      ...runWire,
      status: 'failed',
      error_code: 'llm_provider_error',
      error: 'The notes model is unavailable.',
      dropped: null,
      cost_usd: null,
      output_doc: null,
      replaced_doc: null,
    });

    const run = await client(fetchImpl).getRun(MEETING, RUN);

    expect(run).toMatchObject({
      status: 'failed',
      errorCode: 'llm_provider_error',
      dropped: [],
      costUsd: null,
      outputDoc: null,
    });
  });

  it('refuses a cost that is not a number, and a run read without its docs', async () => {
    // A blank string included: `Number('')` is 0, and an unknown cost must never read as free.
    for (const cost of ['about a cent', ' ']) {
      const badCost = answering(200, { items: [{ ...runWire, cost_usd: cost }] });
      await expect(client(badCost).listRuns(MEETING)).rejects.toMatchObject({
        code: 'invalid_response',
        message: `GET /v1/meetings/${MEETING}/runs returned a cost that is not a number`,
      });
    }

    const noDocs = answering(200, runWire);
    await expect(client(noDocs).getRun(MEETING, RUN)).rejects.toMatchObject({
      code: 'invalid_response',
      message: `GET /v1/meetings/${MEETING}/runs/${RUN} returned no output_doc`,
    });
  });

  it('cancels a run and maps a foreign run id to a 404', async () => {
    const fetchImpl = answering(200, { ...runWire, status: 'cancelled', error_code: 'cancelled' });

    await expect(client(fetchImpl).cancelRun(MEETING, RUN)).resolves.toMatchObject({
      id: RUN,
      status: 'cancelled',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`http://api.test/v1/meetings/${MEETING}/runs/${RUN}/cancel`);
    expect(init?.method).toBe('POST');

    const foreign = answering(404, {
      error: { code: 'not_found', message: `Run ${RUN} not found` },
    });
    await expect(client(foreign).cancelRun(MEETING, RUN)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('NotesClient: chat', () => {
  it('reads the chat thread oldest first, with citations in camelCase', async () => {
    const fetchImpl = answering(200, {
      items: [
        {
          id: QUESTION,
          role: 'user',
          text: 'When does beta ship?',
          citations: null,
          reply_to: null,
          run_id: null,
          status: 'complete',
          created_at: '2026-10-06T10:10:00Z',
        },
        {
          id: ANSWER,
          role: 'assistant',
          text: 'Friday [L12].',
          citations: [{ ref: 'L12', segment_id: SEGMENT, start_ms: 192000 }],
          reply_to: QUESTION,
          run_id: RUN,
          status: 'complete',
          created_at: '2026-10-06T10:10:02Z',
        },
      ],
    });

    const thread = await client(fetchImpl).getChatThread(MEETING, { limit: 50 });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `http://api.test/v1/meetings/${MEETING}/chat?limit=50`,
    );
    expect(thread).toEqual({
      meetingId: MEETING,
      messages: [
        {
          id: QUESTION,
          role: 'user',
          text: 'When does beta ship?',
          citations: [],
          replyTo: null,
          runId: null,
          status: 'complete',
          createdAt: '2026-10-06T10:10:00Z',
        },
        {
          id: ANSWER,
          role: 'assistant',
          text: 'Friday [L12].',
          citations: [{ ref: 'L12', segmentId: SEGMENT, startMs: 192000 }],
          replyTo: QUESTION,
          runId: RUN,
          status: 'complete',
          createdAt: '2026-10-06T10:10:02Z',
        },
      ],
    });
  });

  it('maps a chat of a meeting in another workspace to a 404', async () => {
    const fetchImpl = answering(404, {
      error: { code: 'not_found', message: `Meeting ${MEETING} not found` },
    });
    await expect(client(fetchImpl).getChatThread(MEETING)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`http://api.test/v1/meetings/${MEETING}/chat`);
  });
});
