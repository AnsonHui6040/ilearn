import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';
import { backoffMs, GIVE_UP_MS, makeEvent, Outbox } from '../src/events/outbox.js';
import type { IlearnEvent } from '../src/types.js';

const quiet = { start: '00:00', end: '07:00' };
const schema = JSON.parse(readFileSync(join(process.cwd(), 'schema', 'event.v1.json'), 'utf8')) as object;

function ev(over: Partial<Parameters<typeof makeEvent>[0]> = {}): IlearnEvent {
  return makeEvent({
    type: 'announcement.new',
    delivery: 'push',
    categories: [],
    matched_rules: [],
    course: { id: '1', name: '資料結構', semester: '115-1' },
    item: { id: '88001', kind: 'announcement', title: '改教室', due_at: null, url: null },
    summary: null,
    dedupe_key: 'announcement.new:88001',
    detectedAt: new Date('2026-10-22T04:00:00Z'), // 12:00 Taipei
    quiet,
    ...over,
  });
}

let root: string;
let box: Outbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outbox-'));
  box = new Outbox(root);
});

describe('makeEvent', () => {
  it('uses deliverAfter for night push', () => {
    const e = ev({ detectedAt: new Date('2026-10-22T16:30:00Z') }); // 00:30 Taipei
    expect(e.detected_at).toBe('2026-10-23T00:30:00+08:00');
    expect(e.deliver_after).toBe('2026-10-23T07:00:00+08:00');
    expect(e.schema).toBe('thu-ilearn.event.v1');
  });
  it('record is not delayed', () => {
    const e = ev({ delivery: 'record', detectedAt: new Date('2026-10-22T18:00:00Z') });
    expect(e.deliver_after).toBe(e.detected_at);
  });
});

