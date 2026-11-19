import { describe, expect, it } from 'vitest';
import { producentAllegro } from '../../src/domena/producent-allegro.js';

// Dane zmyślone: marka „Pracownia Półcień”, konto Allegro „Półcień-sklep”, identyfikatory przykładowe.
const MARKA = 'Pracownia Półcień';
const KONTO = 'Półcień-sklep';
const USTAWIENIA = { producentId: 'prod-konta-1', osobaOdpowiedzialnaId: 'osoba-konta-1' };
const BLAD_KONTA = `Ustaw producenta konta ${KONTO} (krok Oferty w konfiguratorze konta).`;

const wolaj = (zmiany = {}) =>
  producentAllegro({
    marka: MARKA,
    droga: 'nowy',
    przypisanie: null,
    ustawienia: USTAWIENIA,
    nazwaKonta: KONTO,
    ...zmiany,
  });

describe('producentAllegro', () => {
  it('przypisanie „konto” → producent i osoba konta', () => {
    expect(wolaj({ przypisanie: { marka: MARKA, zrodlo: 'konto' } })).toEqual({
      zrodlo: 'konto',
      responsibleProducer: { type: 'ID', id: 'prod-konta-1' },
      responsiblePerson: { id: 'osoba-konta-1' },
    });
  });

  it('przypisanie „konto” bez producenta konta → błąd konta, także przy drodze katalog-id', () => {
    for (const droga of ['nowy', 'katalog-id']) {
      expect(wolaj({ droga, przypisanie: { zrodlo: 'konto' }, ustawienia: { producentId: '  ' } })).toEqual({
        zrodlo: 'brak',
        blad: BLAD_KONTA,
      });
    }
  });

  it('osoba odpowiedzialna konta tylko, gdy jest', () => {
    const wynik = wolaj({ przypisanie: { zrodlo: 'konto' }, ustawienia: { producentId: ' prod-konta-1 ' } });
    expect(wynik).toEqual({ zrodlo: 'konto', responsibleProducer: { type: 'ID', id: 'prod-konta-1' } });
    expect('responsiblePerson' in wynik).toBe(false);
  });

  it('przypisanie „wybrany” → producent marki, osoba tylko gdy jest', () => {
    expect(
      wolaj({
        przypisanie: { zrodlo: 'wybrany', producentId: 'prod-marki-7', osobaOdpowiedzialnaId: 'osoba-marki-7' },
      }),
    ).toEqual({
      zrodlo: 'marka',
      responsibleProducer: { type: 'ID', id: 'prod-marki-7' },
      responsiblePerson: { id: 'osoba-marki-7' },
    });
    const bezOsoby = wolaj({ przypisanie: { zrodlo: 'wybrany', producentId: 'prod-marki-7' } });
    expect(bezOsoby).toEqual({ zrodlo: 'marka', responsibleProducer: { type: 'ID', id: 'prod-marki-7' } });
    expect('responsiblePerson' in bezOsoby).toBe(false);
  });

  it('„wybrany” bez producentId działa jak brak przypisania', () => {
    expect(wolaj({ przypisanie: { zrodlo: 'wybrany', producentId: '' } }).zrodlo).toBe('brak');
    expect(wolaj({ droga: 'katalog-id', przypisanie: { zrodlo: 'wybrany' } })).toEqual({ zrodlo: 'katalog' });
  });

  it('droga katalog-id bez przypisania → pole pominięte', () => {
    expect(wolaj({ droga: 'katalog-id' })).toEqual({ zrodlo: 'katalog' });
    expect(wolaj({ droga: 'katalog-id', marka: '' })).toEqual({ zrodlo: 'katalog' });
  });

  it('karta bez marki → producent konta; bez producenta konta → błąd konta', () => {
    expect(wolaj({ marka: '', droga: 'ean' })).toEqual({
      zrodlo: 'konto',
      responsibleProducer: { type: 'ID', id: 'prod-konta-1' },
      responsiblePerson: { id: 'osoba-konta-1' },
    });
    expect(wolaj({ marka: '', ustawienia: {} })).toEqual({ zrodlo: 'brak', blad: BLAD_KONTA });
  });

  it('marka bez przypisania (droga inna niż katalog-id) → błąd marki', () => {
    for (const droga of ['nowy', 'ean']) {
      expect(wolaj({ droga })).toEqual({
        zrodlo: 'brak',
        blad: `Przypisz producenta marki ${MARKA} na koncie ${KONTO} (Ustawienia → Integracje → Moje połączenia, przy koncie Allegro → krok Oferty).`,
      });
    }
  });
});
