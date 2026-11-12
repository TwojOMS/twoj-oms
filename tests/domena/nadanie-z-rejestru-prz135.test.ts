// PRZ-135.04a — metody i reguły nadania czytane z rejestru kurierów. Zmyślony kurier „Półcień Ekspres”
// wchodzi WYŁĄCZNIE przez parametr: rejestr produkcyjny i dzisiejsze stałe zostają nietknięte.
import { describe, expect, it } from 'vitest';
import type { OpisKuriera } from '../../src/core/kontrakty.ts';
import {
  MODULY_KURIEROW, kurierDlaMetody, metodyKurierow, metodaKuriera, metodaDomyslna, kurierDomyslny,
  METODA_DOMYSLNA, KURIER_DOMYSLNY, modulKuriera, modulKurieraLubNull, kluczeEnvKurierow, sprawdzOpisyKurierow,
} from '../../src/domena/moduly-kurierow.ts';
import { metodyWysylki, etykietyWysylki, METODY_WYSYLKI, ETYKIETY_WYSYLKI } from '../../src/domena/wysylka.js';
import { kurierzyDoWyboru } from '../../src/domena/kurier-nadania.js';

const polcien = (pobranie: 'brak' | 'adapter' | 'umowa'): OpisKuriera => ({
  klucz: 'polcien_ekspres', nazwa: 'Półcień Ekspres', logo: '/integracje/polcien.svg', idKatalogu: 'polcien_ekspres',
  opisKatalogu: 'Nadaj przesyłki przez Półcień Ekspres.', umowa: 'wlasna', przewoznicy: ['dpd'],
  metody: [{ klucz: 'polcien_ekspres', etykieta: 'Półcień Ekspres kurier', etykietaWyboru: 'Półcień Ekspres — nasza umowa',
    formularz: 'dpd', punktOdbioru: false }],
  umiejetnosci: { pobranie, nadanieAsynchroniczne: false, sledzenie: 'wlasne', etykieta: { zpl: false, zplPrzyNadaniu: false } },
  pobieranieEtykiety: false,
  kluczeEnv: ['POLCIEN_TOKEN', 'DPD_LOGIN'],
  konfigurator: { sciezka: '/ustawienia/integracje/polcien', etykieta: 'Półcień Ekspres', zdanie: 'token.' },
  piaskownica: { atrapa: 'deploy/proba/atrapy/polcien.mjs', komunikat: 'Piaskownica: Półcień Ekspres jest tu wyłączony.' },
});
const zPolcieniem = (pobranie: 'brak' | 'adapter' | 'umowa' = 'adapter'): Record<string, OpisKuriera> =>
  ({ ...MODULY_KURIEROW, polcien_ekspres: polcien(pobranie) });
const klucze = (z: any, paczka: number, rejestr?: Record<string, OpisKuriera>): string[] =>
  kurierzyDoWyboru(z, paczka, rejestr ? { rejestr } as any : undefined).map((k: any) => `${k.klucz}|${k.etykieta}`);

describe('nowy kurier podany parametrem', () => {
  it('jego metoda wchodzi do metod wysyłki zaraz za kurierami na własnej umowie', () => {
    expect(metodyWysylki(zPolcieniem())).toEqual([
      'dpd', 'inpost_paczkomat', 'polcien_ekspres', 'odbior_osobisty',
      'allegro_dpd', 'allegro_paczkomat', 'allegro_punkt', 'allegro_kurier', 'allegro_inne',
    ]);
    expect(etykietyWysylki(zPolcieniem()).polcien_ekspres).toBe('Półcień Ekspres kurier');
    expect(METODY_WYSYLKI).not.toContain('polcien_ekspres');
    expect([...metodyWysylki()]).toEqual([...METODY_WYSYLKI]);
    expect(etykietyWysylki()).toEqual(ETYKIETY_WYSYLKI);
  });

  it('bez pobrania jest w wyborze (po WzA i dzisiejszych kurierach), z własną etykietą wyboru', () => {
    const z = { sklep: 'allegro_a', metoda_wysylki: 'allegro_dpd', pobranie: 0 };
    expect(klucze(z, 1, zPolcieniem())).toEqual([
      'wza|Wysyłam z Allegro — umowa Allegro (domyślnie)', 'dpd|DPD — nasza umowa',
      'inpost_paczkomat|Paczkomat InPost — nasza umowa', 'polcien_ekspres|Półcień Ekspres — nasza umowa',
    ]);
    expect(klucze({ metoda_wysylki: 'dpd', pobranie: 1 }, 2, zPolcieniem()).map(k => k.split('|')[0]))
      .toEqual(['dpd', 'inpost_paczkomat', 'polcien_ekspres']);
  });

  it.each(['adapter', 'brak'] as const)('przy pobraniu na tej paczce NIE ma go w wyborze, gdy pobranie: %s', (pobranie) => {
    const z = { sklep: 'allegro_a', metoda_wysylki: 'allegro_dpd', pobranie: 1 };
    expect(klucze(z, 1, zPolcieniem(pobranie)).map(k => k.split('|')[0])).toEqual(['wza', 'dpd']);
    expect(klucze({ metoda_wysylki: 'dpd', pobranie: 1 }, 1, zPolcieniem(pobranie)).map(k => k.split('|')[0])).toEqual(['dpd']);
  });

  it('z pobraniem: \'umowa\' wolno go wybrać przy pobraniu', () => {
    const z = { sklep: 'allegro_a', metoda_wysylki: 'allegro_dpd', pobranie: 1 };
    expect(klucze(z, 1, zPolcieniem('umowa')).map(k => k.split('|')[0])).toEqual(['wza', 'dpd', 'polcien_ekspres']);
  });

  it('rejestr produkcyjny nie ma go w wyborze', () => {
    expect(klucze({ metoda_wysylki: 'dpd', pobranie: 0 }, 1).map(k => k.split('|')[0])).toEqual(['dpd', 'inpost_paczkomat']);
  });

  it('funkcje rejestru czytają podany rejestr', () => {
    const r = zPolcieniem();
    expect(kurierDlaMetody('polcien_ekspres', r)).toBe('polcien_ekspres');
    expect(kurierDlaMetody('polcien_ekspres')).toBeNull();
    expect(metodyKurierow(r).map(m => m.klucz)).toContain('polcien_ekspres');
    expect(metodaKuriera('polcien_ekspres', r)?.formularz).toBe('dpd');
    expect(metodaKuriera('polcien_ekspres')).toBeNull();
    expect(modulKuriera('polcien_ekspres', r)).toBe(r.polcien_ekspres);
    expect(() => modulKuriera('polcien_ekspres')).toThrow('Nieznany kurier');
    expect(() => sprawdzOpisyKurierow(r)).not.toThrow();
  });
});

