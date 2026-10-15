// Jeden format daty dla całego modułu OMS (Zadanie „strona główna", punkt C). Bez tego
// panel miesza dwie skale czasu, gołym okiem nierozróżnialne:
//
//  - NASZE znaczniki (poller, wpłaty ręczne, przesyłki, rezerwacja faktury, kolejka druku —
//    wszystkie przez `teraz()` = `new Date().toISOString()` w warstwie `db/`, kontener
//    chodzi z TZ=UTC) — to jest UTC i ma być PRZELICZONE na Europe/Warsaw;
//  - daty ZE SKLEPU (`utworzone_at`, data wpłaty z Woo) — przychodzą JUŻ w czasie sklepu,
//    bez oznaczenia strefy, więc mają być TYLKO przeformatowane, bez żadnej arytmetyki.
//
// Doklejenie obu do jednego formatera bez rozróżnienia pokazywałoby je na dwóch skalach
// w jednej tabeli — różnica to dwie godziny latem. Dokładnie ten błąd już się zdarzył przy
// znaczniku próby statusu DPD (naprawiony jawnym dopiskiem "UTC" w treści) — ten moduł
// zastępuje tamtą łatkę przeliczeniem, więc dopisek "UTC" znika (patrz zamowienie.ejs).
//
// Wzorowane na `dayWarsaw` z src/domain/dates.js (panel zamówień indywidualnych): ta sama
// technika — Intl.DateTimeFormat z timeZone: 'Europe/Warsaw' — rozszerzona o godzinę/minutę/
// sekundę, bo `dayWarsaw` liczy wyłącznie dniami. Wprost jej użyć się nie dało: tamta funkcja
// (i cały `dates.js`) zawsze przepuszcza wartość przez `new Date()`, czyli zakłada, że WEJŚCIE
// już ma jednoznaczną chwilę w czasie — dokładnie to, czego brakuje datom ze sklepu.

// "Z" na końcu albo przesunięcie +/-GG:MM (z dwukropkiem albo bez) — jedyny sygnał, że wartość
// niesie WŁASNE oznaczenie strefy, a nie że akurat da się ją sparsować przez `new Date()`.
const ZE_STREFA = /(?:Z|[+-]\d{2}:?\d{2})$/;

// Rozbiór wartości BEZ oznaczenia strefy — REGEXEM, nigdy przez `new Date()`: w kontenerze
// z TZ=UTC `new Date('2026-07-30T18:40:20')` czytałoby ten napis jako UTC, a przeliczenie na
// Warszawę przesunęłoby go o godzinę (dwie latem) do przodu — czyli dokładnie ten błąd, który
// ta funkcja ma wykluczyć. Godzina/minuta/sekunda są opcjonalne: sama data (np. z ręcznie
// wpisanego pola „data wpłaty", bez czasu) dostaje północ, żeby oba formaty wyjściowe miały
// zawsze komplet cyfr.
const WZORZEC_LOKALNY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

// ⚠️ FORMATER STOI NA POZIOMIE MODUŁU, NIE W FUNKCJI — i to jest zmiana o wydajności, nie
// o stylu. `Intl.DateTimeFormat` jest BEZSTANOWY dla stałej lokalizacji i opcji (datę bierze
// argumentem `formatToParts`), a jego budowa kosztuje: zmierzone na NAS-ie 13.09.2026, gdy
// tworzył się przy każdym wywołaniu, zakładka STATYSTYKI liczyła 802 ms dla 194 zamówień,
// bo `dzienWarszawa`/`fmtDataCzasKrotko` woła się po kilka razy na zamówienie. Ten sam koszt
// płaciła lista zamówień pod `/` przy każdym wierszu.
//
// hourCycle: 'h23' JAWNIE obok hour12: false — bez niego ICU potrafi oddać „24" zamiast
// „00" o północy w niektórych ustawieniach lokalnych, co dawałoby np. „2026-07-31 24:05".
const FORMATER_WARSZAWA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23',
});

