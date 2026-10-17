import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect } from 'vitest';
import { atrybutyWariantu, osiePodzialu } from '../../../src/domena/atrybuty-wariantu.js';
import { powodPominiecia, kartaZProduktu, czyPominietyCelowo } from '../../../src/domena/karta-z-produktu.js';
import { grupujPominiete } from '../../../src/domena/magazyn-pominiete.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszProduktSklepowy, utworzKarte, powiazProdukt, utworzKartyZNiepowiazanych, produktyPominiete,
} from '../../../src/oms/db/magazyn.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Wariant ze sklepu, tak jak lezy w lustrze. `atrybuty_json` PODAJE SIE JAWNIE w kazdym
// tescie, ktory o nim mowi — brak klucza znaczy „lustro jeszcze nie wie" i to tez jest
// przypadek do sprawdzenia, a nie niedopatrzenie.
const W = (nad = {}) => ({
  kanal: 'szkicownia', produkt_id: '7179', wariant_id: '7180', nazwa: 'Kolekcja Las',
  rozmiar_tekst: null, ...nad,
});
const atrybuty = (...pary) => JSON.stringify(pary.map(([nazwa, wartosc]) => ({ nazwa, wartosc })));

// ATRYBUTY WARIANTU — trzy stany, nie dwa.
//
// ⚠️ Lustro do 2026-08-11 NIE TRZYMALO atrybutow wariantu w ogole. Kolumna `atrybuty_json`
// dochodzi migracja, a istniejace 1459 wierszy dostanie w niej NULL az do najblizszego
// odczytu katalogow. Dlatego „nie wiemy" musi byc ODROZNIALNE od „sklep nie dal zadnego
// atrybutu": pierwsze znaczy „kliknij Odczytaj katalogi", drugie znaczy „popraw sklep",
// a pomylenie ich albo zaklada 20 nierozroznialnych kart ze starych danych, albo wysyla
// wlasciciela do naprawy sklepu, w ktorym nie ma czego naprawiac.
describe('atrybutyWariantu — trzy stany lustra', () => {
  it('brak kolumny w wierszu znaczy „nie wiemy", a nie „brak atrybutow"', () => {
    expect(atrybutyWariantu({ wariant_id: '27001', nazwa: 'X' })).toBe(null);
  });

  it('NULL w kolumnie tez znaczy „nie wiemy"', () => {
    expect(atrybutyWariantu({ wariant_id: '27001', atrybuty_json: null })).toBe(null);
  });

  it('pusta tablica znaczy „sklep nie dal ZADNEGO atrybutu" — i to jest wiedza', () => {
    expect(atrybutyWariantu({ wariant_id: '27001', atrybuty_json: '[]' })).toEqual([]);
  });

  it('oddaje pary nazwa/wartosc tak, jak zapisal je odczyt', () => {
    expect(atrybutyWariantu({
      wariant_id: '7180',
      atrybuty_json: '[{"nazwa":"motyw","wartosc":"Szyszka"}]',
    })).toEqual([{ nazwa: 'motyw', wartosc: 'Szyszka' }]);
  });
});

