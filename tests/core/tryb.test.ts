import { describe, it, expect } from 'vitest';
import { sprawdzTrybProby } from '../../src/core/tryb.ts';

describe('tryb próby', () => {
  it('odmawia startu ze wszystkimi ustawionymi kluczami, bez ich wartości', () => {
    const start = () => sprawdzTrybProby({ OMS_TRYB: 'proba', INFAKT_API_KEY: 'sekret-a', ALLEGRO_CLIENT_ID: 'sekret-b' }, ['INFAKT_API_KEY', 'ALLEGRO_CLIENT_ID']);
    expect(start).toThrow(/INFAKT_API_KEY[\s\S]*ALLEGRO_CLIENT_ID/);
    expect(start).not.toThrow(/sekret-a|sekret-b/);
  });
  it('przepuszcza próbę bez kluczy i produkcję z kluczami; odrzuca whitespace poświadczenia', () => {
    expect(() => sprawdzTrybProby({ OMS_TRYB: 'proba' }, ['INFAKT_API_KEY'])).not.toThrow();
    expect(() => sprawdzTrybProby({ OMS_TRYB: 'proba', INFAKT_API_KEY: ' \t' }, ['INFAKT_API_KEY'])).toThrow('INFAKT_API_KEY');
    expect(() => sprawdzTrybProby({ INFAKT_API_KEY: 'x' }, ['INFAKT_API_KEY'])).not.toThrow();
  });
});
