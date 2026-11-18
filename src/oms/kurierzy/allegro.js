// ŚLEDZENIE PRZESYŁEK KANAŁU ALLEGRO — paczki, których panel NIE NADAWAŁ.
//
// Bez tego klienta wiersz z `kurier = 'allegro'` nie miałby kogo zapytać o status.
// Sonda na żywym API pokazała, że `GET /order/carriers/{carrierId}/tracking?waybill=`
// oddaje PEŁNĄ historię także dla przesyłek nadanych POZA panelem — Allegro Punkt
// i Allegro One włącznie. Bez pytania `status_kuriera` zostawałby NULL, a reguła
// „bez ruchu” liczyłaby wiek od nadania i alarmowała bez końca przy paczkach już doręczonych.
//
// ⚠️ NIE ZASTĘPUJE DZIAŁAJĄCEGO TORU WzA PRZEZ DPD. Inne WzA
// (One/ORLEN/DHL) korzystają z tego klienta odczytu, z `carrier` i `packages.waybill`
// zapisanymi w zasobie WzA, a nie z numeru podwykonawcy (domena/sledzenie-przesylki.js).
//
// KONTRAKT jak `dpd.statusPrzesylki` i `inpost.statusPrzesylki`: `{ opis, at }` najnowszego
// zdarzenia albo `null`, gdy zdarzen nie ma. Dokladamy `kod` — Allegro jako jedyny oddaje
// wartosc MASZYNOWA (`code`) obok opisu, ktory jest TLUMACZENIEM zaleznym od
// `Accept-Language`. Etap liczy sie z kodu (domena/etap-przesylki.js: KODY_ALLEGRO).

const czas = (z) => Date.parse(z?.occurredAt ?? '');

/**
 * @param allegroDla `(kanal) => klient Allegro tego konta albo null`
 *
 * ⚠️ KONTO WYBIERA SIE PO KANALE ZAMOWIENIA, tak samo jak w createAllegroWzaClient.
 * Kanaly to OSOBNE konta Allegro (np. `allegro_a` i `allegro_b`), a zasob
 * sledzenia widzi wylacznie przesylki wlasnego konta. Jeden klient „pierwszy z brzegu"
 * dzialalby dla jednego kanalu i MILCZAL dla drugiego — a milczenie ma tu ksztalt
 * `trackingDetails: null`, czyli jest nieodroznialne od paczki swiezo nadanej. Taka usterka
 * nie zapalilaby zadnej lampki.
 */
export function createAllegroSledzenieClient({ allegroDla }) {
  /**
   * @param numerListu numer z `przesylki.numer_listu`
   * @param kontekst   `{ carrier, kanal }` — przewoznik Z ODPOWIEDZI ALLEGRO
   *                   (`przesylki.carrier_allegro`) i kanal zamowienia (`zamowienia.sklep`)
   */
  async function statusPrzesylki(numerListu, kontekst = {}) {
    const carrier = String(kontekst?.carrier ?? '').trim();
    // ⚠️ BEZ IDENTYFIKATORA PRZEWOŹNIKA NIE PYTAMY, i to nie jest nadgorliwość. Zmierzone
    // na wszystkich identyfikatorach z `GET /order/carriers`: zły przewoźnik oddaje
    // HTTP 200 z `trackingDetails: null` — czyli odpowiedz NIEODROZNIALNA od paczki swiezo
    // nadanej. Podstawienie stalej 'ALLEGRO' dzialaloby na dzisiejszych danych i milczaloby
    // przy pierwszej paczce, ktorej Allegro przypisze innego przewoznika.
    if (!carrier) return null;

    // ⚠️⚠️ BRAK KANAŁU TO NASZA USTERKA, NIE STAN PACZKI — i dlatego GŁOŚNO.
    // Ciche `null` w obu sytuacjach byłoby błędem, bo różnica między nimi jest przepaść:
    //   • kanał PODANY, ale bez podpiętego konta — panel czyta stary wiersz kanału, który
    //     odłączono. Stan POPRAWNY: paczka po prostu nie jest odpytywana.
    //   • kanału NIE PODANO — wołający nie wie, o które konto pytać, czyli ktoś podał
    //     atrapę zamówienia (np. `{ id }` bez `sklep`). Wtedy doręczone paczki wisiałyby
    //     jako „bez ruchu”: zapisu nie ma, błędu nie ma, znacznik próby rośnie co przebieg.
    // Rzut ląduje w logu jako BŁĄD TECHNICZNY i zapala odznakę „status u kuriera
    // niedostępny” (moduly/wysylka/services/status-kuriera.js) — czyli ta sama usterka następnym razem
    // sama sie zglosi, zamiast czekac, az ktos zauwazy paczke stojaca w miejscu.
    if (kontekst?.kanal === null || kontekst?.kanal === undefined) {
      throw new Error('Śledzenie Allegro wywołane BEZ KANAŁU zamówienia — nie wiadomo, o które konto pytać.');
    }
    const allegro = allegroDla(kontekst.kanal);
    if (!allegro) return null;

    const d = await allegro.pobierzSledzenie(carrier, numerListu);

    // Zasob oddaje tablice — pytamy o jeden numer, ale bierzemy TEN, o ktory pytalismy,
    // zamiast pierwszego z brzegu.
    const wpis = (d?.waybills ?? []).find((w) => String(w?.waybill ?? '') === String(numerListu));
    const zdarzenia = wpis?.trackingDetails?.statuses;
    // `trackingDetails: null` znaczy „ten przewoznik tego numeru nie zna" i jest stanem
    // POPRAWNYM — tak samo jak pusta historia. Udawanie awarii dopisywaloby odznake
    // „status niedostepny" przy kazdym przebiegu czuwacza i nic by jej nie zdjelo.
    if (!Array.isArray(zdarzenia) || !zdarzenia.length) return null;

    // ⚠️ NAJNOWSZE PO `occurredAt`, NIE PO POZYCJI W TABLICY. Sonda zwróciła pary
    // zdarzen o IDENTYCZNYM znaczniku czasu („Dispatched from sorting center" i „accepted
    // at the sorting center" o 00:48:01) — Allegro porzadkuje je czyms innym niz sam czas.
    // Branie ostatniego elementu dzialaloby na zmierzonych danych i przeklamalo przy
    // pierwszej zmianie kolejnosci po ich stronie.
    const najnowsze = zdarzenia.reduce((a, b) => (czas(b) > czas(a) ? b : a));
    return {
      opis: najnowsze?.description ?? null,
      at: najnowsze?.occurredAt ?? null,
      kod: najnowsze?.code ?? null,
      historia: zdarzenia,
    };
  }

  // ⚠️ ZADNEJ FLAGI `bezSledzenia` — to cala roznica wobec kurierzy/allegro-wza.js. Ten
  // klient sledzenie MA, a flaga wpisana tu przez pomylke uciszylaby caly kanal po cichu.
  return { statusPrzesylki };
}