describe('wartości domyślne z rejestru (D8)', () => {
  it('stałe są wynikiem funkcji na rejestrze produkcyjnym', () => {
    expect(metodaDomyslna()).toBe(METODA_DOMYSLNA);
    expect(kurierDomyslny()).toBe(KURIER_DOMYSLNY);
  });
  it('pierwsza metoda pierwszego kuriera na własnej umowie', () => {
    const { dpd: _d, inpost: _i, ...bezWlasnych } = MODULY_KURIEROW;
    const r = { ...bezWlasnych, polcien_ekspres: polcien('adapter') };
    expect(metodaDomyslna(r)).toBe('polcien_ekspres');
    expect(kurierDomyslny(r)).toBe('polcien_ekspres');
    expect(() => metodaDomyslna(bezWlasnych)).toThrow(/własnej umowie/);
  });
});

describe('pola dla zmiany 04b', () => {
  it('modulKurieraLubNull: pusty albo historyczny kurier → null, bez wyjątku', () => {
    expect(modulKurieraLubNull('dpd')).toBe(MODULY_KURIEROW.dpd);
    for (const k of ['', null, undefined, 'historyczny', 'constructor', '__proto__']) expect(modulKurieraLubNull(k)).toBeNull();
  });
  it('pobieranieEtykiety: InPost tak, DPD i WzA nie (WzA mimo nadania asynchronicznego)', () => {
    expect(Object.fromEntries(Object.entries(MODULY_KURIEROW).map(([k, v]) => [k, v.pobieranieEtykiety])))
      // PRZ-157.08: Przesyłki Erli — etykietę dociąga „Sprawdź ponownie” (czuwacz to osobna zmiana).
      .toEqual({ dpd: false, inpost: true, allegro_wza: false, allegro: false, erli_przesylki: false });
  });
  it('klucze env bez powtórzeń, w kolejności rejestru', () => {
    expect(kluczeEnvKurierow()).toEqual(['DPD_LOGIN', 'DPD_PASSWORD', 'INPOST_TOKEN', 'ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET']);
    expect(kluczeEnvKurierow(zPolcieniem())).toEqual([
      'DPD_LOGIN', 'DPD_PASSWORD', 'INPOST_TOKEN', 'ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET', 'POLCIEN_TOKEN',
    ]);
  });
  it('D5.4: kurier na własnej umowie z metodami musi mieć tekst odmowy w piaskownicy', () => {
    const r = zPolcieniem();
    r.polcien_ekspres = { ...r.polcien_ekspres!, piaskownica: { atrapa: 'deploy/proba/atrapy/polcien.mjs', komunikat: '  ' } };
    expect(() => sprawdzOpisyKurierow(r)).toThrow(/polcien_ekspres:.*piaskownica.komunikat/);
  });
});

describe('etykiety metod — jedno źródło', () => {
  it('każda metoda kuriera ma w ETYKIETY_WYSYLKI dokładnie etykietę z rejestru', () => {
    for (const m of metodyKurierow()) expect(ETYKIETY_WYSYLKI[m.klucz as keyof typeof ETYKIETY_WYSYLKI]).toBe(m.etykieta);
  });
});