// OS PODZIALU — atrybut, ktory realnie robi z wariantu OSOBNA KARTE.
//
// ⚠️ `cena` i `rozmiar` NIE SA taka osia i to sa dwa rozne powody.
// `cena`: „ta sama karta po 79/99/119 zl" nie jest trzema kartami — spec §0d wprost odmawia
//   zgadywania, ktora cena to ktory rozmiar.
// `rozmiar`: rozmiar ma WLASNE KOLUMNY (`szerokosc_mm`/`wysokosc_mm`) i wlasny ekran; gdyby
//   wchodzil do osi, ~229 poprawnie opisanych wariantow PRO dostaloby nazwy w rodzaju
//   „Szpulka — 70 x 100 cm" zamiast „Szpulka", czyli regresja na glownej sciezce modulu.
describe('osiePodzialu — co robi z wariantu osobną kartę', () => {
  it('zwykly atrybut JEST osia podzialu', () => {
    expect(osiePodzialu([{ nazwa: 'uklad', wartosc: 'NAPRZEMIENNIE' }]))
      .toEqual([{ nazwa: 'uklad', wartosc: 'NAPRZEMIENNIE' }]);
  });

  it('sama cena NIE jest osia podzialu', () => {
    expect(osiePodzialu([{ nazwa: 'cena', wartosc: '69' }])).toEqual([]);
  });

  it('sam rozmiar NIE jest osia podzialu — ma wlasne kolumny', () => {
    expect(osiePodzialu([{ nazwa: 'Rozmiar', wartosc: '70 x 100 cm' }])).toEqual([]);
  });

  it('atrybut obok ceny i rozmiaru zostaje osia', () => {
    expect(osiePodzialu([
      { nazwa: 'Cena', wartosc: '79' },
      { nazwa: 'cyfra', wartosc: '7' },
      { nazwa: 'rozmiar', wartosc: '70 x 100 cm' },
    ])).toEqual([{ nazwa: 'cyfra', wartosc: '7' }]);
  });
});

// ROZSTRZYGNIECIE WLASCICIELA (2026-08-11, po pierwszym prawdziwym odczycie 1459 pozycji):
// wariant, ktory ma jakakolwiek OS PODZIALU, zaklada karte. Skoro sklep sam wskazal, czym
// warianty sie roznia, i nie jest tym rozmiar, to sa to ROZNE KARTY — a nie ta sama karta
// w roznych rozmiarach. Do 2026-08-11 wpadaly one do jednego worka „wariant bez rozmiaru"
// razem z produktami, ktore nie niosa nic.
describe('powodPominiecia — wariant bez rozmiaru rozpada sie na cztery sprawy', () => {
  it('wariant z osia podzialu ZAKLADA karte', () => {
    expect(powodPominiecia(W({ atrybuty_json: atrybuty(['motyw', 'Szyszka']) }), ['pro', 'szkicownia'])).toBe(null);
  });

  // Para do powyzszego: straznik ma MILCZEC przy osi, ale ODEZWAC sie przy jej braku.
  // To sa `Koła duże` (26953) i `X` (26998) — 6 wariantow, ceny 79/99/119, ZERO atrybutow.
  // Ceny SA tam rozmiarami, ale panel nie ma czego przeczytac, a drabinka cenowa to
  // zgadywanie, ktorego spec zabrania. Powod ma wiec mowic, CO wlasciciel poprawia w sklepie.
  it('wariant BEZ ZADNEGO atrybutu nie zaklada karty i mowi, co poprawic w sklepie', () => {
    const powod = powodPominiecia(W({ nazwa: 'Koła duże', atrybuty_json: '[]' }), ['pro', 'szkicownia']);
    // Nie „jest zle", tylko CZYNNOSC: nazwij atrybut w sklepie i podaj w nim rozmiary.
    expect(powod).toMatch(/nazw/i);
    expect(powod).toMatch(/atrybut/i);
    expect(powod).toMatch(/rozmiar/i);
  });

  // `Projekt indywidualny` (4464): 12 wariantow, osia podzialu jest SAMA CENA (69..129),
  // bez SKU. To nie sa karty i nigdy nie beda — powod ma to mowic wprost, zeby ekran
  // „pominiete" mogl je odlozyc do „tak ma byc" razem z ofertami Allegro.
  it('wariant, ktorego jedynym atrybutem jest cena, nie jest kartą', () => {
    expect(powodPominiecia(W({ nazwa: 'Projekt indywidualny', atrybuty_json: atrybuty(['cena', '69']) }), ['pro', 'szkicownia']))
      .toMatch(/cen/i);
  });

  // ⚠️ TRZECI STAN. 1459 wierszy zapisanych przed ta zmiana ma `atrybuty_json` NULL — i to
  // NIE ZNACZY „sklep nie dal atrybutu". Zalozenie kart z takich danych daloby 20 kart
  // o nazwie „KLOSZE wys. 90cm (Mleczne)", nierozroznialnych; odeslanie do naprawy sklepu
  // kazaloby poprawiac sklep, ktory jest w porzadku. Panel ma powiedziec, co sam ma zrobic.
  it('wariant, ktorego atrybutow lustro NIE ZNA, czeka na odczyt katalogow', () => {
    expect(powodPominiecia(W(), ['pro', 'szkicownia'])).toMatch(/odczyt/i);
  });

  // ⚠️ PARA CHRONIACA GLOWNA SCIEZKE: ~229 poprawnie opisanych wariantow PRO ma rozmiar
  // w atrybucie i NIE MA jeszcze `atrybuty_json`. Gdyby brak atrybutow w lustrze blokowal
  // takze je, pierwsze klikniecie po wdrozeniu zalozyloby o ~229 kart mniej.
  it('wariant Z ROZMIAREM zaklada karte takze wtedy, gdy lustro nie zna jeszcze atrybutow', () => {
    expect(powodPominiecia(W({ nazwa: 'Plafon', rozmiar_tekst: '70 x 100 cm' }), ['pro', 'szkicownia'])).toBe(null);
  });
});

