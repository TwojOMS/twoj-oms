import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszProduktSklepowy, utworzKarte, powiazProdukt, oznaczZnikniete,
  niepowiazaneOfertyAllegro, powiazaneOfertyAllegro, kartyDoPowiazania,
  powiazOfertyHurtem, odepnijOferte,
} from '../../../src/oms/db/magazyn.js';

// ZAPYTANIA EKRANU POWIAZAN. Trzy warunki decyduja o tym, CO w ogole czlowiek zobaczy
// na liscie do powiazania, i kazdy z nich ma tu wlasna PARE testow (kiedy wpuszcza
// i kiedy odmawia):
//   (1) `kanal LIKE 'allegro%'` — karta powstaje z katalogu SKLEPU, wiec produkt sklepowy
//       na tym ekranie nie ma czego szukac (ma juz swoja karte z osobnego przycisku);
//   (2) `karta_id IS NULL` — oferta raz powiazana ma zniknac z listy roboty;
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
    produkt({ kanal: 'szkicownia', nazwa: 'Ze sklepu A' });

    // ⚠️ Produkt sklepowy trafia tu WYLACZNIE wtedy, gdy warunek kanalu zniknie — a wtedy
    // ekran powiazan proponowalby recznie wiazac to, co „Utwórz karty z niepowiązanych"
    // wiaze samo i poprawniej (karta POWSTAJE z produktu sklepowego, nie dobiera sie do niego).
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Z konta drugiego', 'Z konta glownego']);
  });

  it('oferta POWIAZANA znika z listy, niepowiazana zostaje', () => {
    const kartaId = utworzKarte(db, { nazwa: 'Kandelabr' });
    const powiazana = produkt({ nazwa: 'Juz powiazana' });
    produkt({ nazwa: 'Jeszcze nie' });
    powiazProdukt(db, powiazana, kartaId);

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
    produkt({ nazwa: 'Trójnóg podłogowy' });
    produkt({ nazwa: 'ABAŻUR 23cm/28cm' });
    produkt({ nazwa: 'kandelabr srebrny' });

    // Bez `COLLATE NOCASE` mala litera ladowalaby za wszystkimi wielkimi (porzadek kodow),
    // wiec „kandelabr" staloby pod „Trójnóg" — a czlowiek szuka wzrokiem po alfabecie.
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])))
      .toEqual(['ABAŻUR 23cm/28cm', 'kandelabr srebrny', 'Trójnóg podłogowy']);
  });
});

describe('kartyDoPowiazania — katalog kandydatow', () => {
  it('oddaje nazwe, SKU i wymiary — czyli to, czym rozstrzyga sie wybor', () => {
    utworzKarte(db, { nazwa: 'Kandelabr', sku: 'LMP-KAN-1', szerokosc_mm: 700, wysokosc_mm: 1000 });
    const [w] = kartyDoPowiazania(db);

    expect(w).toMatchObject({
      nazwa: 'Kandelabr', sku: 'LMP-KAN-1', szerokosc_mm: 700, wysokosc_mm: 1000,
    });
    expect(w.id).toBeGreaterThan(0);
  });

  it('pusty rejestr oddaje pusto — to jest STAN DZISIEJSZY produkcji, nie przypadek krancowy', () => {
    // Na produkcji jest 447 ofert Allegro i ZERO kart: zakladanie kart to osobny przycisk.
    produkt({ nazwa: 'Oferta bez katalogu' });
    expect(kartyDoPowiazania(db)).toEqual([]);
  });
});

