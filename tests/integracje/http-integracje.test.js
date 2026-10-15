import { describe, it, expect, vi } from 'vitest';
import { transport } from '../../src/integracje/transport.js';
import { integracje, kluczeKanalu } from '../../src/integracje/klucze.js';
import { sprawdzTrybProby } from '../../src/core/tryb.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';

describe('transport i klucze integracji', () => {
  it('ma niezależną pełną listę poświadczeń z frozen config i ręcznej integracji Apilo', () => {
    // Lista literalna jest niezależna od implementacji deklaracji. Frozen config:
    // kanały 287-320, DPD 335-369, inFakt 376, KSeF 416, Meta 472,
    // GA4 485, GUS 523, InPost 538; Apilo czyta credentialsPath w swoim kliencie.
    expect(integracje).toEqual({
      allegro: { kluczeIntegracji: ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET'] },
      woo: { kluczeIntegracji: ['WOO_CK', 'WOO_CS'] },
      apilo: { kluczeIntegracji: ['APILO_CREDENTIALS_PATH'] },
      dpd: { kluczeIntegracji: ['DPD_LOGIN', 'DPD_PASSWORD'] },
      inpost: { kluczeIntegracji: ['INPOST_TOKEN'] },
      infakt: { kluczeIntegracji: ['INFAKT_API_KEY'] },
      ksef: { kluczeIntegracji: ['KSEF_TOKEN'] },
      gus: { kluczeIntegracji: ['GUS_KLUCZ'] },
      meta: { kluczeIntegracji: ['META_TOKEN'] },
      ga4: { kluczeIntegracji: ['GA4_KLUCZ'] },
      vies: { kluczeIntegracji: [] },
    });
  });
  it('używa podstawionego http', () => {
    const http = vi.fn();
    expect(transport({ http })).toBe(http);
  });
  it.each(['POST', 'PUT', 'PATCH'])('domyślny transport nie ponawia operacji %s po 503', async (method) => {
    const f = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', f);
    try {
      expect((await transport()('https://przyklad.invalid/nadanie', { method })).status).toBe(503);
      expect(f).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('deklaruje wszystkie integracje i blokuje każdy klucz w próbie', () => {
    expect(Object.keys(integracje).sort()).toEqual(['allegro','apilo','dpd','ga4','gus','infakt','inpost','ksef','meta','vies','woo'].sort());
    for (const [nazwa, deklaracja] of Object.entries(integracje)) {
      expect(deklaracja.kluczeIntegracji, nazwa).toBeDefined();
      for (const klucz of deklaracja.kluczeIntegracji) {
        expect(() => sprawdzTrybProby({ OMS_TRYB: 'proba', [klucz]: 'test' }, deklaracja.kluczeIntegracji)).toThrow(klucz);
      }
    }
    expect(integracje.allegro.kluczeIntegracji).toContain('ALLEGRO_CLIENT_SECRET');
    expect(integracje.ga4.kluczeIntegracji).toContain('GA4_KLUCZ');
  });
  it('rdzeń używa deklaracji i odmawia przed konfiguracją oraz dostępem do bazy', async () => {
    for (const d of Object.values(integracje)) {
      for (const klucz of d.kluczeIntegracji) {
        const konfiguracja = vi.fn(modulRdzen.konfiguracja);
        await expect(zbudujAplikacje({ moduly: [{ ...modulRdzen, kluczeIntegracji: d.kluczeIntegracji, konfiguracja }], env: { OMS_TRYB: 'proba', [klucz]: 'test' }, db: null })).rejects.toThrow(klucz);
        expect(konfiguracja).not.toHaveBeenCalled();
      }
    }
  });
  it('blokuje klucze kanałów o prefiksie należącym do klienta', () => {
    for (const [typ, sufiksy] of [['allegro', ['CLIENT_ID','CLIENT_SECRET']], ['woo', ['CK','CS']]]) {
      const d = kluczeKanalu(typ, 'MOJ_SKLEP');
      expect(d.kluczeIntegracji).toEqual(sufiksy.map(s => `MOJ_SKLEP_${s}`));
      for (const klucz of d.kluczeIntegracji) expect(() => sprawdzTrybProby({OMS_TRYB:'proba',[klucz]:'x'},d.kluczeIntegracji)).toThrow(klucz);
    }
    expect(() => kluczeKanalu('inne', 'MOJ_SKLEP')).toThrow();
    expect(() => kluczeKanalu('woo', '../plik')).toThrow();
  });
});
