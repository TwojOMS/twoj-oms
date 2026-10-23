import { sprzedazWOkresieAsync, zwrotyWOkresie } from '../../../domena/sprzedaz-okresu.js';
import {
  agreguj, delty, wgMiesiecy, wgDni, wgTygodni, deltyKanalow, dokumenty,
  udzialyDokumentow, klienci,
} from '../../../domena/agregacja-sprzedazy.js';
import { ostrzezenia } from '../../../domena/ostrzezenia-raportu.js';
import {
  zakresSkrotu, poprzedniOkres, rokWczesniej, miesiaceOkresu, nazwaOkresu,
  dniOkresu, tygodnieOkresu, zakresZZapytania,
} from '../../../domena/okresy-raportu.js';
import { wszystkieGranice, sufitZApilo } from '../../../oms/db/historia-sprzedazy.js';
import { zastrzezenia } from '../../../domena/zastrzezenia-historii.js';
import { ekranOdmowyRaportu } from './odmowa-raportu.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { zl } from '../../../domena/kwoty.js';
import { PODLOGA_ZWROTOW } from '../../../domena/rachunek-zarzadczy.js';
import { BOM_EXCELA, csvSprzedazy, nazwaPlikuSprzedazy } from '../../../domena/eksport-csv.js';

// Zakladka RAPORTY — sprzedaz. Trasa jest CIENKA: parsuje zakres, wola domene, renderuje.
// Wzorzec: routes/koszty.js.
//
// ⚠️ TEN MODUL NICZEGO NIE LICZY. Kazda liczba na ekranie przychodzi z domeny: sprzedaz
// w okresie sklada `sprzedazWOkresie` (scalenie historii z Apilo z biezaca sprzedaza po
// granicy per kanal), KPI i rankingi `agreguj`, zmiany `delty`, zakresy `okresy-raportu.js`.
// Druga sciezka liczaca to samo rozjechalaby sie o grosz przy pierwszej zmianie reguly.

// ⚠️ KOLEJNOSC JEST TRESCIA: skroty ida od NAJKROTSZEGO okresu. „Dzisiaj" (31.08.2026)
// stoi pierwszy, bo odpowiada na pytanie zadawane najczesciej — „co dzis sprzedalismy".
const SKROTY = [
  'dzisiaj', 'ten-miesiac', 'poprzedni-miesiac', 'ten-kwartal', 'poprzedni-kwartal',
  'ten-rok', 'poprzedni-rok', 'ostatnie-30',
];

// ⚠️ CZAS WARSZAWSKI, nie UTC — ta sama funkcja, co przy /koszty i /faktury. Pierwszego dnia
// miesiaca o 01:30 czasu polskiego `new Date().toISOString()` pokazuje jeszcze miesiac
// POPRZEDNI, wiec ekran otwieralby sie na innym miesiacu, niz mowi kalendarz na scianie.
const dzisiaj = () => dzienWarszawa(new Date().toISOString());

