import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszProduktSklepowy, utworzWzor, powiazProdukt, oznaczZnikniete,
  niepowiazaneOfertyAllegro, powiazaneOfertyAllegro, wzoryDoPowiazania,
  powiazOfertyHurtem, odepnijOferte,
} from '../../../src/oms/db/magazyn.js';

// ZAPYTANIA EKRANU POWIAZAN. Trzy warunki decyduja o tym, CO w ogole czlowiek zobaczy
// na liscie do powiazania, i kazdy z nich ma tu wlasna PARE testow (kiedy wpuszcza
// i kiedy odmawia):
//   (1) `kanal LIKE 'allegro%'` — wzor powstaje z katalogu SKLEPU, wiec produkt sklepowy
//       na tym ekranie nie ma czego szukac (ma juz swoj wzor z osobnego przycisku);
//   (2) `wzor_id IS NULL` — oferta raz powiazana ma zniknac z listy roboty;
//   (3) `zniknal_at IS NULL` — oferta wycofana z Allegro nie jest robota do wykonania.

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const ODCZYT = '2026-08-11T06:00:00.000Z';

function produkt(nadpisania = {}) {
  return zapiszProduktSklepowy(db, {
    kanal: 'allegro_szkicownia', produkt_id: String(Math.random()), wariant_id: '',
    nazwa: 'Oferta', odczytane_at: ODCZYT, ...nadpisania,
  });
}

const nazwy = (lista) => lista.map((w) => w.nazwa);

describe('niepowiazaneOfertyAllegro — co wchodzi na liste roboty', () => {
  it('bierze OBA konta Allegro, a produktow sklepowych NIE', () => {
    produkt({ kanal: 'allegro_szkicownia', nazwa: 'Z konta glownego' });
    produkt({ kanal: 'allegro_amarka', nazwa: 'Z konta drugiego' });
    produkt({ kanal: 'pro', nazwa: 'Z PRO' });
    produkt({ kanal: 'szkicownia', nazwa: 'Ze szkicownia.pl' });

    // ⚠️ Produkt sklepowy trafia tu WYLACZNIE wtedy, gdy warunek kanalu zniknie — a wtedy
    // ekran powiazan proponowalby recznie wiazac to, co „Utwórz wzory z niepowiązanych"
    // wiaze samo i poprawniej (wzor POWSTAJE z produktu sklepowego, nie dobiera sie do niego).
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Z konta drugiego', 'Z konta glownego']);
  });

  it('oferta POWIAZANA znika z listy, niepowiazana zostaje', () => {
    const wzorId = utworzWzor(db, { nazwa: 'Kotwica' });
    const powiazana = produkt({ nazwa: 'Juz powiazana' });
    produkt({ nazwa: 'Jeszcze nie' });
    powiazProdukt(db, powiazana, wzorId);

    // Rozstrzygniecie wlasciciela: „Ofertę raz powiązaną panel ma przestać proponować".
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Jeszcze nie']);
  });

  it('oferta ZNIKNIETA z Allegro nie jest robota do wykonania, zywa jest', () => {
    produkt({ kanal: 'allegro_szkicownia', produkt_id: 'a1', nazwa: 'Zywa' });
    produkt({ kanal: 'allegro_szkicownia', produkt_id: 'a2', nazwa: 'Wycofana', odczytane_at: '2026-08-01T00:00:00.000Z' });
    // Ta sama droga, ktora oznacza znikniete w prawdziwym przebiegu odczytu.
    oznaczZnikniete(db, 'allegro_szkicownia', ODCZYT);

    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Zywa']);
  });

  it('kolejnosc jest ALFABETYCZNA i powtarzalna, nie „jak w bazie"', () => {
    produkt({ nazwa: 'Zakaz palenia' });
    produkt({ nazwa: 'ANNE 23cm/28cm' });
    produkt({ nazwa: 'kotwica morska' });

    // Bez `COLLATE NOCASE` mala litera ladowalaby za wszystkimi wielkimi (porzadek kodow),
    // wiec „kotwica" staloby pod „Zakaz" — a czlowiek szuka wzrokiem po alfabecie.
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])))
      .toEqual(['ANNE 23cm/28cm', 'kotwica morska', 'Zakaz palenia']);
  });
});

