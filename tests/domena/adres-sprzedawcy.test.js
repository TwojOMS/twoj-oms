import { describe, it, expect } from 'vitest';
import { adresSprzedawcy } from '../../src/domena/adres-sprzedawcy.js';

// `adresSprzedawcy` — wspolna regula adresu wystawcy dla WSZYSTKICH dokumentow panelu
// (proforma, specyfikacja zamowienia — Zadanie 8). Wyciagnieta z services/proforma.js, gdzie
// byla prywatna funkcja `daneSprzedawcy()`.
//
// ⚠️ TREŚĆ KOMUNIKATU JEST TU PRZYPIĘTA CELOWO (recenzja Zadania 8, 12.08.2026). Do tej
// zmiany jedynym testem tego komunikatu byl regex `/sprzedawc/i` w proforma.test.js — a taki
// regex przepuszcza DOWOLNĄ zmianę treści, więc refaktor tego pliku (wyciągnięcie funkcji
// z proforma.js) po cichu przestawił słowo „proforma" na „dokument" w zdaniu, i żaden test
// tego nie zauważył. Zmiana jest ŚWIADOMA i UZASADNIONA (funkcja obsługuje dziś dwa
// dokumenty, więc „proforma wyszłaby..." bylo nieprawdą przy specyfikacji) — ale następna
// zmiana treści ma być widoczna w diffie testu, a nie tylko w diffie kodu.
const KOMUNIKAT = 'Panel nie zna adresu sprzedawcy (DPD_NADAWCA_*), więc dokument wyszedłby bez '
  + 'nazwy i adresu wystawcy — takiego dokumentu nie da się wysłać klientowi.';

describe('adresSprzedawcy', () => {
  it('sklada nazwe, ulice, kod, miasto i kraj z config.nadawca', () => {
    const config = {
      nadawca: {
        nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
      },
    };
    expect(adresSprzedawcy(config)).toEqual({
      nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
    });
  });

  it('bez nazwy odmawia z DOKLADNIE tą trescia komunikatu', () => {
    const config = { nadawca: { ulica: 'ul. 1 Maja 5' } };
    expect(() => adresSprzedawcy(config)).toThrow(KOMUNIKAT);
  });

  it('bez ulicy odmawia z DOKLADNIE tą trescia komunikatu', () => {
    const config = { nadawca: { nazwa: 'Lumina Marek Zywiecki' } };
    expect(() => adresSprzedawcy(config)).toThrow(KOMUNIKAT);
  });

  it('bez config.nadawca odmawia', () => {
    expect(() => adresSprzedawcy({})).toThrow(KOMUNIKAT);
    expect(() => adresSprzedawcy(undefined)).toThrow(KOMUNIKAT);
  });

  it('komunikat jest oznaczony jako operatorski (dlaOperatora), nie techniczny', () => {
    try {
      adresSprzedawcy({});
      throw new Error('mial rzucic');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });
});
