import { describe, it, expect } from 'vitest';
import { rozkladUslug, udzialProcent } from '../../src/domena/statystyki-wysylki.js';

const z = (d = {}) => ({
  metoda_wysylki: 'dpd', metoda_wysylki_nazwa: null, pobranie: 0, ...d,
});

describe('rozkladUslug', () => {
  it('liczy pozycje i udziały, malejąco', () => {
    const { pozycje, suma } = rozkladUslug([
      z(), z(), z(),
      z({ metoda_wysylki: 'inpost_paczkomat' }),
    ]);
    expect(suma).toBe(4);
    expect(pozycje).toEqual([
      { etykieta: 'Kurier DPD', ile: 3, udzial: 75 },
      { etykieta: 'InPost Paczkomat', ile: 1, udzial: 25 },
    ]);
  });

  it('pełna nazwa usługi Allegro bije etykietę kubełka', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'allegro_punkt', metoda_wysylki_nazwa: 'Allegro Automat ORLEN Paczka' }),
      z({ metoda_wysylki: 'allegro_punkt', metoda_wysylki_nazwa: 'Allegro One Box, One Kurier' }),
    ]);
    expect(pozycje.map((p) => p.etykieta).sort())
      .toEqual(['Allegro Automat ORLEN Paczka', 'Allegro One Box, One Kurier']);
  });

  // ⚠️⚠️ POBRANIE NIE DZIELI USŁUGI NA DWA WIERSZE. `etykietaWysylki` dokłada „(pobranie)",
  // więc bezwarunkowe wołanie z flagą dałoby „Kurier DPD" i „Kurier DPD (pobranie)" jako dwie
  // usługi tego samego przewoźnika — a pytanie brzmiało „ile paczek jedzie którym".
  // Pobranie ma swoje miejsce w sekcji płatności.
  it('pobranie NIE rozdziela usługi', () => {
    const { pozycje } = rozkladUslug([z(), z({ pobranie: 1 })]);
    expect(pozycje).toEqual([{ etykieta: 'Kurier DPD', ile: 2, udzial: 100 }]);
  });

  // ⚠️⚠️ NAZWA ALLEGRO SAMA NIESIE „pobranie" — i to jest DRUGA droga rozdzielenia usługi,
  // niezależna od flagi `pobranie` sprawdzanej wyżej. Prośba właściciela z 13.09.2026 wprost:
  // „Allegro Kurier DPD pobranie policz razem z Allegro Kurier DPD, tak samo Allegro
  // Paczkomaty InPost pobranie". Zmierzone na produkcji: 13 zamówień „Allegro Kurier DPD
  // pobranie" i 1 „Allegro Paczkomaty InPost pobranie" stały jako osobne usługi obok swoich
  // odpowiedników bez pobrania — czyli ta sama usługa kuriera liczona dwa razy.
  it('nazwa Allegro z dopiskiem „pobranie" liczy się razem z tą samą usługą bez niego', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'allegro_dpd', metoda_wysylki_nazwa: 'Allegro Kurier DPD' }),
      z({ metoda_wysylki: 'allegro_dpd', metoda_wysylki_nazwa: 'Allegro Kurier DPD pobranie', pobranie: 1 }),
      z({ metoda_wysylki: 'allegro_paczkomat', metoda_wysylki_nazwa: 'Allegro Paczkomaty InPost' }),
      z({ metoda_wysylki: 'allegro_paczkomat', metoda_wysylki_nazwa: 'Allegro Paczkomaty InPost pobranie', pobranie: 1 }),
    ]);
    expect(pozycje).toEqual([
      { etykieta: 'Allegro Kurier DPD', ile: 2, udzial: 50 },
      { etykieta: 'Allegro Paczkomaty InPost', ile: 2, udzial: 50 },
    ]);
  });

  // ⚠️ Przyrostek po słowie „pobranie" też schodzi. Komentarz przy `etykietaWysylki`
  // dokumentuje zmierzony 25.08.2026 wariant „Allegro Kurier DPD pobranie (AD)" — dziś go
  // w bazie nie ma, ale Allegro dokłada takie ogonki bez pytania nas o zdanie.
  it('przyrostek po „pobranie" nie tworzy trzeciego wiersza', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'allegro_dpd', metoda_wysylki_nazwa: 'Allegro Kurier DPD' }),
      z({ metoda_wysylki: 'allegro_dpd', metoda_wysylki_nazwa: 'Allegro Kurier DPD pobranie (AD)', pobranie: 1 }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Allegro Kurier DPD', ile: 2, udzial: 100 }]);
  });

  // ⚠️ BARIERA NA PRZESADĘ: „pobranie" wolno obciąć TYLKO jako dopisek na końcu. Nazwa,
  // w której to słowo jest treścią usługi, nie ma prawa zniknąć ani zlać się z inną.
  it('nie obcina nazwy, w której „pobranie" nie jest końcowym dopiskiem', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'allegro_inne', metoda_wysylki_nazwa: 'Pobranie kurierem po Polsce' }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Pobranie kurierem po Polsce', ile: 1, udzial: 100 }]);
  });

  it('nieznana metoda ma własny wiersz, nie wypada', () => {
    const { pozycje } = rozkladUslug([z({ metoda_wysylki: 'nieznana' })]);
    expect(pozycje).toEqual([{ etykieta: 'Nieznana metoda', ile: 1, udzial: 100 }]);
  });

  // Sortowanie stabilne: bez drugiego kryterium kolejność dwóch usług o tej samej liczbie
  // skacze między odświeżeniami i ekran wygląda, jakby dane się zmieniały.
  it('przy równej liczbie sortuje alfabetycznie po polsku', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'odbior_osobisty' }),
      z({ metoda_wysylki: 'inpost_paczkomat' }),
    ]);
    expect(pozycje.map((p) => p.etykieta)).toEqual(['InPost Paczkomat', 'Odbiór osobisty']);
  });

  it('pusta lista daje zero pozycji i sumę 0, nie dzielenie przez zero', () => {
    expect(rozkladUslug([])).toEqual({ pozycje: [], suma: 0 });
  });

  it('udział ma jedno miejsce po przecinku', () => {
    const { pozycje } = rozkladUslug([z(), z(), z({ metoda_wysylki: 'inpost_paczkomat' })]);
    expect(pozycje[0].udzial).toBe(66.7);
    expect(pozycje[1].udzial).toBe(33.3);
  });
});

