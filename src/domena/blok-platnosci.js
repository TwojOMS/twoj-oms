import { saldoWplat } from './platnosci.js';
import { czyPobranie } from './wysylka.js';
import { ETYKIETY_TERMINU } from './termin-platnosci.js';
import { numerDniaZNapisu, zNumeruDnia, sklejDate } from './kalendarz.js';
import { dzienWarszawa } from './format-daty.js';
import { zlotowki } from './kwoty.js';

// BLOK „DO ZAPŁATY / PRZELEW" — wspólny kawałek trzech maili (22.08.2026): proformy, faktury
// i przypomnienia o płatności.
//
// ⚠️ MODUŁ CZYSTY: składa MODEL i nic nie renderuje. Ten sam obiekt układa potem tabela HTML
// i wersja tekstowa tej samej wiadomości — mail idzie multipartem, więc dwie ścieżki liczenia
// dałyby klientowi dwie różne kwoty w jednej kopercie.
//
// ⚠️⚠️ ARYTMETYKI PIENIĘDZY TU NIE MA ANI JEDNEJ LINII. Kwota bierze się z `saldoWplat`,
// czyli z tej samej funkcji, którą karta pokazuje operatorowi — mail i ekran nie mają prawa
// twierdzić czegoś innego o tym samym długu.

const dzisiajWarszawa = () => dzienWarszawa(new Date().toISOString());

/**
 * Termin płatności uzgodniony PRZY ZAMÓWIENIU, przeliczony na datę.
 *
 * Zwraca `{ etykieta, data, minal }` albo `null`, gdy nic nie uzgodniono (stan normalny —
 * większość zamówień sklepowych).
 *
 * ⚠️ DATA LICZONA OD ZŁOŻENIA ZAMÓWIENIA, nie od dziś: „14 dni" uzgodnione przy zamówieniu
 * z 21 sierpnia mija 4 września niezależnie od tego, kiedy operator kliknie przypomnienie.
 * Liczona na NUMERZE DNIA (`domain/kalendarz.js`) — ta sama arytmetyka, co na fakturze;
 * dodawanie milisekund gubi dzień przy zmianie czasu, a termin przesunięty o dobę to termin,
 * którego klient nie uzgodnił.
 *
 * ⚠️ WARIANTY SŁOWNE NIE MAJĄ DATY. „Płatne przy odbiorze" i „płatne od razu" nie wyznaczają
 * dnia — dopisanie im daty złożenia zamówienia byłoby wymyśleniem terminu.
 */
export function terminZamowienia(z, dzis = dzisiajWarszawa()) {
  const wybor = String(z?.termin_platnosci ?? '').trim();
  if (wybor === '') return null;

  const etykieta = ETYKIETY_TERMINU[wybor] ?? wybor;
  // ⚠️ WARUNEK UPROSZCZONY (recenzja 22.08.2026): `PRZY_ODBIORZE` i `BEZ_TERMINU` to napisy
  // słowne, więc żaden z nich i tak nie przejdzie `^\d+$` — pierwsze dwa człony warunku były
  // zawsze zawarte w trzecim i nigdy nie decydowały same. Sam regex wystarcza: „nie jest
  // liczbą dni" obejmuje oba warianty słowne I każdy inny napis, którego panel nie rozpozna.
  if (!/^\d+$/.test(wybor)) {
    return { etykieta, data: null, minal: false };
  }

  const start = numerDniaZNapisu(dzienWarszawa(z?.utworzone_at ?? ''));
  if (start === null) return { etykieta, data: null, minal: false };

  const numerTerminu = start + Number(wybor);
  const data = sklejDate(zNumeruDnia(numerTerminu));
  // ⚠️⚠️ PORÓWNANIE PRZEZ NUMER DNIA, NIE PRZEZ STRING (recenzja 22.08.2026). `String(dzis) >
  // data` porównywało NAPISY: `String(null)` to „null", `String(undefined)` to „undefined",
  // `String(new Date(...))` zaczyna się od dnia tygodnia („Sat Aug…") — a każdy z tych napisów
  // jest LEKSYKALNIE WIĘKSZY od jakiejkolwiek daty ISO „RRRR-MM-DD", bo zaczyna się literą,
  // nie cyfrą. Efekt: KAŻDY mail fałszywie oskarżał klienta o zwłokę, gdy `dzis` nie było
  // gotowym napisem w tym formacie. Numer dnia nieparsowalnego `dzis` daje `null` →
  // `minal: false` — nigdy nie oskarżamy klienta o zaległość, której nie umiemy stwierdzić.
  const numerDzis = numerDniaZNapisu(String(dzis ?? ''));
  return { etykieta, data, minal: numerDzis !== null && numerDzis > numerTerminu };
}

export const STAN_PLATNOSCI = Object.freeze({
  DO_ZAPLATY: 'do_zaplaty',
  POKRYTE: 'pokryte',
  POBRANIE: 'pobranie',
  BRAK_RACHUNKU: 'brak_rachunku',
  BLAD: 'blad',
});

