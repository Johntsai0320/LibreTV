import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnvSubscriptions } from './env-subscriptions';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES } from './source-list';
import { isValidProxyUrl } from './ssrf';
import { parseSubscriptionJson, parseSubscriptionPayload } from './tvbox-parser';

describe('public/sources.json preset source list', () => {
  const originalEnvSubs = process.env.DEFAULT_SUBSCRIPTIONS;

  afterEach(() => {
    if (originalEnvSubs === undefined) delete process.env.DEFAULT_SUBSCRIPTIONS;
    else process.env.DEFAULT_SUBSCRIPTIONS = originalEnvSubs;
  });

  const rawText = fs.readFileSync(path.join(process.cwd(), 'public/sources.json'), 'utf8');
  const json = parseSubscriptionJson(rawText) as {
    name?: string;
    version?: number;
    sources: Array<{ name: string; url: string; detail?: string; isAdult?: boolean }>;
    liveSources: Array<{ name: string; url: string; epg?: string }>;
  };

  it('parses cleanly as LibreTV-SourceList v2 without skipped or truncated entries', () => {
    const parsed = parseSubscriptionPayload(json);
    expect(parsed.stats).toBeDefined();
    expect(parsed.stats?.format).toBe('libretv');
    expect(parsed.stats?.skipped).toBe(0);
    expect(parsed.stats?.truncated).toBe(0);
    expect(parsed.sources.length).toBe(json.sources.length);
    expect(parsed.liveSources.length).toBe(json.liveSources.length);
    expect(parsed.sources.length).toBeLessThanOrEqual(MAX_VOD_SOURCES);
    expect(parsed.liveSources.length).toBeLessThanOrEqual(MAX_LIVE_SOURCES);
  });

  it('has unique public HTTPS/HTTP VOD URLs without query strings or XML endpoints', () => {
    const seen = new Set<string>();
    for (const s of json.sources) {
      expect(isValidProxyUrl(s.url), `Invalid VOD URL: ${s.url}`).toBe(true);
      expect(s.url.includes('?'), `VOD URL must not include query string: ${s.url}`).toBe(false);
      expect(s.url.includes('/at/xml'), `VOD URL must not be XML endpoint: ${s.url}`).toBe(false);
      const normalized = s.url.replace(/\/+$/, '');
      expect(seen.has(normalized), `Duplicate VOD URL: ${s.url}`).toBe(false);
      seen.add(normalized);
      if (s.detail) {
        expect(isValidProxyUrl(s.detail), `Invalid detail URL: ${s.detail}`).toBe(true);
      }
    }
  });

  it('includes both general and isAdult=true VOD categories', () => {
    const general = json.sources.filter((s) => s.isAdult === false);
    const adult = json.sources.filter((s) => s.isAdult === true);
    expect(general.length).toBeGreaterThanOrEqual(10);
    expect(adult.length).toBeGreaterThanOrEqual(5);
  });

  it('has unique valid live IPTV URLs', () => {
    const seen = new Set<string>();
    for (const l of json.liveSources) {
      expect(isValidProxyUrl(l.url), `Invalid live URL: ${l.url}`).toBe(true);
      expect(seen.has(l.url), `Duplicate live URL: ${l.url}`).toBe(false);
      seen.add(l.url);
      if (l.epg) {
        expect(isValidProxyUrl(l.epg), `Invalid EPG URL: ${l.epg}`).toBe(true);
      }
    }
  });

  it('Dockerfile ENV DEFAULT_SUBSCRIPTIONS parses cleanly with getEnvSubscriptions()', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const match = dockerfile.match(/^ENV DEFAULT_SUBSCRIPTIONS="(.+)"$/m);
    expect(match).not.toBeNull();
    process.env.DEFAULT_SUBSCRIPTIONS = match![1].replace(/\\"/g, '"');
    expect(getEnvSubscriptions()).toEqual([
      {
        url: 'https://raw.githubusercontent.com/Johntsai0320/LibreTV/main/public/sources.json',
        name: 'LibreTV精選片源',
        refreshDays: 7,
      },
    ]);
  });
});