// ⚠️⚠️ NAZWA MUSI NIESC WARTOSC OSI PODZIALU. Bez tego z `Kolekcja Las` powstaja TRZY karty
// o nazwie „Kolekcja Las" — nierozroznialne na liscie, w filtrze i w generatorze SKU, a do sklepu
// poszedlby wymiar i SKU losowej z trzech. To ta sama usterka, przed ktora
// broni sie caly ten modul, tylko przesunieta o jeden krok.
describe('kartaZProduktu — nazwa niesie wartosc osi podzialu', () => {
  it('doklada wartosc atrybutu do nazwy rodzica', () => {
    expect(kartaZProduktu(W({ atrybuty_json: atrybuty(['motyw', 'Szyszka']) })).nazwa)
      .toBe('Kolekcja Las — Szyszka');
  });

  // ⚠️ WARTOSCI NIE KALECZYMY. Sklep zapisal „Szyszka" i „NAPRZEMIENNIE" — polskie znaki
  // i wielkie litery sa TRESCIA, a nie stylem do znormalizowania. Po tej nazwie wlasciciel
  // rozpoznaje karte na liscie i w wyszukiwarce.
  it('nie kaleczy polskich znakow ani wielkich liter', () => {
    expect(kartaZProduktu(W({ nazwa: 'Księżyc Senny', atrybuty_json: atrybuty(['uklad', 'NAPRZEMIENNIE']) })).nazwa)
      .toBe('Księżyc Senny — NAPRZEMIENNIE');
  });

  it('przy kilku osiach niesie wszystkie, w kolejnosci ze sklepu', () => {
    expect(kartaZProduktu({
      kanal: 'pro', wariant_id: '1074', nazwa: 'KLOSZE wys. 90cm (Mleczne)', rozmiar_tekst: null,
      atrybuty_json: atrybuty(['szklo', 'Mleczne'], ['cyfra', '7']),
    }).nazwa).toBe('KLOSZE wys. 90cm (Mleczne) — Mleczne, 7');
  });

  it('trzy warianty tego samego rodzica daja TRZY ROZNE nazwy', () => {
    const nazwy = ['Szyszka', 'Żołądź', 'Liść']
      .map((w) => kartaZProduktu(W({ atrybuty_json: atrybuty(['motyw', w]) })).nazwa);
    expect(new Set(nazwy).size).toBe(3);
  });

  // ⚠️ PARA MILCZENIA #1: ~229 poprawnie opisanych wariantow PRO rozroznia ROZMIAR, ktory ma
  // wlasne kolumny. Dopisanie go do nazwy zamienialoby „Szpulka" w „Szpulka — 70 x 100 cm"
  // na calej glownej sciezce modulu.
  it('sam rozmiar do nazwy NIE wchodzi', () => {
    expect(kartaZProduktu({
      kanal: 'pro', wariant_id: '1091', nazwa: 'Plafon', rozmiar_tekst: '70 x 100 cm',
      atrybuty_json: atrybuty(['rozmiar', '70 x 100 cm']),
    }).nazwa).toBe('Plafon');
  });

  // ⚠️ PARA MILCZENIA #2: produkt prosty i wiersz, ktorego atrybutow lustro nie zna, maja
  // dostac nazwe DOKLADNIE taka jak dotad.
  it('bez znanych atrybutow nazwa zostaje nietknieta', () => {
    expect(kartaZProduktu({ kanal: 'szkicownia', wariant_id: '', nazwa: 'Plecionka' }).nazwa).toBe('Plecionka');
    expect(kartaZProduktu(W({ nazwa: 'Plecionka', rozmiar_tekst: '70 x 100 cm' })).nazwa).toBe('Plecionka');
  });
});

