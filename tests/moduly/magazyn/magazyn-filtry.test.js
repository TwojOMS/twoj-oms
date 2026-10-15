import { describe, it, expect, beforeEach } from 'vitest';
import {
  filtryZZapytania, parametryUkryte, wartosciPol, saJakiesFiltry, adresMagazynu,
  BRAKI_MAGAZYNU, PACZKOMAT_DO_FILTRA, BRAKI_ETYKIETY,
} from '../../../src/domena/magazyn-filtry.js';
// Jawne wejście historycznych testów; pętle sprawdzają filtr i zachowanie bazy.
const KANALY_MAGAZYNU = ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka'];
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzWzor, zapiszProduktSklepowy, powiazProdukt, wzoryZKanalami } from '../../../src/oms/db/magazyn.js';

// FILTRY MAGAZYNU — warstwa czysta miedzy adresem HTTP a zapytaniem.
//
// ⚠️ Ten modul jest SLOWNIKIEM, ktory musi sie zgadzac z `db/magazyn.js` co do jednej
// wartosci. Warstwa zapytan traktuje NIEZNANA wartosc filtru jako `1 = 0`, czyli oddaje
// PUSTO — swiadomie, bo filtr, ktorego nie rozumiemy, nie ma prawa poszerzac zbioru przed
// edycja hurtem. Skutek uboczny jest taki, ze pozycja wystawiona w interfejsie, a nieznana
// bazie, daje PUSTY EKRAN zamiast wyniku — i wyglada jak „nie ma takich wzorow", a nie jak
// brakujaca funkcja. Dlatego kazda z trzech list nizej jest przypieta do zachowania bazy,
// a nie tylko do samej siebie.

