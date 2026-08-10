import { describe, expect, it } from 'vitest';
import { genreNamesFor } from './genre-names';

describe('genreNamesFor', () => {
  it('maps known ids to the requested locale', () => {
    expect(genreNamesFor(['1', '23'], 'ru')).toEqual(['Экшены', 'Инди']);
  });

  it('falls back to English for locales outside the table', () => {
    expect(genreNamesFor(['2'], 'ja')).toEqual(['Strategy']);
  });

  it('drops unknown ids silently', () => {
    expect(genreNamesFor(['1', '9999'], 'en')).toEqual(['Action']);
  });

  it('returns [] when nothing maps', () => {
    expect(genreNamesFor(['9999'], 'en')).toEqual([]);
    expect(genreNamesFor([], 'en')).toEqual([]);
  });

  it('collapses duplicate ids', () => {
    expect(genreNamesFor(['1', '1'], 'en')).toEqual(['Action']);
  });
});
