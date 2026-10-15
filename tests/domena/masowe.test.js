import { describe, it, expect } from 'vitest';
import { podzielDoStatusu, podzielDoNadania, wybraneZListy } from '../../src/domena/masowe.js';

// Akcje masowe ze strony głównej: zmiana statusu i nadanie przesyłek domyślnymi parametrami.
//
// ⚠️ Cała wartość tego modułu jest w tym, CZEGO NIE ROBI. Nadanie paczki jest nieodwracalne
// (DPD odmawia powtórzenia referencji), a robione hurtem — nieodwracalne razy N. Reguły
// pomijania są tu, w warstwie czystej, żeby dało się je przeczytać w jednym miejscu i żeby
// ekran podglądu pokazywał DOKŁADNIE to, co potem wykona trasa.

const zam = (nad = {}) => ({
  id: 1, numer: '1281', metoda_wysylki: 'dpd', anulowane: 0, oplacone_at: '2026-07-30T10:00:00',
  przesylki: [], ...nad,
});

describe('wybraneZListy', () => {
  it('bierze zamówienia o podanych identyfikatorach, w kolejności listy', () => {
    const lista = [zam({ id: 5, numer: 'A' }), zam({ id: 7, numer: 'B' }), zam({ id: 9, numer: 'C' })];
    expect(wybraneZListy(lista, ['9', '5']).map((z) => z.numer)).toEqual(['A', 'C']);
  });

  it('identyfikator spoza listy pomija po cichu — nie zmyśla zamówienia', () => {
    expect(wybraneZListy([zam({ id: 5 })], ['5', '999', 'abc'])).toHaveLength(1);
  });

  it('pojedyncza wartość (nie tablica) też działa — tak Fastify oddaje jeden checkbox', () => {
    expect(wybraneZListy([zam({ id: 5 })], '5')).toHaveLength(1);
  });

  it('brak zaznaczenia daje pustą listę', () => {
    expect(wybraneZListy([zam()], undefined)).toEqual([]);
  });
});

describe('podzielDoStatusu', () => {
  it('przepuszcza zamówienia, którym wolno ustawić ten status', () => {
    const { doZmiany, pominiete } = podzielDoStatusu([zam({ numer: 'A' }), zam({ numer: 'B' })], 'wyslane');
    expect(doZmiany.map((z) => z.numer)).toEqual(['A', 'B']);
    expect(pominiete).toEqual([]);
  });

  // ⚠️ SEDNO: jedno zamówienie, którego nie wolno ruszyć, NIE BLOKUJE reszty. Odmowa
  // całości znaczyłaby, że operator musi znaleźć winowajcę wśród dwudziestu zaznaczeń,
  // odznaczyć go i kliknąć jeszcze raz — czyli że przy pierwszym anulowanym zamówieniu
  // funkcja przestaje być użyteczna.
  it('pomija zamówienie z odmową i wykonuje resztę', () => {
    const lista = [zam({ numer: 'A' }), zam({ numer: 'B', anulowane: 1 }), zam({ numer: 'C' })];
    const { doZmiany, pominiete } = podzielDoStatusu(lista, 'wyslane');
    expect(doZmiany.map((z) => z.numer)).toEqual(['A', 'C']);
    expect(pominiete).toHaveLength(1);
    expect(pominiete[0].numer).toBe('B');
    expect(pominiete[0].powod).toMatch(/anulowane W SKLEPIE/);
  });

  it('powód pomijania jest TYM SAMYM zdaniem, co przy zmianie pojedynczej', () => {
    const { pominiete } = podzielDoStatusu([zam({ anulowane: 1 })], 'nowe');
    expect(pominiete[0].powod).toMatch(/Najpierw wycofaj anulowanie w sklepie/);
  });

  it('nieznany status odrzuca wszystko, bo to błąd formularza, a nie stan zamówienia', () => {
    const { doZmiany, pominiete } = podzielDoStatusu([zam()], 'bzdura');
    expect(doZmiany).toEqual([]);
    expect(pominiete[0].powod).toMatch(/Nieznany status/);
  });
});

