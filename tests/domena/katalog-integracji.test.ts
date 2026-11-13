import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODUL_WOO } from '../../src/domena/modul-woo.ts';
import { MODUL_ALLEGRO } from '../../src/domena/modul-allegro.ts';
import { KATALOG_INTEGRACJI, filtrujIntegracje } from '../../src/domena/katalog-integracji.ts';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';

describe('katalog integracji', () => {
  it('WooCommerce i Allegro biorą adres i napis przycisku z opisu modułu', () => {
    const woo = KATALOG_INTEGRACJI.find(u => u.id === 'woocommerce');
    expect(woo).toMatchObject({ dostepnosc: 'dostepna', href: '/ustawienia/integracje/woocommerce/nowy' });
    expect(woo?.konfigurator).toEqual({ dodaj: MODUL_WOO.konfigurator.dodaj, href: `${MODUL_WOO.konfigurator.sciezka}/${MODUL_WOO.konfigurator.nowy}` });
    const allegro = KATALOG_INTEGRACJI.find(u => u.id === 'allegro');
    expect(allegro?.konfigurator).toEqual({ dodaj: MODUL_ALLEGRO.konfigurator.dodaj, href: `${MODUL_ALLEGRO.konfigurator.sciezka}/${MODUL_ALLEGRO.konfigurator.nowy}` });
    expect(allegro?.href).toBe(allegro?.konfigurator?.href);
  });
  it('dostępne sklepy przed planowanymi — ERLI trzecie (PRZ-157.12h)', () => {
    expect(KATALOG_INTEGRACJI.filter(u => u.kategoria === 'sklepy').map(u => u.id)).toEqual(['allegro', 'woocommerce', 'erli', 'shoper', 'empik', 'etsy']);
  });
  it('obejmuje wymagane usługi bez duplikatów i bez TwojeFaktury', () => {
    expect(KATALOG_INTEGRACJI.map((usluga) => usluga.id).sort()).toEqual([
      'allegro', 'woocommerce', 'shoper', 'empik', 'erli', 'etsy',
      'dpd', 'inpost', 'wza', 'gls', 'dhl', 'apaczka', 'infakt', 'fakturownia',
      'ksef', 'gus', 'smtp', 'meta', 'ga4', 'google_ads',
    ].sort());
  });

  it('oznacza siedem zapowiedzi bez odnośnika do podłączenia', () => {
    const planowane = KATALOG_INTEGRACJI.filter((usluga) => usluga.dostepnosc === 'planowana');
    expect(planowane.map((usluga) => usluga.id).sort()).toEqual(
      ['shoper', 'empik', 'etsy', 'gls', 'dhl', 'apaczka'].sort(),
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

describe('katalog integracji — wysyłka z rejestru kurierów (PRZ-135.07a)', () => {
  it('wpis wysyłki z rejestru: każdy kurier z metodami ma wpis z polami z opisu, w kolejności rejestru', () => {
    const kurierzy = Object.values(MODULY_KURIEROW).filter((opis) => opis.metody.length > 0 && (opis as { wKatalogu?: false }).wKatalogu !== false);
    const dostepne = KATALOG_INTEGRACJI.filter((u) => u.kategoria === 'wysylka' && u.dostepnosc === 'dostepna');
    expect(dostepne.map((u) => u.id)).toEqual(kurierzy.map((opis) => opis.idKatalogu));
    for (const opis of kurierzy) {
      expect(KATALOG_INTEGRACJI.find((u) => u.id === opis.idKatalogu)).toEqual({
        id: opis.idKatalogu, nazwa: opis.nazwa, kategoria: 'wysylka', opis: opis.opisKatalogu, logo: opis.logo,
        dostepnosc: 'dostepna', // PRZ-136.14 (#5): WzA nie ma ekranu — cel to grupa kont Allegro na liście.
        href: opis.idKatalogu === 'wza' ? '/ustawienia/integracje#grupa-sprzedaz' : opis.konfigurator.sciezka, konfigurator: null,
      });
    }
  });

  it('DHL i Apaczka planowane (T3, decyzja właściciela 03.11), jak GLS — bez odnośnika i bez modułu', () => {
    const gls = KATALOG_INTEGRACJI.find((u) => u.id === 'gls');
    for (const id of ['dhl', 'apaczka']) {
      const wpis = KATALOG_INTEGRACJI.find((u) => u.id === id);
      expect(wpis).toMatchObject({ kategoria: 'wysylka', dostepnosc: 'planowana', href: null, konfigurator: null });
      expect(wpis).toMatchObject({ kategoria: gls?.kategoria, dostepnosc: gls?.dostepnosc, href: gls?.href });
      expect(Object.hasOwn(MODULY_KURIEROW, id)).toBe(false);
    }
    expect(KATALOG_INTEGRACJI.find((u) => u.id === 'apaczka')?.opis).toBe('Broker — wiele firm kurierskich w jednej umowie.');
    expect(filtrujIntegracje({ kategoria: 'wysylka', planowane: false }).map((u) => u.id)).toEqual(['dpd', 'inpost', 'wza']);
  });
});
