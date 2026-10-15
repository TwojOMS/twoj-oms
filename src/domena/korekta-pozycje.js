import { grosze, zl } from './kwoty.js';
// Nazwa pozycji dostawy na fakturze. Dawniej byla LITERALEM w `domain/pozycje-faktury.js`
// (`name: 'Dostawa'`); druga kopia rozjechalaby sie przy pierwszej zmianie i korekta
// przestalaby rozpoznawac wlasna pozycje dostawy — po cichu. Eksportowana STAMTAD.
import { NAZWA_DOSTAWY } from './pozycje-faktury.js';

/**
 * Pary „stan przed / stan po" dla `POST /v3/async/corrective_invoices.json`.
 *
 * ⚠️⚠️ `services` W KOREKCIE TO PARY, A NIE LISTA ZWRACANYCH POZYCJI. Kazda pozycja
 * oryginalnej faktury musi wystapic — te nietkniete przepisujemy bez zmian.
 *
 * ⚠️⚠️ PARA TO DWA WIERSZE, NIE JEDEN Z POLAMI `_before_correction`. Zmierzone na prawdziwej
 * korekcie tego konta (`1/KOR/07/2026`, 2026-08-14): dwa obiekty o tym samym `group`,
 * rozroznione flaga `correction` — `false` = stan PRZED, `true` = stan PO. Pol
 * `quantity_before_correction` / `gross_price_before_correction` na encji NIE MA (jest
 * `sale_date_before_correction`, ale to inna sprawa — data sprzedazy, nie pozycja).
 *
 * ⚠️ To pomiar ODCZYTU. Zapisu nikt jeszcze nie potwierdzil, a inFakt potrafi byc
 * asymetryczny. PIERWSZA PRAWDZIWA KOREKTA IDZIE POD NADZOREM WLASCICIELA i to ona
 * rozstrzyga ostatecznie.
 *
 * ⚠️⚠️ „PRZED" POCHODZI Z INFAKTU, NIE Z ZAMOWIENIA. Faktura mogla zostac poprawiona recznie
 * w inFakcie (inna cena, dopisana pozycja), a korekta odnoszaca sie do „przed", ktorego nigdy
 * nie bylo, jest dokumentem NIEPRAWDZIWYM — u organu i u nabywcy. Dlatego rozbieznosc
 * dostaje ODMOWE z nazwa pozycji, a nie ciche podstawienie.
 *
 * Modul jest CZYSTY (bazy ani sieci nie dotyka) i nigdy nie rzuca — kazda odmowa wraca
 * jako `{ services: null, blad }`, tak samo jak `parsujZwrot` w `domain/zwrot.js`.
 *
 * `zwrot` to WIERSZ ODCZYTANY Z BAZY (db/zwroty.js: `zwrotyZamowienia`/`zwrot`), nie wynik
 * `parsujZwrot` — stad pola w snake_case (`kwota_dostawy`), a nie `kwotaDostawy`.
 */
