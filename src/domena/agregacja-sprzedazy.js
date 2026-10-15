import { czyPozycjaNieTowar } from './pozycje-niesprzedazowe.js';

// Agregacja sprzedazy w okresie. Modul jest CZYSTY: dostaje gotowe wiersze z `sprzedazWOkresie`
// i niczego nie czyta z bazy. Dzieki temu ten sam kod liczy okres biezacy, poprzedni i rok
// wczesniej — bez trzech sciezek, ktore moglyby sie rozjechac.

/**
 * ⚠️ WYSYLKA I „REALIZACJA PRIORYTETOWA" PRZYCHODZA JAKO POZYCJE PRODUKTOWE (`type: 1`) —
 * wtyczka panelu nie ustawia typow, bo wszystko idzie tym samym placeholderem. Bez tej laty
 * „wysyłka kurierem DPD" konkuruje z szablonami o miejsce w rankingu i zawyza licznik sztuk
 * (w tygodniu 30/2026 bylo to 5 pozycji wysylki + 2 ekspresy = 7 falszywych „sztuk").
 * Wlasciwa naprawa jest we wtyczce i czeka na zrobienie.
 *
 * ⚠️ SAMA LISTA WZORCOW WYPROWADZILA SIE STAD 21.08.2026 (domain/pozycje-niesprzedazowe.js):
 * czyta ja teraz takze karta zamowienia, zeby nie rysowac pustego wiersza „Wysylka 0,00"
 * pod pozycja, ktora tym transportem jest. Dwie kopie tej samej zgadywanki po nazwie
 * rozjechalyby sie po cichu.
 */
const czyProdukt = (p) => Number(p.typ ?? 1) === 1 && !czyPozycjaNieTowar(p.nazwa);

const suma = (lista, pole) => lista.reduce((s, x) => s + (x[pole] ?? 0), 0);

export function agreguj(wiersze, zwroty = []) {
  const bruttoGrosze = suma(wiersze, 'bruttoGrosze');
  const nettoGrosze = suma(wiersze, 'nettoGrosze');
  const zamowien = wiersze.length;

  const produkty = new Map();
  let sztuk = 0;
  for (const w of wiersze) {
    for (const p of w.pozycje ?? []) {
      if (!czyProdukt(p)) continue;
      sztuk += Number(p.ilosc ?? 0);
      const b = produkty.get(p.nazwa) ?? { nazwa: p.nazwa, sztuk: 0, bruttoGrosze: 0 };
      b.sztuk += Number(p.ilosc ?? 0);
      b.bruttoGrosze += p.bruttoGrosze ?? 0;
      produkty.set(p.nazwa, b);
    }
  }

  const wgKanalu = new Map();
  for (const w of wiersze) {
    const b = wgKanalu.get(w.kanal) ?? { kanal: w.kanal, bruttoGrosze: 0, zamowien: 0 };
    b.bruttoGrosze += w.bruttoGrosze;
    b.zamowien += 1;
    wgKanalu.set(w.kanal, b);
  }

  const top = [...produkty.values()]
    .sort((a, b) => b.bruttoGrosze - a.bruttoGrosze)
    .slice(0, 10);

  return {
    kpi: {
      bruttoGrosze,
      nettoGrosze,
      zamowien,
      // ⚠️ Pusty okres NIE dzieli przez zero. Zero zamowien znaczy zerowa srednia, a nie NaN
      // — a `NaN` przeszedlby przez caly renderer i wyszedl na ekran jako puste miejsce.
      aovGrosze: zamowien ? Math.round(bruttoGrosze / zamowien) : 0,
      sztuk,
      // ⚠️ ZWROTY NIE ZMIENIAJA LICZNIKOW SPRZEDAZY. `zamowien`, `sztuk`, `aovGrosze`
      // i `kanaly[].zamowien` liczą się WYLACZNIE ze sprzedazy — 520 zamowien zostaje 520.
      // Inaczej srednia wartosc zamowienia zaczyna klamac, a licznik przestaje pasowac do
      // sprzedazy. Zwrot jest osobna liczba obok, nie modyfikatorem tamtych.
      zwrotyGrosze: suma(zwroty, 'bruttoGrosze'),
      zwrotyNettoGrosze: suma(zwroty, 'nettoGrosze'),
      bruttoPoZwrotachGrosze: bruttoGrosze - suma(zwroty, 'bruttoGrosze'),
      nettoPoZwrotachGrosze: nettoGrosze - suma(zwroty, 'nettoGrosze'),
    },
    kanaly: [...wgKanalu.values()]
      .map((k) => ({
        ...k,
        aovGrosze: k.zamowien ? Math.round(k.bruttoGrosze / k.zamowien) : 0,
        udzial: bruttoGrosze ? (k.bruttoGrosze / bruttoGrosze) * 100 : 0,
      }))
      .sort((a, b) => b.bruttoGrosze - a.bruttoGrosze),
    produkty: top,
    // ⚠️ KONCENTRACJA: ile brutto CALEGO okresu pokrywa lista top produktow. Pusty okres
    // oddaje null, nie zero — „top 10 = 0%" wygladaloby na zmierzony fakt.
    udzialTop: bruttoGrosze ? (suma(top, 'bruttoGrosze') / bruttoGrosze) * 100 : null,
  };
}