// ⚠️⚠️ ATRYBUTOW WARIANTU DO 2026-08-11 NIE BYLO W LUSTRZE W OGOLE. Jedynym ich sladem byly
// parametry w kolumnie `adres` (`?attribute_uklad=…`) — czyli w PERMALINKU, ktory jest ozdoba:
// sklep moze go przebudowac, przepisac na identyfikatory albo wylaczyc ladne adresy, a panel
// dowiedzialby sie o tym dopiero po zalozeniu setek kart o zlych nazwach. Dlatego wlasna
// kolumna, wypelniana z odpowiedzi WooCommerce, a nie parser adresu.
describe('lustro trzyma atrybuty wariantu we WLASNEJ kolumnie', () => {
  it('istniejaca baza dostaje kolumne migracja, a nie dopiero przy zakladaniu od zera', () => {
    // PRZ026-13: odmowa niezgodnej nieoznaczonej bazy i zachowanie danych przy poprawnym reopen.
    potwierdzOdmoweHistorycznegoSchema(
      ['ALTER TABLE produkty_sklepowe DROP COLUMN atrybuty_json'], ['atrybuty_json']);
    const katalog = mkdtempSync(join(tmpdir(), 'oms-warianty-reopen-'));
    const plik = join(katalog, 'oms.sqlite');
    const zapisaneAtrybuty = atrybuty(['motyw', 'Szyszka']);
    try {
      const pierwsza = openOmsDb(plik);
      let produktId;
      let kartaId;
      try {
        kartaId = utworzKarte(pierwsza, { nazwa: 'Kandelabr wariantu', sku: 'TEST-13' });
        produktId = zapiszProduktSklepowy(pierwsza, {
          kanal: 'kanal-testowy', produkt_id: '7179', wariant_id: '7180',
          nazwa: 'Kandelabr produktu', sku_sklepu: 'TEST-13', cena_gr: 9900,
          odczytane_at: '2026-10-01T10:00:00Z', atrybuty_json: zapisaneAtrybuty,
        });
        powiazProdukt(pierwsza, produktId, kartaId);
      } finally { pierwsza.close(); }
      const druga = openOmsDb(plik);
      try {
        expect(druga.prepare('PRAGMA table_info(produkty_sklepowe)').all().map(k => k.name))
          .toContain('atrybuty_json');
        expect(druga.prepare('SELECT kanal,produkt_id,wariant_id,nazwa,sku_sklepu,cena_gr,atrybuty_json,karta_id FROM produkty_sklepowe WHERE id=?').get(produktId))
          .toEqual({ kanal: 'kanal-testowy', produkt_id: '7179', wariant_id: '7180',
            nazwa: 'Kandelabr produktu', sku_sklepu: 'TEST-13', cena_gr: 9900,
            atrybuty_json: zapisaneAtrybuty, karta_id: kartaId });
        expect(druga.prepare('SELECT nazwa,sku FROM karty_produktow WHERE id=?').get(kartaId))
          .toEqual({ nazwa: 'Kandelabr wariantu', sku: 'TEST-13' });
      } finally { druga.close(); }
    } finally { rmSync(katalog, { recursive: true, force: true }); }
  });

  it('odczyt katalogu zapisuje atrybuty i odswieza je przy kolejnym przebiegu', () => {
    const db = openOmsDb(':memory:');
    const wiersz = {
      kanal: 'szkicownia', produkt_id: '7179', wariant_id: '7180', nazwa: 'Kolekcja Las',
      odczytane_at: '2026-08-11T06:00:00.000Z', atrybuty_json: atrybuty(['motyw', 'Szyszka']),
    };
    const id = zapiszProduktSklepowy(db, wiersz);
    expect(db.prepare('SELECT atrybuty_json FROM produkty_sklepowe WHERE id = ?').get(id).atrybuty_json)
      .toBe(atrybuty(['motyw', 'Szyszka']));

    // Wlasciciel przemianowal wartosc w sklepie — lustro ma za nia POJSC, a nie zostac
    // przy starej. Kolumna lustra, wiec `DO UPDATE SET`, tak jak nazwa i cena.
    zapiszProduktSklepowy(db, { ...wiersz, atrybuty_json: atrybuty(['motyw', 'Żołądź']) });
    expect(db.prepare('SELECT atrybuty_json FROM produkty_sklepowe WHERE id = ?').get(id).atrybuty_json)
      .toBe(atrybuty(['motyw', 'Żołądź']));
  });

  // ⚠️ PARA: kolumna lustra przepisuje sie przy kazdym odczycie, ale POWIAZANIE Z KARTĄ ma
  // przezyc. Gdyby `atrybuty_json` trafilo na liste kolumn kasowanych/zerowanych albo gdyby
  // przy okazji ruszylo `karta_id`, kazde odswiezenie katalogu zrywaloby reczna prace wlasciciela.
  it('zapis atrybutow nie zrywa powiazania z kartą', () => {
    const db = openOmsDb(':memory:');
    const wiersz = {
      kanal: 'szkicownia', produkt_id: '7179', wariant_id: '7180', nazwa: 'Kolekcja Las',
      odczytane_at: '2026-08-11T06:00:00.000Z', atrybuty_json: '[]',
    };
    const id = zapiszProduktSklepowy(db, wiersz);
    const kartaId = utworzKarte(db, { nazwa: 'Kolekcja Las' });
    powiazProdukt(db, id, kartaId);

    zapiszProduktSklepowy(db, { ...wiersz, atrybuty_json: atrybuty(['motyw', 'Liść']) });

    expect(db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(id).karta_id).toBe(kartaId);
  });
});

