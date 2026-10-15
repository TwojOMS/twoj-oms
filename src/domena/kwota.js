// Kwota dziesietna → GROSZE jako `INTEGER`. Jedna implementacja na caly magazyn.
//
// ⚠️ DLACZEGO W OSOBNYM MODULE, A NIE PRZY ALLEGRO. Ta sama regula obowiazuje DWA zrodla:
// oferty Allegro (`sellingMode.price.amount`) i produkty WooCommerce (`price`) — oba oddaja
// cene NAPISEM, oba lada w tej samej kolumnie `produkty_sklepowe.cena_gr`. Druga kopia tego
// przeliczenia rozjechalaby sie po cichu z pierwsza, a rozjazd widac dopiero przy porownaniu
// ceny ze sklepu z cena na Allegro — czyli w miejscu, w ktorym magazyn ma pomagac decydowac.
//
// ⚠️ WALUTY TEN MODUL NIE ZNA I NIE MA ZNAC. Sprawdza ja wolajacy: Allegro niesie walute przy
// kwocie (`domain/allegro-oferta.js` odmawia wszystkiemu poza PLN), a sklepy trzymaja ja
// w ustawieniu sklepu, nie przy produkcie.

// Kwota dziesietna BEZ znaku. Zmierzone ksztalty: „89.00", „79.0", „89", „74.90".
// Przecinka, spacji ani waluty w tych polach nie ma — a gdyby sie pojawily, maja byc bledem.
const WZOR_KWOTY = /^(\d+)(?:\.(\d+))?$/;

/**
 * @param {string|number|null|undefined} kwota
 * @param {string} opis — co to za pozycja; ląduje w komunikacie błędu.
 * @returns {number|null} grosze albo `null`, gdy kwoty NIE MA.
 *
 * ⚠️ PRZELICZENIE IDZIE PO CYFRACH NAPISU, NIE PRZEZ `Number(x) * 100`. Mnozenie robi sie
 * na dwojkowym zmiennoprzecinkowym i myli sie o grosz w obie strony:
 *   Number('1.005') * 100 === 100.49999999999999  → Math.round daje 100, ma byc 101
 *   Number('2.675') * 100 === 267.49999999999994  → Math.round daje 267, ma byc 268
 * Roznica jest niepowtarzalna i wychodzi dopiero przy porownaniu ceny z cena w sklepie.
 *
 * ⚠️ TRZY STANY, NIE DWA. Brak kwoty (`undefined`/`null`) to `null` — stan normalny. Kwota,
 * ktorej NIE UMIEMY przeliczyc, RZUCA: kolumna `cena_gr` jest `INTEGER`, a napis w niej psuje
 * filtr ceny w calym magazynie (porownanie napisu z liczba w SQLite jest zawsze falszywe),
 * `NaN` zapisuje sie jako `null`, a ciche zero znaczy „za darmo" i wpada w kazdy filtr od zera
 * w gore. To sa pieniadze — traktujemy ostrzej.
 */
export function groszeZKwoty(kwota, opis) {
  if (kwota === undefined || kwota === null) return null;

  const odmow = () => {
    throw new Error(`nie umiem przeliczyć kwoty "${String(kwota)}" na grosze (${opis})`);
  };

  // Liczba tez jest przeliczalna — ale przez SWOJ ZAPIS DZIESIETNY, nie przez mnozenie.
  // `String(1e21)` daje '1e+21', czyli postac, ktorej wzor nie przyjmie — i dobrze.
  const surowa = typeof kwota === 'number' ? String(kwota) : kwota;
  if (typeof surowa !== 'string') odmow();

  const dopasowanie = WZOR_KWOTY.exec(surowa.trim());
  if (!dopasowanie) odmow();

  const [, calosc, ulamek = ''] = dopasowanie;
  const grosze = Number(calosc) * 100 + Number(`${ulamek}00`.slice(0, 2));
  // Zaokraglenie arytmetyczne od TRZECIEJ cyfry po przecinku — na cyfrach, nie na floacie.
  const wynik = ulamek.length > 2 && Number(ulamek[2]) >= 5 ? grosze + 1 : grosze;
  // Kwota tak duza, ze przestaje byc dokladna, jest bledem, a nie zaokragleniem.
  if (!Number.isSafeInteger(wynik)) odmow();
  return wynik;
}