export function paryKorekty(faktura, zwrot) {
  const odmowa = (blad) => ({ services: null, blad });
  const oryginalne = faktura?.services ?? [];
  if (!oryginalne.length) return odmowa('Faktura z inFaktu nie ma ani jednej pozycji — korekty nie ma z czego złożyć.');

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
        `Faktura ${faktura?.number ?? ''} ma ${ile} pozycje o tej samej nazwie („${nazwa}")`
        + ' — korekty nie da się złożyć jednoznacznie. Wystaw ją ręcznie w inFakcie.',
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
        `Pozycji „${nazwa}" nie ma na fakturze ${faktura?.number ?? ''} — korekty nie da się złożyć.`
        + ' Sprawdź, czy faktura nie została poprawiona w inFakcie.',
      );
    }
  }

  const dostawaGr = zwrot?.kwota_dostawy ? grosze(zwrot.kwota_dostawy, 'zwrot dostawy') : 0;
  // ⚠️ DOSTAWA MA DOSTAC TE SAMA ODMOWE, CO POZYCJA SPOZA FAKTURY (petla wyzej). Wczesniej
  // pozycja nieznana na fakturze konczyla sie komunikatem, a zwrocona DOSTAWA przy fakturze
  // bez linii „Dostawa" — NICZYM: `blad: null` i korekta bez tych pieniedzy. Raport zdejmuje
  // kwote dostawy zawsze, wiec panel i dokument u organu rozjezdzaly sie po cichu, dokladnie
  // o te 19 zl. Faktura bez linii dostawy zdarza sie normalnie: darmowa wysylka, dostawa
  // wliczona w cene, dokument poprawiony recznie w inFakcie.
  if (dostawaGr && !nazwyFaktury.has(NAZWA_DOSTAWY)) {
    return odmowa(
      `Zwrot obejmuje ${zl(dostawaGr)} zł dostawy, a faktura ${faktura?.number ?? ''} nie ma pozycji`
      + ` „${NAZWA_DOSTAWY}" — korekty nie da się złożyć. Wystaw ją ręcznie w inFakcie.`,
    );
  }

  // ⚠️⚠️ DWA ZRODLA DLA JEDNEJ LINII — ODMOWA, A NIE CICHE NADPISANIE (recenzja kontrolna
  // 2026-08-15). Zwracana POZYCJA moze nazywac sie dokladnie „Dostawa" (bo tak nazywa sie
  // pozycja faktury, a operator zaznaczyl ja w tabeli zwrotu) i JEDNOCZESNIE moze byc wpisana
  // kwota zwrotu dostawy. Petla nizej liczyla wtedy `bruttoPo` z pozycji, po czym galaz dostawy
  // liczyla je OD NOWA (`bruttoPrzed - dostawaGr`) i NADPISYWALA tamten wynik — kwota na
  // dokumencie u organu rozjezdzala sie z kwota zwrotu w panelu PO CICHU.
  //
  // ⚠️ ODMOWA, NIE SUMOWANIE, i to jest ten sam wybor, co przy zdublowanej nazwie wyzej:
  // zsumowanie zgadywaloby, czy to sa TE SAME pieniadze wpisane dwa razy (wtedy suma podwaja
  // zwrot dostawy), czy DWIE ROZNE kwoty (wtedy suma jest poprawna) — a zgadywanie zmienia
  // kwote dokumentu widocznego u nabywcy i u organu. Wyjscie dla czlowieka jest proste:
  // zostawic kwote dostawy w JEDNYM z dwoch pol.
  if (dostawaGr && zwracane.has(NAZWA_DOSTAWY)) {
    // ⚠️⚠️ DROBIAZG 2 (recenzja 2026-08-15): RADA MUSI BYC WYKONALNA. Stalo tu „Zapisz zwrot
    // jeszcze raz" bez wzgledu na stan zwrotu — a to jest krok DWUETAPOWY (skasuj, potem
    // zapisz od nowa: modul nie umie EDYTOWAC istniejacego zwrotu, tylko dopisac nowy albo
    // usunac stary), ktorego pierwszy etap `usunZwrot` (db/zwroty.js) ODMAWIA, gdy pieniadze
    // za TEN zwrot juz wyszly do kupujacego (`powodOdmowyUsunieciaZwrotu`, domain/zwrot.js).
    // Rada byla wiec radą NIEWYKONALNĄ dokładnie wtedy, gdy jest najpilniejsza — po oddaniu
    // pieniędzy. `zwrot` tutaj to wiersz ODCZYTANY Z BAZY (docblock modulu wyzej), wiec
    // `pieniadze_oddane_at` jest na nim dostepne bez dodatkowego zapytania.
    const naprawa = zwrot?.pieniadze_oddane_at
      ? 'Pieniądze za ten zwrot zostały już oddane kupującemu, więc panel go nie skasuje —'
        + ' wystaw korektę ręcznie w inFakcie i wpisz zwrot dostawy tylko RAZ, tą kwotą, która'
        + ' naprawdę wyszła.'
      : 'Usuń ten zwrot i zapisz go jeszcze raz, z kwotą dostawy w jednym z tych pól — albo'
        + ' wystaw korektę ręcznie w inFakcie.';
    return odmowa(
      `Zwrot dostawy jest wpisany w dwóch miejscach naraz: jako pozycja „${NAZWA_DOSTAWY}"`
      + ` (${zl(zwracane.get(NAZWA_DOSTAWY).grosze)} zł) i jako zwrot kosztu dostawy`
      + ` (${zl(dostawaGr)} zł) — panel nie zgadnie, czy to te same pieniądze, czy dwie różne`
      + ` kwoty. ${naprawa}`,
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
        return odmowa(
          `Zwrot obejmuje ${z.ilosc} szt. „${s.name}", a na fakturze jest ${iloscPrzed} szt.`,
        );
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
      name: s.name, quantity: iloscPrzed, gross_price: bruttoPrzed,
      tax_symbol: s.tax_symbol, group: grupa, correction: false,
    });
    services.push({
      name: s.name, quantity: iloscPo, gross_price: bruttoPo,
      tax_symbol: s.tax_symbol, group: grupa, correction: true,
    });
  }
  return { services, blad: null };
}
