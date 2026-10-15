import { bladOperatora } from './bledy.js';

// Klienci rozliczani ZBIORCZO: wiele zamowien w miesiacu, jedna faktura na koniec.
//
// ⚠️⚠️ ZRODLEM WARUNKOW JEST TABELA `klienci`, NIE `.env` (od 2026-08-24). Do tego dnia
// caly kontrakt stal w jednym ciagu `OMS_KLIENCI_ZBIORCZY`, a klucz, nazwa, NIP i rabat
// RÓWNOLEGLE w bazie stalych klientow — panel znal wiec dwie prawdy naraz i sam to
// przyznawal pasem rozjazdu bez przycisku. `parsujKlientowZbiorczych` ponizej zyje juz
// WYLACZNIE dla migracji jednorazowej (db/klienci.js) i nie ma innego konsumenta.
//
// ⚠️ Dopasowanie idzie po NIP-ie, NIE po adresie mailowym. Mail jest wlasciwoscia
// KORESPONDENCJI (klient moze napisac z innego adresu, z telefonu, przez pracownika),
// a NIP jest wlasciwoscia PODMIOTU — i to on trafia na fakture. Dopasowanie po mailu
// cicho wypchneloby zamowienie poza okres rozliczeniowy, a wykrylibysmy to dopiero
// przy fakturze, ktora nie zgadza sie z rzeczywistoscia.
const POLA = 7;

function liczba(surowe, opis, numerWpisu) {
  const oczyszczone = String(surowe).trim();
  // Literowka ma wywalic start uslugi. Ciche zero w rabacie znaczy „sprzedajemy po
  // cenach katalogowych", a w progu darmowej dostawy — „kazda wysylka za darmo".
  // Oba bledy kosztuja pieniadze i oba wygladaja w konfiguracji poprawnie.
  // Pusty ciag (albo sam biale znaki, np. podwojny dwukropek "::" po literowce)
  // to najczestsza postac tej literowki — a Number('') zwraca 0, wiec sam warunek
  // na skonczonosc by go nie zlapal. Trzeba odrzucic pustke PRZED konwersja.
  if (oczyszczone === '') {
    throw new Error(`OMS_KLIENCI_ZBIORCZY: ${opis} musi być nieujemną liczbą, wpis nr ${numerWpisu}`);
  }
  const n = Number(oczyszczone);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`OMS_KLIENCI_ZBIORCZY: ${opis} musi być nieujemną liczbą, wpis nr ${numerWpisu}`);
  }
  return n;
}

/**
 * Kody krajow Unii uzywane w numerach VAT-UE. „EL" to Grecja (nie „GR"), „XI" to Irlandia
 * Polnocna po brexicie — oba wygladaja na literowke i oba sa poprawne.
 *
 * ⚠️ LISTA JEST ZAMKNIETA CELOWO. Bez niej „brak", „nie dotyczy" czy „NIP 676..." wpisane
 * recznie w archiwalnym zamowieniu udawalyby numer zagraniczny, bo kazde zaczyna sie od
 * dwoch liter. Zamkniety slownik znaczy, ze prefiks jest KODEM KRAJU albo nie ma go wcale.
 */
const KODY_KRAJOW_UE = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
]);