describe('Outbox', () => {
  it('copies schema and validates written lines', () => {
    expect(existsSync(join(root, 'outbox', 'schema', 'event.v1.json'))).toBe(true);
    box.append(ev());
    box.append(ev({ type: 'assignment.due_reminder', offset: 'P1D', dedupe_key: 'r:1', item: null, course: null }));
    const dir = join(root, 'outbox', 'events');
    const files = readdirSync(dir);
    expect(files).toEqual(['2026-10-22.jsonl']);
    const validate = new Ajv({ strict: false }).compile(schema);
    const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(validate(JSON.parse(l)), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('file name uses detected_at Taipei date', () => {
    box.append(ev({ detectedAt: new Date('2026-10-22T17:00:00Z') })); // 10-23 01:00 Taipei
    expect(readdirSync(join(root, 'outbox', 'events'))).toEqual(['2026-10-23.jsonl']);
  });

  it('dedupes by dedupe_key, persists across instances', () => {
    expect(box.append(ev())).toBe(true);
    expect(box.append(ev())).toBe(false);
    expect(new Outbox(root).append(ev())).toBe(false);
    expect(box.read()).toHaveLength(1);
  });

  it('reload events with different reload_id are allowed, same batch not repeated', () => {
    const r = (id: string) => ev({ reason: 'reload', reload_id: id });
    expect(box.append(ev())).toBe(true);
    expect(box.append(r('a'))).toBe(true);
    expect(box.append(r('a'))).toBe(false);
    expect(box.append(r('b'))).toBe(true);
  });

  it('read filters by deliverableAt, type, since', () => {
    const night = ev({ detectedAt: new Date('2026-10-22T16:30:00Z'), dedupe_key: 'n' });
    box.append(night);
    box.append(ev({ type: 'exam.new', dedupe_key: 'x' }));
    const noon = new Date('2026-10-22T10:00:00Z');
    expect(box.read({ deliverableAt: noon }).map((e) => e.dedupe_key)).toEqual(['x']);
    expect(box.read({ deliverableAt: new Date('2026-10-22T23:00:00Z') })).toHaveLength(2);
    expect(box.read({ type: 'exam.new' })).toHaveLength(1);
    expect(box.read({ since: '2026-10-22T20:00:00+08:00' })).toHaveLength(1);
  });

  it('per-agent cursor, forward only', () => {
    const a = ev({ dedupe_key: 'a', detectedAt: new Date('2026-10-22T04:00:00Z') });
    const b = ev({ dedupe_key: 'b', detectedAt: new Date('2026-10-22T04:01:00Z') });
    box.append(a);
    box.append(b);
    box.ack('A', a.event_id);
    expect(box.read({ agent: 'A' }).map((e) => e.dedupe_key)).toEqual(['b']);
    expect(box.read({ agent: 'B' })).toHaveLength(2);
    box.ack('A', b.event_id);
    box.ack('A', a.event_id);
    expect(box.read({ agent: 'A' })).toHaveLength(0);
    const cur = JSON.parse(readFileSync(join(root, 'outbox', 'cursors', 'A.json'), 'utf8')) as { last_event_id: string };
    expect(cur.last_event_id).toBe(b.event_id);
  });

  it('rejects bad agent names', () => {
    expect(() => box.ack('../x', 'a')).toThrow();
    expect(() => box.read({ agent: 'a/b' })).toThrow();
    expect(() => box.ack('', 'a')).toThrow();
  });

  it('hook bookkeeping', () => {
    const push = ev({ dedupe_key: 'p' });
    const rec = ev({ dedupe_key: 'r', delivery: 'record' });
    const later = ev({ dedupe_key: 'l', detectedAt: new Date('2026-10-22T16:30:00Z') });
    [push, rec, later].forEach((e) => box.append(e));
    const now = new Date('2026-10-22T10:00:00Z');
    expect(box.pendingHooks('cli', now).map((e) => e.dedupe_key)).toEqual(['p']);
    const file = join(root, 'outbox', 'events', '2026-10-22.jsonl');
    const before = readFileSync(file, 'utf8').split('\n').length;
    box.markHook('cli', push.event_id, false, now, 'exit code 1');
    expect(readFileSync(file, 'utf8').split('\n').length).toBe(before);
    expect(box.pendingHooks('webhook', now).map((e) => e.dedupe_key)).toEqual(['p']);
    box.markHook('cli', push.event_id, true, new Date(now.getTime() + 5 * 60_000));
    expect(box.pendingHooks('cli', new Date(now.getTime() + 10 * 60_000))).toEqual([]);
    expect(new Outbox(root).pendingHooks('cli', new Date(now.getTime() + 10 * 60_000))).toEqual([]);
    expect(box.pendingHooks('cli', new Date('2026-10-23T00:00:00Z')).map((e) => e.dedupe_key)).toEqual(['l']);
  });

  it('hook retries back off 5, 10, 20, 40, then every 60 minutes', () => {
    const push = ev({ dedupe_key: 'p' });
    box.append(push);
    const t0 = new Date('2026-10-22T04:00:00Z').getTime();
    const at = (min: number): Date => new Date(t0 + min * 60_000);
    const due = (min: number): boolean => box.pendingHooks('cli', at(min)).length === 1;
    let last = 0;
    for (const wait of [5, 10, 20, 40, 60, 60]) {
      box.markHook('cli', push.event_id, false, at(last));
      expect(due(last + wait - 1)).toBe(false);
      expect(due(last + wait)).toBe(true);
      last += wait;
    }
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(9)).toBe(60 * 60_000);
  });

  it('gives up 24 hours after deliver_after but keeps the event in the outbox', () => {
    const push = ev({ dedupe_key: 'p' });
    box.append(push);
    const t0 = Date.parse(push.deliver_after);
    box.markHook('cli', push.event_id, false, new Date(t0), 'exit code 1');
    expect(box.hookStats('cli', new Date(t0 + 60 * 60_000))).toEqual({ retrying: 1, gave_up: 0, last_error: 'exit code 1' });
    const late = new Date(t0 + GIVE_UP_MS + 60_000);
    expect(box.pendingHooks('cli', late)).toEqual([]);
    expect(box.hookStats('cli', late)).toEqual({ retrying: 0, gave_up: 1, last_error: 'exit code 1' });
    expect(box.read().map((e) => e.event_id)).toEqual([push.event_id]);
  });

  it('renders markdown, newest first, max 100', () => {
    for (let i = 0; i < 105; i++) {
      box.append(ev({ dedupe_key: `k${i}`, item: { id: String(i), kind: 'announcement', title: `標題${i}`, due_at: null, url: null }, detectedAt: new Date(Date.UTC(2026, 9, 22, 4, 0, i)) }));
    }
    box.renderMarkdown();
    const p = join(root, 'outbox', '通知.md');
    const md = readFileSync(p, 'utf8');
    expect(md.match(/^## /gm)).toHaveLength(100);
    expect(md.indexOf('標題104')).toBeLessThan(md.indexOf('標題103'));
    expect(md).not.toContain('標題4\n');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
