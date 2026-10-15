import { grosze, zl } from './kwoty.js';
import { wysylkaEfektywna, wysylkaZeSklepu } from './wysylka-kwota.js';

// ⚠️ `grosze` i `zl` MIESZKAJĄ TERAZ W `domain/kwoty.js` (07.08.2026) — tutaj są tylko
// przepuszczone dalej. Powód jest jeden i opisany tam w całości: ten moduł musiał zacząć
// pytać o efektywną kwotę wysyłki, a tamta ścieżka wraca do `pozycje-reczne.js`, który
// czytał `grosze` STĄD — czyli powstałby cykl importów wokół arytmetyki pieniędzy.
//
// Re-eksport zostaje, bo kilkanaście plików czyta obie funkcje z tego modułu i przepisywanie
// ich wszystkich przy okazji zupełnie innej poprawki byłoby zmianą bez związku ze sprawą.
export { grosze, zl };

// ⚠️ JEDYNA funkcja licząca wartość JEDNEJ pozycji — i to jest wymóg, nie preferencja.
// Czytają ją NARAZ: suma pod tabelą, kolumna „Suma" w wierszu, saldo wpłat, bariera
// arytmetyczna faktury i `gross_price` pozycji wysyłanej do inFaktu. Dopóki reguła istniała
// w czterech kopiach, kazda zmiana musiala trafic we wszystkie cztery — a nie trafiala.
//
// Regula: brutto_linii (tak, jak podal je sklep — z rabatem i wlasnym zaokragleniem),
// a dla wierszy sprzed dolozenia tej kolumny (brutto_linii = NULL) fallback cena_brutto
// * ilosc. Dziala tak samo dla pozycji ze sklepu i dla dopisanej recznie: tej drugiej
// `brutto_linii` liczy parsujNowaPozycje, tez w groszach.
export function wartoscPozycjiGrosze(p) {
  return p?.brutto_linii != null && String(p.brutto_linii).trim() !== ''
    ? grosze(p.brutto_linii, `pozycja "${p?.nazwa}"`)
    : grosze(p?.cena_brutto, `pozycja "${p?.nazwa}"`) * (Number(p?.ilosc) || 1);
}

// Suma WSZYSTKICH pozycji PLUS wysylka, w groszach — DOKLADNIE tak, jak liczy ja bariera
// arytmetyczna faktury. Wartosci sa EFEKTYWNE (po nadpisaniach recznych), bo warstwa odczytu
// naklada je zanim ktokolwiek tu zajrzy (nalozNadpisaniaPozycji w domain/pozycje-reczne.js,
// wolane w zLinii) — nie ma tu drugiej sciezki, ktora czytalaby wartosci sklepowe.
export function sumaPozycjiZWysylkaGrosze(zamowienie) {
  const zaLinie = (zamowienie?.pozycje ?? []).reduce((acc, p) => acc + wartoscPozycjiGrosze(p), 0);
  return zaLinie + wysylkaBruttoGrosze(zamowienie);
}

/**
 * Wartość LINII WYSYŁKI w groszach — cena efektywna × ilość efektywna.
 *
 * ⚠️ CZYTA NADPISANIE, a nie samą kolumnę `koszt_dostawy_brutto` (07.08.2026, prośba
 * właściciela: „wysyłka powinna być edytowalna tak samo jak produkty. Ilość oraz cena").
 * Wołanie `grosze(z.koszt_dostawy_brutto)` wprost — tak było do tego dnia — pokazywałoby
 * na karcie poprawioną kwotę, a do sumy i na fakturę brałoby sklepową.
 *
 * `? :`, nie samo `grosze(...)`: brak kolumny (stara baza) i darmowa dostawa mają obie
 * dawać 0, a nie rzucać na pustej/NULL wartości — dokładnie tak, jak liczyła to bariera od
 * początku. Ilość mnoży się DOPIERO po tym sicie: zero razy cokolwiek to dalej zero, ale
 * `grosze(null)` rzuciłoby, zanim ktokolwiek zdążyłby pomnożyć.
 */
export function wysylkaBruttoGrosze(zamowienie) {
  const w = wysylkaEfektywna(zamowienie);
  return w.cena_brutto ? grosze(w.cena_brutto, 'koszt dostawy') * w.ilosc : 0;
}

/** To samo, ale WEDŁUG SKLEPU — druga strona różnicy w `kwotaOczekiwanaGrosze`. */
export function wysylkaBruttoSklepGrosze(zamowienie) {
  const w = wysylkaZeSklepu(zamowienie);
  return w.cena_brutto ? grosze(w.cena_brutto, 'koszt dostawy') * w.ilosc : 0;
}