// ⚠️⚠️ WADA WAŻNA Z RECENZJI 13.09.2026: rozkład czytał SUROWE kolumny `metoda_wysylki`
// i `metoda_wysylki_nazwa`, a kolumna „Dostawa" na liście robi to inaczej — przez
// `nazwaDostawy` (domain/wysylka.js), która bierze metodę i pobranie z `wysylka_reczna_json`
// i UNIEWAŻNIA nazwę od Allegro po ręcznej zmianie. Dwa ekrany panelu mówiły o tej samej
// paczce co innego: lista „Kurier DPD", statystyka „InPost Paczkomat".
describe('rozkladUslug — metoda EFEKTYWNA, ta sama co w kolumnie „Dostawa"', () => {
  const nadpisanie = (o) => ({ wysylka_reczna_json: JSON.stringify(o) });

  it('ręczna poprawka metody przenosi zamówienie do właściwego przewoźnika', () => {
    const { pozycje } = rozkladUslug([
      z({
        metoda_wysylki: 'inpost_paczkomat',
        metoda_wysylki_nazwa: 'Allegro Paczkomat InPost',
        ...nadpisanie({ metoda: 'dpd' }),
      }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Kurier DPD', ile: 1, udzial: 100 }]);
  });

  // ⚠️ TO JEST DRUGA POŁOWA REGUŁY `nazwaDostawy` i nie wolno jej zgubić: poprawka samego
  // PUNKTU ODBIORU to nadal TA SAMA USŁUGA, więc nazwa od Allegro zostaje prawdziwa.
  // Szerszy warunek (`metodaZmienionaRecznie`) gubiłby nazwę przy najczęstszej korekcie,
  // jaką robi operator — i rozsypywałby jedną usługę na dwa wiersze rozkładu.
  it('poprawka samego punktu odbioru NIE unieważnia nazwy usługi', () => {
    const { pozycje } = rozkladUslug([
      z({
        metoda_wysylki: 'allegro_paczkomat',
        metoda_wysylki_nazwa: 'Allegro Paczkomat InPost',
        ...nadpisanie({ metoda: 'allegro_paczkomat', punkt_odbioru: 'WRO10B' }),
      }),
      z({ metoda_wysylki: 'allegro_paczkomat', metoda_wysylki_nazwa: 'Allegro Paczkomat InPost' }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Allegro Paczkomat InPost', ile: 2, udzial: 100 }]);
  });

  // ⚠️ Włączenie POBRANIA z karty też unieważnia nazwę od Allegro (opisuje wybór kupującego),
  // ale NIE ma prawa rozdzielić usługi na dwa wiersze — to zostaje decyzją z 1.08.2026.
  it('ręczne włączenie pobrania unieważnia nazwę, ale nie rozdziela usługi', () => {
    const { pozycje } = rozkladUslug([
      z({
        metoda_wysylki: 'dpd',
        metoda_wysylki_nazwa: 'Allegro Kurier DPD',
        ...nadpisanie({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '212.90' }),
      }),
      z({ metoda_wysylki: 'dpd' }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Kurier DPD', ile: 2, udzial: 100 }]);
  });

  // ⚠️ Wiersz PO NAKŁADCE (`zLinii` — tak przychodzi z `zamowieniaOkresu`) niesie metodę
  // efektywną w `metoda_wysylki`, a sklepową w `metoda_wysylki_sklep`. Reguła musi być
  // IDEMPOTENTNA: policzona drugi raz na własnym wyniku ma dać to samo.
  it('działa tak samo na wierszu po nakładce, jak na surowym', () => {
    const { pozycje } = rozkladUslug([
      z({
        metoda_wysylki: 'dpd',
        metoda_wysylki_sklep: 'inpost_paczkomat',
        pobranie_sklep: 0,
        metoda_wysylki_nazwa: 'Allegro Paczkomat InPost',
        ...nadpisanie({ metoda: 'dpd' }),
      }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'Kurier DPD', ile: 1, udzial: 100 }]);
  });

  // ⚠️ Śmieciowy JSON w kolumnie (ręczny UPDATE w pliku SQLite) nie ma prawa wywalić ekranu
  // ani zmienić przewoźnika — wtedy rządzi sklep. Ta sama zasada, co przy karcie.
  it('uszkodzone nadpisanie zostawia metodę ze sklepu', () => {
    const { pozycje } = rozkladUslug([
      z({ metoda_wysylki: 'inpost_paczkomat', wysylka_reczna_json: '{niepoprawny' }),
    ]);
    expect(pozycje).toEqual([{ etykieta: 'InPost Paczkomat', ile: 1, udzial: 100 }]);
  });
});

// ⚠️⚠️ `udzialProcent` nie miała ani jednego testu bezpośredniego — a gałęzi `null` nie da
// się dobić przez `rozkladUslug`: przy zerowej sumie mapa kubełków jest pusta, więc
// `udzialProcent` w ogóle nie zostaje wywołana. Recenzja to wykorzystała: podmiana
// `zCzego ?` na `zCzego || 1` (zero przestaje dawać `null`) przeszła przez CAŁĄ suitę
// zielono. Dwa kolejne zadania tej gałęzi importują tę funkcję i liczą swoje procenty na
// niej — cicha regresja tutaj rozeszłaby się po całym ekranie. Stąd strażnik wprost na
// samej funkcji, osobno od `rozkladUslug`.
describe('udzialProcent', () => {
  it('zerowy mianownik daje null, nigdy 0 — brak wiedzy to nie to samo co zero', () => {
    expect(udzialProcent(0, 0)).toBeNull();
    expect(udzialProcent(5, 0)).toBeNull();
  });

  it('zerowy licznik przy niezerowym mianowniku daje 0, nie null — to już wiedza, nie jej brak', () => {
    expect(udzialProcent(0, 5)).toBe(0);
  });

  it('zaokrągla do jednego miejsca po przecinku', () => {
    // 1/7 bez zaokrąglenia to 0,142857142857... — długie rozwinięcie, które musi
    // wylądować dokładnie na 14.3, nie „gdzieś blisko".
    expect(udzialProcent(1, 7)).toBe(14.3);
  });

  it('pełny udział daje 100', () => {
    expect(udzialProcent(5, 5)).toBe(100);
  });
});
