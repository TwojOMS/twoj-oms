import { bladOperatora } from './bledy.js';
import {
  zl, sumaPozycjiZWysylkaGrosze, kwotaOczekiwanaGrosze, wartoscPozycjiGrosze, wysylkaBruttoGrosze,
} from './suma-pozycji.js';
import { wysylkaEfektywna } from './wysylka-kwota.js';
// Stawka DOKUMENTU liczy sie z NIP-u nabywcy (domena/wdt.js): nabywca z panstwa UE dostaje
// 0% (WDT), kazdy inny STAWKA_VAT z domena/vat.js — to jest ta "swiadoma zmiana z testem",
// ktora zapowiadal komentarz w vat.js. Nabywce dokumentu rozstrzyga daneFaktury(z), czyli
// TA SAMA regula, ktora wskazuje NIP kartotece inFaktu (services/faktura.js) — reczna
// poprawka numeru na karcie zmienia wiec stawke razem z nabywca, nigdy osobno.
import { czyWdt } from './wdt.js';
import { daneFaktury } from './dane-faktury.js';
import { czyStawkaVat, stawkaPozycji } from './vat.js';

// Nazwa pozycji dostawy na fakturze — jedna, eksportowana stala. Korekta (domena/korekta-pozycje.js)
// musi rozpoznac wlasna pozycje dostawy po TEJ SAMEJ nazwie; druga kopia literalu rozjechalaby
// sie przy pierwszej zmianie i korekta przestalaby ja widziec, po cichu.
export const NAZWA_DOSTAWY = 'Dostawa';

// gross_price pozycji to SUMA LINII, nie cena za sztuke — sprawdzone na prawdziwej
// fakturze z konta (quantity=18, unit_net_price=2602, net_price=46829, gross_price=57600).
// Cena jednostkowa siedzi w polach z prefiksem `unit_`. Wysylanie tu ceny jednostkowej
// przy jednoczesnym `quantity` zanizalo fakture *quantity*-krotnie.
//
// Suma linii idzie do inFaktu DOKLADNIE taka, jaka podal ja sklep (`brutto_linii`).
// Wczesniej panel liczyl ja jako `cena_jednostkowa * ilosc`, a cene jednostkowa sam
// wczesniej otrzymal dzielac te sama sume przez ilosc i zaokraglajac do groszy — czyli
// sam produkowal rozjazd, o ktory sam sie potem odbijal na barierze:
//   3 szt., linia 100,00 zl (rabat 10%) -> 33,33 x 3 = 99,99 -> ODMOWA, deterministycznie.
// Bariera zostaje nietknieta; przestaje tylko strzelac do naszych wlasnych zaokraglen.
//
// ⚠️ Pozycje bierzemy z `z.pozycje`, czyli JUZ EFEKTYWNE: warstwa odczytu (zLinii
// w db/zamowienia.js) naklada na nie reczne nadpisania, a pozycje dopisane recznie leza
// w tej samej liscie co sklepowe. Dzieki temu na fakturze lada DOKLADNIE te nazwy, ilosci
// i kwoty, ktore panel pokazuje na karcie — bez ani jednej linii kodu o tym tutaj.
//
// Netto pozycji recznej NIE JEDZIE do inFaktu i nie ma prawa pojechac: wysylamy brutto
// (`gross_price`), tak samo jak przy pozycjach ze sklepu, a podatek liczy program faktur.
//
// Stawka PER POZYCJA: stawka wybrana w wierszu idzie na fakturę (i dalej do KSeF) oraz na proformę. Pozycja
// ręczna niesie własną (`vat`), sklepowa/Allegro i dostawa dostają domyślną z Ustawień (`stawkaDomyslna` —
// czytajStawkeDomyslna, moduly/faktury/db/stawka-vat.js). Nabywca z UE (WDT) wymusza 0 na KAŻDEJ linii — RAZ
// na dokument, bo dokument ma jednego nabywcę.
//
// ⚠️ `stawkaDomyslna` jest WYMAGANA. Brak = wyjatek, nie ciche „23”: instalacja z domyslna 8 dostalaby inaczej
// fakture z 23 z kazdego miejsca, ktore zapomnialo ja podac — bez bledu i bez sladu.
//
// `zw: true` (wyłącznie program wbudowany) przepuszcza stawkę „zw” — domyślną i pozycji ręcznej.
// Bez flagi (inFakt) „zw” jak dotąd: domyślna „zw” = wyjątek, ręczna „zw” = stawka domyślna. WDT bez zmian (0).
// `zwolniona: true` (sprzedawca zwolniony z VAT, `sprzedawcaZwolniony`) — numer UE nabywcy to NIE WDT,
// stawki jak dla polskiego nabywcy. Bez flagi jak dotąd.
/**
 * @param {any} z
 * @param {{ stawkaDomyslna?: string|number, zw?: boolean, zwolniona?: boolean }} [opcje]
 */