/**
 * Numer podatkowy w postaci porownywalnej: polski NIP to SAME CYFRY, numer z innego
 * panstwa Unii to KOD KRAJU + znaki alfanumeryczne, wielkimi literami.
 *
 * ⚠️⚠️ POLSKI NUMER MUSI WYCHODZIC STAD TAK SAMO JAK PRZED 26.08.2026 — i to jest
 * najwazniejsze zdanie w tej funkcji. Cala kolumna `klienci.nip`, cala kolumna
 * `zamowienia.nip` i kazde przypisanie zamowienia do okresu porownuja wynik tej
 * normalizacji. Gdyby polski numer zaczal wychodzic inaczej, panel z dnia na dzien
 * przestalby rozpoznawac WSZYSTKICH dotychczasowych klientow — i zrobilby to po cichu,
 * bo „nie znalazlem karty" wyglada dokladnie tak samo jak „klient jeszcze nic nie zamowil".
 * Dlatego „PL" jest ZDEJMOWANE, a nie zachowywane jak pozostale kody.
 *
 * ⚠️ „SK1234567890" NIE MA sie zlac z „1234567890". To dwa rozne podmioty (drugi to
 * najzwyczajniej czyjs polski NIP), a ciche zrownanie ich podstawiloby na fakture
 * nabywce, ktorego nikt nie wskazal.
 *
 * ⚠️ FUNKCJA NIE RZUCA — jest uzywana takze do SZUKANIA (klientPoNip, zamowieniaPoNip)
 * po danych archiwalnych, gdzie w polu NIP-u lezy wszystko, co ktos kiedys wpisal.
 * Odmowa nalezy do sciezki ZAPISU (`znormalizujKlienta` w domain/klient-staly.js);
 * tutaj numer nierozpoznany oddaje po prostu same cyfry, tak jak dotad.
 */
export function normalizujNip(nip) {
  const surowy = String(nip ?? '').replace(/[\s.\-/]/g, '').toUpperCase();
  const dopasowanie = surowy.match(/^([A-Z]{2})([0-9A-Z]{2,14})$/);
  if (dopasowanie) {
    const [, kraj, reszta] = dopasowanie;
    // Polski numer trzymamy bez prefiksu — patrz zdanie o zgodnosci wstecz wyzej.
    if (kraj === 'PL') return reszta.replace(/\D/g, '');
    if (KODY_KRAJOW_UE.has(kraj)) return `${kraj}${reszta}`;
  }
  return surowy.replace(/\D/g, '');
}

/**
 * Czy numer da sie rozpoznac — czyli czy to same cyfry (polski NIP) albo kod kraju Unii
 * z numerem. Sluzy WYLACZNIE sciezce zapisu, zeby odmowic zamiast zapisac kawalek.
 *
 * ⚠️⚠️ DOSTAJE NAPIS SUROWY, NIE ZNORMALIZOWANY — i to jest cala sztuczka. Wolane na
 * wyniku `normalizujNip` bylo BEZUZYTECZNE: „XY123456" przechodzi tam przez galaz
 * „nieznany kraj" i wychodzi jako „123456", czyli jako poprawne cyfry. Straznik pytalby
 * wiec o wartosc JUZ OKROJONA i przepuszczal dokladnie ten przypadek, przed ktorym mial
 * bronic. Litery trzeba zobaczyc, zanim znikna.
 */
export function nipRozpoznany(surowy) {
  const t = String(surowy ?? '').replace(/[\s.\-/]/g, '').toUpperCase();
  if (t === '') return false;
  if (/^\d+$/.test(t)) return true;
  const m = t.match(/^([A-Z]{2})([0-9A-Z]{2,14})$/);
  return Boolean(m && (m[1] === 'PL' || KODY_KRAJOW_UE.has(m[1])));
}

export function parsujKlientowZbiorczych(env) {
  const surowe = env?.OMS_KLIENCI_ZBIORCZY;
  // Brak sekcji to POPRAWNY tryb, nie awaria: nikt nie jest rozliczany zbiorczo,
  // a panel robi swoje. Tak samo jak brak sekcji InPost w config.js.
  if (surowe === undefined || surowe === '') return [];

  return surowe.split(',').map((wpisSurowy, indeks) => {
    // Operator dostaje lokalizację błędu; dane klienta nie trafiają do logu startu.
    const numerWpisu = indeks + 1;
    const wpis = wpisSurowy.trim();
    const czesci = wpis.split(':').map((s) => s.trim());
    if (czesci.length !== POLA) {
      throw new Error(
        `OMS_KLIENCI_ZBIORCZY: wpis musi mieć ${POLA} pól `
        + '(klucz:nazwa:nip:rabat%:próg zł:obsługa zł:kurier zł), '
        + `wpis nr ${numerWpisu}`,
      );
    }
    const [klucz, nazwa, nip, rabat, prog, obsluga, kurier] = czesci;
    if (!klucz || !nazwa || !normalizujNip(nip)) {
      throw new Error(`OMS_KLIENCI_ZBIORCZY: klucz, nazwa i NIP są wymagane, wpis nr ${numerWpisu}`);
    }
    return {
      klucz,
      nazwa,
      nip: normalizujNip(nip),
      rabatProcent: liczba(rabat, 'rabat', numerWpisu),
      progDarmowejDostawyGr: Math.round(liczba(prog, 'próg darmowej dostawy', numerWpisu) * 100),
      oplataObslugiGr: Math.round(liczba(obsluga, 'opłata za obsługę', numerWpisu) * 100),
      oplataKurierskaGr: Math.round(liczba(kurier, 'opłata kurierska', numerWpisu) * 100),
    };
  });
}

