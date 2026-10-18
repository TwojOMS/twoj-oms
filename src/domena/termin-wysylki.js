// TERMIN WYSYŁKI — JEDNA FORMUŁA SPÓŹNIENIA NA CAŁY PANEL (13.09.2026).
//
// Reguła jest treścią niezmiennika 4.49 i do tego dnia mieszkała WEWNĄTRZ `wiekZamowienia`
// (zegar na liście zamówień). Zakładka STATYSTYKI zadaje jej to samo pytanie o INNY moment
// — nie „czy zamówienie już się spóźnia", a „czy paczka, która WYSZŁA, wyszła w terminie".
// Druga kopia limitów, startu i odcięcia 12:00 rozjechałaby się przy pierwszej zmianie
// reguły, i to cicho: obie liczby wyglądałyby sensownie, a mówiłyby co innego.
//
// ⚠️ `wiekZamowienia` GAŚNIE po wysłaniu (oddaje `null`), a ten moduł działa DOKŁADNIE
// na wysłanych. Dlatego gaśnięcie zostaje tam, gdzie było — w tamtej funkcji — a tutaj
// nie ma go wcale.
import { dniRoboczeMiedzy } from './etap-przesylki.js';
import { dzienWarszawa, fmtDataCzas, fmtDataCzasKrotko } from './format-daty.js';
import { czyEkspres } from './wiek-zamowienia.js';

const czyRoboczy = (dzienIso) => {
  const dow = new Date(Date.parse(`${dzienIso}T00:00:00Z`)).getUTCDay();
  return dow !== 0 && dow !== 6;
};

/**
 * Typ zamówienia — rozstrzyga limit terminu.
 *
 * ⚠️ EKSPRES BIJE INDYWIDUALNE: zamówienie indywidualne z pozycją ekspresową ma 2 dni,
 * nie 7. Jedyny wyjątek od „kanał rozstrzyga typ", bo pozycja ekspresowa jest decyzją
 * silniejszą niż kanał (niezmiennik 4.49).
 *
 * ⚠️ EKSPORTOWANE OSOBNO, bo `wiekZamowienia` potrzebuje typu TAKŻE wtedy, gdy terminu nie
 * ma: napis „czeka na wpłatę" niesie typ, a `terminZamowienia` oddaje wtedy `null`. Bez tego
 * eksportu ta sama drabinka warunków stałaby w dwóch plikach i rozjechałaby się przy
 * pierwszej zmianie.
 */
export function typZamowienia(z) {
  if (czyEkspres(z?.pozycje)) return 'ekspres';
  if (z?.indywidualne) return 'indywidualne';
  if (String(z?.sklep ?? '').toLowerCase().startsWith('allegro')) return 'allegro';
  return 'krotki';
}

/**
 * Od czego liczy się zegar — albo `null`, gdy nie ma od czego.
 *
 * ⚠️ START NIE JEST JEDNYM POLEM: przedpłata liczy od `oplacone_at`, a POBRANIE i B2B od
 * `utworzone_at` — tam wpłaty przed wysyłką nie ma, więc zegar od opłacenia nigdy by nie
 * ruszył. Nieopłacona przedpłata oddaje `null`: to klient jest winien odpowiedź, nie my.
 *
 * ⚠️ EKSPORTOWANE OSOBNO z tego samego powodu, co `typZamowienia` — `wiekZamowienia` musi
 * odróżnić BRAK WPŁATY (napis do człowieka) od ŚMIECIOWEJ DATY (pusty opis), a obie te
 * sytuacje `terminZamowienia` zwija do jednego `null`.
 */
export function startZegara(z) {
  const odZlozenia = Boolean(z?.pobranie) || Boolean(z?.b2b);
  return (odZlozenia ? z?.utworzone_at : z?.oplacone_at) || null;
}

/**
 * Termin dla zamówienia: `{ typ, start, dzienStartu, limit, cutoffAllegro }` albo `null`,
 * gdy zegar NIE MA OD CZEGO ruszyć (nieopłacona przedpłata, śmieciowa data).
 *
 * ⚠️ ODCIĘCIE 12:00 JEST W CZASIE POLSKIM, a dane w bazie chodzą po UTC. Godzinę czyta
 * `fmtDataCzasKrotko` — TEN SAM przelicznik (`Europe/Warsaw`), którego używa kolumna z datą.
 * Gołe `new Date(...).getHours()` w kontenerze z TZ=UTC myliłoby się o godzinę zależnie od
 * pory roku (latem 12:00 PL = 10:00Z, zimą = 11:00Z), a mechanizm jest STREFOWY, nie stałym
 * przesunięciem — dlatego testy przypinają go w obu porach roku.
 */