/** Kwota zamówienia W SKLEPIE, w groszach. NIGDY nie rośnie od naszych dopisków. */
export function kwotaZamowieniaGrosze(zamowienie) {
  return grosze(zamowienie?.kwota_brutto, 'kwota zamówienia');
}

// Ile ta pozycja jest warta ZDANIEM SKLEPU. Pozycja dopisana u nas jest warta dla sklepu
// ZERO, bo sklep o niej nie wie — i to jest cała treść tej funkcji.
//
// `p.sklep` (kopia wartości sprzed nadpisań) zakłada warstwa odczytu. Jej brak czytamy jako
// „ten wiersz nie przeszedł przez nakładkę, więc jego wartości SĄ sklepowe" — inaczej
// pominięcie nakładki gdziekolwiek w module podniosłoby kwotę oczekiwaną o całą wartość
// zamówienia i niedopłata zniknęłaby z ekranu.
function wartoscSklepowaPozycjiGrosze(p) {
  if (p?.zrodlo === 'reczna') return 0;
  return wartoscPozycjiGrosze(p?.sklep ?? p);
}

// ⚠️ KWOTA, KTÓREJ OCZEKUJEMY OD KLIENTA — i to ona, a nie `kwota_brutto`, jest miarą dla
// salda wpłat, bariery arytmetycznej i ostrzeżenia pod tabelą pozycji.
//
// Powód, dla którego `kwota_brutto` NIE MOŻE po prostu urosnąć, jest twardy: wpłata o źródle
// 'sklep' podąża za tą kolumną przy każdej synchronizacji (zsynchronizujWplateSklepu
// w db/platnosci.js). Gdyby ręczna pozycja ją podniosła, WPŁATA SKLEPOWA UROSŁABY RAZEM
// Z NIĄ i niedopłata zniknęłaby z ekranu — panel przestałby pokazywać, że klient jest nam
// winien pieniądze. To jest cały sens dopisywania pozycji, więc to jest miejsce, w którym
// nie wolno się pomylić.
//
// Liczymy RÓŻNICĄ wobec sklepu, a nie jako sumę efektywnych pozycji, i to też jest istotne:
// dzięki temu bariera arytmetyczna dalej sprawdza dokładnie to, co sprawdzała od początku —
// czy dane linii ZE SKLEPU sumują się do kwoty zamówienia W SKLEPIE. Suma efektywna po obu
// stronach porównania zamieniłaby barierę w tautologię, która nie łapie już niczego.
export function kwotaOczekiwanaGrosze(zamowienie) {
  // ⚠️ Zamowienie RECZNE nie ma pozycji sklepowych, wiec nie ma czego z czym porownywac:
  // kwota zamowienia JEST kwota oczekiwana (utrzymuje ja przeliczanie przy zapisie pozycji).
  // Bez tego warunku czlon roznicowy policzylby kazda pozycje DRUGI RAZ — bo dla pozycji
  // recznej `wartoscSklepowaPozycjiGrosze` to 0 — i kazde takie zamowienie wisialoby
  // z blokada „suma pozycji nie zgadza sie z kwota oczekiwana".
  if (zamowienie?.sklep === 'reczne') return kwotaZamowieniaGrosze(zamowienie);

  const roznicaGr = (zamowienie?.pozycje ?? []).reduce(
    (acc, p) => acc + wartoscPozycjiGrosze(p) - wartoscSklepowaPozycjiGrosze(p),
    0,
  );
  // ⚠️ WYSYŁKA MA TU SWÓJ WŁASNY CZŁON RÓŻNICOWY i bez niego cała ta poprawka nie działa
  // (07.08.2026). Kwota dostawy jest częścią `kwota_brutto` ze sklepu, więc podniesienie jej
  // u nas podnosi lewą stronę bariery (`sumaPozycjiZWysylkaGrosze`) i NIC po prawej — czyli
  // każde zamówienie z poprawioną wysyłką wisiałoby z „suma pozycji nie zgadza się z kwotą
  // zamówienia" i nie dałoby się do niego wystawić faktury. Dokładnie ten sam człon, co przy
  // pozycjach, i z dokładnie tego samego powodu.
  //
  // Bariera przez to NIE SŁABNIE: po skróceniu obu stron dalej sprawdza to, co sprawdzała od
  // początku — czy dane ZE SKLEPU (pozycje + dostawa) sumują się do kwoty zamówienia
  // W SKLEPIE.
  const roznicaWysylki = wysylkaBruttoGrosze(zamowienie) - wysylkaBruttoSklepGrosze(zamowienie);
  return kwotaZamowieniaGrosze(zamowienie) + roznicaGr + roznicaWysylki;
}