describe('filtryZZapytania — czytanie adresu', () => {
  it('czyta wszystkie filtry naraz', () => {
    expect(filtryZZapytania({
      fraza: 'pieszy',
      kanal: 'pro',
      kategoria: 'Aplikacje',
      brak: 'sku',
      paczkomat: 'nieoznaczone',
      cenaOd: '10',
      cenaDo: '99',
    }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka'])).toEqual({
      fraza: 'pieszy',
      kanal: 'pro',
      kategoria: 'Aplikacje',
      brak: 'sku',
      paczkomat: 'nieoznaczone',
      // Ceny w GROSZACH — kolumna `produkty_sklepowe.cena_gr` jest INTEGER-em w groszach,
      // a porownanie zlotowek z groszami przesunie granice filtru o dwa rzedy wielkosci.
      cenaOd: 1000,
      cenaDo: 9900,
    });
  });

  it('puste pole ceny to brak filtru, a nie zero', () => {
    // Zero jest WARTOSCIA: „od 0 zl" przepuszcza produkty za darmo i rodzicow wariantowych.
    // Puste pole formularza ma znaczyc „nie zawezaj", i te dwie rzeczy nie moga byc tym samym.
    expect(filtryZZapytania({ cenaOd: '' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(null);
    expect(filtryZZapytania({ cenaOd: '   ' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(null);
    expect(filtryZZapytania({}, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(null);
    expect(filtryZZapytania({ cenaOd: '0' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(0);
  });

  it('cena z przecinkiem dziesietnym, bo tak sie ja pisze po polsku', () => {
    expect(filtryZZapytania({ cenaOd: '74,90' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(7490);
    expect(filtryZZapytania({ cenaOd: '74.90' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(7490);
  });

  it('cena, ktorej nie umiemy przeliczyc, spada do braku filtru zamiast wywalac ekran', () => {
    // `groszeZKwoty` RZUCA na niezrozumialej kwocie i tak ma zostac — to sa pieniadze
    // zapisywane do bazy. Ale tutaj kwota przychodzi z paska adresu, wiec literowka ma
    // pokazac liste, a nie pieciusetke.
    for (const zla of ['abc', '10zl', '1e5', '-5', '10.', 'NaN', '99 99']) {
      expect(filtryZZapytania({ cenaOd: zla }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(null);
      expect(filtryZZapytania({ cenaDo: zla }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaDo).toBe(null);
    }
  });

  it('nieznana wartosc filtru jest odrzucana, nie przekazywana dalej', () => {
    expect(filtryZZapytania({ kanal: 'sklep-ktorego-nie-ma' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kanal).toBe(null);
    expect(filtryZZapytania({ brak: 'cokolwiek' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).brak).toBe(null);
    expect(filtryZZapytania({ paczkomat: 'moze' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).paczkomat).toBe(null);
  });

  it('nazwa z lancucha prototypow nie przechodzi przez zadna z bialych list', () => {
    // ⚠️ `LISTA[x] ?? domyslne` oddaje funkcje z `Object.prototype` — realna pieciusetka
    // zlapana przy Zadaniu 4 na `?sort=constructor`. Filtry czytaja z tego samego adresu.
    for (const zly of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(filtryZZapytania({ kanal: zly }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kanal).toBe(null);
      expect(filtryZZapytania({ brak: zly }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).brak).toBe(null);
      expect(filtryZZapytania({ paczkomat: zly }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).paczkomat).toBe(null);
    }
  });

  it('powtorzony parametr adresu (tablica) nie leci dalej jako tablica', () => {
    // Fastify oddaje `?fraza=a&fraza=b` jako tablice. Tablica w LIKE albo w `=` konczy sie
    // wiazaniem, ktorego node:sqlite nie przyjmie — czyli pieciusetka z paska adresu.
    expect(filtryZZapytania({ fraza: ['a', 'b'] }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).fraza).toBe(null);
    expect(filtryZZapytania({ kanal: ['pro', 'szkicownia'] }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kanal).toBe(null);
    expect(filtryZZapytania({ kategoria: ['Boho', 'Aplikacje'] }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kategoria).toBe(null);
    expect(filtryZZapytania({ cenaOd: ['10', '20'] }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).cenaOd).toBe(null);
  });

  it('fraza jest przycinana, a sama biel to brak frazy', () => {
    expect(filtryZZapytania({ fraza: '  pieszy  ' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).fraza).toBe('pieszy');
    expect(filtryZZapytania({ fraza: '   ' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).fraza).toBe(null);
  });

  it('kategoria NIE ma zamknietej listy — nazwy przychodza ze sklepow', () => {
    // Odwrotnie niz kanaly: kategorie doklada SKLEP, bez pytania nas o zdanie (ta sama
    // asymetria, co przy metodach platnosci na liscie zamowien). Nazwa nietrafiona po prostu
    // nie trafi w zaden wzor — i to jest inna sytuacja niz „wartosc spoza slownika".
    expect(filtryZZapytania({ kategoria: 'Kategoria, ktorej jeszcze nie ma' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kategoria)
      .toBe('Kategoria, ktorej jeszcze nie ma');
    expect(filtryZZapytania({ kategoria: '  Boho  ' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kategoria).toBe('Boho');
    expect(filtryZZapytania({ kategoria: '' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).kategoria).toBe(null);
  });
});

// ⚠️⚠️ MINA Z ZADANIA 4. Warstwa zapytan zna DOKLADNIE cztery braki: sku, wymiary,
// kategoria, paczkomat. Plan Zadania 10 proponowal `brak ∈ sku|wymiary|allegro` — wartosci
// `allegro` w `db/magazyn.js` NIE MA i nieznana wartosc leci tam w `1 = 0`. Pozycja
// „bez oferty na Allegro" wystawiona w interfejsie oddawalaby wiec PUSTA LISTE przy kazdym
// klknieciu, co wyglada jak „nie ma takich wzorow", a nie jak funkcja, ktorej nie napisano.
describe('slowniki filtrow zgadzaja sie z warstwa zapytan', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  // ⚠️ KAZDEMU WZOROWI BRAKUJE DOKLADNIE JEDNEJ RZECZY, i kazdemu innej.
  //
  // Wczesniej stal tu jeden wzor „Niepelny" bez NICZEGO — a wtedy wszystkie cztery pozycje
  // `brak` oddawaly ten sam wiersz i test nie odrozial ich od siebie: podmiana galezi
  // `brak === 'sku'` na warunek o wymiarach przechodzila na zielono. Wlasciwosc byla
  // GWARANTOWANA USTAWIENIEM ATRAPY, a nie sprawdzana — ta sama rodzina, co produkt
  // zawsze powiazany z wzorem.
  //
  // ⚠️ PIATA POZYCJA (`komplet`) NIE JEST BRAKIEM, tylko druga strona tej samej monety:
  // wzory, ktorym NICZEGO nie brakuje. W tym katalogu jest to dokladnie jeden wiersz, wiec
  // rozjechanie sie jej z warstwa zapytan pada tak samo jak przy czterech pozostalych.
  const WZOR_POZYCJI = Object.freeze({
    sku: 'BezSku',
    wymiary: 'BezWymiarow',
    kategoria: 'BezKategorii',
    paczkomat: 'BezPaczkomatu',
    komplet: 'Komplet',
  });

  function katalog() {
    // `wzory.sku` ma UNIQUE, wiec kazdy wzor dostaje wlasny numer — inaczej atrapa wysypuje
    // sie na wiezie, zamiast opisac katalog.
    const pelny = (nazwa) => ({
      nazwa, sku: `PRO-${nazwa}`, szerokosc_mm: 700, wysokosc_mm: 1000,
      kategoria_glowna: 'Boho', paczkomat: 'tak',
    });
    const bez = {
      sku: { sku: null },
      // Polowiczny wymiar to nadal brak wymiarow — do ciecia potrzebne sa oba.
      wymiary: { wysokosc_mm: null },
      kategoria: { kategoria_glowna: null },
      paczkomat: { paczkomat: null },
    };
    // ⚠️ `komplet` z WZOR_POZYCJI wlasnym wzorem nie jest — to TEN wzor, ktory ma komplet.
    const komplet = utworzWzor(db, pelny(WZOR_POZYCJI.komplet));
    for (const [brak, dziura] of Object.entries(bez)) {
      utworzWzor(db, { ...pelny(WZOR_POZYCJI[brak]), ...dziura });
    }
    // Dwa produkty w lustrze, w roznych kanalach — zeby „filtr zawezil" znaczylo cos wiecej
    // niz „filtr czegos nie wywalil".
    for (const [wzorId, kanal, produktId] of [[komplet, 'pro', '1']]) {
      const p = zapiszProduktSklepowy(db, {
        kanal, produkt_id: produktId, wariant_id: '', cena_gr: 5000, nazwa: `Produkt ${produktId}`,
        odczytane_at: '2026-08-11T06:00:00.000Z',
      });
      powiazProdukt(db, p, wzorId);
    }
  }

  it('KAZDA pozycja z BRAKI_MAGAZYNU zaweza do SWOJEGO wzoru, a nie do „byle niepelnego"', () => {
    katalog();
    expect(wzoryZKanalami(db, {})).toHaveLength(5);

    for (const brak of BRAKI_MAGAZYNU) {
      const wynik = wzoryZKanalami(db, { filtry: { brak } });
      // Pozycja nieznana bazie oddalaby ZERO na kazdym katalogu. A ze kazdemu wzorowi
      // brakuje CZEGOS INNEGO, przestawienie dwoch galezi miedzy soba tez tu pada.
      expect(wynik.map((w) => w.nazwa), `brak=${brak}`).toEqual([WZOR_POZYCJI[brak]]);
    }
  });

  // ⚠️ PIATA POZYCJA JEST KAFLEM POSTEPU, a kafel PROWADZI do listy. Gdyby `komplet` zostalo
  // dopisane do slownika, a warstwa zapytan go nie znala, kafel „gotowe: 214" prowadzilby
  // do PUSTEJ tabeli — czyli do obrazu „nie ma takich wzorow" przy 214 wzorach, ktore sa.
  it('komplet jest pozycja slownika, ma etykiete i baza go rozumie', () => {
    katalog();
    expect(BRAKI_MAGAZYNU).toContain('komplet');
    expect(BRAKI_ETYKIETY.komplet).toBe('komplet — nic nie brakuje');
    expect(filtryZZapytania({ brak: 'komplet' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).brak).toBe('komplet');
    // Cztery niepelne wzory z `katalog()` maja tu NIE BYC — inaczej „komplet" znaczyloby
    // „cokolwiek", a hurt puszczony po tym zawezeniu ruszylby caly katalog.
    expect(wzoryZKanalami(db, { filtry: { brak: 'komplet' } }).map((w) => w.nazwa))
      .toEqual(['Komplet']);
  });

  // Pole wyboru filtru sklada trasa jako `BRAKI_MAGAZYNU.map(k => ({k, BRAKI_ETYKIETY[k]}))`,
  // wiec pozycja bez etykiety renderuje sie jako PUSTY wiersz listy rozwijanej — widoczny,
  // klikalny i nie do nazwania.
  it('KAZDA pozycja slownika ma etykiete, bo z nich powstaje pole wyboru', () => {
    for (const brak of BRAKI_MAGAZYNU) {
      expect(BRAKI_ETYKIETY[brak], `etykieta dla brak=${brak}`).toBeTruthy();
    }
    expect(Object.keys(BRAKI_ETYKIETY).sort()).toEqual([...BRAKI_MAGAZYNU].sort());
  });

  it('pozycja SPOZA slownika oddaje pusto — i wlasnie dlatego slownik musi sie zgadzac', () => {
    katalog();
    // Straznik milczy (wyzej) i straznik alarmuje (tutaj). `allegro` z planu Zadania 10 jest
    // wlasnie taka wartoscia — dlatego nie ma go w BRAKI_MAGAZYNU.
    expect(BRAKI_MAGAZYNU).not.toContain('allegro');
    expect(wzoryZKanalami(db, { filtry: { brak: 'allegro' } })).toEqual([]);
    expect(filtryZZapytania({ brak: 'allegro' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']).brak).toBe(null);
  });

  it('KAZDY kanal ze slownika zaweza do SWOJEGO wzoru, a nie do „byle majacego produkt"', () => {
    // ⚠️ Wczesniej stal tu JEDEN wzor obecny we WSZYSTKICH czterech kanalach i drugi bez
    // produktu — a wtedy filtr, ktory w ogole nie patrzy na wartosc `kanal`, oddawal ten sam
    // wynik i test swiecil na zielono. Wlasciwosc byla gwarantowana atrapa. Teraz kazdy
    // kanal ma WLASNY wzor, wiec pominiecie wartosci kanalu oddaje cztery wiersze zamiast
    // jednego.
    KANALY_MAGAZYNU.forEach((kanal, i) => {
      const wzorId = utworzWzor(db, { nazwa: `Tylko ${kanal}` });
      const p = zapiszProduktSklepowy(db, {
        kanal, produkt_id: String(100 + i), wariant_id: '', cena_gr: 1000, nazwa: `Tylko ${kanal}`,
        odczytane_at: '2026-08-11T06:00:00.000Z',
      });
      powiazProdukt(db, p, wzorId);
    });
    utworzWzor(db, { nazwa: 'Nigdzie' });

    for (const kanal of KANALY_MAGAZYNU) {
      expect(wzoryZKanalami(db, { filtry: { kanal } }).map((w) => w.nazwa), kanal)
        .toEqual([`Tylko ${kanal}`]);
    }
  });

  it('KAZDY stan paczkomatu ze slownika zawęża liste do swojego wzoru', () => {
    utworzWzor(db, { nazwa: 'Atak', paczkomat: 'tak' });
    utworzWzor(db, { nazwa: 'Bnie', paczkomat: 'nie' });
    utworzWzor(db, { nazwa: 'Cbrak' });

    const oczekiwane = { tak: ['Atak'], nie: ['Bnie'], nieoznaczone: ['Cbrak'] };
    for (const stan of PACZKOMAT_DO_FILTRA) {
      expect(wzoryZKanalami(db, { filtry: { paczkomat: stan } }).map((w) => w.nazwa), stan)
        .toEqual(oczekiwane[stan]);
    }
    // ⚠️ Plan Zadania 10 proponowal `paczkomat ∈ tak|nie|brak`. Baza zna `nieoznaczone`,
    // a `brak` leci u niej w `1 = 0` — pusty ekran zamiast trzeciego stanu.
    expect(PACZKOMAT_DO_FILTRA).not.toContain('brak');
    expect(wzoryZKanalami(db, { filtry: { paczkomat: 'brak' } })).toEqual([]);
  });

  it('wartosc przepuszczona przez parser jest wartoscia, ktora baza rozumie', () => {
    katalog();
    // Petla po WSZYSTKICH pozycjach kazdego slownika naraz: parser ma je przepuscic,
    // a zapytanie ma je zrozumiec. Dopisanie pozycji do jednej strony bez drugiej pada tu.
    for (const [pole, wartosci] of [
      ['kanal', KANALY_MAGAZYNU], ['brak', BRAKI_MAGAZYNU], ['paczkomat', PACZKOMAT_DO_FILTRA],
    ]) {
      for (const w of wartosci) {
        expect(filtryZZapytania({ [pole]: w }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka'])[pole], `${pole}=${w}`).toBe(w);
      }
    }
  });
});

describe('saJakiesFiltry', () => {
  it('milczy przy pustym komplecie', () => {
    expect(saJakiesFiltry(filtryZZapytania({}, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']))).toBe(false);
    expect(saJakiesFiltry({})).toBe(false);
    expect(saJakiesFiltry(null)).toBe(false);
  });

  it('alarmuje na KAZDYM pojedynczym filtrze z osobna', () => {
    // Po jednym na pole: pominiete pole w sumie logicznej znaczy „ekran twierdzi, ze nic
    // nie zawezil", czyli pusty wynik filtrowania opisuje sie jako pusty magazyn.
    for (const q of [
      { fraza: 'pieszy' }, { kanal: 'pro' }, { kategoria: 'Boho' }, { brak: 'sku' },
      { paczkomat: 'tak' }, { cenaOd: '10' }, { cenaDo: '10' },
    ]) {
      expect(saJakiesFiltry(filtryZZapytania(q, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka'])), JSON.stringify(q)).toBe(true);
    }
  });

  it('cena zerowa TEZ jest filtrem — zero to wartosc, nie brak', () => {
    expect(saJakiesFiltry(filtryZZapytania({ cenaOd: '0' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']))).toBe(true);
  });
});

describe('parametryUkryte — formularze niosa nawzajem swoje wartosci', () => {
  // ⚠️ SEDNO. Prosba wlasciciela przy liscie zamowien brzmiala: „chce poszukac klienta
  // i wyswietlic jego zamowienia z okreslonego czasu". Tu jest tak samo: fraza i filtry
  // musza sie LACZYC. Formularz GET wysyla TYLKO wlasne pola, wiec kazdy z dwoch
  // formularzy musi niesc wartosci drugiego ukrytymi polami.
  it('formularz filtrow niesie dalej fraze', () => {
    expect(parametryUkryte({ fraza: 'pieszy', kanal: 'pro' }))
      .toContainEqual({ name: 'fraza', value: 'pieszy' });
  });

  it('formularz wyszukiwarki niesie dalej filtry', () => {
    const u = parametryUkryte({ fraza: null, kanal: 'pro', brak: 'sku' });
    expect(u).toContainEqual({ name: 'kanal', value: 'pro' });
    expect(u).toContainEqual({ name: 'brak', value: 'sku' });
  });

  it('pustych wartosci nie przenosi — inaczej adres puchnie o puste parametry', () => {
    expect(parametryUkryte({ fraza: null, kanal: null })).toEqual([]);
    expect(parametryUkryte({})).toEqual([]);
  });

  it('⚠️ cena wraca ZLOTOWKAMI, a nie groszami — inaczej kazde kliknięcie mnozy ja przez sto', () => {
    // Filtry trzymamy w groszach (tego chce baza), a pole formularza mowi zlotowkami.
    // Przepisanie surowej wartosci do ukrytego pola zamienia „od 10 zl" w „od 1000 zl"
    // przy pierwszym klknieciu w naglowek sortujacy, a w „od 100 000 zl" przy drugim.
    const u = parametryUkryte(filtryZZapytania({ cenaOd: '10', cenaDo: '74,90' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']));
    expect(u).toContainEqual({ name: 'cenaOd', value: '10.00' });
    expect(u).toContainEqual({ name: 'cenaDo', value: '74.90' });
  });

  it('obrot przez ukryte pole nie rusza zadnej wartosci (dwa razy tam i z powrotem)', () => {
    const pierwsze = filtryZZapytania({
      fraza: 'pieszy', kanal: 'pro', kategoria: 'Boho', brak: 'sku',
      paczkomat: 'nieoznaczone', cenaOd: '10', cenaDo: '74,90',
    }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    const jakZapytanie = (pary) => Object.fromEntries(pary.map((p) => [p.name, p.value]));
    const drugie = filtryZZapytania(jakZapytanie(parametryUkryte(pierwsze)), ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    const trzecie = filtryZZapytania(jakZapytanie(parametryUkryte(drugie)), ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);

    expect(drugie).toEqual(pierwsze);
    expect(trzecie).toEqual(pierwsze);
  });

  it('formularz nie wysyla wlasnego pola DWA RAZY', () => {
    // ⚠️ Plan mowil „oba formularze renderuja parametryUkryte(filtry)" — doslownie wzięte
    // znaczyloby, ze formularz filtrow wysyla `kanal` ukrytym polem I polem wyboru naraz.
    // Fastify oddaje wtedy TABLICE, parser slusznie odrzuca ja do `null` i filtr znika
    // dokladnie w tym formularzu, ktory sluzy do jego ustawiania.
    const filtry = filtryZZapytania({ fraza: 'pieszy', kanal: 'pro', cenaOd: '10' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    const u = parametryUkryte(filtry, { pomin: ['kanal', 'kategoria', 'brak', 'paczkomat', 'cenaOd', 'cenaDo'] });

    expect(u).toEqual([{ name: 'fraza', value: 'pieszy' }]);
    expect(parametryUkryte(filtry, { pomin: ['fraza'] }).map((p) => p.name)).not.toContain('fraza');
  });
});

describe('wartosciPol — to, co stoi w polach formularza', () => {
  it('cena w polu jest ZLOTOWKA, tak jak ja wpisano', () => {
    const w = wartosciPol(filtryZZapytania({ cenaOd: '10', cenaDo: '74,90' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']));
    // `value="1000"` przy „od 10 zl" utrwaliloby setke jako nowa wartosc filtru przy
    // pierwszym klknieciu „Filtruj" — po cichu, bo obie postacie sa poprawnymi liczbami.
    expect(w.cenaOd).toBe('10.00');
    expect(w.cenaDo).toBe('74.90');
  });

  it('brak wartosci to PUSTY NAPIS, a nie „null" do skasowania recznie', () => {
    const w = wartosciPol(filtryZZapytania({}, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']));
    for (const klucz of ['fraza', 'kanal', 'kategoria', 'brak', 'paczkomat', 'cenaOd', 'cenaDo']) {
      expect(w[klucz], klucz).toBe('');
    }
  });

  it('przepisuje pozostale pola bez zmiany', () => {
    const w = wartosciPol(filtryZZapytania({
      fraza: 'pieszy', kanal: 'pro', kategoria: 'Boho', brak: 'sku', paczkomat: 'nieoznaczone',
    }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']));
    expect(w).toMatchObject({
      fraza: 'pieszy', kanal: 'pro', kategoria: 'Boho', brak: 'sku', paczkomat: 'nieoznaczone',
    });
  });
});

describe('adresMagazynu — filtry przezywaja klikniecie w naglowek sortujacy', () => {
  it('zachowuje fraze i KAZDY filtr przy zmianie sortowania', () => {
    const filtry = filtryZZapytania({
      fraza: 'pieszy', kanal: 'pro', kategoria: 'Boho', brak: 'sku',
      paczkomat: 'nieoznaczone', cenaOd: '10', cenaDo: '99',
    }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    const adres = adresMagazynu(filtry, { sort: 'sku', kier: 'desc' });

    expect(adres.startsWith('/magazyn?')).toBe(true);
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));
    expect(Object.fromEntries(q)).toEqual({
      fraza: 'pieszy',
      kanal: 'pro',
      kategoria: 'Boho',
      brak: 'sku',
      paczkomat: 'nieoznaczone',
      cenaOd: '10.00',
      cenaDo: '99.00',
      sort: 'sku',
      kier: 'desc',
    });
  });

  it('adres bez filtrow niesie samo sortowanie — „Wyczysc" nie gubi kolejnosci', () => {
    expect(adresMagazynu({}, { sort: 'wysokosc', kier: 'desc' }))
      .toBe('/magazyn?sort=wysokosc&kier=desc');
  });

  it('koduje znaki, ktore inaczej rozbilyby adres na dwa parametry', () => {
    const adres = adresMagazynu(filtryZZapytania({ fraza: 'a&kanal=szkicownia' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']), { sort: 'nazwa', kier: 'asc' });
    expect(adres).not.toContain('a&kanal=szkicownia');
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));
    expect(q.get('fraza')).toBe('a&kanal=szkicownia');
    expect(q.get('kanal')).toBe(null);
  });

  it('kolejnosc parametrow jest STALA — ten sam widok ma zawsze ten sam adres', () => {
    const a = adresMagazynu(filtryZZapytania({ kanal: 'pro', fraza: 'x' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']), { sort: 'nazwa', kier: 'asc' });
    const b = adresMagazynu(filtryZZapytania({ fraza: 'x', kanal: 'pro' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']), { sort: 'nazwa', kier: 'asc' });
    expect(a).toBe(b);
  });

  // ——— TRYB KOLUMN TABELI (przebudowa 2026-08-25, Zadanie 5) ———————————————————————
  //
  // ⚠️ TRYB JEDZIE ADRESEM, bo panel nie ma JavaScriptu — przelacznik kolumn to zwykly
  // odnosnik, wiec musi sie skladac TAM, GDZIE KAZDY inny odnosnik ekranu (niezmiennik
  // 4.13b). Gdyby powstawal osobno, przelaczenie trybu kasowaloby zawezenie i kolejnosc.
  it('tryb tabeli jedzie adresem WYLACZNIE wtedy, gdy nie jest domyslny', () => {
    expect(adresMagazynu({}, { widok: 'katalog' })).toBe('/magazyn?widok=katalog');
    // ⚠️ DOMYSLNY NIE ZASMIECA ADRESU: „/magazyn" i „/magazyn?widok=porzadki" bylyby dwoma
    // adresami JEDNEJ rzeczy (historia przegladarki, zakladki, porownanie w tescie).
    expect(adresMagazynu({}, { widok: 'porzadki' })).toBe('/magazyn');
    expect(adresMagazynu({}, {})).toBe('/magazyn');
    // Wartosc spoza pary tez nie ma prawa wejsc do adresu — biala lista jest w trasie,
    // ale ta funkcja nie ma prawa przepuscic niczego innego niz „katalog".
    expect(adresMagazynu({}, { widok: 'constructor' })).toBe('/magazyn');
  });

  it('tryb stoi PO kolejnosci, a PRZED zaznaczeniem — kolejnosc pol jest stala', () => {
    expect(adresMagazynu({}, {
      sort: 'braki', kier: 'desc', widok: 'katalog', zaznacz: true,
    })).toBe('/magazyn?sort=braki&kier=desc&widok=katalog&zaznacz=1');
  });

  it('tryb doklada sie do PELNEGO kompletu, a nie zastepuje go', () => {
    const filtry = filtryZZapytania({ fraza: 'pieszy', kanal: 'pro', brak: 'sku' }, ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    const adres = adresMagazynu(filtry, { sort: 'braki', kier: 'desc', widok: 'katalog' });
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));

    expect(Object.fromEntries(q)).toEqual({
      fraza: 'pieszy', kanal: 'pro', brak: 'sku', sort: 'braki', kier: 'desc', widok: 'katalog',
    });
  });
});