/**
 * Powód, dla którego mail ma (albo nie ma) mówić o pieniądzach — JEDNO źródło prawdy, czytane
 * i przez `blokPlatnosci` (czy pokazać tabelę przelewu), i przez `zamkniecie`
 * w `wiadomosc-platnicza.js` (co napisać zamiast niej).
 *
 * ⚠️⚠️ POWSTAŁO Z BŁĘDU (recenzja 22.08.2026): `blokPlatnosci` oddawał `null` z CZTERECH
 * różnych powodów, a `wiadomosc-platnicza.js` czytał tylko `Boolean(platnosc)` i przy KAŻDYM
 * z nich pisał „Zamówienie jest opłacone — dziękujemy." Realny scenariusz, który to psuło:
 * FAKTURA DO ZAMÓWIENIA ZA POBRANIEM — klient dostawał zapewnienie, że nic nie jest winien,
 * zanim kurier cokolwiek zainkasował. Ta funkcja nazywa wszystkie cztery powody z osobna,
 * żeby oba miejsca czytały JEDNĄ decyzję, a nie dwa niezależne przybliżenia tej samej sprawy.
 *
 * ⚠️ KOLEJNOŚĆ STRAŻNIKÓW JEST ISTOTNA:
 *   1. POBRANIE — FAKT o zamówieniu (kurier inkasuje), niezależny od tego, czy saldo w ogóle
 *      da się policzyć i czy mamy gdzieś skonfigurowany rachunek. Wygrywa z każdym innym
 *      powodem: klientowi za pobraniem należy się zdanie o kurierze, nie o naszym configu
 *      ani o błędzie wyceny.
 *   2. BŁĄD WYCENY (`saldoWplat` → `stan: 'blad'`) — DOTĄD POŁKNIĘTY, bo `blokPlatnosci`
 *      traktował go tak samo jak „pokryte" (`stan !== 'niedoplata'`). Nie wiemy, ile klient
 *      jest winien, więc NIE WOLNO twierdzić ani że zapłacił, ani ile ma jeszcze przelać.
 *   3. POKRYTE (i NADPŁATA — obie znaczą „nie ma czego płacić") — sprawdzane PRZED brakiem
 *      rachunku: gdy klient już zapłacił, to, czy mamy gdzieś skonfigurowany numer konta,
 *      jest bez znaczenia.
 *   4. BRAK RACHUNKU — nasza usterka konfiguracji, sprawdzana na końcu: zostaje jeszcze
 *      wtedy, gdy naprawdę jest coś do zapłaty (niedopłata), a mail i tak nie ma dokąd
 *      skierować przelewu.
 */
export function stanPlatnosci(z, { rachunek } = {}) {
  if (czyPobranie(z)) return STAN_PLATNOSCI.POBRANIE;

  const saldo = saldoWplat(z);
  if (saldo.stan === 'blad') return STAN_PLATNOSCI.BLAD;
  if (saldo.stan !== 'niedoplata') return STAN_PLATNOSCI.POKRYTE;

  if (!String(rachunek ?? '').trim()) return STAN_PLATNOSCI.BRAK_RACHUNKU;

  return STAN_PLATNOSCI.DO_ZAPLATY;
}

/**
 * Dane do przelewu albo `null`, gdy przelewu nie ma być.
 *
 * `null` z KAŻDEGO stanu innego niż `STAN_PLATNOSCI.DO_ZAPLATY` — a tych stanów są CZTERY
 * i każdy znaczy co innego, choć skutek dla tej funkcji jest ten sam (bloku nie pokazujemy).
 * Pełny opis każdego stoi przy `stanPlatnosci` wyżej — TEJ SAMEJ funkcji, którą czyta też
 * zdanie zamykające w `wiadomosc-platnicza.js`, żeby oba miejsca zgadzały się co do POWODU,
 * a nie tylko co do samego faktu „nie pokazujemy bloku".
 *
 * `tytul` przychodzi ARGUMENTEM, bo zależy od tematu maila (numer proformy, numer faktury,
 * a w ostateczności numer zamówienia) — a nie od samego zamówienia.
 */
export function blokPlatnosci(z, opcje = {}) {
  const { rachunek, odbiorca, tytul, dzis = dzisiajWarszawa() } = opcje;
  if (stanPlatnosci(z, opcje) !== STAN_PLATNOSCI.DO_ZAPLATY) return null;

  const saldo = saldoWplat(z);
  const termin = terminZamowienia(z, dzis);
  return {
    doZaplaty: zlotowki(saldo.roznicaZl),
    odbiorca: String(odbiorca ?? '').trim(),
    rachunek: String(rachunek).trim(),
    tytul: String(tytul ?? '').trim(),
    // Zdanie o terminie zmienia BRZMIENIE po jego minięciu — „termin 14 dni — do 04.09"
    // przeczytane 10 września brzmi jak informacja, a nie jak zaległość.
    termin: termin?.data
      ? (termin.minal ? `termin minął ${termin.data}` : `${termin.etykieta} — do ${termin.data}`)
      : (termin?.etykieta ?? null),
  };
}