export function pozycjeDokumentu(z, { stawkaDomyslna, zw = false, zwolniona = false } = {}) {
  if (!czyStawkaVat(stawkaDomyslna, { zw })) {
    throw new Error(`pozycjeDokumentu: brak albo zła stawka domyślna („${stawkaDomyslna}”).`);
  }
  // Przy 0% (WDT) kwoty zamowienia SA kwotami netto (netto = brutto), wiec cala arytmetyka
  // ponizej — suma linii, dostawa, bariera — dziala bez ani jednej zmiany.
  const wdt = czyWdt(daneFaktury(z).nip, { zwolniona });
  const stawkaLinii = (p) => (wdt ? '0' : stawkaPozycji(p, stawkaDomyslna, { zw }));
  const stawka = wdt ? '0' : String(stawkaDomyslna);
  const services = z.pozycje.map((p) => ({
    name: p.nazwa,
    quantity: p.ilosc,
    // TA SAMA funkcja, ktora liczy sume pod tabela, saldo wplat i bariere nizej
    // (domena/suma-pozycji.js) — razem z fallbackiem dla wierszy, ktorych migracja nie
    // umiala uzupelnic. Wczesniej ta regula stala tu w osobnej kopii.
    gross_price: wartoscPozycjiGrosze(p),
    tax_symbol: stawkaLinii(p),
  }));
  // Dostawa (i dostawy grupy scalonej) — stawka domyslna. Prawnie dostawa dzieli los towaru glownego; przy
  // pozycjach z roznymi stawkami bierzemy domyślną firmy.

  // Koszt dostawy jest czescia `kwota_brutto`, ale NIE ma go w `line_items` — bez tej
  // pozycji faktura jest zanizona o wysylke przy kazdym platnym transporcie.
  //
  // ⚠️ KWOTA I ILOSC SA EFEKTYWNE — TA SAMA funkcja, co suma pod tabela
  // i bariera nizej (domena/suma-pozycji.js), wiec poprawiona cena dostawy albo druga paczka
  // trafiaja na fakture dokladnie tak, jak pokazuje je karta. Czytanie tu samej kolumny
  // `koszt_dostawy_brutto` znaczyloby fakture na kwote sklepowa przy karcie pokazujacej inna
  // — i barierę, ktora by to zlapala dopiero jako rozjazd, bez wskazania przyczyny.
  //
  // `gross_price` to SUMA LINII (patrz naglowek), wiec ilosc idzie obok niej, a nie zamiast:
  // dokladnie tak samo jak przy pozycjach wyzej.
  const dostawa = wysylkaBruttoGrosze(z);
  // Zamówienie GRUPY scalonej (domena/scalanie.js, `zamowienieGrupy`) niesie wysyłki
  // członków osobno — każda idzie osobną pozycją (główne „Dostawa”, dołączone „Dostawa — zamówienie
  // N”). Główne zostaje pod NAZWA_DOSTAWY, bo po niej korekta poznaje dostawę. Linie MUSZĄ dać
  // kwotę wysyłki, którą liczy bariera niżej — bariera nie sumuje `services`, więc rozjazd
  // przeszedłby po cichu; stąd odmowa tutaj.
  const wysylkiGrupy = z.grupa?.wysylki;
  if (Array.isArray(wysylkiGrupy)) {
    const suma = wysylkiGrupy.reduce((s, w) => s + w.grosze, 0);
    if (suma !== dostawa) {
      throw bladOperatora(`Suma wysyłek grupy (${zl(suma)} zł) nie zgadza się z wysyłką zamówienia scalonego (${zl(dostawa)} zł). `
        + 'Faktura NIE została wystawiona.');
    }
    for (const w of wysylkiGrupy) {
      services.push({
        name: w.glowne ? NAZWA_DOSTAWY : `${NAZWA_DOSTAWY} — zamówienie ${w.numer}`,
        quantity: w.ilosc ?? 1,
        gross_price: w.grosze,
        tax_symbol: stawka,
      });
    }
    return services;
  }
  if (dostawa > 0) {
    const ilosc = wysylkaEfektywna(z).ilosc;
    services.push({ name: NAZWA_DOSTAWY, quantity: ilosc, gross_price: dostawa, tax_symbol: stawka });
  }
  return services;
}

