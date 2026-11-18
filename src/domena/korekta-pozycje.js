import { grosze, zl } from './kwoty.js';
// Nazwa pozycji dostawy na fakturze. Dawniej byla LITERALEM w `domena/pozycje-faktury.js`
// (`name: 'Dostawa'`); druga kopia rozjechalaby sie przy pierwszej zmianie i korekta
// przestalaby rozpoznawac wlasna pozycje dostawy — po cichu. Eksportowana STAMTAD.
import { NAZWA_DOSTAWY } from './pozycje-faktury.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';
import { powodOdmowyKorektyBezDostawy } from './zwrot.js';

/**
 * Pary „stan przed / stan po" dla `POST /v3/async/corrective_invoices.json`.
 *
 * ⚠️⚠️ `services` W KOREKCIE TO PARY, A NIE LISTA ZWRACANYCH POZYCJI. Każda pozycja
 * oryginalnej faktury musi wystąpić — te nietknięte przepisujemy bez zmian.
 *
 * ⚠️⚠️ PARA TO DWA WIERSZE, NIE JEDEN Z POLAMI `_before_correction`. Zmierzone na prawdziwej
 * korekcie odczytanej z API: dwa obiekty o tym samym `group`,
 * rozróżnione flagą `correction` — `false` = stan PRZED, `true` = stan PO. Pól
 * `quantity_before_correction` / `gross_price_before_correction` na encji NIE MA (jest
 * `sale_date_before_correction`, ale to inna sprawa — data sprzedaży, nie pozycja).
 *
 * ⚠️ To pomiar ODCZYTU. Zapisu nikt jeszcze nie potwierdził, a inFakt potrafi być
 * asymetryczny. PIERWSZA PRAWDZIWA KOREKTA IDZIE POD NADZOREM CZŁOWIEKA i to ona
 * rozstrzyga ostatecznie.
 *
 * ⚠️⚠️ „PRZED" POCHODZI Z INFAKTU, NIE Z ZAMÓWIENIA. Faktura mogła zostać poprawiona ręcznie
 * w inFakcie (inna cena, dopisana pozycja), a korekta odnosząca się do „przed”, którego nigdy
 * nie było, jest dokumentem NIEPRAWDZIWYM — u organu i u nabywcy. Dlatego rozbieżność
 * dostaje ODMOWĘ z nazwą pozycji, a nie ciche podstawienie.
 *
 * Moduł jest CZYSTY (bazy ani sieci nie dotyka) i nigdy nie rzuca — każda odmowa wraca
 * jako `{ services: null, blad }`, tak samo jak `parsujZwrot` w `domena/zwrot.js`.
 *
 * `zwrot` to WIERSZ ODCZYTANY Z BAZY (oms/db/zwroty.js: `zwrotyZamowienia`/`zwrot`), nie wynik
 * `parsujZwrot` — stąd pola w snake_case (`kwota_dostawy`), a nie `kwotaDostawy`.
 */
