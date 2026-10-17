import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { miniaturyLustra } from '../../../src/oms/db/miniatury-lustra.js';
import { kluczLustra, miniaturaZLustra, miniaturaPozycji } from '../../../src/domena/miniatura-pozycji.js';

// ================================================================================
// MINIATURA POZYCJI ZAMOWIENIA — PRAWDA Z LUSTRA, ZGADYWANIE JAKO SIATKA
//
// Zgloszenie wlasciciela: zdjecia produktow nie laduja sie na ekranach zamowien. Powod jest
// ten sam, ktory 2026-08-12 naprawiono w magazynie: `adresMiniatury` DOKLEJA `-150x150` do
// nazwy pliku oryginalu, a szkicownia.pl skaluje miniatury do `247x296`. Zmierzone na
// produkcji: pro.szkicownia.pl 0% brakow, szkicownia.pl 608 brakow na 684 (89%).
//
// ⚠️⚠️ POPRAWA MA BYC SCISLE JEDNOSTRONNA i to jest NAJWAZNIEJSZY warunek tej zmiany, a nie
// ostroznosc. Przy naprawie magazynu ekran przestawiono na czytanie WYLACZNIE nowej kolumny;
// kolumna startowala pusta, wiec zgasly takze miniatury PRO, ktore wczesniej dzialaly —
// usterka czesciowa zamienila sie w calkowita az do recznego odczytu katalogow. Tutaj:
//   * produkt jest w lustrze i ma `miniatura` → prawdziwy adres (naprawa dla szkicownia.pl);
//   * produktu nie ma w lustrze albo `miniatura` pusta → DOTYCHCZASOWY zgadywany adres
//     (PRO dziala jak dotad, Allegro dziala jak dotad, archiwum dziala jak dotad).
// Ponizsze `describe` trzyma te pare wprost, zeby zadna przyszla „porzadkujaca" zmiana nie
// mogla przeciac galezi zapasowej po cichu.

describe('kluczLustra — para (kanal, produkt) jako jeden klucz mapy', () => {
  it('sklada kanal i identyfikator produktu w jeden klucz', () => {
    expect(kluczLustra('szkicownia', '944')).toBe(kluczLustra('szkicownia', '944'));
    expect(kluczLustra('szkicownia', '944')).not.toBe(kluczLustra('pro', '944'));
  });

  // ⚠️ `pozycje.produkt_id` jest kolumna INTEGER, a `produkty_sklepowe.produkt_id` kolumna
  // TEXT. Bez jednej konwersji po naszej stronie 944 !== '944' rozminaloby sie z lustrem
  // CICHO: zielona suita, zero bledow i ani jednej miniatury wiecej niz dzis.
  it('identyfikator liczbowy daje ten sam klucz co napis', () => {
    expect(kluczLustra('szkicownia', 944)).toBe(kluczLustra('szkicownia', '944'));
  });

  // Brak identyfikatora to pozycja dopisana recznie — nie ma czego szukac w lustrze
  // i nie wolno zbudowac klucza, ktory trafilby w cudzy wiersz.
  it('brak kanalu albo produktu nie daje klucza w ogole', () => {
    expect(kluczLustra('szkicownia', null)).toBe(null);
    expect(kluczLustra('szkicownia', undefined)).toBe(null);
    expect(kluczLustra('szkicownia', '')).toBe(null);
    expect(kluczLustra(null, '944')).toBe(null);
    expect(kluczLustra('', '944')).toBe(null);
  });

  // ⚠️ Rozdzielacz nie moze byc znakiem, ktory wystepuje w kanale albo w identyfikatorze —
  // inaczej ('a-b', 'c') i ('a', 'b-c') byloby tym samym kluczem, czyli cudza miniatura.
  it('rozdzielacz nie skleja dwoch roznych par w jeden klucz', () => {
    expect(kluczLustra('a', 'bc')).not.toBe(kluczLustra('ab', 'c'));
  });
});