// „TAK MA BYC" ROZSTRZYGA POZYCJA, NIE SAM KANAL.
//
// ⚠️ Do 2026-08-11 grupa byla „celowa" dokladnie wtedy, gdy zadna jej pozycja nie pochodzila
// z kanalu sklepowego — czyli w praktyce: gdy mowila wylacznie o ofertach Allegro. Pomiar na
// produkcyjnej bazie pokazal 13 pozycji ZE SKLEPU, ktore kartami nie beda nigdy: `Projekt
// indywidualny` (12 wariantow roznicych sie sama cena) i zaslepka `psm-zam-placeholder`.
// Siedzialy w „robocie", czyli na gorze ekranu, i udawaly usterke do naprawienia — a naprawic
// ich sie nie da, bo nie sa zepsute.
describe('czyPominietyCelowo — co odklada sie do „tak ma byc"', () => {
  it('oferta Allegro — tak ma byc (kanal nie zaklada kart)', () => {
    expect(czyPominietyCelowo({ kanal: 'allegro_szkicownia', nazwa: 'Lampa SZPULKA' }, ['pro', 'szkicownia'])).toBe(true);
  });

  it('zaslepka panelu ofert — tak ma byc, choc siedzi w kanale sklepowym', () => {
    expect(czyPominietyCelowo({
      kanal: 'szkicownia', wariant_id: '', nazwa: 'Pozycja indywidualna', sku_sklepu: 'psm-zam-placeholder',
    }, ['pro', 'szkicownia'])).toBe(true);
  });

  it('wariant rozniacy sie sama cena — tak ma byc', () => {
    expect(czyPominietyCelowo(W({ nazwa: 'Projekt indywidualny', atrybuty_json: atrybuty(['cena', '69']) }), ['pro', 'szkicownia']))
      .toBe(true);
  });

  // ⚠️ PARY MILCZENIA. Wszystko ponizej to ROBOTA i ma zostac na gorze ekranu — inaczej
  // 6 wierszy do naprawienia w sklepie schowaloby sie pod zwinieta sekcja na dole.
  it('wariant bez atrybutu to ROBOTA — sklep da sie poprawic', () => {
    expect(czyPominietyCelowo(W({ nazwa: 'Koła duże', atrybuty_json: '[]' }), ['pro', 'szkicownia'])).toBe(false);
  });

  it('wariant, ktorego atrybutow lustro nie zna, to ROBOTA — wystarczy odczytac katalogi', () => {
    expect(czyPominietyCelowo(W(), ['pro', 'szkicownia'])).toBe(false);
  });

  it('produkt sklepowy bez nazwy to ROBOTA', () => {
    expect(czyPominietyCelowo({ kanal: 'szkicownia', wariant_id: '', nazwa: '  ' }, ['pro', 'szkicownia'])).toBe(false);
  });
});