describe('powiazOfertyHurtem — zatwierdzenie wielu par w JEDNEJ transakcji', () => {
  it('wiaze wszystkie wskazane pary', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const lampion = utworzKarte(db, { nazwa: 'Lampion' });
    const a = produkt({ nazwa: 'Kandelabr z Allegro' });
    const b = produkt({ nazwa: 'Lampion z Allegro' });

    const wynik = powiazOfertyHurtem(db, [
      { produktId: a, kartaId: kandelabr }, { produktId: b, kartaId: lampion },
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
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const lampion = utworzKarte(db, { nazwa: 'Lampion' });
    const a = produkt({ nazwa: 'Sporna' });
    const b = produkt({ nazwa: 'Zwyczajna' });
    powiazProdukt(db, a, kandelabr);

    const wynik = powiazOfertyHurtem(db, [
      { produktId: a, kartaId: lampion }, { produktId: b, kartaId: lampion },
    ], ['allegro_szkicownia', 'allegro_amarka']);

    expect(wynik.nieaktualne).toEqual([a]);
    expect(wynik.powiazane).toEqual([b]);
    // Wybor sprzed chwili STOI — to jest cala tresc tego strazniks.
    expect(db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(a).karta_id)
      .toBe(kandelabr);
  });

  it('oferta ZNIKNIETA z Allegro nie daje sie powiazac', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const a = produkt({ produkt_id: 'stara', nazwa: 'Wycofana', odczytane_at: '2026-08-01T00:00:00.000Z' });
    oznaczZnikniete(db, 'allegro_szkicownia', ODCZYT);

    expect(powiazOfertyHurtem(db, [{ produktId: a, kartaId: kandelabr }], ['allegro_szkicownia', 'allegro_amarka']).nieaktualne).toEqual([a]);
  });

  // ⚠️ TRANSAKCJA. Blad na dziesiatej parze z czterdziestu nie ma prawa zostawic dziewieciu
  // powiazan i trzydziestu jeden bez — bo drugie klikniecie dolozyloby reszte, a rejestr
  // powstalby z dwoch roznych przebiegow i nikt by juz nie wiedzial, ktora oferta skad jest.
  it('blad w polowie NIE zostawia polowy powiazan', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const a = produkt({ nazwa: 'Pierwsza' });
    const b = produkt({ nazwa: 'Druga' });

    // Karty o tym numerze nie ma — odmawia `wymagajKarty` (karta_id nie ma klucza obcego, PRZ-090).
    expect(() => powiazOfertyHurtem(db, [
      { produktId: a, kartaId: kandelabr }, { produktId: b, kartaId: 999999 },
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
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const a = produkt({ nazwa: 'Pomylka' });
    powiazProdukt(db, a, kandelabr);

    expect(odepnijOferte(db, a, ['allegro_szkicownia', 'allegro_amarka'])).toBe(true);
    expect(nazwy(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka']))).toEqual(['Pomylka']);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY, I NIE JEST TO FORMALNOSC. Bez warunku kanalu ta trasa odpinalaby
  // DOWOLNY wiersz lustra po numerze — takze produkt sklepowy, ktorego powiazanie z kartą
  // ZBUDOWALO te karte („Utwórz karty z niepowiązanych"). Karta zostalaby wtedy sierota:
  // bez ceny, bez zdjecia, bez kategorii, i bez sladu, co ja osierocilo.
  it('produktu SKLEPOWEGO nie odpina i mowi o tym wprost', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const sklepowy = produkt({ kanal: 'pro', nazwa: 'Kandelabr ze sklepu' });
    powiazProdukt(db, sklepowy, kandelabr);

    expect(odepnijOferte(db, sklepowy, ['allegro_szkicownia', 'allegro_amarka'])).toBe(false);
    expect(db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(sklepowy).karta_id)
      .toBe(kandelabr);
  });

  it('numer, ktorego nie ma, oddaje „nic nie zrobiono" zamiast wyjatku', () => {
    expect(odepnijOferte(db, 999999, ['allegro_szkicownia', 'allegro_amarka'])).toBe(false);
  });
});

describe('powiazaneOfertyAllegro — skad w ogole wziac co odpiac', () => {
  it('pokazuje oferte razem z nazwa karty, do ktorego zostala przypieta', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr srebrny', sku: 'LMP-KAN-1' });
    const a = produkt({ nazwa: 'KANDELABR ozdobny wysoki' });
    produkt({ nazwa: 'Niepowiazana' });
    powiazProdukt(db, a, kandelabr);

    // ⚠️ NAZWA KARTY JEDZIE Z ZAPYTANIA, a nie z drugiego odczytu per wiersz: przy setkach
    // powiazan „jedno zapytanie na wiersz" to setki zapytan na kazde otwarcie ekranu.
    expect(powiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual([{
      id: a, kanal: 'allegro_szkicownia', nazwa: 'KANDELABR ozdobny wysoki',
      karta_id: kandelabr, karta_nazwa: 'Kandelabr srebrny', karta_sku: 'LMP-KAN-1',
    }]);
  });

  it('produkt SKLEPOWY powiazany z kartą tu nie wchodzi', () => {
    const kandelabr = utworzKarte(db, { nazwa: 'Kandelabr' });
    const sklepowy = produkt({ kanal: 'szkicownia', nazwa: 'Kandelabr ze sklepu' });
    powiazProdukt(db, sklepowy, kandelabr);

    // Gdyby wchodzil, ekran oferowalby przycisk „odepnij" przy wierszu, ktorego `odepnijOferte`
    // i tak odmawia — czyli przycisk, ktory nic nie robi i nie mowi dlaczego.
    expect(powiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual([]);
  });
});
