// Added in the PR #30 review. The offline cache and the check-off queue must survive the app
// being closed. Gemini's version kept them in memory only, so a check-off made offline was lost
// when the app was swiped away. This stands in for the phone's files with a Map that outlives
// resetTodayState() (which clears memory, like an app restart).
const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    constructor(dirUri: string) {
      this.uri = dirUri;
    }
  }
  class MockFile {
    uri: string;
    constructor(dir: MockDirectory, name: string) {
      this.uri = `${dir.uri}${name}`;
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    create() {
      mockFiles.set(this.uri, '');
    }
    async write(value: string) {
      mockFiles.set(this.uri, value);
    }
    async text() {
      return mockFiles.get(this.uri) ?? '';
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }
  return {
    File: MockFile,
    Paths: {
      document: new MockDirectory('file:///doc/'),
      cache: new MockDirectory('file:///cache/'),
    },
  };
});

import { CARECIRCLE_MOCKS } from '@carecircle/core';
import {
  TODAY_CHECKOFF_QUEUE_KEY,
  buildSnapshotFromMocks,
  loadCachedTodaySnapshot,
  saveCachedTodaySnapshot,
  TODAY_SNAPSHOT_CACHE_KEY,
  checkOffDose,
  loadQueuedDoseCheckOffs,
  resetTodayState,
} from './features/today/api';

const helperId = 'c1000001-0000-4000-8000-00000000000c';
const doseId = 'c1300001-0000-4000-8000-000000000031';

it('keeps a check-off made offline after the app restarts, in the document folder', async () => {
  const res = await checkOffDose(
    { doseEventId: doseId, status: 'given', memberRole: 'helper' },
    {
      isOffline: true,
      getUserId: async () => helperId,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
    },
  );
  expect(res).toMatchObject({ ok: true, queued: true, queuedCount: 1 });

  resetTodayState(); // app restart: memory is gone, files are not

  const queue = await loadQueuedDoseCheckOffs(undefined, helperId);
  expect(queue).toEqual([
    { doseEventId: doseId, status: 'given', actedAt: '2026-11-15T12:00:00.000Z', userId: helperId },
  ]);
  expect(mockFiles.has(`file:///doc/${TODAY_CHECKOFF_QUEUE_KEY}.json`)).toBe(true);
  // The snapshot (medicine names) never goes in the backed-up document folder.
  expect(mockFiles.has(`file:///doc/${TODAY_SNAPSHOT_CACHE_KEY}.json`)).toBe(false);
});

it('keeps the cached Today snapshot after a restart, in the cache folder (not backed up)', async () => {
  await saveCachedTodaySnapshot({ ...buildSnapshotFromMocks(CARECIRCLE_MOCKS), userId: helperId });
  resetTodayState();
  const cached = await loadCachedTodaySnapshot(undefined, helperId);
  expect(cached?.circle.id).toBe(CARECIRCLE_MOCKS.circle.id);
  expect(mockFiles.has(`file:///cache/${TODAY_SNAPSHOT_CACHE_KEY}.json`)).toBe(true);
  expect(mockFiles.has(`file:///doc/${TODAY_SNAPSHOT_CACHE_KEY}.json`)).toBe(false);
});