export function zarejestrujTrasyRaportow(app, { db, config }) {
  // Plik z tymi samymi wierszami, ktore rysuje ekran — do zestawienia z KPiR i z wyciagiem.
  // ⚠️ TA SAMA FUNKCJA `sprzedazWOkresie`, wiec plik OBEJMUJE historie z Apilo. Eksport
  // liczony z samej tabeli `zamowienia` bylby dla czerwca PUSTY (cala sprzedaz tego miesiaca
  // jest sprzed granicy) i wygladalby jak „nie bylo sprzedazy".
  app.get('/raporty/eksport.csv', async (req, reply) => {
    const { zakres, blad } = zakresZZapytania(req.query, dzisiaj());
    if (blad) return ekranOdmowyRaportu(reply, blad);
    try {
      const wiersze = await sprzedazWOkresieAsync(db, zakres, config.regulySprzedazy);
      const csv = csvSprzedazy(wiersze, { zKlientem: req.query.klient === '1' });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition',
          `attachment; filename="${nazwaPlikuSprzedazy(zakres.od, zakres.do)}"`)
        .send(BOM_EXCELA + csv);
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return ekranOdmowyRaportu(reply, e);
    }
  });

  app.get('/raporty', async (req, reply) => {
    const dzien = dzisiaj();
    const { zakres, blad } = zakresZZapytania(req.query, dzien);
    if (blad) return ekranOdmowyRaportu(reply, blad);

    try {
      // ⚠️ WSZYSTKIE TRZY OKRESY DOSTAJA SWOJE ZWROTY (Zadanie 11) — inaczej porownanie „rok
      // do roku" zestawialoby sprzedaz PO zwrotach (teraz) z sprzedaza SUROWA (przedRokiem).
      // Zakresy licza sie raz i ida do obu wywolan (sprzedaz + zwroty), zeby nie rozjechac sie
      // przy drugim przeliczeniu tej samej daty.
      const zakresWczesniej = poprzedniOkres(zakres);
      const zakresPrzedRokiem = rokWczesniej(zakres);
      const wiersze = await sprzedazWOkresieAsync(db, zakres, config.regulySprzedazy);
      const zwroty = zwrotyWOkresie(db, zakres, config.regulySprzedazy);
      const teraz = agreguj(wiersze, zwroty);
      const wczesniej = agreguj(
        await sprzedazWOkresieAsync(db, zakresWczesniej, config.regulySprzedazy),
        zwrotyWOkresie(db, zakresWczesniej, config.regulySprzedazy),
      );
      const przedRokiem = agreguj(
        await sprzedazWOkresieAsync(db, zakresPrzedRokiem, config.regulySprzedazy),
        zwrotyWOkresie(db, zakresPrzedRokiem, config.regulySprzedazy),
      );
      // ⚠️ PODLOGA ZWROTOW: dla zakresu konczacego sie PRZED dniem wdrozenia panel nie ma
      // ZADNEGO zrodla zwrotow (tabela `zwroty` byla wtedy pusta) — zero z `zwrotyWOkresie`
      // znaczy „nie widzielismy", nie „nie bylo". Ekran ma to napisac wprost, a nie pokazac
      // zmyslone 0,00 zl (ta sama zasada, co przy DROPSHIPPING za 2025).
      const zwrotyPoznane = Boolean(config.podlogaZwrotow && zakres.do >= config.podlogaZwrotow);
      const miesiace = miesiaceOkresu(zakres);

      // ⚠️ PRZEBIEG SPRZEDAZY (17.08.2026): do 62 dni slupki DZIENNE, powyzej TYGODNIOWE —
      // 90 dziennych kresek na szerokosci karty to szum, nie wykres. Listy dni i tygodni
      // przychodza Z ZAKRESU (dziury maja slupek z zerem), agregacje z domeny.
      const dni = dniOkresu(zakres);
      const przebieg = dni.length <= 62
        ? { typ: 'dzienny', slupki: wgDni(wiersze, dni) }
        : { typ: 'tygodniowy', slupki: wgTygodni(wiersze, tygodnieOkresu(zakres)) };

      // Klienci znani SPRZED okresu — jedno zapytanie, bo lista maili z calej historii
      // liczona w pamieci przy raporcie rocznym znaczylaby wczytanie wszystkiego dwa razy.
      const znane = new Set(
        db.prepare('SELECT DISTINCT LOWER(klient_email) m FROM sprzedaz_historyczna'
          + ' WHERE klient_email IS NOT NULL AND dzien < ?').all(zakres.od).map((w) => w.m),
      );

      // ⚠️ Sekcja „rok do roku" rysuje sie TYLKO gdy historia siega tamtego okresu.
      // Zero z okresu, ktorego w bazie nie ma, wygladaloby jak zapasc sprzedazy.
      const jestRokWczesniej = Boolean(przedRokiem.kpi.zamowien);

      return reply.view('raporty.ejs', {
        title: 'Raporty',
        nazwyKanalow: config.nazwyKanalow,
        zakres,
        nazwa: nazwaOkresu(zakres),
        skroty: SKROTY.map((klucz) => ({ klucz, etykieta: zakresSkrotu(klucz, dzien).etykieta })),
        ...teraz,
        // ⚠️ PO spreadzie `...teraz`, bo NADPISUJE jego `kanaly` — te same wiersze,
        // wzbogacone o zmiane procentowa wzgledem okresu poprzedniego (null = myslnik).
        kanaly: deltyKanalow(teraz.kanaly, wczesniej.kanaly),
        przebieg,
        zwrotyPoznane,
        podlogaZwrotow: config.podlogaZwrotow,
        delty: delty(teraz.kpi, wczesniej.kpi),
        // Podpisy delt w kaflach: czlowiek ma widziec, Z CZYM porownuje — „vs 2026-06",
        // a nie goly procent. Nazwy licza sie z TYCH SAMYCH zakresow, co delty.
        nazwaWczesniej: nazwaOkresu(zakresWczesniej),
        nazwaPrzedRokiem: jestRokWczesniej ? nazwaOkresu(zakresPrzedRokiem) : null,
        przedRokiem: jestRokWczesniej ? przedRokiem.kpi : null,
        // ⚠️ TA SAMA funkcja `delty`, co przy okresie poprzednim — a nie odejmowanie
        // w widoku. Zmiana rok do roku jest liczba o pieniadzach i ma powstawac tam,
        // gdzie stoi regula „brak podstawy daje null, nie zero".
        deltyRok: jestRokWczesniej ? delty(teraz.kpi, przedRokiem.kpi) : null,
        // Sekcja sezonowosci od DWOCH miesiecy wzwyz — przy jednym nie ma czego porownywac.
        miesiacami: miesiace.length >= 2 ? wgMiesiecy(wiersze, miesiace) : null,
        dokumenty: dokumenty(wiersze),
        // ⚠️ PROCENTY LICZY DOMENA. Ta sama liczba steruje szerokoscia paska i napisem
        // w jego srodku — policzona drugi raz w szablonie rozjechalaby sie przy zaokragleniu.
        udzialyDokumentow: udzialyDokumentow(dokumenty(wiersze)),
        klienci: klienci(wiersze, znane),
        ostrzezenia: ostrzezenia(wiersze, {
          ...zakres, granice: wszystkieGranice(db),
          kanalGddWHistorii: config.regulySprzedazy.klasyfikacja.tagGdd !== null,
        }),
        // ⚠️ OSOBNY PAS, NIE DOPISEK DO `ostrzezenia` — i to jest decyzja, nie niedbalstwo.
        // Pas ostrzezen jest ZWINIETY (`<details>`), bo jego tresc zalezy od danych okresu.
        // Te zdania mowia, czego archiwum NIE WIE o calej epoce, i musza byc widoczne bez
        // rozwijania: raport za 2016 rok pokazuje 2 395 zamowien, ktore bez tego zdania
        // czyta sie jako „tyle sprzedalismy" — a to wylacznie sklep, bez Allegro i hurtu.
        zastrzezeniaHistorii: zastrzezenia({ od: zakres.od, sufitApilo: config.kontoHistorii !== null ? sufitZApilo(db, config.kontoHistorii) : null, kontoNieustawione: config.kontoHistorii === null, nazwaSklepu: config.nazwaSklepuHistorii, dataImportu: config.dataImportuHistorii }),
        // ⚠️ ZAMIANA GROSZY NA ZLOTOWKI IDZIE Z DOMENY (domain/kwoty.js), a nie z wlasnego
        // dzielenia w szablonie: to jedyne dzielenie pieniedzy na tym ekranie i ma byc
        // TYM SAMYM dzieleniem, ktore panel robi wszedzie indziej. Widok dokleda juz tylko
        // polski zapis liczby (spacje i przecinek).
        zl,
      });
    } catch (e) {
      // ⚠️ Brak granicy kanalu ma dac ZDANIE DLA CZLOWIEKA, nie piecsetke. Blad techniczny
      // leci dalej, do logu — tak samo jak przy /koszty.
      if (!e?.dlaOperatora) throw e;
      return ekranOdmowyRaportu(reply, e);
    }
  });
}