export function paryKorekty(faktura, zwrot, { nazwaProgramu = NAZWA_ZAPASOWA } = {}) {
  // `nazwaProgramu` = odmiana nazwy programu fakturowego (domyślnie inFakt — domena/nazwa-programu.js).
  const odmowa = (blad) => ({ services: null, blad });
  const wProgramie = nazwaProgramu.miejscownik;
  const oryginalne = faktura?.services ?? [];
  if (!oryginalne.length)
    return odmowa(`Faktura z ${nazwaProgramu.dopelniacz} nie ma ani jednej pozycji — korekty nie ma z czego złożyć.`);

  // ⚠️⚠️ ZDUBLOWANA NAZWA NA FAKTURZE ZATRUWA CALA MAPE PONIZEJ. Mapa `zwracane` jest
  // kluczowana NAZWA, a petla po pozycjach siega do tego samego kubelka przy KAZDEJ linii
  // o tej nazwie — zwrot JEDNEJ sztuki zerowal wtedy OBIE linie. Zmierzone: dwie linie
  // „Kot 70x100" po 1 szt./99,00 zl, zwrot jednej sztuki → korekta na 198,00 zl zamiast
  // 99,00 zl i ANI JEDNEGO ostrzezenia (bariera „ilosc > iloscPrzed" nizej liczy per linia,
  // wiec 1 > 1 jest falszem przy obu).
  //
  // Dwie linie o tej samej nazwie powstaja NORMALNIE: ten sam produkt kupiony dwoma
  // pozycjami w Woo, dwa `lineItems` na te sama oferte w Allegro, pozycja dopisana recznie
  // o nazwie identycznej ze sklepowa.
  //
  // ⚠️ ODMOWA JEST WYBOREM, NIE BRAKIEM POMYSLU. Kuszace rozdzielanie sztuk po liniach
  // („zdejmij z pierwszej, reszte z drugiej") ZGADYWALOBY, ktora linie klient zwrocil —
  // a przy roznych cenach na liniach zgadywanie zmienia KWOTE dokumentu widocznego u organu
  // i u nabywcy. Mylna korekta jest gorsza niz jej brak: braku nie trzeba prostowac trzecim
  // dokumentem. Odmawiamy dla CALEJ faktury, takze gdy zwrot dotyczy innej pozycji — bo
  // pary buduje sie dla calego dokumentu naraz.
  const zliczoneNazwy = new Map();
  for (const s of oryginalne) zliczoneNazwy.set(s.name, (zliczoneNazwy.get(s.name) ?? 0) + 1);
  for (const [nazwa, ile] of zliczoneNazwy) {
    if (ile > 1) {
      return odmowa(
        `Faktura ${faktura?.number ?? ''} ma ${ile} pozycje o tej samej nazwie („${nazwa}")` +
          ` — korekty nie da się złożyć jednoznacznie. Wystaw ją ręcznie w ${wProgramie}.`,
      );
    }
  }

  // Zwracane sztuki i kwoty, po nazwie pozycji. Nazwa jest jedyna tozsamoscia, jaka lacza
  // pozycje faktury z pozycja zamowienia — inFakt nie zna naszych kluczy.
  const zwracane = new Map();
  for (const p of zwrot?.pozycje ?? []) {
    const b = zwracane.get(p.nazwa) ?? { ilosc: 0, grosze: 0 };
    b.ilosc += Number(p.ilosc ?? 0);
    b.grosze += grosze(p.kwota, `pozycja zwrotu „${p.nazwa}"`);
    zwracane.set(p.nazwa, b);
  }

  const nazwyFaktury = new Set(oryginalne.map((s) => s.name));
  for (const nazwa of zwracane.keys()) {
    if (!nazwyFaktury.has(nazwa)) {
      return odmowa(
        `Pozycji „${nazwa}" nie ma na fakturze ${faktura?.number ?? ''} — korekty nie da się złożyć.` +
          ` Sprawdź, czy faktura nie została poprawiona w ${wProgramie}.`,
      );
    }
  }

  const dostawaGr = zwrot?.kwota_dostawy ? grosze(zwrot.kwota_dostawy, 'zwrot dostawy') : 0;
  // ⚠️ DOSTAWA MA DOSTAĆ TĘ SAMĄ ODMOWĘ, CO POZYCJA SPOZA FAKTURY (pętla wyżej). Bez niej
  // pozycja nieznana na fakturze kończyłaby się komunikatem, a zwrócona DOSTAWA przy fakturze
  // bez linii „Dostawa” — NICZYM: `blad: null` i korekta bez tych pieniędzy. Raport zdejmuje
  // kwotę dostawy zawsze, więc panel i dokument u organu rozjechałyby się po cichu, dokładnie
  // o kwotę dostawy. Faktura bez linii dostawy zdarza się normalnie: darmowa wysyłka, dostawa
  // wliczona w cenę, dokument poprawiony ręcznie w inFakcie.
  // Reguła i zdanie w domenie zwrotu — te same czyta karta zamówienia i ekran zwrotu.
  const bezDostawy = powodOdmowyKorektyBezDostawy(zwrot, faktura, { nazwa: nazwaProgramu });
  if (bezDostawy) return odmowa(bezDostawy);

  // ⚠️⚠️ DWA ŹRÓDŁA DLA JEDNEJ LINII — ODMOWA, A NIE CICHE NADPISANIE. Zwracana POZYCJA
  // może nazywać się dokładnie „Dostawa” (bo tak nazywa się
  // pozycja faktury, a operator zaznaczył ją w tabeli zwrotu) i JEDNOCZEŚNIE może być wpisana
  // kwota zwrotu dostawy. Pętla niżej policzyłaby wtedy `bruttoPo` z pozycji, po czym gałąź dostawy
  // policzyłaby je OD NOWA (`bruttoPrzed - dostawaGr`) i NADPISAŁA tamten wynik — kwota na
  // dokumencie u organu rozjechałaby się z kwotą zwrotu w panelu PO CICHU.
  //
  // ⚠️ ODMOWA, NIE SUMOWANIE, i to jest ten sam wybor, co przy zdublowanej nazwie wyzej:
  // zsumowanie zgadywaloby, czy to sa TE SAME pieniadze wpisane dwa razy (wtedy suma podwaja
  // zwrot dostawy), czy DWIE ROZNE kwoty (wtedy suma jest poprawna) — a zgadywanie zmienia
  // kwote dokumentu widocznego u nabywcy i u organu. Wyjscie dla czlowieka jest proste:
  // zostawic kwote dostawy w JEDNYM z dwoch pol.
  if (dostawaGr && zwracane.has(NAZWA_DOSTAWY)) {
    // ⚠️⚠️ RADA MUSI BYĆ WYKONALNA. „Zapisz zwrot jeszcze raz” bez względu na stan zwrotu
    // to krok DWUETAPOWY (skasuj, potem
    // zapisz od nowa: moduł nie umie EDYTOWAĆ istniejącego zwrotu, tylko dopisać nowy albo
    // usunąć stary), którego pierwszy etap `usunZwrot` (oms/db/zwroty.js) ODMAWIA, gdy pieniądze
    // za TEN zwrot już wyszły do kupującego (`powodOdmowyUsunieciaZwrotu`, domena/zwrot.js).
    // Taka rada byłaby NIEWYKONALNA dokładnie wtedy, gdy jest najpilniejsza — po oddaniu
    // pieniędzy. `zwrot` tutaj to wiersz ODCZYTANY Z BAZY (docblock modułu wyżej), więc
    // `pieniadze_oddane_at` jest na nim dostępne bez dodatkowego zapytania.
    const naprawa = zwrot?.pieniadze_oddane_at
      ? 'Pieniądze za ten zwrot zostały już oddane kupującemu, więc panel go nie skasuje —' +
        ` wystaw korektę ręcznie w ${wProgramie} i wpisz zwrot dostawy tylko RAZ, tą kwotą, która` +
        ' naprawdę wyszła.'
      : 'Usuń ten zwrot i zapisz go jeszcze raz, z kwotą dostawy w jednym z tych pól — albo' +
        ` wystaw korektę ręcznie w ${wProgramie}.`;
    return odmowa(
      `Zwrot dostawy jest wpisany w dwóch miejscach naraz: jako pozycja „${NAZWA_DOSTAWY}"` +
        ` (${zl(zwracane.get(NAZWA_DOSTAWY).grosze)} zł) i jako zwrot kosztu dostawy` +
        ` (${zl(dostawaGr)} zł) — panel nie zgadnie, czy to te same pieniądze, czy dwie różne` +
        ` kwoty. ${naprawa}`,
    );
  }
  const services = [];
  let grupa = 0;
  for (const s of oryginalne) {
    grupa += 1;
    const iloscPrzed = Number(s.quantity ?? 0);
    const bruttoPrzed = Number(s.gross_price ?? 0);
    const z = zwracane.get(s.name);
    let iloscPo = iloscPrzed;
    let bruttoPo = bruttoPrzed;
    if (z) {
      if (z.ilosc > iloscPrzed) {
        return odmowa(`Zwrot obejmuje ${z.ilosc} szt. „${s.name}", a na fakturze jest ${iloscPrzed} szt.`);
      }
      iloscPo = iloscPrzed - z.ilosc;
      bruttoPo = bruttoPrzed - z.grosze;
    }
    if (s.name === NAZWA_DOSTAWY && dostawaGr) {
      if (dostawaGr > bruttoPrzed) {
        return odmowa(`Zwrot dostawy przekracza kwotę dostawy na fakturze ${faktura?.number ?? ''}.`);
      }
      bruttoPo = bruttoPrzed - dostawaGr;
      // Zwrocona dostawa w calosci znaczy pozycje wyzerowana, nie ujemna ilosc.
      if (bruttoPo === 0) iloscPo = 0;
    }
    if (bruttoPo < 0) return odmowa(`Kwota zwrotu przy „${s.name}" przekracza kwotę z faktury.`);
    // DWA wiersze na pozycje, wspolny `group`, flaga `correction` rozroznia stany.
    services.push({
      name: s.name,
      quantity: iloscPrzed,
      gross_price: bruttoPrzed,
      tax_symbol: s.tax_symbol,
      group: grupa,
      correction: false,
    });
    services.push({
      name: s.name,
      quantity: iloscPo,
      gross_price: bruttoPo,
      tax_symbol: s.tax_symbol,
      group: grupa,
      correction: true,
    });
  }
  return { services, blad: null };
}
