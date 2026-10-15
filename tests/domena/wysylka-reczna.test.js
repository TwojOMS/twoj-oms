import { describe, it, expect } from 'vitest';
import {
  metodaWysylki, kwotaPobrania, metodaZeSklepu, kwotaPobraniaZeSklepu,
  metodaZmienionaRecznie, saNadpisanieWysylki, sprawdzZmianeMetody,
  czyPobranie, pobranieZeSklepu,
} from '../../src/domena/wysylka.js';

// Surowy wiersz z bazy — tak wyglada zamowienie ZANIM przejdzie przez zLinii().
// ⚠️ Od 2026-08-01 pobranie ma WLASNA kolumne obok metody — surowy wiersz musi ja miec,
// bo to ona (a nie nazwa metody) decyduje, czy kurier cos inkasuje.
const surowy = (o = {}) => ({
  metoda_wysylki: 'dpd', pobranie: 0, kwota_pobrania: null, wysylka_reczna_json: null, ...o,
});
const nadpisanie = (o) => JSON.stringify(o);

describe('metodaWysylki / kwotaPobrania — wartosci EFEKTYWNE', () => {
  it('bez nadpisania rzadzi sklep', () => {
    expect(metodaWysylki(surowy())).toBe('dpd');
    expect(metodaWysylki(surowy({ metoda_wysylki: 'nieznana' }))).toBe('nieznana');
  });

  it('nadpisanie wygrywa nad sklepem', () => {
    const w = surowy({ wysylka_reczna_json: nadpisanie({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '123.00' }) });
    expect(metodaWysylki(w)).toBe('dpd');
    expect(czyPobranie(w)).toBe(true);
    expect(kwotaPobrania(w)).toBe('123.00');
  });

  // ⚠️ TO SA PIENIADZE. Zamowienie zlozone jako pobranie ma w bazie kwote ze sklepu.
  // Przelaczenie na zwykla wysylke MUSI te kwote przestac uwzgledniac — inaczej klient
  // zaplaciby przelewem, a kurier zainkasowalby te sama kwote drugi raz.
  it('przelaczenie z pobrania na zwykla wysylke ZERUJE kwote pobrania', () => {
    const w = surowy({
      pobranie: 1, kwota_pobrania: '246.00',
      wysylka_reczna_json: nadpisanie({ metoda: 'dpd', pobranie: 0 }),
    });
    expect(metodaWysylki(w)).toBe('dpd');
    expect(czyPobranie(w)).toBe(false);
    expect(kwotaPobrania(w)).toBeNull();
  });

  // Ta sama regula bez zadnego nadpisania: kwota istnieje WYLACZNIE przy pobraniu.
  it('zwykla wysylka nigdy nie niesie kwoty pobrania, nawet gdy zostala w kolumnie', () => {
    expect(kwotaPobrania(surowy({ metoda_wysylki: 'dpd', pobranie: 0, kwota_pobrania: '246.00' }))).toBeNull();
  });

  it('pobranie ze sklepu bez nadpisania niesie kwote ze sklepu', () => {
    expect(kwotaPobrania(surowy({ metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '246.00' }))).toBe('246.00');
  });

  // Uszkodzony JSON (reczny UPDATE w pliku SQLite) nie moze wywalic karty — czytamy sklep.
  it('uszkodzone nadpisanie czyta sie jako brak nadpisania', () => {
    const w = surowy({ pobranie: 1, kwota_pobrania: '9.00', wysylka_reczna_json: '{niedomkniety' });
    expect(metodaWysylki(w)).toBe('dpd');
    expect(czyPobranie(w)).toBe(true);
    expect(kwotaPobrania(w)).toBe('9.00');
  });

  // Nadpisanie z metoda spoza listy obslugiwanej przez panel jest smieciem, a nie decyzja —
  // przepuszczenie go daloby `wybierzKuriera` metode, ktorej nie zna.
  it('nadpisanie z nieobslugiwana metoda jest ignorowane', () => {
    expect(metodaWysylki(surowy({ wysylka_reczna_json: nadpisanie({ metoda: 'inpost' }) }))).toBe('dpd');
    // ...i to samo dotyczy POBRANIA z takiego nadpisania: smiec nie ma prawa wlaczyc inkasa.
    const smiec = surowy({ pobranie: 0, wysylka_reczna_json: nadpisanie({ metoda: 'inpost', pobranie: 1 }) });
    expect(czyPobranie(smiec)).toBe(false);
  });
});

describe('funkcje sa IDEMPOTENTNE — dzialaja przed i po zLinii', () => {
  // Po zLinii `metoda_wysylki` to juz wartosc efektywna, a sklepowa lezy obok. Gdyby te
  // funkcje czytaly tylko `metoda_wysylki`, drugie wywolanie porownywaloby wartosc
  // efektywna z nia sama i oznaczenie „zmienione recznie" nigdy by sie nie pokazalo.
  const poZLinii = {
    metoda_wysylki: 'odbior_osobisty', pobranie: 0, kwota_pobrania: null,
    metoda_wysylki_sklep: 'dpd', pobranie_sklep: 1, kwota_pobrania_sklep: '246.00',
    wysylka_reczna_json: nadpisanie({ metoda: 'odbior_osobisty', pobranie: 0 }),
  };

  it('metodaZeSklepu / kwotaPobraniaZeSklepu czytaja kolumny _sklep, gdy sa', () => {
    expect(metodaZeSklepu(poZLinii)).toBe('dpd');
    expect(pobranieZeSklepu(poZLinii)).toBe(true);
    expect(kwotaPobraniaZeSklepu(poZLinii)).toBe('246.00');
  });

  it('metodaWysylki / kwotaPobrania oddaja to samo po ponownym wywolaniu', () => {
    expect(metodaWysylki(poZLinii)).toBe('odbior_osobisty');
    expect(czyPobranie(poZLinii)).toBe(false);
    expect(kwotaPobrania(poZLinii)).toBeNull();
  });

  it('oznaczenie „zmienione recznie" dziala po zLinii', () => {
    expect(metodaZmienionaRecznie(poZLinii)).toBe(true);
  });
});