describe('grupujPominiete — grupa celowa po TRESCI pozycji', () => {
  it('zaslepki i pozycje cennikowe ze sklepu ida do „tak ma byc"', () => {
    const [grupa] = grupujPominiete([{
      id: 1, kanal: 'szkicownia', nazwa: 'Pozycja indywidualna',
      sku_sklepu: 'psm-zam-placeholder', powod: 'zaślepka',
    }], ['pro', 'szkicownia']);
    expect(grupa.celowo).toBe(true);
  });

  // Para: ten sam kanal, ta sama grupa — ale pozycja, ktora DA SIE naprawic, robi z grupy robote.
  it('wariant do naprawy w sklepie zostaje ROBOTA', () => {
    const [grupa] = grupujPominiete([{
      id: 2, kanal: 'szkicownia', wariant_id: '26954', nazwa: 'Koła duże',
      atrybuty_json: '[]', powod: 'bez atrybutu',
    }], ['pro', 'szkicownia']);
    expect(grupa.celowo).toBe(false);
  });
});

// ============================================================================
// SWIADECTWO: 47 POZYCJI Z PIERWSZEGO PRAWDZIWEGO ODCZYTU
// ============================================================================
//
// ⚠️⚠️ TO NIE SA WYMYSLONE DANE. Pierwszy odczyt katalogow (2026-08-11) wciagnal 1459 pozycji.
// Kart powstalo 0, bo zakladanie jest osobnym przyciskiem — ale ekran „pominiete" pokazal
// 47 pozycji ZE SKLEPOW, ktore do jednego worka „wariant bez rozmiaru" wpadaly z CZTERECH
// ROZNYCH powodow. Ten test odtwarza te cztery grupy i zostaje w suicie jako odpowiedz na
// pytanie „skad sie wziely te reguly": kazda z nich ma tu swoj rzad w tabeli.
//
//   20 — `KLOSZE wys. 90/50cm (Mleczne)`, PRO: szklo + cyfra 0..9, kazdy wariant z wlasnym SKU
//    8 — `Kolekcja Las` (motyw=Szyszka/Żołądź/Liść), `Księżyc Senny` i `Gliwka` (uklad=…), po 79 zl
//    6 — `Koła duże`, `X`: ZERO atrybutow, ceny 79/99/119 (ceny SA rozmiarami, ale nikt tego
//        nie napisal — i wlasnie dlatego karta z nich nie powstaje)
//   13 — `Projekt indywidualny` (12 wariantow, os podzialu = sama cena) i zaslepka
//        `psm-zam-placeholder`: to nie sa karty i nigdy nie beda
const LUSTRO = '2026-08-11T06:00:00.000Z';