describe('wzoryDoPowiazania — katalog kandydatow', () => {
  it('oddaje nazwe, SKU i wymiary — czyli to, czym rozstrzyga sie wybor', () => {
    utworzWzor(db, { nazwa: 'Kotwica', sku: 'PRO-KOT-1', szerokosc_mm: 700, wysokosc_mm: 1000 });
    const [w] = wzoryDoPowiazania(db);

    expect(w).toMatchObject({
      nazwa: 'Kotwica', sku: 'PRO-KOT-1', szerokosc_mm: 700, wysokosc_mm: 1000,
    });
    expect(w.id).toBeGreaterThan(0);
  });

  it('pusty rejestr oddaje pusto — to jest STAN DZISIEJSZY produkcji, nie przypadek krancowy', () => {
    // Na produkcji jest 447 ofert Allegro i ZERO wzorow: zakladanie wzorow to osobny przycisk.
    produkt({ nazwa: 'Oferta bez katalogu' });
    expect(wzoryDoPowiazania(db)).toEqual([]);
  });
});

describe('powiazOfertyHurtem — zatwierdzenie wielu par w JEDNEJ transakcji', () => {
  it('wiaze wszystkie wskazane pary', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const latarnia = utworzWzor(db, { nazwa: 'Latarnia' });
    const a = produkt({ nazwa: 'Kotwica z Allegro' });
    const b = produkt({ nazwa: 'Latarnia z Allegro' });

    const wynik = powiazOfertyHurtem(db, [
      { produktId: a, wzorId: kotwica }, { produktId: b, wzorId: latarnia },
    ], ['allegro_szkicownia', 'allegro_amarka']);

    expect(wynik.powiazane).toEqual([a, b]);
    expect(wynik.nieaktualne).toEqual([]);
    expect(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual([]);
  });

  // ⚠️⚠️ STRAZNIK STANU NIEAKTUALNEGO. Panel nie ma JavaScriptu, wiec formularz zyje
  // w karcie przegladarki tak dlugo, jak dlugo jest otwarta — a przy 447 wierszach jest
  // otwarty dlugo. Druga karta, przycisk Wstecz albo powtorzone wyslanie tego samego
  // formularza przyniosly by pare, ktora ktos juz rozstrzygnal INACZEJ. Bezwarunkowy
  // UPDATE nadpisalby tamten wybor po cichu.
  it('oferta powiazana W MIEDZYCZASIE nie daje sie nadpisac i wraca jako nieaktualna', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const latarnia = utworzWzor(db, { nazwa: 'Latarnia' });
    const a = produkt({ nazwa: 'Sporna' });
    const b = produkt({ nazwa: 'Zwyczajna' });
    powiazProdukt(db, a, kotwica);

    const wynik = powiazOfertyHurtem(db, [
      { produktId: a, wzorId: latarnia }, { produktId: b, wzorId: latarnia },
    ], ['allegro_szkicownia', 'allegro_amarka']);

    expect(wynik.nieaktualne).toEqual([a]);
    expect(wynik.powiazane).toEqual([b]);
    // Wybor sprzed chwili STOI — to jest cala tresc tego strazniks.
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id = ?').get(a).wzor_id)
      .toBe(kotwica);
  });

  it('oferta ZNIKNIETA z Allegro nie daje sie powiazac', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const a = produkt({ produkt_id: 'stara', nazwa: 'Wycofana', odczytane_at: '2026-08-01T00:00:00.000Z' });
    oznaczZnikniete(db, 'allegro_szkicownia', ODCZYT);

    expect(powiazOfertyHurtem(db, [{ produktId: a, wzorId: kotwica }], ['allegro_szkicownia', 'allegro_amarka']).nieaktualne).toEqual([a]);
  });

  // ⚠️ TRANSAKCJA. Blad na dziesiatej parze z czterdziestu nie ma prawa zostawic dziewieciu
  // powiazan i trzydziestu jeden bez — bo drugie klikniecie dolozyloby reszte, a rejestr
  // powstalby z dwoch roznych przebiegow i nikt by juz nie wiedzial, ktora oferta skad jest.
  it('blad w polowie NIE zostawia polowy powiazan', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const a = produkt({ nazwa: 'Pierwsza' });
    const b = produkt({ nazwa: 'Druga' });

    // Wzoru o tym numerze nie ma — klucz obcy odmawia (PRAGMA foreign_keys = ON w openOmsDb).
    expect(() => powiazOfertyHurtem(db, [
      { produktId: a, wzorId: kotwica }, { produktId: b, wzorId: 999999 },
    ], ['allegro_szkicownia', 'allegro_amarka'])).toThrow();

    // ⚠️ PIERWSZA PARA TEZ MA BYC COFNIETA — i to jest cala tresc tego testu. Bez transakcji
    // „Pierwsza" zostalaby powiazana, a lista wrocilaby z jedna pozycja mniej BEZ slowa
    // wyjasnienia, dlaczego reszta nie przeszla.
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Druga', 'Pierwsza']);
  });

  it('pusta lista par niczego nie rusza i nie wywala transakcji', () => {
    produkt({ nazwa: 'Nietknieta' });
    expect(powiazOfertyHurtem(db, [], ['allegro_szkicownia', 'allegro_amarka'])).toEqual({ powiazane: [], nieaktualne: [] });
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Nietknieta']);
  });
});