describe('miniaturaZLustra — lustro wygrywa, zgadywanie zostaje siatka', () => {
  const ORYGINAL = 'https://szkicownia.pl/wp-content/uploads/2026/07/kot.jpg';
  const ZGADNIETY = 'https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg';
  const PRAWDZIWY = 'https://szkicownia.pl/wp-content/uploads/2026/07/kot-247x296.jpg';

  // STRAZNIK DZIALA: produkt znany lustru bierze adres, ktory sklep NAPRAWDE wygenerowal.
  it('znany produkt dostaje adres z lustra, a nie doklejony rozmiar', () => {
    expect(miniaturaZLustra(PRAWDZIWY, ORYGINAL)).toBe(PRAWDZIWY);
  });

  // STRAZNIK MILCZY: produkt nieznany lustru zachowuje sie DOKLADNIE jak dotad.
  it('nieznany produkt dostaje dotychczasowy adres zgadywany', () => {
    expect(miniaturaZLustra(null, ORYGINAL)).toBe(ZGADNIETY);
    expect(miniaturaZLustra(undefined, ORYGINAL)).toBe(ZGADNIETY);
  });

  // Pusta kolumna to nadal „nie wiemy" — trzy stany kolumny `miniatura` opisuje schema.sql.
  it('pusta wartosc z lustra nie gasi zdjecia, tylko wraca do zgadywania', () => {
    expect(miniaturaZLustra('', ORYGINAL)).toBe(ZGADNIETY);
    expect(miniaturaZLustra('   ', ORYGINAL)).toBe(ZGADNIETY);
  });

  // Lustro bierze sie z cudzego API i laduje wprost w atrybucie `src` naszego HTML-a —
  // ten sam warunek, co przy kazdym innym adresie w domain/miniatury.js.
  it('adres spoza http(s) z lustra jest odrzucany, a nie wpuszczany do src', () => {
    expect(miniaturaZLustra('javascript:alert(1)', ORYGINAL)).toBe(ZGADNIETY);
    expect(miniaturaZLustra('/wp-content/kot.jpg', ORYGINAL)).toBe(ZGADNIETY);
  });

  // Allegro nie ma Store API, wiec do lustra nic tam nie trafia — i wlasnie dlatego galaz
  // zapasowa musi zostac: dla Allegro to ONA jest droga poprawna (podmiana /original/ na /s150/).
  it('pozycja Allegro bez wpisu w lustrze dostaje wariant s150, tak jak dotad', () => {
    expect(miniaturaZLustra(null, 'https://9.allegroimg.com/original/03e7d6/772bd1'))
      .toBe('https://9.allegroimg.com/s150/03e7d6/772bd1');
  });

  // ⚠️ Produkt znany lustru, ale pozycja bez wlasnego zdjecia (stara pozycja, sklep dolozyl
  // zdjecie pozniej) MA zobaczyc miniature — to jest zysk, a nie ryzyko: dzis komorka jest
  // pusta, wiec gorzej byc nie moze.
  it('brak zdjecia w pozycji nie blokuje adresu z lustra', () => {
    expect(miniaturaZLustra(PRAWDZIWY, null)).toBe(PRAWDZIWY);
  });

  it('brak i tu, i tam daje brak, a nie pusta ramke', () => {
    expect(miniaturaZLustra(null, null)).toBe(null);
    expect(miniaturaZLustra('', '')).toBe(null);
  });
});

describe('miniaturaPozycji — jedna droga dla wszystkich czterech ekranow', () => {
  const ORYGINAL = 'https://szkicownia.pl/wp-content/uploads/2026/07/kot.jpg';
  const PRAWDZIWY = 'https://szkicownia.pl/wp-content/uploads/2026/07/kot-247x296.jpg';
  const lustro = new Map([[kluczLustra('szkicownia', '944'), PRAWDZIWY]]);

  it('trafienie w lustrze oddaje adres ze sklepu', () => {
    expect(miniaturaPozycji(lustro, 'szkicownia', 944, ORYGINAL)).toBe(PRAWDZIWY);
  });

  it('pudlo w lustrze oddaje adres dotychczasowy', () => {
    expect(miniaturaPozycji(lustro, 'szkicownia', 999, ORYGINAL))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg');
    expect(miniaturaPozycji(lustro, 'pro', 944, ORYGINAL))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg');
  });

  // Pozycja dopisana recznie nie ma produktu w sklepie — ma sie zachowac jak dotad,
  // a nie szukac w lustrze klucza zbudowanego z pustki.
  it('pozycja bez produktu zachowuje sie jak dotad', () => {
    expect(miniaturaPozycji(lustro, 'reczne', null, ORYGINAL))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg');
  });

  // Brak lustra w ogole (ekran, ktory go jeszcze nie zbudowal) NIE MOZE rzucic — to byloby
  // 500 zamiast listy zamowien.
  it('brak mapy lustra nie rzuca, tylko wraca do zgadywania', () => {
    expect(miniaturaPozycji(null, 'szkicownia', 944, ORYGINAL))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg');
    expect(miniaturaPozycji(undefined, 'szkicownia', 944, ORYGINAL))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-150x150.jpg');
  });
});