// ⚠️ Pomiar zapisal LACZNIE 8 pozycji w drugiej grupie i po trzy wartosci `uklad`, ale nie
// zapisal, ktory z dwoch produktow ma ich trzy, a ktory dwie. Regula od tego nie zalezy —
// liczy sie, ze KAZDY z tych wierszy ma os podzialu — wiec fixture bierze 3 + 3 + 2 = 8.
function pierwszyOdczyt(baza) {
  const wpisz = (p) => zapiszProduktSklepowy(baza, { odczytane_at: LUSTRO, ...p });

  // GRUPA 1 — rozmiar stoi w nazwie RODZICA, os podzialu to cyfra.
  for (const [produktId, nazwa] of [['1074', 'KLOSZE wys. 90cm (Mleczne)'], ['1075', 'KLOSZE wys. 50cm (Mleczne)']]) {
    for (let cyfra = 0; cyfra <= 9; cyfra += 1) {
      wpisz({
        kanal: 'pro', produkt_id: produktId, wariant_id: `${produktId}${cyfra}`, nazwa,
        sku_sklepu: `LMP-KLOSZE${produktId === '1074' ? '90' : '50'}-07${cyfra}`,
        cena_gr: 8900, rozmiar_tekst: null,
        atrybuty_json: atrybuty(['szklo', 'Mleczne'], ['cyfra', String(cyfra)]),
      });
    }
  }

  // GRUPA 2 — os podzialu jest, rozmiaru nie ma NIGDZIE (wlasciciel: wszystkie 70×100,
  // wpisze sie hurtem — Zadanie 12 partii 2).
  const grupa2 = [
    ['7179', 'Kolekcja Las', 'motyw', ['Szyszka', 'Żołądź', 'Liść']],
    ['10018', 'Księżyc Senny', 'uklad', ['RÓWNOLEGLE', 'NAPRZEMIENNIE', 'NIEREGULARNIE']],
    ['10269', 'Gliwka', 'uklad', ['RÓWNOLEGLE', 'NAPRZEMIENNIE']],
  ];
  for (const [produktId, nazwa, atrybut, wartosci] of grupa2) {
    wartosci.forEach((wartosc, i) => wpisz({
      kanal: 'szkicownia', produkt_id: produktId, wariant_id: `${produktId}${i}`, nazwa,
      sku_sklepu: null, cena_gr: 7900, rozmiar_tekst: null,
      atrybuty_json: atrybuty([atrybut, wartosc]),
    }));
  }

  // GRUPA 3 — ZADNYCH atrybutow. Ceny sa rozmiarami, ale panel nie ma czego przeczytac.
  for (const [produktId, nazwa] of [['26953', 'Koła duże'], ['26998', 'X']]) {
    [7900, 9900, 11900].forEach((cena, i) => wpisz({
      kanal: 'szkicownia', produkt_id: produktId, wariant_id: `${produktId}${i}`, nazwa,
      sku_sklepu: null, cena_gr: cena, rozmiar_tekst: null, atrybuty_json: '[]',
    }));
  }

  // GRUPA 4 — to nie sa karty.
  [69, 79, 89, 99, 109, 119, 129, 139, 149, 159, 169, 179].forEach((cena, i) => wpisz({
    kanal: 'szkicownia', produkt_id: '4464', wariant_id: `4464${i}`, nazwa: 'Projekt indywidualny',
    sku_sklepu: null, cena_gr: cena * 100, rozmiar_tekst: null,
    atrybuty_json: atrybuty(['cena', String(cena)]),
  }));
  wpisz({
    kanal: 'szkicownia', produkt_id: '9001', wariant_id: '', nazwa: 'Pozycja indywidualna',
    sku_sklepu: 'psm-zam-placeholder', cena_gr: 100, rozmiar_tekst: null,
  });
}

