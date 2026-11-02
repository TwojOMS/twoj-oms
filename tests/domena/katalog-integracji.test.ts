import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KATALOG_INTEGRACJI, filtrujIntegracje } from '../../src/domena/katalog-integracji.ts';

describe('katalog integracji', () => {
  it('obejmuje wymagane usługi bez duplikatów i bez TwojeFaktury', () => {
    expect(KATALOG_INTEGRACJI.map((usluga) => usluga.id).sort()).toEqual([
      'allegro', 'woocommerce', 'shoper', 'empik', 'erli', 'etsy',
      'dpd', 'inpost', 'wza', 'gls', 'infakt', 'fakturownia',
      'ksef', 'gus', 'smtp', 'meta', 'ga4', 'google_ads',
    ].sort());
  });

  it('oznacza sześć zapowiedzi bez odnośnika do podłączenia', () => {
    const planowane = KATALOG_INTEGRACJI.filter((usluga) => usluga.dostepnosc === 'planowana');
    expect(planowane.map((usluga) => usluga.id).sort()).toEqual(
      ['shoper', 'empik', 'erli', 'etsy', 'gls', 'fakturownia'].sort(),
    );
    expect(planowane.every((usluga) => usluga.href === null)).toBe(true);
  });

  it('udostępnia komplet informacji i lokalne pliki logotypów', () => {
    for (const usluga of KATALOG_INTEGRACJI) {
      expect(usluga.nazwa.trim()).not.toBe('');
      expect(usluga.opis.trim()).not.toBe('');
      expect(['sklepy', 'wysylka', 'faktury', 'poczta', 'reklamy']).toContain(usluga.kategoria);
      expect(['dostepna', 'przez_konfiguracje', 'planowana']).toContain(usluga.dostepnosc);
      expect(usluga.logo).toMatch(/^\/integracje\/[^/]+$/);
      expect(existsSync(join(process.cwd(), 'src/public', usluga.logo))).toBe(true);
      if (usluga.dostepnosc !== 'planowana') expect(usluga.href).toMatch(/^\/ustawienia\//);
    }
  });

  it('domyślnie zwraca również planowane usługi', () => {
    expect(filtrujIntegracje().map((usluga) => usluga.id).sort()).toEqual(
      KATALOG_INTEGRACJI.map((usluga) => usluga.id).sort(),
    );
  });

  it('wyszukuje niezależnie od wielkości liter i polskich znaków', () => {
    expect(filtrujIntegracje({ szukaj: 'WYSYLAM Z ALLEGRO' }).map((usluga) => usluga.id)).toEqual(['wza']);
  });

  it('łączy kategorię i wyszukiwanie z ukryciem planowanych', () => {
    expect(filtrujIntegracje({ kategoria: 'wysylka', szukaj: 'gls', planowane: false })).toEqual([]);
    expect(filtrujIntegracje({ kategoria: 'wysylka', szukaj: 'gls', planowane: true }).map((usluga) => usluga.id)).toEqual(['gls']);
    expect(filtrujIntegracje({ kategoria: 'sklepy', szukaj: 'gls' })).toEqual([]);
  });
});