/**
 * Sprzedaz dzien po dniu. Lista dni przychodzi Z ZAKRESU (`dniOkresu`), nie z danych —
 * dzien bez sprzedazy MA MIEC wiersz z zerem (ta sama zasada, co `wgMiesiecy`).
 * ⚠️ Zamowienie spoza listy dni jest ignorowane, nie wybucha: KPI licza caly zakres
 * z tych samych wierszy, wiec rozjazd bylby widoczny w liczbach, a piecsetka zabralaby
 * caly ekran.
 */
export function wgDni(wiersze, dni) {
  const wg = new Map(dni.map((d) => [d, { dzien: d, bruttoGrosze: 0, zamowien: 0 }]));
  for (const w of wiersze) {
    const b = wg.get(w.dzien);
    if (!b) continue;
    b.bruttoGrosze += w.bruttoGrosze;
    b.zamowien += 1;
  }
  return [...wg.values()];
}

/**
 * Sprzedaz tydzien po tygodniu — dla zakresow, przy ktorych slupki dzienne zlewaja sie
 * w szum. Lista tygodni przychodzi z `tygodnieOkresu` (pn–nd, przyciete do zakresu).
 */
export function wgTygodni(wiersze, tygodnie) {
  const wg = tygodnie.map((t) => ({ ...t, bruttoGrosze: 0, zamowien: 0 }));
  for (const w of wiersze) {
    const b = wg.find((t) => w.dzien >= t.od && w.dzien <= t.do);
    if (!b) continue;
    b.bruttoGrosze += w.bruttoGrosze;
    b.zamowien += 1;
  }
  return wg;
}

/**
 * Kanaly biezace wzbogacone o zmiane procentowa brutto wzgledem okresu poprzedniego.
 * ⚠️ BRAK PODSTAWY DAJE `null`, NIE ZERO — kanal nieobecny (albo zerowy) w poprzednim
 * okresie nie ma sie do czego porownac, a „+∞%" nie jest liczba do pokazania (ta sama
 * zasada, co w `delty`).
 */
export function deltyKanalow(teraz, wczesniej) {
  const poprzednie = new Map((wczesniej ?? []).map((k) => [k.kanal, k.bruttoGrosze]));
  return teraz.map((k) => {
    const bylo = poprzednie.get(k.kanal) ?? 0;
    return { ...k, zmiana: bylo ? ((k.bruttoGrosze - bylo) / bylo) * 100 : null };
  });
}

/**
 * Zmiana procentowa wzgledem okresu porownawczego.
 * ⚠️ BRAK PODSTAWY DAJE `null`, NIE ZERO. Zero znaczy „bez zmian" i jest zdaniem o faktach;
 * przy pustym okresie poprzednim zadnego faktu nie ma, a „+∞%" nie jest liczba do pokazania.
 */
export function delty(teraz, wczesniej) {
  const zmiana = (a, b) => (b ? ((a - b) / b) * 100 : null);
  if (!wczesniej) return { brutto: null, zamowien: null, aov: null, sztuk: null };
  return {
    brutto: zmiana(teraz.bruttoGrosze, wczesniej.bruttoGrosze),
    zamowien: zmiana(teraz.zamowien, wczesniej.zamowien),
    aov: zmiana(teraz.aovGrosze, wczesniej.aovGrosze),
    sztuk: zmiana(teraz.sztuk, wczesniej.sztuk),
  };
}