describe('metodaZmienionaRecznie / saNadpisanieWysylki', () => {
  it('bez nadpisania nie ma ani oznaczenia, ani czego przywracac', () => {
    expect(metodaZmienionaRecznie(surowy())).toBe(false);
    expect(saNadpisanieWysylki(surowy())).toBe(false);
  });

  // Ta sama zasada, co przy danych klienta: oznaczenie liczy sie z ROZNICY wobec sklepu,
  // a przycisk przywracania — z obecnosci kolumny. Nadpisanie rowne sklepowi nie jest
  // juz zmiana, ale dalej lezy w bazie i dalej wypada je umiec skasowac.
  it('nadpisanie rowne sklepowi: bez oznaczenia, ale jest co przywracac', () => {
    const w = surowy({ wysylka_reczna_json: nadpisanie({ metoda: 'dpd', pobranie: 0 }) });
    expect(metodaZmienionaRecznie(w)).toBe(false);
    expect(saNadpisanieWysylki(w)).toBe(true);
  });

  // ⚠️ Najczestsza reczna korekta („ten sam DPD, ale za pobraniem") NIE RUSZA metody —
  // bez porownania pobrania karta pokazywalaby wlaczone inkaso bez ani slowa o tym, ze
  // zdecydowal o nim czlowiek, a przycisk przywracania wygladalby na niepotrzebny.
  it('samo włączenie pobrania, przy tej samej dostawie, JEST zmianą ręczną', () => {
    const w = surowy({
      metoda_wysylki: 'dpd', pobranie: 0,
      wysylka_reczna_json: nadpisanie({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '246.00' }),
    });
    expect(metodaZmienionaRecznie(w)).toBe(true);
  });
});

describe('sprawdzZmianeMetody — bramka na pieniadze', () => {
  it('zwykla wysylka nie wymaga kwoty i kwoty nie zapisuje', () => {
    expect(sprawdzZmianeMetody('dpd', false, '')).toEqual({
      nadpisanie: { metoda: 'dpd', pobranie: 0 }, blad: null,
    });
    expect(sprawdzZmianeMetody('dpd', false, '199.00').nadpisanie).toEqual({ metoda: 'dpd', pobranie: 0 });
  });

  it('pobranie z poprawna kwota przechodzi', () => {
    expect(sprawdzZmianeMetody('dpd', true, ' 246.00 ')).toEqual({
      nadpisanie: { metoda: 'dpd', pobranie: 1, kwota_pobrania: '246.00' }, blad: null,
    });
  });

  // ⚠️ Po rozdzieleniu dostawy i pobrania ta sprzeczna para DA SIE kliknac w formularzu
  // (dwa osobne pola), wiec bramka musi ja odrzucic — inkasuje KURIER, a przy odbiorze
  // osobistym kuriera nie ma.
  it('odbior osobisty z pobraniem jest odmowa', () => {
    const { nadpisanie: n, blad } = sprawdzZmianeMetody('odbior_osobisty', true, '100.00');
    expect(n).toBeNull();
    expect(blad).toMatch(/wykluczają się/i);
  });

  // ⚠️ SEDNO: paczka za pobraniem bez kwoty to paczka, za ktora kurier NIC nie zainkasuje,
  // a klient uzna, ze zaplacil przy odbiorze.
  it('pobranie BEZ kwoty jest odmowa', () => {
    const { nadpisanie: n, blad } = sprawdzZmianeMetody('dpd', true, '');
    expect(n).toBeNull();
    expect(blad).toMatch(/kwot[ęy] pobrania/i);
  });

  it('pobranie z kwota zero jest odmowa', () => {
    expect(sprawdzZmianeMetody('dpd', true, '0').blad).toMatch(/wieksz|większ/i);
    expect(sprawdzZmianeMetody('dpd', true, '0.00').blad).toMatch(/wieksz|większ/i);
  });

  it('kwota ujemna jest odmowa', () => {
    expect(sprawdzZmianeMetody('dpd', true, '-10.00').blad).toMatch(/wieksz|większ/i);
  });

  // Przecinek dziesietny to najczestsza literowka polskiej klawiatury, a Number('12,50')
  // to NaN — bez tej odmowy kwota poszlaby do DPD jako smiec albo cicho zniknela.
  it('kwota z przecinkiem dziesietnym jest odmowa, a nie cichym NaN', () => {
    expect(sprawdzZmianeMetody('dpd', true, '12,50').blad).toMatch(/nie umiem odczytać/i);
  });

  it('metoda spoza listy panelu jest odmowa', () => {
    expect(sprawdzZmianeMetody('inpost', false, '').blad).toMatch(/inpost/);
    expect(sprawdzZmianeMetody('', false, '').blad).toBeTruthy();
    expect(sprawdzZmianeMetody('nieznana', false, '').blad).toBeTruthy();
    // Stara nazwa („pobranie jako metoda") tez jest juz smieciem, a nie skrotem.
    expect(sprawdzZmianeMetody('dpd_pobranie', true, '246.00').blad).toMatch(/dpd_pobranie/);
  });
});
