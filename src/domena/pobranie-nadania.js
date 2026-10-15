// Nadpisanie kwoty pobrania z formularza ekranu nadania — JEDNORAZOWE.
//
// ⚠️ TO SA PRAWDZIWE PIENIADZE: kwota pobrania to gotowka, ktora kurier inkasuje od
// klienta przy dorczeniu. Po nadaniu nie da sie jej odkrecic inaczej niz w panelu DPD,
// wiec kazda odmowa w tym module musi PADAC PRZED dotknieciem kuriera.
//
// Wzorzec jest ten sam, co przy kodzie paczkomatu (`punktOdbioru`): wartosc z formularza
// leci do klienta kuriera przy TYM nadaniu i NIE ZAPISUJE SIE do zamowienia. Trwala
// korekta kwoty ma swoje miejsce na karcie zamowienia (domain/wysylka.js:
// sprawdzZmianeMetody) — to jest INNE pole, nie duplikat tamtego.
//
// ⚠️ WARUNEK „NA KTOREJ PACZCE JEDZIE POBRANIE" ZOSTAJE W KLIENCIE KURIERA
// (kurierzy/dpd.js, kurierzy/inpost.js) — tam, gdzie widac cala koperte. Ten modul nie
// jest jego druga kopia ani obejsciem: on tylko pilnuje, zeby wartosc w ogole nie
// wyruszyla w strone kuriera tam, gdzie pola na ekranie nie ma.
//
// ⚠️ Od 04.09.2026 to NIE JEST juz zawsze „paczka nr 1": operator moze wskazac paczke
// N > 1 jako ZAMIENNIK pierwszej (wyrzucona etykieta). Oba miejsca — to i klient kuriera —
// czytaja wtedy TEN SAM fakt (`pobranieNaTejPaczce`), a nie kazde swoj numer.

// Kwota po normalizacji przecinka: same cyfry, opcjonalna czesc dziesietna. Number()
// samo w sobie NIE WYSTARCZA, bo przepuszcza zapisy, ktore do kuriera jada ZNAK W ZNAK:
// '1e3' i '0x10' sa dla niego skonczonymi liczbami, ale w <amount> to smiec, ktory DPD
// odczyta po swojemu albo odrzuci. Przy wadze paczki (domain/paczka.js) ta dziura jest
// nieszkodliwa, bo tam do kuriera idzie LICZBA; tu idzie NAPIS, wiec zamykamy ja.
// Kazda prawdziwa kwota ('212.90', '310,33', '31033', '212') przechodzi bez zmian.
const KSZTALT_KWOTY = /^\d+(\.\d+)?$/;

/**
 * Zwraca `{ kwotaPobrania }` — napis gotowy do wstawienia w kopertę kuriera — albo
 * `{ blad }` z czytelnym komunikatem dla operatora.
 *
 * `kwotaPobrania === undefined` znaczy „bez nadpisania": kurier weźmie kwotę z zamówienia,
 * dokładnie jak przed tą zmianą (nadanie zbiorcze, wywołania wsadowe, zamówienia bez
 * pobrania, paczki N > 1).
 *
 * ⚠️ PUSTE POLE TO ODMOWA, NIGDY „bez pobrania". DPD przy braku kwoty po prostu nie
 * wstawia `<cod>`: paczka jedzie jak przedpłacona, kurier nie inkasuje nic i NIGDZIE
 * nie ma błędu. To ten sam tryb cichej awarii, który recenzja złapała 01.08 przy
 * zakładaniu zamówienia — dlatego brak wartości musi być głośny.
 *
 * ⚠️ BEZ GÓRNEGO PROGU (decyzja właściciela 04.08). Literówka „31033" zamiast „310,33"
 * PRZEJDZIE do kuriera — i właśnie dlatego kwota faktycznie użyta jest zapisywana do logu
 * zamówienia (services/nadanie.js). To jedyna droga, żeby po miesiącu odpowiedzieć, ile
 * kurier miał zainkasować.
 */
export function parsujNadpisanieKwotyPobrania(
  dane,
  { pobranie, kolejnosc, pobranieNaTejPaczce = kolejnosc === 1 } = {},
) {
  // Pole istnieje na ekranie WYLACZNIE przy pobraniu i WYLACZNIE na paczce, na ktorej
  // pobranie naprawde jedzie, wiec wszystko, co przyjdzie poza tymi dwoma warunkami, jest
  // zadaniem spreparowanym albo stara karta — i ma zostac ZIGNOROWANE, nie przepuszczone
  // dalej. Kwota podrzucona do zamowienia przedplaconego zamienialaby je w pobraniowe;
  // kwota podrzucona do zwyklej dosylki znaczylaby, ze kurier inkasuje od klienta DRUGI RAZ.
  //
  // ⚠️ DRUGI WARUNEK PYTA O FAKT, NIE O NUMER (04.09.2026). Domyslnie `kolejnosc === 1`,
  // czyli dokladnie jak dotad; jawne `pobranieNaTejPaczce` przychodzi z trasy POST wtedy
  // i tylko wtedy, gdy operator ŚWIADOMIE zaznaczyl, ze ta paczka jest zamiennikiem
  // pierwszej (uzasadnienie: komentarz przy <cod> w kurierzy/dpd.js). Gdyby zostal sam
  // numer, pole na ekranie by bylo, a jego wartosc gina by po cichu — i zamiennik
  // pojechalby z kwota Z ZAMOWIENIA zamiast z tej, ktora operator wpisal.
  if (!pobranie || !pobranieNaTejPaczce) return { kwotaPobrania: undefined };

  const przycieta = String(dane?.kwota_pobrania ?? '').trim();
  if (!przycieta) {
    return {
      blad: 'Kwota pobrania jest pusta — podaj kwotę, którą kurier ma zainkasować od klienta. '
        + 'Puste pole NIE znaczy „nadaj bez pobrania": paczka pojechałaby jako przedpłacona, '
        + 'a kurier nie pobrałby ani złotówki. Panel niczego nie nadał.',
    };
  }

  // Przecinek dziesietny to polska klawiatura, nie blad wpisu — dokladnie jak przy wadze
  // paczki (domain/paczka.js). Do kuriera idzie zawsze wersja z KROPKA.
  const znormalizowana = przycieta.replace(',', '.');
  const liczba = Number(znormalizowana);
  if (!KSZTALT_KWOTY.test(znormalizowana) || !Number.isFinite(liczba)) {
    return {
      blad: `Nie umiem odczytać kwoty pobrania: „${przycieta}" — wpisz samą liczbę `
        + '(przecinek albo kropka dziesiętna, bez „zł" i bez spacji). Panel niczego nie nadał.',
    };
  }
  if (liczba <= 0) {
    return {
      blad: 'Kwota pobrania musi być większa od zera — paczka za pobraniem bez kwoty to towar '
        + 'oddany za darmo. Panel niczego nie nadał.',
    };
  }

  return { kwotaPobrania: znormalizowana };
}