/**
 * Sprzedaz miesiac po miesiacu.
 * ⚠️ LISTA MIESIECY PRZYCHODZI Z ZEWNATRZ (`miesiaceOkresu`), a nie z danych — miesiac bez
 * sprzedazy MA MIEC wiersz z zerem. Miesiac wyliczony z danych po prostu znikalby z wykresu,
 * a luka w sezonowosci wygladalaby jak jej brak.
 */
export function wgMiesiecy(wiersze, miesiace) {
  const wg = new Map(miesiace.map((m) => [m, { miesiac: m, bruttoGrosze: 0, zamowien: 0 }]));
  for (const w of wiersze) {
    const b = wg.get(w.dzien.slice(0, 7));
    if (!b) continue;
    b.bruttoGrosze += w.bruttoGrosze;
    b.zamowien += 1;
  }
  return [...wg.values()];
}

/** Podzial sprzedazy na fakture i paragon — po liczbie zamowien i po wartosci. */
export function dokumenty(wiersze) {
  const pusty = () => ({ zamowien: 0, bruttoGrosze: 0 });
  const wynik = { faktura: pusty(), paragon: pusty() };
  for (const w of wiersze) {
    const b = w.faktura ? wynik.faktura : wynik.paragon;
    b.zamowien += 1;
    b.bruttoGrosze += w.bruttoGrosze;
  }
  return wynik;
}

/**
 * Udzialy faktury i paragonu — osobno po LICZBIE zamowien i po WARTOSCI (17.08.2026).
 *
 * ⚠️ PROCENTY LICZY DOMENA, NIE WIDOK (przewodnik, sekcja 3). Ta sama liczba steruje
 * SZEROKOSCIA paska i napisem w jego srodku; policzona dwa razy rozjechalaby sie przy
 * pierwszym zaokragleniu i pasek klamalby o wlasnej etykiecie.
 *
 * ⚠️ DRUGI UDZIAL JEST DOPELNIENIEM PIERWSZEGO, nie osobnym rachunkiem. Dwa niezalezne
 * zaokraglenia daja czasem 33% + 66% (szpara w pasku) albo 33% + 68% (pasek szerszy niz
 * kontener) — a pasek ma miec DOKLADNIE 100%.
 *
 * ⚠️ PUSTY OKRES ODDAJE `null`, NIE ZERO. „0% faktur" przy pustym miesiacu wyglada jak
 * zmierzony fakt („nikt nie chcial faktury"), a znaczy „nie bylo ani jednego zamowienia".
 * Zero jest prawdziwe dopiero wtedy, gdy zamowienia BYLY i zadne nie chcialo faktury.
 */
export function udzialyDokumentow(dok) {
  const para = (aWartosc, bWartosc) => {
    const razem = aWartosc + bWartosc;
    if (!razem) {
      return { faktura: { ile: aWartosc, procent: null }, paragon: { ile: bWartosc, procent: null }, razem };
    }
    const procentA = Math.round((aWartosc / razem) * 100);
    return {
      faktura: { ile: aWartosc, procent: procentA },
      paragon: { ile: bWartosc, procent: 100 - procentA },
      razem,
    };
  };
  return {
    zamowien: para(dok.faktura.zamowien, dok.paragon.zamowien),
    wartosc: para(dok.faktura.bruttoGrosze, dok.paragon.bruttoGrosze),
  };
}

/**
 * Nowi i powracajacy klienci — wskaznik, na ktorym stoi decyzja „kampania na pozyskanie
 * czy na powrot".
 *
 * ⚠️ LICZYMY KLIENTOW, NIE ZAMOWIENIA: drugie zamowienie tej samej osoby w tym samym okresie
 * nie robi z niej dwoch klientow.
 * ⚠️ ZAMOWIENIE BEZ MAILA MA WLASNY LICZNIK. Wrzucone do „nowych" zawyzaloby pozyskanie
 * przy kazdym zamowieniu telefonicznym bez adresu.
 */
export function klienci(wiersze, znaneMaile) {
  const wOkresie = new Set();
  let bezMaila = 0;
  let nowych = 0;
  let powracajacych = 0;
  for (const w of wiersze) {
    const mail = String(w.email ?? '').trim().toLowerCase();
    if (!mail) { bezMaila += 1; continue; }
    if (wOkresie.has(mail)) continue;
    wOkresie.add(mail);
    if (znaneMaile.has(mail)) powracajacych += 1;
    else nowych += 1;
  }
  return { nowych, powracajacych, bezMaila };
}