// ================================================================================
// ODCZYT LUSTRA — JEDNO ZAPYTANIE NA EKRAN

const P = (nad = {}) => ({
  kanal: 'szkicownia', produkt_id: '944', wariant_id: '', nazwa: 'Kot 70x100',
  zdjecia_json: '["https://szkicownia.pl/wp-content/uploads/2026/07/kot.jpg"]',
  miniatura: 'https://szkicownia.pl/wp-content/uploads/2026/07/kot-247x296.jpg',
  odczytane_at: '2026-08-12T10:00:00Z', ...nad,
});

describe('miniaturyLustra — mapa (kanal, produkt) → adres miniatury', () => {
  it('oddaje adres zapisany przez odczyt katalogu', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    const mapa = miniaturyLustra(db, [{ kanal: 'szkicownia', produktId: 944 }]);
    expect(mapa.get(kluczLustra('szkicownia', '944')))
      .toBe('https://szkicownia.pl/wp-content/uploads/2026/07/kot-247x296.jpg');
  });

  // ⚠️ TEN SAM identyfikator produktu wystepuje w OBU sklepach niezaleznie (Woo numeruje
  // wpisy per instalacja). Mapa kluczowana samym numerem podstawilaby zdjecie z PRO
  // pod pozycje ze szkicownia.pl — czyli pokazalaby operatorowi NIE TEN produkt.
  it('ten sam numer produktu w dwoch kanalach to dwa rozne wpisy', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ kanal: 'szkicownia', miniatura: 'https://szkicownia.pl/a.jpg' }));
    zapiszProduktSklepowy(db, P({ kanal: 'pro', miniatura: 'https://pro.szkicownia.pl/b.png' }));
    const mapa = miniaturyLustra(db, [
      { kanal: 'szkicownia', produktId: '944' }, { kanal: 'pro', produktId: '944' },
    ]);
    expect(mapa.get(kluczLustra('szkicownia', '944'))).toBe('https://szkicownia.pl/a.jpg');
    expect(mapa.get(kluczLustra('pro', '944'))).toBe('https://pro.szkicownia.pl/b.png');
  });

  // ⚠️⚠️ ZAPYTANIE JEST PROSTOKATEM SZERSZYM NIZ ZBIOR PAR: `kanal IN (…) AND produkt_id IN (…)`
  // zwraca takze rogi, o ktore nikt nie pytal. Prawdziwym straznikiem poprawnosci jest wiec
  // ODSIEW PO STRONIE JS, a nie sam warunek SQL — i to on jest tu sprawdzany.
  //
  // ⚠️ WSZYSTKIE CZTERY ROGI MUSZA ISTNIEC W BAZIE, inaczej test celuje w cel, ktorego nie ma:
  // przy dwoch wierszach (szkicownia/1 i pro/2) prostokat jest pusty w rogach i test przechodzi
  // TAKZE bez odsiewu — sprawdzone weryfikacja mutacyjna, pierwsza wersja tego testu wlasnie
  // tak przepuszczala usuniecie `szukane.has(klucz)`.
  it('rog prostokata, o ktory nie pytano, nie wchodzi do mapy', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ kanal: 'szkicownia', produkt_id: '1', miniatura: 'https://szkicownia.pl/s1.jpg' }));
    zapiszProduktSklepowy(db, P({ kanal: 'szkicownia', produkt_id: '2', miniatura: 'https://szkicownia.pl/s2.jpg' }));
    zapiszProduktSklepowy(db, P({ kanal: 'pro', produkt_id: '1', miniatura: 'https://pro.szkicownia.pl/p1.png' }));
    zapiszProduktSklepowy(db, P({ kanal: 'pro', produkt_id: '2', miniatura: 'https://pro.szkicownia.pl/p2.png' }));

    // Pytamy o PRZEKATNA: szkicownia/1 i pro/2. Rogi szkicownia/2 i pro/1 ISTNIEJA w bazie
    // i wpadaja w prostokat `IN` — mapa nie ma prawa ich wpuscic.
    const mapa = miniaturyLustra(db, [
      { kanal: 'szkicownia', produktId: '1' }, { kanal: 'pro', produktId: '2' },
    ]);
    expect(mapa.get(kluczLustra('szkicownia', '1'))).toBe('https://szkicownia.pl/s1.jpg');
    expect(mapa.get(kluczLustra('pro', '2'))).toBe('https://pro.szkicownia.pl/p2.png');
    expect(mapa.get(kluczLustra('szkicownia', '2'))).toBeUndefined();
    expect(mapa.get(kluczLustra('pro', '1'))).toBeUndefined();
    expect(mapa.size).toBe(2);
  });

  // Kolumna ma TRZY STANY (schema.sql): NULL = „nie wiemy". Wpis „wiem, ze nie wiem"
  // przecialby galaz zapasowa — czyli zgasilby zdjecia, ktore dzis dzialaja.
  it('produkt bez zapisanej miniatury nie ma wpisu w ogole', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ miniatura: null }));
    zapiszProduktSklepowy(db, P({ produkt_id: '945', miniatura: '   ' }));
    const mapa = miniaturyLustra(db, [
      { kanal: 'szkicownia', produktId: '944' }, { kanal: 'szkicownia', produktId: '945' },
    ]);
    expect(mapa.has(kluczLustra('szkicownia', '944'))).toBe(false);
    expect(mapa.has(kluczLustra('szkicownia', '945'))).toBe(false);
  });

  // ⚠️ `pozycje.produkt_id` TRZYMA RODZICA, NIGDY WARIANTU — i to jest powod, dla ktorego
  // ta droga w ogole dziala: `miniatura` w lustrze jest miniatura PRODUKTU, a wariant niesie
  // miniature rodzica (Store API oddaje zdjecia na produkcie). Produkt wariantowy ma w lustrze
  // WIELE wierszy o tym samym `produkt_id`; wybor musi byc deterministyczny, inaczej ta sama
  // pozycja pokazywalaby raz jedno, raz drugie zdjecie.
  it('produkt wariantowy oddaje zawsze ten sam, deterministyczny adres', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ wariant_id: '1091', miniatura: 'https://szkicownia.pl/pierwszy.jpg' }));
    zapiszProduktSklepowy(db, P({ wariant_id: '1092', miniatura: 'https://szkicownia.pl/drugi.jpg' }));
    const pytanie = [{ kanal: 'szkicownia', produktId: '944' }];
    expect(miniaturyLustra(db, pytanie).get(kluczLustra('szkicownia', '944')))
      .toBe('https://szkicownia.pl/pierwszy.jpg');
    expect(miniaturyLustra(db, pytanie).get(kluczLustra('szkicownia', '944')))
      .toBe('https://szkicownia.pl/pierwszy.jpg');
  });

  // Wariant rodzica bez wlasnej miniatury nie ma prawa przeslonic wariantu, ktory ja ma —
  // „pierwszy wiersz" znaczy „pierwszy wiersz Z MINIATURA".
  it('wiersz bez miniatury nie przeslania wiersza, ktory ja ma', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ wariant_id: '1091', miniatura: null }));
    zapiszProduktSklepowy(db, P({ wariant_id: '1092', miniatura: 'https://szkicownia.pl/drugi.jpg' }));
    expect(miniaturyLustra(db, [{ kanal: 'szkicownia', produktId: '944' }]).get(kluczLustra('szkicownia', '944')))
      .toBe('https://szkicownia.pl/drugi.jpg');
  });

  // ⚠️ Produkt WYCOFANY ze sklepu zostaje w lustrze (`zniknal_at`) i jego miniatura NADAL
  // jest prawdziwa. Archiwum zamowien to najwiekszy zbior ekranow, na ktorych ta poprawka
  // ma cos zmienic — odsianie znikietych zabraloby wlasnie jego.
  it('produkt wycofany ze sklepu nadal oddaje swoja miniature', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-08-11T10:00:00Z'").run();
    expect(miniaturyLustra(db, [{ kanal: 'szkicownia', produktId: '944' }]).has(kluczLustra('szkicownia', '944')))
      .toBe(true);
  });

  it('puste pytanie oddaje pusta mape', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    expect(miniaturyLustra(db, []).size).toBe(0);
    expect(miniaturyLustra(db).size).toBe(0);
  });

  // Pozycja dopisana recznie nie ma produktu w sklepie. Para bez identyfikatora ma po prostu
  // wypasc z pytania, a nie zbudowac warunku, ktory zlapie wiersz o pustym `produkt_id`.
  it('pary bez kanalu albo bez produktu wypadaja z pytania', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    expect(miniaturyLustra(db, [{ kanal: 'reczne', produktId: null }, { kanal: null, produktId: '944' }]).size)
      .toBe(0);
  });

  // ⚠️ MAPA, NIE LITERAL OBIEKTU. Klucz rowny nazwie odziedziczonej z `Object.prototype`
  // („constructor", „__proto__") oddalby funkcje natywna zamiast `undefined` — a ta trafilaby
  // wprost do atrybutu `src` na karcie zamowienia.
  it('nazwa odziedziczona z Object.prototype nie udaje adresu miniatury', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    const mapa = miniaturyLustra(db, [{ kanal: 'szkicownia', produktId: '944' }]);
    for (const zla of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(mapa.get(kluczLustra(zla, zla))).toBeUndefined();
      expect(mapa.get(zla)).toBeUndefined();
    }
  });

  it('kanal spoza lustra oddaje pusta mape, a nie blad', () => {
    const db = openOmsDb(':memory:');
    expect(miniaturyLustra(db, [{ kanal: 'allegro_amarka', produktId: '1234567890' }]).size).toBe(0);
  });
});