// BARIERA ARYTMETYCZNA — jedyna tania ochrona przed wystawieniem zlego dokumentu w
// inFakcie. Sprawdza wynik, nie zalozenia: lapie i zapomniana pozycje dostawy, i pomylke
// jednostkowa/suma linii, i zaokraglenia (33.33 x 3 = 99.99 przy totalu 100.00), i kazdy
// przyszly przypadek, ktorego dzis nie przewidzielismy. Porownanie w groszach, na liczbach
// calkowitych.
//
// Wystawiony dokument idzie dalej do KSeF (automat albo wysyłka ręczna) — i to jest powód tej
// bariery. Źle wystawiony dokument trzeba by ręcznie znaleźć i skasować w programie faktur PRZED
// wysyłką; kto tego nie złapie na czas, dostaje dokument w KSeF, którego już się nie kasuje,
// tylko koryguje. Bariera złapała już realny błąd zaniżający faktury o koszt dostawy — dlatego
// zostaje nietknięta.
export function sprawdzSumeDokumentu(services, z) {
  // Jedyna dziura w barierze: zamowienie na 0,00 zl bez ani jednej pozycji przechodzilo
  // ja bezblednie (suma pustej listy = 0 = kwota zamowienia) i do inFaktu leciala faktura
  // z pustym `services`. Dokument bez pozycji to też realny błąd w programie faktur — trzeba go
  // ręcznie znaleźć i skasować, a jeśli nikt się nie zorientuje przed wysyłką do KSeF,
  // trafi tam i też będzie wymagał korekty.
  if (services.length === 0) {
    throw bladOperatora(
      'Zamówienie nie ma żadnej pozycji do zafakturowania — faktury bez pozycji panel nie wystawi. '
      + 'Sprawdź zamówienie w sklepie.',
    );
  }
  // Suma liczona WSPÓLNĄ funkcją z domena/suma-pozycji.js, DOKŁADNIE tą samą, którą karta
  // zamówienia (domena/tabela-pozycji.js) używa do wiersza „Razem" i ostrzeżenia pod tabelą
  // „Pozycje" — jedno miejsce arytmetyki, żeby bariera i karta nigdy nie mogły pokazać
  // innej liczby.
  //
  // ⚠️ Druga strona porównania to KWOTA OCZEKIWANA OD KLIENTA (kwota ze sklepu plus to, co
  // dopisaliśmy u siebie), a nie sama `kwota_brutto`. Porównanie z kwotą sklepową kazałoby
  // barierze odmawiać KAŻDEMU zamówieniu z dopisaną pozycją — czyli dokładnie tym, przy
  // których dopłata musi trafić na fakturę.
  //
  // Bariera przez to NIE SŁABNIE i to jest sedno: kwota oczekiwana powstaje jako kwota ze
  // sklepu plus RÓŻNICA naszych poprawek wobec sklepu, więc po skróceniu obu stron
  // porównanie sprawdza dalej dokładnie to, co sprawdzało od początku — czy dane linii
  // ZE SKLEPU sumują się do kwoty zamówienia W SKLEPIE.
  const suma = sumaPozycjiZWysylkaGrosze(z);
  const oczekiwana = kwotaOczekiwanaGrosze(z);
  if (suma !== oczekiwana) {
    throw bladOperatora(
      `Suma pozycji faktury (${zl(suma)} zł) nie zgadza się z kwotą zamówienia (${zl(oczekiwana)} zł). `
      + 'Faktura NIE została wystawiona — popraw zamówienie albo wystaw dokument ręcznie w inFakcie.',
    );
  }
}