describe('podzielDoNadania', () => {
  it('przepuszcza zwykłe zamówienie DPD bez paczki', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam()]);
    expect(doNadania).toHaveLength(1);
    expect(pominiete).toEqual([]);
  });

  it('pomija anulowane', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ anulowane: 1 })]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toMatch(/anulowane/i);
  });

  it('pomija anulowane RĘCZNIE w panelu, nie tylko w sklepie', () => {
    const { doNadania } = podzielDoNadania([zam({ anulowane: 0, anulowane_recznie: 1 })]);
    expect(doNadania).toEqual([]);
  });

  // PRZ-070 (właściciel 14.10.2026): pobranie wchodzi do hurtu z kwotą Z ZAMÓWIENIA — kwotę widać
  // w uwadze podglądu, a hurt nadaje wyłącznie paczkę nr 1, czyli tę, na której jedzie pobranie.
  it('pobranie z kwotą idzie do nadania, kwota z zamówienia w uwadze', () => {
    const { doNadania, pominiete, uwagi } = podzielDoNadania([
      zam({ metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '486.00' }),
    ]);
    expect(pominiete).toEqual([]);
    expect(doNadania).toHaveLength(1);
    expect(uwagi[0].tresc).toBe('za pobraniem — kurier zainkasuje 486.00 zł');
  });

  it('pomija odbiór osobisty i nieznaną metodę — dla nich nie ma kuriera', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ numer: 'A', metoda_wysylki: 'odbior_osobisty' }),
      zam({ numer: 'B', metoda_wysylki: 'nieznana' }),
    ]);
    expect(doNadania).toEqual([]);
    expect(pominiete.map((p) => p.numer)).toEqual(['A', 'B']);
  });

  // Hurtem nadajemy WYŁĄCZNIE paczkę nr 1. Dosyłka i zamiennik za zgubioną to decyzje
  // jednostkowe, z powodem wpisywanym do logu — nie coś, co wychodzi z zaznaczenia wiersza.
  it('pomija zamówienie, które ma już żywą paczkę', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ przesylki: [{ status: 'nadana', numer_listu: '1048123722945U' }] }),
    ]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toMatch(/paczk/i);
  });

  it('nieudane nadanie (paczka w stanie „błąd") NIE blokuje — tam u kuriera nic nie powstało', () => {
    const { doNadania } = podzielDoNadania([zam({ przesylki: [{ status: 'blad' }] })]);
    expect(doNadania).toHaveLength(1);
  });

  it('paczka „do wyjaśnienia" blokuje — numer listu u kuriera już istnieje', () => {
    const { doNadania } = podzielDoNadania([zam({ przesylki: [{ status: 'do_wyjasnienia' }] })]);
    expect(doNadania).toEqual([]);
  });

  // ⚠️ Nieopłacone NIE jest powodem pominięcia — to sklep B2B i wysyłka na fakturę z
  // terminem płatności jest normalna (ta sama decyzja, co przy nadaniu pojedynczym).
  // Ale na ekranie podglądu ma to być WIDOCZNE, bo hurtem nikt nie zagląda w kwoty.
  it('nieopłacone przepuszcza, ale zgłasza jako uwagę', () => {
    const { doNadania, uwagi } = podzielDoNadania([zam({ oplacone_at: null, kwota_brutto: '1240.00' })]);
    expect(doNadania).toHaveLength(1);
    expect(uwagi).toHaveLength(1);
    expect(uwagi[0].numer).toBe('1281');
    expect(uwagi[0].tresc).toMatch(/opłacone/i);
  });

  it('dzieli listę mieszaną, nie przerywając jej na pierwszym pominięciu', () => {
    const lista = [
      zam({ id: 1, numer: 'A' }),
      zam({ id: 2, numer: 'B', metoda_wysylki: 'dpd', pobranie: 1 }),
      zam({ id: 3, numer: 'C' }),
    ];
    const { doNadania, pominiete } = podzielDoNadania(lista);
    expect(doNadania.map((z) => z.numer)).toEqual(['A', 'C']);
    expect(pominiete.map((p) => p.numer)).toEqual(['B']);
  });

  // ⚠️ ZADANIE 8. POWÓD, jaki widzi operator na ekranie podglądu, nie ma prawa kłamać.
  // PRZ-070 (14.10.2026): paczkomat idzie hurtem, więc pomijany jest już tylko paczkomat BEZ
  // KODU — z tym samym zdaniem, co na karcie, a nie z „ustaw metodę na karcie zamówienia".
  it('pomija paczkomat bez kodu z WŁASNYM powodem, nie z „nieznana metoda"', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ numer: 'P', metoda_wysylki: 'inpost_paczkomat' }),
    ]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toMatch(/nie ma kodu paczkomatu/);
    // Właściwość, która się dziś psuje: paczkomat NIE MA prawa dostać powodu, który mówi
    // operatorowi, żeby poprawił coś, co jest już poprawne.
    expect(pominiete[0].powod).not.toMatch(/nieznana metoda/i);
  });

  // ⚠️ KANAL ALLEGRO. PRZ-070 (właściciel 14.10.2026): od 11.08 (DPD) i 18.09 (osiem usług) panel
  // nadaje paczki tego kanalu przez „Wysyłam z Allegro" — hurt idzie ta sama droga, co karta.
  // Zdanie „paczki tego kanału nadajesz w Allegro" przestalo byc prawda i zniknelo.
  it('zamówienie z Allegro idzie drogą „Wysyłam z Allegro”, nie z „nieznana metoda”', () => {
    const wynik = podzielDoNadania([{ id: 1, sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd', numer: 'A1' }]);
    expect(wynik.doNadania).toHaveLength(1);
    expect(wynik.doNadania[0].rodzajFormularza).toBe('wza');
  });

  // Te zamowienia NIE sa z kanalu Allegro (fixture bez `sklep`) — metoda allegrowa przy
  // zamowieniu sklepowym to reczna korekta, ktorej adapter WzA i tak by nie nadal.
  it('metoda allegrowa przy zamówieniu spoza Allegro — KAŻDA, także ta, której słownik nie zna', () => {
    const lista = ['allegro_dpd', 'allegro_paczkomat', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']
      .map((m, i) => zam({ id: i + 1, numer: m, metoda_wysylki: m }));
    const { doNadania, pominiete } = podzielDoNadania(lista);
    expect(doNadania).toEqual([]);
    expect(pominiete).toHaveLength(5);
    for (const p of pominiete) expect(p.powod).toBe('metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia');
  });

  // ⚠️ KOLEJNOSC WARUNKOW = KOLEJNOSC WAZNOSCI, a te trzy testy sa jedynym, co jej pilnuje.
  // Galaz allegrowa stoi PRZED sprawdzeniem pobrania i przed sprawdzeniem zywej paczki,
  // a PO anulowaniu — przesuniecie jej w ktoras strone daje powod, ktory brzmi jak robota
  // do wykonania („kwote potwierdz na karcie", „dosylke nadaj z karty zamowienia") przy
  // zamowieniu, ktorego panel nie nadaje w ogole.
  it('allegrowe ZA POBRANIEM nie dostaje powodu o kwocie — jej i tak nikt tu nie potwierdza', () => {
    const { pominiete } = podzielDoNadania([
      zam({ metoda_wysylki: 'allegro_dpd', pobranie: 1, kwota_pobrania: '99.00' }),
    ]);
    expect(pominiete[0].powod).toBe('metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia');
    expect(pominiete[0].powod).not.toMatch(/potwierdź na karcie/);
  });

  it('allegrowe z odnotowaną paczką nie dostaje powodu o dosyłce z karty', () => {
    const { pominiete } = podzielDoNadania([
      zam({ metoda_wysylki: 'allegro_paczkomat', przesylki: [{ status: 'nadana', numer_listu: 'AD123' }] }),
    ]);
    expect(pominiete[0].powod).toBe('metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia');
  });

  it('anulowanie dalej wyprzedza Allegro — to jedyny stan, w którym paczka nie ma wyjechać W OGÓLE', () => {
    const { pominiete } = podzielDoNadania([zam({ metoda_wysylki: 'allegro_dpd', anulowane: 1 })]);
    expect(pominiete[0].powod).toBe('zamówienie jest anulowane');
  });

  // Metoda sklepowa o nazwie zaczynajacej sie od „allegro" bez podkreslnika NIE JEST kanalem
  // Allegro. Warunek na samym „allegro" wciagnalby kiedys dostawe sklepowa o takiej nazwie
  // i po cichu wylaczyl ja z nadania hurtem.
  it('nie łapie metod, które tylko zaczynają się od słowa „allegro”', () => {
    const { pominiete } = podzielDoNadania([zam({ metoda_wysylki: 'allegrowa_dostawa' })]);
    expect(pominiete[0].powod).toMatch(/nieznana metoda/);
  });

  it('zaznaczenie mieszane DPD + Allegro: DPD idzie do nadania, Allegro wypada z powodem', () => {
    const lista = [
      zam({ id: 1, numer: 'D', metoda_wysylki: 'dpd' }),
      zam({ id: 2, numer: 'A', metoda_wysylki: 'allegro_dpd' }),
    ];
    const { doNadania, pominiete } = podzielDoNadania(lista);
    expect(doNadania.map((z) => z.numer)).toEqual(['D']);
    expect(pominiete.map((p) => p.numer)).toEqual(['A']);
  });

  // Zmiana statusu hurtem to co innego niz nadanie: nie tworzy niczego u kuriera, wiec
  // zamowieniom Allegro wolno ja robic. Gdyby odmowa nadania przeciekla do drugiej funkcji,
  // caly kanal stalby sie na liscie nieruszalny.
  it('odmowa dotyczy WYŁĄCZNIE nadania — status hurtem zamówieniu z Allegro wolno zmienić', () => {
    const { doZmiany, pominiete } = podzielDoStatusu([zam({ metoda_wysylki: 'allegro_dpd' })], 'wyslane');
    expect(doZmiany).toHaveLength(1);
    expect(pominiete).toEqual([]);
  });

  // ⚠️⚠️ TEN TEST BRONI PIENIEDZY I JEST SEDNEM POPRAWKI Z 04.08.2026. Do niej odmowa byla
  // kluczowana METODA, a metoda jest EDYTOWALNA z karty zamowienia (wysylka_reczna_json) —
  // i metody sklepowe sa na liscie wyboru. Operator, ktory przestawil zamowienie z Allegro
  // na „dpd", wyprowadzal je z galezi allegrowej WPROST do nadania hurtem, bo ta funkcja
  // czyta wartosc EFEKTYWNA. Skutek: DRUGA, platna paczka DPD do klienta, ktory dostal juz
  // swoja z Allegro — nie do cofniecia. Dyskryminatorem jest teraz KANAL (`sklep`), ktory
  // ustawia poller i ktorego zaden formularz panelu nie rusza.
  it('zamówienie Z KANAŁU Allegro z ręcznie przestawioną metodą na „dpd” NIE trafia do nadania zbiorczego', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ id: 7, numer: 'A7', sklep: 'allegro_szkicownia', metoda_wysylki: 'dpd' }),
    ]);
    expect(doNadania).toEqual([]);
    expect(pominiete).toHaveLength(1);
    expect(pominiete[0].powod).toBe('zamówienie z Allegro ma ręcznie ustawioną metodę sklepową — nadaj je z karty zamówienia');
  });

  // Kazda metoda, ktora panel UMIE nadac (dzis dpd hurtem, paczkomat pojedynczo) i kazda,
  // ktora umie kiedys — wpisana recznie na zamowieniu z kanalu Allegro musi dac ten sam
  // powod. Test idzie po metodach SKLEPOWYCH, bo to one sa furtka; allegrowe lapie i tak
  // druga siatka (warunek na metode).
  it.each(['dpd', 'inpost_paczkomat', 'odbior_osobisty'])(
    'kanał Allegro bije metodę „%s” wpisaną ręcznie — powód zawsze ten sam',
    (metoda) => {
      const { doNadania, pominiete } = podzielDoNadania([
        zam({ sklep: 'allegro_amarka', metoda_wysylki: metoda }),
      ]);
      expect(doNadania).toEqual([]);
      expect(pominiete[0].powod).toBe('zamówienie z Allegro ma ręcznie ustawioną metodę sklepową — nadaj je z karty zamówienia');
    },
  );

  // Zaznaczenie mieszane: przestawione zamowienie z Allegro wyglada na liscie DOKLADNIE jak
  // zwykle DPD (ta sama kolumna „Dostawa"), wiec wpadnie w to samo zaznaczenie „wszystkie".
  it('mieszane zaznaczenie: sklepowe DPD idzie, allegrowe przestawione na DPD zostaje', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ id: 1, numer: 'D', sklep: 'szkicownia', metoda_wysylki: 'dpd' }),
      zam({ id: 2, numer: 'A', sklep: 'allegro_szkicownia', metoda_wysylki: 'dpd' }),
    ]);
    expect(doNadania.map((z) => z.numer)).toEqual(['D']);
    expect(pominiete.map((p) => p.numer)).toEqual(['A']);
  });

  // Druga strona tej samej reguly: siatka kanalowa NIE MOZE zatrzymac zamowien sklepowych.
  // Bez tego testu „odmawiaj zawsze" przechodziloby jako poprawka.
  it('zamówienie ze sklepu dalej idzie do nadania — siatka kanałowa nie łapie za szeroko', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'szkicownia', metoda_wysylki: 'dpd' })]);
    expect(doNadania).toHaveLength(1);
    expect(pominiete).toEqual([]);
  });

  // Ta sama pulapka, co przy metodach: klucz sklepu zaczynajacy sie od „allegro" BEZ
  // podkreslnika nie jest kanalem Allegro (klucze kanalow to `allegro_szkicownia`
  // i `allegro_amarka` — config.js, stala KANALY).
  it('klucz sklepu „allegrowy” nie jest kanałem Allegro', () => {
    const { doNadania } = podzielDoNadania([zam({ sklep: 'allegrowy', metoda_wysylki: 'dpd' })]);
    expect(doNadania).toHaveLength(1);
  });

  it('zaznaczenie mieszane DPD + paczkomat: DPD idzie do nadania, paczkomat wypada z powodem', () => {
    const lista = [
      zam({ id: 1, numer: 'D', metoda_wysylki: 'dpd' }),
      zam({ id: 2, numer: 'P', metoda_wysylki: 'inpost_paczkomat' }),
    ];
    const { doNadania, pominiete } = podzielDoNadania(lista);
    expect(doNadania.map((z) => z.numer)).toEqual(['D']);
    expect(pominiete).toHaveLength(1);
    expect(pominiete[0].numer).toBe('P');
    // PRZ-070: paczkomat idzie hurtem — ten, z fixture bez kodu, odpada za brak kodu.
    expect(pominiete[0].powod).toMatch(/nie ma kodu paczkomatu/);
  });
});