// ⚠️ TO NIE JEST TEST OZDOBNY — wzorzec z tests/oms/magazyn-db.test.js. Lista zamowien
// renderuje wiele zamowien po wiele pozycji: odczyt „per pozycja" znaczylby setki zapytan
// na KAZDE otwarcie strony glownej. Na bazie testowej jest to niewidoczne, a na produkcyjnej
// klada ekran — dlatego liczymy WYKONANIA, a nie milisekundy.
function bazaZLicznikiem(db) {
  const licznik = { zapytania: 0 };
  const opakuj = (st) => ({
    all: (...a) => { licznik.zapytania += 1; return st.all(...a); },
    get: (...a) => { licznik.zapytania += 1; return st.get(...a); },
    run: (...a) => { licznik.zapytania += 1; return st.run(...a); },
  });
  return [{ prepare: (sql) => opakuj(db.prepare(sql)) }, licznik];
}

describe('miniaturyLustra — koszt odczytu', () => {
  it('liczba zapytan nie rosnie z liczba pozycji na ekranie', () => {
    const db = openOmsDb(':memory:');
    const pary = [];
    for (let i = 0; i < 400; i += 1) {
      zapiszProduktSklepowy(db, P({ produkt_id: String(i), miniatura: `https://szkicownia.pl/${i}.jpg` }));
      pary.push({ kanal: 'szkicownia', produktId: String(i) });
    }

    const [maly, licznikMaly] = bazaZLicznikiem(db);
    expect(miniaturyLustra(maly, pary.slice(0, 3)).size).toBe(3);

    const [duzy, licznikDuzy] = bazaZLicznikiem(db);
    expect(miniaturyLustra(duzy, pary).size).toBe(400);

    expect(licznikDuzy.zapytania).toBe(licznikMaly.zapytania);
    expect(licznikDuzy.zapytania).toBe(1);
  });

  // Ekran bez ani jednej pozycji sklepowej (same zamowienia reczne) nie ma o co pytac —
  // i nie ma prawa dotknac bazy ani razu.
  it('puste pytanie nie dotyka bazy w ogole', () => {
    const [pusty, licznik] = bazaZLicznikiem(openOmsDb(':memory:'));
    expect(miniaturyLustra(pusty, []).size).toBe(0);
    expect(licznik.zapytania).toBe(0);
  });
});