function skladoweWarszawa(d) {
  const czesci = FORMATER_WARSZAWA.formatToParts(d);
  const g = (t) => czesci.find((x) => x.type === t)?.value;
  return {
    rok: g('year'), miesiac: g('month'), dzien: g('day'),
    godzina: g('hour'), minuta: g('minute'), sekunda: g('second'),
  };
}

function skladoweLokalne(s) {
  const m = WZORZEC_LOKALNY.exec(s);
  if (!m) return null;
  const [, rok, miesiac, dzien, godzina = '00', minuta = '00', sekunda = '00'] = m;
  return { rok, miesiac, dzien, godzina, minuta, sekunda };
}

// Regex sam przepuściłby „2026-13-40 25:99:99" — bez tej walidacji wartość bez strefy,
// ale bezsensowna, wyszłaby na ekran zamiast pustego stringa.
function poprawne({ miesiac, dzien, godzina, minuta, sekunda }) {
  return Number(miesiac) >= 1 && Number(miesiac) <= 12
    && Number(dzien) >= 1 && Number(dzien) <= 31
    && Number(godzina) <= 23 && Number(minuta) <= 59 && Number(sekunda) <= 59;
}

function sklej({ rok, miesiac, dzien, godzina, minuta, sekunda }, zSekundami) {
  const data = `${rok}-${miesiac}-${dzien}`;
  return zSekundami ? `${data} ${godzina}:${minuta}:${sekunda}` : `${data} ${godzina}:${minuta}`;
}

function sformatuj(wartosc, zSekundami) {
  if (wartosc == null) return '';
  const s = String(wartosc).trim();
  if (!s) return '';
  if (ZE_STREFA.test(s)) {
    const d = new Date(s);
    // Nieparsowalna wartość ma dać PUSTY STRING, nigdy „Invalid Date" na ekranie — karta
    // czyta to samo, co reszta panelu (np. `wart()` w zamowienie.ejs zamienia pusty string
    // na kreskę zamiast pokazywać usterkę renderowania).
    if (Number.isNaN(d.getTime())) return '';
    return sklej(skladoweWarszawa(d), zSekundami);
  }
  const skladowe = skladoweLokalne(s);
  if (!skladowe || !poprawne(skladowe)) return '';
  return sklej(skladowe, zSekundami);
}

/**
 * `RRRR-MM-DD GG:MM:SS` — wszędzie POZA kolumną „Zamówienie" w tabeli na stronie głównej.
 * Wartość z oznaczeniem strefy przelicza na Europe/Warsaw; wartość bez niego (data ze sklepu)
 * tylko przeformatowuje. Pusta / nieparsowalna wartość → pusty string.
 */
export const fmtDataCzas = (wartosc) => sformatuj(wartosc, true);

/**
 * `RRRR-MM-DD GG:MM` (bez sekund) — WYŁĄCZNIE kolumna „Zamówienie" w tabeli zamówień na
 * stronie głównej (brief zadania, punkt C). Ta sama reguła przeliczenia co `fmtDataCzas`.
 */
export const fmtDataCzasKrotko = (wartosc) => sformatuj(wartosc, false);

/**
 * Sam dzień kalendarzowy `RRRR-MM-DD` w czasie warszawskim — do porównywania z zakresem
 * dat z filtrów nad tabelą (domain/filtry-listy.js).
 *
 * ⚠️ Liczony TĄ SAMĄ funkcją, co data drukowana w wierszu, i to jest cały powód, dla którego
 * mieszka tutaj, a nie w module filtrów. Filtr „lipiec" ma brać dokładnie te zamówienia,
 * które w kolumnie „Zamówienie" mają lipcową datę — druga implementacja rozjechałaby się
 * na obu skalach czasu naraz: daty ze sklepu (bez strefy, czas Warszawy) i naszych własnych
 * znaczników UTC przy zamówieniach ręcznych (`utworzone_at` spada wtedy na `teraz()`).
 * Różnica to dwie godziny latem, czyli zamówienie z nocy widoczne w innym dniu, niż filtruje.
 */
export const dzienWarszawa = (wartosc) => sformatuj(wartosc, false).slice(0, 10);
