import { describe, expect, it, vi } from 'vitest';
import { GenreService, type GenreServiceDeps } from './genres';

function makeDeps(overrides: Partial<GenreServiceDeps> = {}): GenreServiceDeps {
  return {
    peekDetails: () => null,
    getGenreIds: async () => new Map(),
    mapGenreIds: (ids) => ids.map((id) => `genre-${id}`),
    fetchDetails: async () => null,
    broadcast: () => {},
    delayMs: 0,
    ...overrides,
  };
}

const details = (...names: string[]) => ({
  genres: names.map((description, id) => ({ id, description })),
});

async function flush(): Promise<void> {
  // resolveMisses + drain hop the macrotask queue a few times with delayMs=0.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('GenreService.request', () => {
  it('answers synchronously from the store cache without any fetch', () => {
    const getGenreIds = vi.fn(async () => new Map<number, string[]>());
    const fetchDetails = vi.fn(async () => null);
    const svc = new GenreService(
      makeDeps({
        peekDetails: (appid) => (appid === 10 ? details('Action', 'RPG') : null),
        getGenreIds,
        fetchDetails,
      })
    );
    const { known } = svc.request([10], 'en');
    expect(known).toEqual({ 10: ['Action', 'RPG'] });
    expect(getGenreIds).not.toHaveBeenCalled();
    expect(fetchDetails).not.toHaveBeenCalled();
  });

  it('cached game without genres resolves to empty list, not a queue entry', () => {
    const svc = new GenreService(
      makeDeps({ peekDetails: () => ({ genres: undefined }) })
    );
    expect(svc.request([5], 'en').known).toEqual({ 5: [] });
  });

  it('resolves misses from PICS in one bulk call, without the web API', async () => {
    const broadcast = vi.fn();
    const getGenreIds = vi.fn(
      async () =>
        new Map<number, string[]>([
          [1, ['2']],
          [2, ['1', '23']],
        ])
    );
    const fetchDetails = vi.fn(async () => null);
    const svc = new GenreService(makeDeps({ getGenreIds, fetchDetails, broadcast }));
    const { known } = svc.request([1, 2], 'ru');
    expect(known).toEqual({});
    await flush();
    expect(getGenreIds).toHaveBeenCalledTimes(1);
    expect(getGenreIds).toHaveBeenCalledWith([1, 2]);
    expect(fetchDetails).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      appid: 1,
      locale: 'ru',
      genres: ['genre-2'],
    });
    expect(broadcast).toHaveBeenCalledWith({
      appid: 2,
      locale: 'ru',
      genres: ['genre-1', 'genre-23'],
    });
  });

  it('falls back to the web API only for appids PICS could not resolve', async () => {
    const broadcast = vi.fn();
    const fetchDetails = vi.fn(async () => details('Shooter'));
    const svc = new GenreService(
      makeDeps({
        getGenreIds: async () => new Map([[1, ['2']]]),
        fetchDetails,
        broadcast,
      })
    );
    svc.request([1, 2], 'en');
    await flush();
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    expect(fetchDetails).toHaveBeenCalledWith(2, 'en');
    expect(broadcast).toHaveBeenCalledWith({
      appid: 2,
      locale: 'en',
      genres: ['Shooter'],
    });
  });

  it('falls back to the web API when PICS ids all map to nothing', async () => {
    const fetchDetails = vi.fn(async () => details('Documentary'));
    const svc = new GenreService(
      makeDeps({
        getGenreIds: async () => new Map([[7, ['9999']]]),
        mapGenreIds: () => [],
        fetchDetails,
      })
    );
    svc.request([7], 'en');
    await flush();
    expect(fetchDetails).toHaveBeenCalledWith(7, 'en');
  });

  it('broadcasts [] when every source fails so the renderer stops waiting', async () => {
    const broadcast = vi.fn();
    const svc = new GenreService(
      makeDeps({
        fetchDetails: async () => {
          throw new Error('boom');
        },
        broadcast,
      })
    );
    svc.request([7], 'en');
    await flush();
    expect(broadcast).toHaveBeenCalledWith({ appid: 7, locale: 'en', genres: [] });
  });

  it('dedupes an appid already pending for the same locale', async () => {
    const getGenreIds = vi.fn(async () => new Map<number, string[]>());
    const fetchDetails = vi.fn(async () => details('Indie'));
    const svc = new GenreService(makeDeps({ getGenreIds, fetchDetails }));
    svc.request([3], 'en');
    svc.request([3], 'en');
    await flush();
    expect(fetchDetails).toHaveBeenCalledTimes(1);
  });

  it('same appid in a different locale is a separate resolution', async () => {
    const fetchDetails = vi.fn(async () => details('Indie'));
    const svc = new GenreService(makeDeps({ fetchDetails }));
    svc.request([3], 'en');
    svc.request([3], 'ru');
    await flush();
    expect(fetchDetails).toHaveBeenCalledTimes(2);
  });

  it('re-resolves after a broadcast (pending key released)', async () => {
    const fetchDetails = vi.fn(async () => details('Indie'));
    const svc = new GenreService(makeDeps({ fetchDetails }));
    svc.request([3], 'en');
    await flush();
    svc.request([3], 'en');
    await flush();
    // Store cache would normally absorb the second call; with a null
    // peek it re-fetches — the point is it doesn't deadlock on pending.
    expect(fetchDetails).toHaveBeenCalledTimes(2);
  });

  it('drops whitespace-only genre names from web results', async () => {
    const broadcast = vi.fn();
    const svc = new GenreService(
      makeDeps({
        fetchDetails: async () => details('  ', 'Racing'),
        broadcast,
      })
    );
    svc.request([9], 'en');
    await flush();
    expect(broadcast).toHaveBeenCalledWith({
      appid: 9,
      locale: 'en',
      genres: ['Racing'],
    });
  });
});
