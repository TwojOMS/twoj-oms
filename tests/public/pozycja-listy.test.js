import { describe, expect, it, vi } from 'vitest';
import {
  odczytajPozycje,
  odtworzPozycje,
  uruchomPozycjeListy,
  zapiszPozycje,
  zapiszPozycjePodKluczem,
} from '../../src/public/pozycja-listy.js';

const KLUCZ_A = `oms:pozycja-listy:v1:${'a'.repeat(64)}`;
const KLUCZ_B = `oms:pozycja-listy:v1:${'b'.repeat(64)}`;

function fakeSessionStorage(poczatkowe = {}) {
  const dane = new Map(Object.entries(poczatkowe));
  return {
    getItem: (klucz) => dane.get(klucz) ?? null,
    setItem: (klucz, wartosc) => dane.set(klucz, String(wartosc)),
    removeItem: (klucz) => dane.delete(klucz),
    wpisy: () => [...dane.entries()],
  };
}

describe('pozycja listy w jednej karcie przeglądarki', () => {
  it('dwa magazyny i dwa klucze adresów nie dzielą jednej globalnej pozycji', async () => {
    const kartaA = fakeSessionStorage();
    const kartaB = fakeSessionStorage();
    await zapiszPozycje({ storage: kartaA, klucz: KLUCZ_A, y: 840 });
    await zapiszPozycje({ storage: kartaB, klucz: KLUCZ_B, y: 125 });
    expect(await odczytajPozycje({ storage: kartaA, klucz: KLUCZ_A })).toBe(840);
    expect(await odczytajPozycje({ storage: kartaB, klucz: KLUCZ_B })).toBe(125);
    expect(await odczytajPozycje({ storage: kartaA, klucz: KLUCZ_B })).toBeNull();
  });

  it('nie zapisuje NaN, liczb ujemnych ani danych innych niż pozycja Y', async () => {
    const storage = fakeSessionStorage();
    for (const y of [NaN, Infinity, -1, '840', { y: 840 }]) {
      expect(await zapiszPozycje({ storage, klucz: KLUCZ_A, y })).toBe(false);
    }
    expect(storage.wpisy()).toEqual([]);
  });

  it('przewija tylko gdy wpis jest poprawny i wiersz z kotwicy nadal istnieje', async () => {
    const storage = fakeSessionStorage();
    const przewin = vi.fn();
    const cel = { id: 'zamowienie-123' };
    await zapiszPozycje({ storage, klucz: KLUCZ_A, y: 840 });
    await odtworzPozycje({
      storage,
      klucz: KLUCZ_A,
      hash: '#zamowienie-123',
      znajdzCel: () => cel,
      przewin,
    });
    expect(przewin).toHaveBeenCalledWith(0, 840);
  });

  it('usuwa starą pozycję i zostawia natywną kotwicę, gdy wiersz zniknął', async () => {
    const storage = fakeSessionStorage();
    const przewin = vi.fn();
    await zapiszPozycje({ storage, klucz: KLUCZ_A, y: 840 });
    await odtworzPozycje({
      storage,
      klucz: KLUCZ_A,
      hash: '#zamowienie-123',
      znajdzCel: () => null,
      przewin,
    });
    expect(przewin).not.toHaveBeenCalled();
    expect(await odczytajPozycje({ storage, klucz: KLUCZ_A })).toBeNull();
  });

  it('odmowa dostępu do sessionStorage nie wywala strony', async () => {
    const storage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(await zapiszPozycje({ storage, klucz: KLUCZ_A, y: 10 })).toBe(false);
    expect(await odczytajPozycje({ storage, klucz: KLUCZ_A })).toBeNull();
  });

  it('PRZ-100: znacznik skryptu szukany po początku adresu — src ma wersję (?v=…)', async () => {
    const selektory = [];
    const dokument = { querySelector: (s) => { selektory.push(s); return null; } };
    await uruchomPozycjeListy({ okno: {}, dokument });
    expect(selektory).toEqual(['script[data-klucz-listy][src^="/public/pozycja-listy.js"]']);
  });

  it('bootstrap używa wyłącznie sessionStorage i milczy, gdy przeglądarka go blokuje', async () => {
    const okno = {
      get sessionStorage() { throw new Error('SecurityError'); },
      get localStorage() { throw new Error('localStorage nie może być czytany'); },
    };
    const dokument = {
      querySelector: () => ({ dataset: { kluczListy: KLUCZ_A } }),
    };
    await expect(uruchomPozycjeListy({ okno, dokument })).resolves.toBeUndefined();
  });

  it('na produkcyjnym HTTP pagehide zapisuje synchronicznie pod kluczem z serwera', async () => {
    const storage = fakeSessionStorage();
    const zdarzenia = new Map();
    const okno = {
      sessionStorage: storage,
      get crypto() { throw new Error('HTTP LAN nie udostępnia crypto.subtle'); },
      scrollY: 913,
      location: { hash: '#zamowienie-123' },
      addEventListener: (nazwa, fn) => zdarzenia.set(nazwa, fn),
      requestAnimationFrame: vi.fn(),
      scrollTo: vi.fn(),
    };
    const dokument = {
      querySelector: () => ({ dataset: { kluczListy: KLUCZ_A } }),
      getElementById: () => ({ id: 'zamowienie-123' }),
    };
    await uruchomPozycjeListy({ okno, dokument });
    const wynik = zdarzenia.get('pagehide')();
    expect(wynik).toBeUndefined();
    expect(storage.wpisy()).toEqual([[KLUCZ_A, '913']]);
  });

  it('synchroniczny zapis odrzuca zły klucz i złą pozycję', () => {
    const storage = fakeSessionStorage();
    expect(zapiszPozycjePodKluczem({ storage, klucz: null, y: 2 })).toBe(false);
    expect(zapiszPozycjePodKluczem({ storage, klucz: 'oms:x', y: Infinity })).toBe(false);
    expect(storage.wpisy()).toEqual([]);
  });
});
