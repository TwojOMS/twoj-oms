// SLEDZENIE PRZESYLEK KANALU ALLEGRO (25.08.2026) — paczki, ktorych panel NIE NADAWAL.
//
// Do tego dnia wiersz z `kurier = 'allegro'` nie mial klienta w mapie kurierow i bylo to
// zapisane jako decyzja: „panel o te paczke nikogo nie pyta, bo nadal jej nie my"
// (kurierzy/index.js). Zalozenie okazalo sie za szerokie. Sonda na zywym API 25.08 pokazala,
// ze `GET /order/carriers/{carrierId}/tracking?waybill=` oddaje PELNA historie takze dla
// przesylek nadanych POZA panelem — Allegro Punkt i Allegro One wlacznie. Szesc paczek,
// ktore tego dnia wisialy w zakladce jako „bez ruchu", bylo w rzeczywistosci DORECZONYCH:
// panel nigdy o nie nie zapytal, wiec `status_kuriera` zostawal NULL, a regula „bez ruchu"
// liczyla wiek od nadania i alarmowala bez konca.
//
// ⚠️ NIE ZASTEPUJE DZIALAJACEGO TORU WzA PRZEZ DPD. Od 22.09.2026 inne WzA
// (One/ORLEN/DHL) korzystaja z tego klienta odczytu, z `carrier` i `packages.waybill`
// zapisanymi w zasobie WzA, a nie z numeru podwykonawcy.
//
// KONTRAKT jak `dpd.statusPrzesylki` i `inpost.statusPrzesylki`: `{ opis, at }` najnowszego
// zdarzenia albo `null`, gdy zdarzen nie ma. Dokladamy `kod` — Allegro jako jedyny oddaje
// wartosc MASZYNOWA (`code`) obok opisu, ktory jest TLUMACZENIEM zaleznym od
// `Accept-Language`. Etap liczy sie z kodu (domain/etap-przesylki.js: KODY_ALLEGRO).

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
    // ⚠️ BEZ IDENTYFIKATORA PRZEWOZNIKA NIE PYTAMY, i to nie jest nadgorliwosc. Zmierzone
    // 25.08 na wszystkich 74 identyfikatorach z `GET /order/carriers`: zly przewoznik oddaje
    // HTTP 200 z `trackingDetails: null` — czyli odpowiedz NIEODROZNIALNA od paczki swiezo
    // nadanej. Podstawienie stalej 'ALLEGRO' dzialaloby na dzisiejszych danych i milczaloby
    // przy pierwszej paczce, ktorej Allegro przypisze innego przewoznika.
    if (!carrier) return null;

    // ⚠️⚠️ BRAK KANALU TO NASZA USTERKA, NIE STAN PACZKI — i dlatego GLOSNO (31.08.2026).
    // Do tego dnia obie sytuacje konczyly sie tym samym cichym `null`, a roznica miedzy
    // nimi jest przepasc:
    //   • kanal PODANY, ale bez podpietego konta — panel czyta stary wiersz kanalu, ktory
    //     odlaczono. Stan POPRAWNY: paczka po prostu nie jest odpytywana.
    //   • kanalu NIE PODANO — wolajacy nie wie, o ktore konto pytac, czyli ktos podal
    //     atrape zamowienia. Tak wlasnie wolal czuwacz przesylek (`{ id }` bez `sklep`)
    //     i przez szesc dni „pytal" o trzy DORECZONE paczki, ktore wisialy jako
    //     „bez ruchu": zapisu nie bylo, bledu nie bylo, znacznik proby rosl co godzine.
    // Rzut ladu je w logu jako BLAD TECHNICZNY i zapala odznake „status u kuriera
    // niedostepny" (services/status-kuriera.js) — czyli ta sama usterka nastepnym razem
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

    // ⚠️ NAJNOWSZE PO `occurredAt`, NIE PO POZYCJI W TABLICY. Sonda 25.08 zwrocila pary
    // zdarzen o IDENTYCZNYM znaczniku czasu („Dispatched from sorting center" i „accepted
    // at the sorting center" o 00:48:01) — Allegro porzadkuje je czyms innym niz sam czas.
    // Branie ostatniego elementu dzialaloby na zmierzonych danych i przeklamalo przy
    // pierwszej zmianie kolejnosci po ich stronie.
    const najnowsze = zdarzenia.reduce((a, b) => ((czas(b) > czas(a)) ? b : a));
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