/** Kwoty umowy — trzy pola, jedna nazwa dla komunikatu i dla mapowania. */
const KWOTY_UMOWY = [
  ['progDarmowejDostawyGr', 'prog_darmowej_dostawy_gr', 'próg darmowej dostawy'],
  ['oplataObslugiGr', 'oplata_obslugi_gr', 'opłata za obsługę'],
  ['oplataKurierskaGr', 'oplata_kurierska_gr', 'opłata kurierska'],
];

/**
 * Warunki umowy zbiorczej z wiersza tabeli `klienci` — albo `null`, gdy ten klient
 * rozliczany zbiorczo nie jest.
 *
 * ⚠️ KSZTALT OBIEKTU JEST TEN SAM, co oddawal `parsujKlientowZbiorczych` z `.env` (do
 * 2026-08-24 jedyne zrodlo tych warunkow). Dzieki temu `oplataDlaZamowienia`,
 * `przypiszDoOkresu`, `stawkaKontraktowa` i nabywca faktury okresowej nie zmieniaja ANI
 * JEDNEJ reguly — zmienia im sie wylacznie to, skad obiekt przychodzi.
 *
 * ⚠️⚠️ BRAKUJACA KWOTA TO ODMOWA, NIGDY ZERO — i to jest cala tresc tej funkcji.
 * Ta trasa konczy sie doklejeniem oplaty do zamowienia. Zamowienie zalozone bez naleznej
 * oplaty wyglada poprawnie na ekranie i wychodzi na jaw dopiero na fakturze zbiorczej na
 * koniec miesiaca — czyli wtedy, gdy poprawka wymaga KOREKTY DOKUMENTU. Podstawione zero
 * znaczyloby przy progu „kazda wysylka za darmo", a przy oplacie „nie pobieramy": oba
 * wygladaja w bazie poprawnie i oba kosztuja pieniadze. Glosna odmowa kosztuje trzydziesci
 * sekund na karcie klienta.
 *
 * ⚠️ `rabatProcent` czytamy z tej samej tabeli, bo baza jest zrodlem stawki rabatu
 * od 2026-08-23 (przewodnik 4.52) — nie ma tu drugiego zrodla do uzgadniania.
 */
export function umowaZbiorcza(wiersz) {
  if (!wiersz || Number(wiersz.rozliczenie_zbiorcze) !== 1) return null;

  const brakujace = KWOTY_UMOWY
    .filter(([, kolumna]) => !Number.isInteger(wiersz[kolumna]))
    .map(([, , opis]) => opis);
  if (brakujace.length) {
    throw bladOperatora(
      `Klient „${wiersz.nazwa}" jest oznaczony jako rozliczany zbiorczo, ale nie ma`
      + ` ustalonych warunków: ${brakujace.join(', ')}. Uzupełnij je na karcie klienta —`
      + ' bez nich panel nie wie, czy i ile doliczyć do zamówienia.',
    );
  }

  return {
    klucz: wiersz.klucz,
    nazwa: wiersz.nazwa,
    nip: normalizujNip(wiersz.nip),
    rabatProcent: Number(wiersz.rabat_procent ?? 0),
    ...Object.fromEntries(KWOTY_UMOWY.map(([pole, kolumna]) => [pole, wiersz[kolumna]])),
  };
}