export function terminZamowienia(z) {
  const typ = typZamowienia(z);
  const start = startZegara(z);
  if (!start) return null;

  // ⚠️ „Śmieciowa" data (niepusta, niesparsowalna) ma dać `null`, NIGDY wyjątek — ta sama
  // konwencja, co na liście: uszkodzone dane jednego wiersza nie mają prawa położyć ekranu.
  const dzienStartu = dzienWarszawa(start);
  if (!dzienStartu) return null;

  const godzinaStartu = Number(fmtDataCzasKrotko(start).slice(11, 13));
  const cutoffAllegro = typ === 'allegro' && czyRoboczy(dzienStartu) && godzinaStartu < 12;
  const limit = typ === 'indywidualne' ? 7 : typ === 'ekspres' ? 2 : cutoffAllegro ? 0 : 1;

  return { typ, start, dzienStartu, limit, cutoffAllegro };
}

/**
 * Dni robocze od startu do wysłania — albo `null`, gdy pytanie nie ma sensu.
 *
 * ⚠️⚠️ WYSŁANE PRZED OPŁACENIEM ODDAJE `null`, NIE ZERO. Zmierzone na produkcji 13.09.2026:
 * 15 zamówień ma `wyslane_at` wcześniejszy niż `oplacone_at`, a zamówienie 28171 o 217 godzin
 * (wysłane 4.08, opłacone 13.08). Arytmetyka bez tego warunku dałaby liczbę ujemną albo
 * — po `Math.max(0, …)` — zero, czyli „wysłane tego samego dnia": NAJLEPSZY możliwy wynik
 * dla przypadku, który w ogóle nie powinien wchodzić do statystyki.
 *
 * ⚠️⚠️ PORÓWNUJEMY CHWILE, NIE DNI — poprawka po recenzji 13.09.2026. Do tego dnia stało tu
 * `dzienWyslania < t.dzienStartu`, czyli porównanie DNI warszawskich, choć akapit wyżej
 * obiecywał chwile. Ujemny czas realizacji mieszczący się w jednej dacie przechodził wtedy
 * jako wysyłka wzorowa: opłacone 20:00 PL, wysłane 08:00 PL TEGO SAMEGO DNIA (12 h na minusie)
 * dawało `dniRoboczeDoWysylki = 0`, `tegoSamegoDnia = true`, `poTerminie = false`, a wiersz
 * „wysłane przed wpłatą" pokazywał przy tym 0. Na produkcji 13 z tych 15 zamówień różni się
 * „o sekundy", więc ekran obiecywał 15 wyłączeń, a pokazywał 1–2 — i chwalił się wynikiem
 * policzonym na przypadkach, których nie umie policzyć.
 *
 * ⚠️⚠️ CHWILE SKŁADA `fmtDataCzas`, A NIE `Date.parse`, i to jest tu treścią. Panel miesza
 * DWIE SKALE CZASU (patrz nagłówek domain/format-daty.js): nasze znaczniki są UTC z „Z",
 * a daty ze sklepu przychodzą BEZ strefy, już w czasie warszawskim. `Date.parse` czytałby
 * jedne i drugie jako UTC (kontener chodzi z TZ=UTC), więc wpłata sklepowa „08:30" wyglądałaby
 * na 10:30 PL i zamówienie nadane o 09:00 PL fałszywie wypadałoby z mianownika jako „wysłane
 * przed wpłatą" — dwie godziny latem, czyli dokładnie ta wada, tylko odwrócona. `fmtDataCzas`
 * sprowadza obie skale do zegara warszawskiego w stałym formacie `RRRR-MM-DD GG:MM:SS`, więc
 * porównanie NAPISÓW jest chronologiczne (ten sam trik, na którym stoi `dzienWarszawa`).
 *
 * ⚠️ RÓWNOŚĆ TO JESZCZE NIE „PRZED WPŁATĄ": nadanie w tej samej sekundzie, co start zegara,
 * jest normalną zerodniową wysyłką i MA zostać w mianowniku (typowe dla pobrania nadanego
 * w chwili złożenia). Stąd `<`, nie `<=`.
 */
export function dniRoboczeDoWysylki(z, termin = undefined) {
  if (!z?.wyslane_at) return null;
  const t = termin === undefined ? terminZamowienia(z) : termin;
  if (!t) return null;
  const chwilaWyslania = fmtDataCzas(z.wyslane_at);
  if (!chwilaWyslania || chwilaWyslania < fmtDataCzas(t.start)) return null;
  return dniRoboczeMiedzy(t.start, z.wyslane_at);
}

/** `true` / `false` / `null` (nie da się rozstrzygnąć). Po terminie ⇔ zużyte > limit. */
export function poTerminie(z) {
  const zuzyte = dniRoboczeDoWysylki(z);
  if (zuzyte === null) return null;
  const t = terminZamowienia(z);
  return zuzyte > t.limit;
}

/**
 * Czy paczka wyszła TEGO SAMEGO DNIA, co start zegara.
 *
 * ⚠️ DNIAMI WARSZAWSKIMI, nie różnicą chwil. Zamówienie opłacone 23:40 i wysłane 8:10
 * następnego dnia różni się o 8,5 godziny, ale klient dostał je NASTĘPNEGO dnia — i to
 * jest odpowiedź, po którą ktokolwiek sięga na ten ekran.
 */
export function tegoSamegoDnia(z) {
  if (dniRoboczeDoWysylki(z) === null) return null;
  return dzienWarszawa(terminZamowienia(z).start) === dzienWarszawa(z.wyslane_at);
}
