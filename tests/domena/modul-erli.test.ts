import { afterEach, expect, it } from 'vitest';
import { MODULY_KANALOW, modulZamowienia, nieznaneKanalyZamowien, sprawdzOpisyKanalow, ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';
import { KATALOG_INTEGRACJI } from '../../src/domena/katalog-integracji.ts';
import { odnosnikPozycji } from '../../src/domena/link-pozycji.js';

afterEach(() => ustawRejestrKanalow(null));

it('ERLI z rejestru otrzymuje prawdziwy moduł bez ostrzeżenia, niezależnie od prefiksu', async () => {
  const { MODUL_ERLI } = await import('../../src/domena/modul-erli.ts');
  ustawRejestrKanalow(k => ['erli_x', 'rynek_polcien'].includes(k) ? 'erli' : null);
  expect(modulZamowienia({ sklep: 'erli_x' })).toBe(MODUL_ERLI);
  expect(modulZamowienia({ sklep: 'rynek_polcien' })).toBe(MODUL_ERLI);
  expect(nieznaneKanalyZamowien()).toEqual([]);
});

it('umiejętności ERLI odpowiadają D4', async () => {
  const { MODUL_ERLI } = await import('../../src/domena/modul-erli.ts');
  expect(MODUL_ERLI.umiejetnosci).toEqual({
    zdarzenia: 'skrzynka', wymagaAkceptacji: false, statusZwrotny: 'mapa', numerListu: 'przesylki',
    plikFaktury: false, wiadomosci: false, wysylkaPlatformy: false, terminWysylki: true, scalanie: false, stany: 'brak',
  });
});

it('opis ERLI ma unikalną literę i katalog, wymagane klucze oraz sześć kroków (3 i 4 od PRZ-157.11b)', async () => {
  const { MODUL_ERLI } = await import('../../src/domena/modul-erli.ts');
  expect(MODULY_KANALOW).toHaveProperty('erli', MODUL_ERLI);
  expect(sprawdzOpisyKanalow).not.toThrow();
  expect(MODUL_ERLI).toMatchObject({ typ: 'erli', nazwa: 'ERLI', litera: 'e', idKatalogu: 'erli', wzorzecLinku: 'erli',
    kluczeEnv: { sekrety: ['KLUCZ_API'], wymagane: ['KLUCZ_API', 'ADRES_API', 'OD'] } });
  expect(MODUL_ERLI.konfigurator.sciezka).toBe('/ustawienia/integracje/erli');
  expect(MODUL_ERLI.konfigurator.kroki.map(k => [k.id, k.numer])).toEqual([['dane', 1], ['polaczenie', 2], ['metody', 3], ['nadawanie', 4], ['start', 5]]);
  expect(MODUL_ERLI.konfigurator.kroki.at(-1)).toMatchObject({ id: 'start', tytul: 'Start' });
});

it('katalog ma jeden planowany wpis ERLI bez linku i konfiguratora', () => {
  const wpisy = KATALOG_INTEGRACJI.filter(w => w.id === 'erli');
  expect(wpisy).toHaveLength(1);
  expect(wpisy[0]).toMatchObject({ dostepnosc: 'dostepna', href: '/ustawienia/integracje/erli/nowe', konfigurator: {href:'/ustawienia/integracje/erli/nowe',dodaj:'Dodaj konto'}, logo: '/integracje/erli.png' });
});

it.each(['produkt-PC_001.2', '1000001'])('bezpieczny slug/externalId %s daje link do produktu ERLI', slug => {
  ustawRejestrKanalow(k => k === 'erli_x' ? 'erli' : null);
  expect(odnosnikPozycji({ sklep: 'erli_x' }, { slug })).toEqual({ adres: `https://erli.pl/produkt/${slug}`, tytul: 'Otwórz produkt na ERLI' });
  expect(odnosnikPozycji({ sklep: 'erli_x' }, { externalId: slug })?.adres).toBe(`https://erli.pl/produkt/${slug}`);
});

it.each(['a/b', 'a b', '', ' abc', 'abc\n', 'a?b', 'a#b', 'ą'])('niebezpieczny slug %j nie daje linku', slug => {
  ustawRejestrKanalow(k => k === 'erli_x' ? 'erli' : null);
  expect(odnosnikPozycji({ sklep: 'erli_x' }, { slug })).toBeNull();
});

it('brak identyfikatora i pozycja ręczna nie dają linku ERLI', () => {
  ustawRejestrKanalow(k => k === 'erli_x' ? 'erli' : null);
  expect(odnosnikPozycji({ sklep: 'erli_x' }, {})).toBeNull();
  expect(odnosnikPozycji({ sklep: 'erli_x' }, { slug: 'PC-001', reczna: true })).toBeNull();
});