describe('cztery grupy z pierwszego odczytu — ile kart powstaje z kazdej', () => {
  it('47 pozycji daje 28 kart, 6 pozycji do naprawy w sklepie i 13 „tak ma byc"', () => {
    const db = openOmsDb(':memory:');
    pierwszyOdczyt(db);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c).toBe(47);

    const wynik = utworzKartyZNiepowiazanych(db, { kanalySklepow: ['pro', 'szkicownia'],  teraz: '2026-08-11T09:00:00Z' });

    // 20 (KLOSZE) + 8 (Kolekcja Las/Księżyc Senny/Gliwka) — dokladnie te, ktorym sklep wskazal os podzialu.
    expect(wynik.utworzone).toBe(28);
    expect(wynik.pominiete).toHaveLength(19);

    const grupy = grupujPominiete(produktyPominiete(db, ['pro', 'szkicownia']), ['pro', 'szkicownia']);
    const robota = grupy.filter((g) => !g.celowo);
    const takMaByc = grupy.filter((g) => g.celowo);
    expect(robota.reduce((s, g) => s + g.ile, 0)).toBe(6);
    expect(takMaByc.reduce((s, g) => s + g.ile, 0)).toBe(13);
    // ROBOTA NA GORZE — 6 wierszy do poprawienia nie ma prawa schowac sie pod 13 pozycjami,
    // z ktorymi nie ma nic do roboty.
    expect(grupy[0].celowo).toBe(false);
  });

  it('kazdy z 28 kart ma INNA nazwe — po to os podzialu wchodzi do nazwy', () => {
    const db = openOmsDb(':memory:');
    pierwszyOdczyt(db);
    utworzKartyZNiepowiazanych(db, { kanalySklepow: ['pro', 'szkicownia'],  teraz: '2026-08-11T09:00:00Z' });

    const nazwy = db.prepare('SELECT nazwa FROM karty_produktow').all().map((w) => w.nazwa);
    expect(nazwy).toHaveLength(28);
    expect(new Set(nazwy).size).toBe(28);
    expect(nazwy).toContain('Kolekcja Las — Szyszka');
    expect(nazwy).toContain('Księżyc Senny — NIEREGULARNIE');
    expect(nazwy).toContain('KLOSZE wys. 90cm (Mleczne) — Mleczne, 7');
  });

  // ⚠️ GLOBAL CONSTRAINT: ROZMIAR NIGDY NIE ZGADUJE. Zaden z tych 28 kart nie dostaje
  // wymiarow — `KLOSZE wys. 90cm` niesie w nazwie JEDNA liczbe, a karta potrzebuje dwoch, wiec
  // „90 cm" musialoby dorobic szerokosc z niczego. Wszystkie 28 trafia na liste „bez wymiarow"
  // i wymiar wpisze sie hurtem; to jest wynik POPRAWNY, a nie brakujaca funkcja.
  it('zaden z 28 kart nie dostaje zgadnietego wymiaru', () => {
    const db = openOmsDb(':memory:');
    pierwszyOdczyt(db);
    utworzKartyZNiepowiazanych(db, { kanalySklepow: ['pro', 'szkicownia'],  teraz: '2026-08-11T09:00:00Z' });

    expect(db.prepare(
      'SELECT COUNT(*) c FROM karty_produktow WHERE szerokosc_mm IS NOT NULL OR wysokosc_mm IS NOT NULL',
    ).get().c).toBe(0);
  });

  // ⚠️ DRUGIE KLIKNIECIE NIE MNOZY. Te 28 kart powstaje z pozycji, ktore do 2026-08-11
  // karty nie mialy — a przycisk jest jeden i wlasciciel klika go po kazdym odczycie.
  it('drugie klikniecie nie dokłada ani jednej karty', () => {
    const db = openOmsDb(':memory:');
    pierwszyOdczyt(db);
    utworzKartyZNiepowiazanych(db, { kanalySklepow: ['pro', 'szkicownia'],  teraz: '2026-08-11T09:00:00Z' });
    const drugie = utworzKartyZNiepowiazanych(db, { kanalySklepow: ['pro', 'szkicownia'],  teraz: '2026-08-11T10:00:00Z' });

    expect(drugie.utworzone).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow').get().c).toBe(28);
  });
});