describe('odepnijOferte — wiazanie jest ODWRACALNE', () => {
  it('odpina oferte Allegro i wraca ona na liste roboty', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const a = produkt({ nazwa: 'Pomylka' });
    powiazProdukt(db, a, kotwica);

    expect(odepnijOferte(db, a, ['allegro_szkicownia', 'allegro_amarka'])).toBe(true);
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Pomylka']);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY, I NIE JEST TO FORMALNOSC. Bez warunku kanalu ta trasa odpinalaby
  // DOWOLNY wiersz lustra po numerze — takze produkt sklepowy, ktorego powiazanie z wzorem
  // ZBUDOWALO ten wzor („Utwórz wzory z niepowiązanych"). Wzor zostalby wtedy sierota:
  // bez ceny, bez zdjecia, bez kategorii, i bez sladu, co go osierocilo.
  it('produktu SKLEPOWEGO nie odpina i mowi o tym wprost', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const sklepowy = produkt({ kanal: 'pro', nazwa: 'Kotwica ze sklepu' });
    powiazProdukt(db, sklepowy, kotwica);

    expect(odepnijOferte(db, sklepowy, ['allegro_szkicownia', 'allegro_amarka'])).toBe(false);
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id = ?').get(sklepowy).wzor_id)
      .toBe(kotwica);
  });

  it('numer, ktorego nie ma, oddaje „nic nie zrobiono" zamiast wyjatku', () => {
    expect(odepnijOferte(db, 999999, ['allegro_szkicownia', 'allegro_amarka'])).toBe(false);
  });
});

describe('powiazaneOfertyAllegro — skad w ogole wziac co odpiac', () => {
  it('pokazuje oferte razem z nazwa wzoru, do ktorego zostala przypieta', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica morska', sku: 'PRO-KOT-1' });
    const a = produkt({ nazwa: 'KOTWICA szablon malarski' });
    produkt({ nazwa: 'Niepowiazana' });
    powiazProdukt(db, a, kotwica);

    // ⚠️ NAZWA WZORU JEDZIE Z ZAPYTANIA, a nie z drugiego odczytu per wiersz: przy setkach
    // powiazan „jedno zapytanie na wiersz" to setki zapytan na kazde otwarcie ekranu.
    expect(powiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual([{
      id: a, kanal: 'allegro_szkicownia', nazwa: 'KOTWICA szablon malarski',
      wzor_id: kotwica, wzor_nazwa: 'Kotwica morska', wzor_sku: 'PRO-KOT-1',
    }]);
  });

  it('produkt SKLEPOWY powiazany z wzorem tu nie wchodzi', () => {
    const kotwica = utworzWzor(db, { nazwa: 'Kotwica' });
    const sklepowy = produkt({ kanal: 'szkicownia', nazwa: 'Kotwica ze sklepu' });
    powiazProdukt(db, sklepowy, kotwica);

    // Gdyby wchodzil, ekran oferowalby przycisk „odepnij" przy wierszu, ktorego `odepnijOferte`
    // i tak odmawia — czyli przycisk, ktory nic nie robi i nie mowi dlaczego.
    expect(powiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual([]);
  });
});
