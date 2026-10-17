import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from './pliki-historyczne.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';

// KARTA PRODUKTU — stanowisko pracy przy JEDNEJ karcie: dane, powiazane produkty i oferty,
// dopisanie oferty Allegro.
//
// ⚠️⚠️ SZESC RZECZY, KTORYCH TA SUITA PILNUJE, BO ROZSTRZYGNAL JE WLASCICIEL:
//   (1) KARTA JEST DOMYSLNIE DO ODCZYTU — formularz otwiera dopiero „Edytuj" (`?edytuj=dane`),
//       tak samo jak trzy panele karty zamowienia;
//   (2) wymiary wpisuje sie w CENTYMETRACH, a baza trzyma MILIMETRY jako INTEGER;
//   (3) paczkomat ma TRZY stany i jest WYLACZNIE reczny — zadnego wyliczania z wymiarow;
//   (4) odpiac wolno WYLACZNIE oferte Allegro; produkt sklepowy ZBUDOWAL te karte;
//   (5) podpowiedzi PROPONUJA, nic nie wiaza bez klikniecia;
//   (6) karta nie wysyla do sklepu ani do Allegro ANI JEDNEGO zadania modyfikujacego.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

const STAN_PUSTY = {
  trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null,
};
const atrapaMagazynu = () => ({ start: vi.fn(), stan: () => STAN_PUSTY });

let db;
let numerKolejny;
let magazyn;
function serwer(uslugaMagazynu = magazyn) {
  return buildOmsServer({ db, config, magazyn: uslugaMagazynu });
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  numerKolejny = 0;
  magazyn = atrapaMagazynu();
});

// Wiersz lustra. Oddaje id — czyli to, czym formularze nazywaja produkt.
function produkt(nazwa, nadpisania = {}) {
  numerKolejny += 1;
  return zapiszProduktSklepowy(db, {
    kanal: 'allegro_szkicownia', produkt_id: `p-${numerKolejny}`, wariant_id: '',
    nazwa, odczytane_at: '2026-08-12T06:00:00.000Z', ...nadpisania,
  });
}
const oferta = (nazwa, nadpisania = {}) => produkt(nazwa, nadpisania);
const produktSklepu = (nazwa, nadpisania = {}) => produkt(nazwa, { kanal: 'pro', ...nadpisania });
const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload, naglowki = auth) => app.inject({
  method: 'POST', url, headers: naglowki, payload,
});

const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const kartaProduktu = (id) => db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?')
  .get(id).karta_id;
const ilePowiazan = () => db
  .prepare('SELECT COUNT(*) AS c FROM produkty_sklepowe WHERE karta_id IS NOT NULL').get().c;

/**
 * JEDNA SEKCJA KARTY — bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI KAZDEJ ASERCJI NA TEJ KARCIE. Wspolny
 * uklad (`layout-oms.ejs`) jedzie w KAZDEJ stronie i niesie wlasne pola formularzy
 * (przelacznik motywu, szukajka paska), a karta pokazuje TE SAMA nazwe karty w naglowku,
 * w polu formularza i przy kandydatach. Asercja „na stronie jest X" bywa wiec spelniona
 * przez cokolwiek innego niz to, o czym mowi. Rzuca, gdy sekcji nie ma — inaczej kazde
 * `not.toContain` przechodziloby na pustym napisie.
 */
function sekcja(body, id) {
  const wzorzec = new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`);
  const trafienie = wzorzec.exec(body);
  if (!trafienie) throw new Error(`Na karcie produktu nie ma sekcji „${id}"`);
  return trafienie[0];
}

/** Wiersz JEDNEGO powiazanego produktu — sam wiersz, bez reszty sekcji. */
function wierszProduktu(body, nazwa) {
  const znacznik = `<div class="nazwa-produktu">${nazwa}</div>`;
  const w = sekcja(body, 'produkty-karty').split('<tr').find((t) => t.includes(znacznik));
  if (!w) throw new Error(`Na karcie nie ma powiazanego produktu „${nazwa}"`);
  return w;
}

/** Wiersz JEDNEGO kandydata do dopisania — sam wiersz, bez reszty sekcji. */
function wierszKandydata(body, nazwa) {
  const znacznik = `<div class="nazwa-kandydata">${nazwa}</div>`;
  const w = sekcja(body, 'dopisz-oferte').split('<tr').find((t) => t.includes(znacznik));
  if (!w) throw new Error(`Na karcie nie ma kandydata „${nazwa}"`);
  return w;
}

const nazwyProduktow = (body) => [...sekcja(body, 'produkty-karty')
  .matchAll(/<div class="nazwa-produktu">([^<]*)<\/div>/g)].map((m) => m[1]);
const nazwyKandydatow = (body) => [...sekcja(body, 'dopisz-oferte')
  .matchAll(/<div class="nazwa-kandydata">([^<]*)<\/div>/g)].map((m) => m[1]);

/**
 * AKAPIT ODNOSNIKA „Wróć do magazynu" — sam akapit, bez reszty strony. RZUCA, gdy go nie ma.
 *
 * ⚠️⚠️ WARUNEK NOSNOSCI asercji strażnika `wroc` (Zadanie 6): zla wartosc ma NIE WYSTAPIC
 * W TEJ KOTWICE, nie „gdziekolwiek na stronie" — `not.toContain` na calym `body` bywa
 * spelnione z powodow, ktore nie maja nic wspolnego z bariera (patrz test nizej).
 */
function akapitWroc(body) {
  const m = /<p class="wroc">[\s\S]*?<\/p>/.exec(body);
  if (!m) throw new Error('Na karcie nie ma odnośnika „Wróć do magazynu"');
  return m[0];
}

// ————————————————————————————————————————————————————————————————————————————————
describe('GET /magazyn/:id — karta jest DOMYSLNIE DO ODCZYTU', () => {
  it('pokazuje dane karty jako TEKST, bez ani jednego pola formularza', async () => {
    const id = kartaO('Kandelabr srebrny', {
      sku: 'LMP-PLA-118', szerokosc_mm: 700, wysokosc_mm: 1000, opis: 'Opis kandelabru',
    });

    const r = await get(serwer(), `/magazyn/${id}`);
    expect(r.statusCode).toBe(200);

    const dane = sekcja(r.body, 'dane-karty');
    expect(dane).toContain('LMP-PLA-118');
    expect(dane).toContain('70 × 100 cm');
    expect(dane).toContain('Opis kandelabru');
    // ⚠️ TO JEST CALA TRESC ROZSTRZYGNIECIA (2): ani jednego `<input>`, ani jednego
    // `<textarea>` z danymi karty, dopoki nikt nie kliknal „Edytuj".
    expect(dane).not.toContain('<input');
    expect(dane).not.toContain('<textarea');
    expect(dane).not.toContain('<select');
    // ...a droga do edycji ma byc widoczna, inaczej „do odczytu" znaczy „nie do zmiany".
    expect(dane).toContain(`href="/magazyn/${id}?edytuj=dane"`);
  });

  // ⚠️ NIEZMIENNIK 4.13b W WERSJI KARTY: odnosnik „Edytuj" sklada sie z PELNEGO kompletu
  // stanu ekranu, a nie od zera. Zbudowany jako gole „?edytuj=dane" kasowalby zawezenie,
  // po ktorym ktos wlasnie szukal oferty do dopisania — czyli klikniecie „Edytuj" wracaloby
  // do pelnej listy 447 ofert.
  it('odnosnik „Edytuj" NIESIE DALEJ szukanie, zamiast je kasowac', async () => {
    const id = kartaO('Kandelabr srebrny');
    const dane = sekcja(
      (await get(serwer(), `/magazyn/${id}?fraza=kandelabr&kanal=allegro_szkicownia`)).body, 'dane-karty',
    );
    expect(dane).toContain('fraza=kandelabr');
    expect(dane).toContain('kanal=allegro_szkicownia');
  });

  it('„?edytuj=dane" otwiera formularz i ZNACZY panel, ze zmiany czekaja niezapisane', async () => {
    const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 700, wysokosc_mm: 1000 });

    const dane = sekcja((await get(serwer(), `/magazyn/${id}?edytuj=dane`)).body, 'dane-karty');
    expect(dane).toContain('panel--edycja');
    expect(dane).toMatch(/<input[^>]*name="nazwa"/);
    expect(dane).toMatch(/<input[^>]*name="sku"/);
    // ⚠️ POLA SA W CENTYMETRACH — tak czlowiek mysli o produkcie. Baza trzyma milimetry.
    expect(dane).toMatch(/<input[^>]*name="szerokosc_cm"[^>]*value="70"/);
    expect(dane).toMatch(/<input[^>]*name="wysokosc_cm"[^>]*value="100"/);
    // Druga polowa pary: „Edytuj" ma ZNIKNAC, gdy panel juz jest w edycji.
    expect(dane).not.toContain('href="?edytuj=dane"');
  });

  it('nierozpoznana wartosc „?edytuj" zostawia karte DO ODCZYTU, a nie wywala ekranu', async () => {
    const id = kartaO('Kandelabr srebrny');
    const app = serwer();

    // `constructor` i spolka: parametr z adresu HTTP nie ma prawa siegnac prototypu.
    // Powtorzony klucz wraca z Fastify jako TABLICA — `typeof === 'string'` odrzuca ja tak
    // samo, jak przy `?edytuj` na karcie zamowienia.
    for (const zly of ['constructor', 'toString', 'nie-ma-takiej', 'dane&edytuj=dane']) {
      const r = await get(app, `/magazyn/${id}?edytuj=${zly}`);
      expect(r.statusCode, zly).toBe(200);
      expect(sekcja(r.body, 'dane-karty'), zly).not.toContain('<input');
    }
  });

  it('karta bez wymiarow, SKU i opisu mowi o braku, zamiast pokazywac pusto', async () => {
    const id = kartaO('Kandelabr srebrny');
    const dane = sekcja((await get(serwer(), `/magazyn/${id}`)).body, 'dane-karty');
    expect(dane).toContain('bez SKU');
    // Trzy stany paczkomatu: „nieoznaczone" to robota do wykonania, nie decyzja „nie".
    expect(dane).toContain('nieoznaczone');
  });
});

describe('GET /magazyn/:id — karty moze nie byc', () => {
  it('numer, ktorego nie ma, oddaje CZYTELNA odmowe, a nie pieciusetke', async () => {
    const r = await get(serwer(), '/magazyn/9999');
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain('Nie ma karty o numerze 9999');
    // Odmowa ma prowadzic z powrotem, a nie zostawiac w slepym zaulku.
    expect(r.body).toContain('/magazyn');
  });

  it('numer, ktory nie jest liczba, tez oddaje odmowe zamiast pieciusetki', async () => {
    // ⚠️ KARTA O ID 1000 ISTNIEJE — inaczej `/magazyn/1e3` odpowiadalby 404 dlatego, ze
    // takiego wiersza nie ma, a nie dlatego, ze adres jest zly. Ta sama karta pod dwoma
    // adresami znaczy, ze odnosnik z listy i adres w zakladce to nie to samo miejsce.
    db.prepare('INSERT INTO karty_produktow (id, nazwa, utworzony_at, zmieniony_at) VALUES (1000, ?, ?, ?)')
      .run('Karta tysięczny', '2026-08-12T06:00:00.000Z', '2026-08-12T06:00:00.000Z');
    const app = serwer();

    expect((await get(app, '/magazyn/1000')).statusCode).toBe(200);
    for (const zly of ['abc', '1e3', '1000.0', ' 1000', '+1000', '9999999999999999999999']) {
      const r = await get(app, `/magazyn/${zly}`);
      expect(r.statusCode, zly).toBe(404);
    }
  });

  it('panel bez sklepow oddaje strone „pusta celowo", a nie 404', async () => {
    const app = buildOmsServer({ db, config });
    const r = await get(app, '/magazyn/1');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('SKLEP_*/ALLEGRO_*');
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('POST /magazyn/:id — wymiary wpisywane w CENTYMETRACH', () => {
  it('zapis przyjmuje centymetry i zapisuje MILIMETRY jako liczbe', async () => {
    const id = kartaO('Kandelabr srebrny');

    const r = await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(303);
    const w = wiersz(id);
    expect(w.szerokosc_mm).toBe(700);
    expect(w.wysokosc_mm).toBe(1000);
    // ⚠️ LICZBA, NIE NAPIS. Napis w kolumnie ustawia „80x150" przed „80x100" w sortowaniu
    // i wywraca filtr „większe niż" — a te wymiary ida do sklepu i na paczke.
    expect(typeof w.szerokosc_mm).toBe('number');
  });

  it('przecinek dziesietny jest przyjmowany', async () => {
    const id = kartaO('Kandelabr srebrny');
    await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', szerokosc_cm: '10,5', wysokosc_cm: '20',
    });
    expect(wiersz(id).szerokosc_mm).toBe(105);
  });

  it('puste pole KASUJE wymiar, a nie ustawia zera', async () => {
    const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 700, wysokosc_mm: 1000 });

    await post(serwer(), `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', szerokosc_cm: '', wysokosc_cm: '' });

    const w = wiersz(id);
    // ⚠️ ZERO TO NIE JEST BRAK. Karta „0 × 0 cm" wypada z filtru „bez wymiarów", czyli
    // z jedynej listy, na ktorej ktos by go uzupelnil.
    expect(w.szerokosc_mm).toBe(null);
    expect(w.wysokosc_mm).toBe(null);
  });

  // ————————————————————————————————————————————————————————————————————————————
  // ⚠️⚠️ WYMIAR POLOWICZNY NIE MA PRAWA POWSTAC — I TO NIE JEST NOWA REGULA, tylko
  // domkniecie jedynej szczeliny w regule, ktora obowiazuje juz WSZEDZIE INDZIEJ:
  // `opisWymiarow` oddaje dla polowicznego `null`, filtr „bez wymiarów" go LAPIE
  // (`szerokosc_mm IS NULL OR wysokosc_mm IS NULL`), a ekran pominietych liczy tak samo.
  // Karta byla jedynym miejscem w calym module, ktore potrafilo taki stan ZAPISAC.
  //
  // ⚠️ CZEMU TO PILNE: karta z sama szerokoscia wpada do filtru „bez wymiarów", czyli
  // dokladnie w zawezenie, po ktorym idzie edycja hurtem. Hurt ustawilby mu 70×100,
  // KASUJAC jedyna zmierzona wartosc — przy 645 wierszach naraz i bez cofniecia.
  // Zmierzone na wdrozonej karcie: `szerokosc=45` + wysokosc pusta = 303 i `{450, null}`.
  describe('polowiczny wymiar — karta ODMAWIA, zamiast go zapisac', () => {
    it('OBA wymiary wypelnione — zapis przechodzi (straznik MILCZY)', async () => {
      const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 450, wysokosc_mm: 650 });

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '70', wysokosc_cm: '100',
      });

      expect(r.statusCode).toBe(303);
      expect(wiersz(id).szerokosc_mm).toBe(700);
      expect(wiersz(id).wysokosc_mm).toBe(1000);
    });

    // ⚠️ SPRAWDZONE NA KARCIE, KTORA OBA WYMIARY MA. Karta bez wymiarow przeszlaby ten test
    // takze wtedy, gdyby odmowa zapisywala polowe — bo na `null` nie widac roznicy.
    it('sama SZEROKOSC odmawia, a w bazie zostaje STARA para nietknieta', async () => {
      const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 450, wysokosc_mm: 650 });

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '70', wysokosc_cm: '',
      });

      expect(r.statusCode).toBe(400);
      const w = wiersz(id);
      // Ani nowa polowa, ani `null` — dokladnie to, co bylo.
      expect(w.szerokosc_mm).toBe(450);
      expect(w.wysokosc_mm).toBe(650);
    });

    it('sama WYSOKOSC odmawia, a w bazie zostaje STARA para nietknieta', async () => {
      const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 450, wysokosc_mm: 650 });

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '', wysokosc_cm: '100',
      });

      expect(r.statusCode).toBe(400);
      const w = wiersz(id);
      expect(w.szerokosc_mm).toBe(450);
      expect(w.wysokosc_mm).toBe(650);
    });

    // To jest DOKLADNIE przypadek zmierzony przez recenzenta na wdrozonej karcie:
    // karta bez wymiarow, wpisana sama szerokosc. Wczesniej dawal 303 i {450, null}.
    it('karta BEZ wymiarow nie da sie doprowadzic do stanu polowicznego', async () => {
      const id = kartaO('Kandelabr srebrny');

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '45', wysokosc_cm: '',
      });

      expect(r.statusCode).toBe(400);
      const w = wiersz(id);
      expect(w.szerokosc_mm).toBe(null);
      expect(w.wysokosc_mm).toBe(null);
    });

    it('odmowa mowi WPROST, co zrobic: oba albo zadnego', async () => {
      const id = kartaO('Kandelabr srebrny');
      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '45', wysokosc_cm: '',
      });
      expect(r.body).toMatch(/oba|obie/i);
    });

    // ⚠️ ODMOWA JEST CALOSCIOWA takze tutaj: pola, ktore z tym wymiarem nie maja nic
    // wspolnego, tez nie wchodza — inaczej polowa zapisu siedzi w bazie, a ekran mowi
    // „nie zapisalem".
    it('odmowa wstrzymuje TAKZE pozostale pola formularza', async () => {
      const id = kartaO('Kandelabr srebrny', { kategoria_glowna: 'Aplikacje', opis: 'stary' });

      await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Nowa nazwa', kategoria_glowna: 'Lampy wiszące', opis: 'nowy',
        szerokosc_cm: '45', wysokosc_cm: '',
      });

      const w = wiersz(id);
      expect(w.nazwa).toBe('Kandelabr srebrny');
      expect(w.kategoria_glowna).toBe('Aplikacje');
      expect(w.opis).toBe('stary');
    });

    it('po odmowie formularz wraca otwarty z tym, co czlowiek wpisal', async () => {
      const id = kartaO('Kandelabr srebrny');
      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '45', wysokosc_cm: '',
      });

      const dane = sekcja(r.body, 'dane-karty');
      expect(dane).toContain('panel--edycja');
      expect(dane).toMatch(/name="szerokosc_cm"[^>]*value="45"/);
    });

    // ⚠️ OBA PUSTE TO NADAL KASOWANIE OBU i tak ma zostac — to jest zachowanie karty,
    // a nie stan polowiczny. Para do trzech odmow wyzej.
    it('OBA puste dalej kasuja oba — straznik MILCZY', async () => {
      const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 450, wysokosc_mm: 650 });

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '', wysokosc_cm: '',
      });

      expect(r.statusCode).toBe(303);
      expect(wiersz(id).szerokosc_mm).toBe(null);
      expect(wiersz(id).wysokosc_mm).toBe(null);
    });

    // ⚠️ ROZSTRZYGA STAN PO ZAPISIE, a nie „ile pol przyslal formularz". Zadanie niosace
    // SAMA szerokosc na karcie, ktory wysokosc JUZ MA, daje pare kompletna i ma przejsc —
    // inaczej ta bariera blokowalaby poprawke jednego wymiaru.
    it('samo pole szerokosci na karcie z wysokoscia daje pare kompletna i przechodzi', async () => {
      const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 450, wysokosc_mm: 650 });

      const r = await post(serwer(), `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: '70',
      });

      expect(r.statusCode).toBe(303);
      expect(wiersz(id).szerokosc_mm).toBe(700);
      expect(wiersz(id).wysokosc_mm).toBe(650);
    });
  });

  // ⚠️⚠️ PARA DO POWYZSZEGO: napis, ktorego NIE ROZUMIEMY, nie ma prawa wygladac jak puste
  // pole. Cichy `null` skasowalby wymiar, ktory ktos wlasnie chcial poprawic — i zrobilby
  // to bez slowa, na karcie, z ktorej wymiar idzie do sklepu.
  it('wymiar, ktorego nie rozumiemy, ODMAWIA zapisu i NIE rusza tego, co bylo', async () => {
    const id = kartaO('Kandelabr srebrny', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    const app = serwer();

    for (const zly of ['siedemdziesiąt', '70 cm', '70x100', '-70', '0', 'abc']) {
      const r = await post(app, `/magazyn/${id}`, {
        nazwa: 'Kandelabr srebrny', szerokosc_cm: zly, wysokosc_cm: '100',
      });
      expect(r.statusCode, zly).toBe(400);
      expect(r.body, zly).toMatch(/w centymetrach/i);
      const w = wiersz(id);
      expect(w.szerokosc_mm, zly).toBe(700);
      // ⚠️ ODMOWA JEST CALOSCIOWA: wysokosc z tego samego formularza tez ma nie wejsc,
      // inaczej polowa zapisu siedzi w bazie, a ekran mowi „nie zapisalem".
      expect(w.wysokosc_mm, zly).toBe(1000);
    }
  });

  it('po odmowie formularz WRACA OTWARTY, z tym, co czlowiek wpisal', async () => {
    const id = kartaO('Kandelabr srebrny');
    const r = await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', szerokosc_cm: 'siedemdziesiąt', wysokosc_cm: '100',
    });

    const dane = sekcja(r.body, 'dane-karty');
    expect(dane).toContain('panel--edycja');
    // Bez tego czlowiek traci wszystko, co wpisal w pozostalych polach, i wpisuje od nowa.
    expect(dane).toMatch(/name="szerokosc_cm"[^>]*value="siedemdziesiąt"/);
    expect(dane).toMatch(/name="wysokosc_cm"[^>]*value="100"/);
  });
});

describe('POST /magazyn/:id — SKU, nazwa i paczkomat', () => {
  it('SKU zajete przez INNA karte odmawia i mowi, kto go uzywa', async () => {
    const id = kartaO('Kandelabr srebrny', { sku: 'LMP-PLA-100' });
    kartaO('Lampion srebrny', { sku: 'LMP-PLA-118' });

    const r = await post(serwer(), `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', sku: 'LMP-PLA-118' });

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/zajęte|używa/i);
    // Komunikat MOWI, ktora karta je trzyma — inaczej nie da sie tego rozstrzygnac.
    expect(r.body).toContain('Lampion srebrny');
    expect(wiersz(id).sku).toBe('LMP-PLA-100');
  });

  // ⚠️ DRUGA POLOWA PARY: straznik ma MILCZEC, gdy SKU nalezy do TEJ karty. Bez tego
  // zapis czegokolwiek innego na karcie (opis, kategoria) odbijalby sie o wlasne SKU.
  it('SKU nalezace do TEJ SAMEJ karty przechodzi bez slowa', async () => {
    const id = kartaO('Kandelabr srebrny', { sku: 'LMP-PLA-118' });

    const r = await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', sku: 'LMP-PLA-118', opis: 'Nowy opis',
    });

    expect(r.statusCode).toBe(303);
    expect(wiersz(id).opis).toBe('Nowy opis');
  });

  it('puste SKU kasuje numer katalogowy, a nie zapisuje pustego napisu', async () => {
    const id = kartaO('Kandelabr srebrny', { sku: 'LMP-PLA-118' });
    await post(serwer(), `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', sku: '  ' });
    // ⚠️ NULL, NIE ''. Kolumna jest UNIQUE, a w SQLite NULL-e sa wzajemnie rozne — dwa
    // karty z pustym NAPISEM odbilyby sie o baze, a jest ich na starcie okolo tysiaca.
    expect(wiersz(id).sku).toBe(null);
  });

  it('pusta nazwa odmawia — karta bez nazwy nie jest do niczego', async () => {
    const id = kartaO('Kandelabr srebrny');
    const r = await post(serwer(), `/magazyn/${id}`, { nazwa: '   ', sku: 'LMP-PLA-118' });

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nazw/i);
    expect(wiersz(id).nazwa).toBe('Kandelabr srebrny');
    // Odmowa jest CALOSCIOWA: SKU z tego samego formularza tez nie wchodzi.
    expect(wiersz(id).sku).toBe(null);
  });

  it('paczkomat ma trzy stany i ustawia sie WYLACZNIE recznie', async () => {
    const id = kartaO('Kandelabr srebrny');
    const app = serwer();

    await post(app, `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', paczkomat: 'tak' });
    expect(wiersz(id).paczkomat).toBe('tak');

    await post(app, `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', paczkomat: 'nie' });
    expect(wiersz(id).paczkomat).toBe('nie');

    // Trzeci stan — „jeszcze nieoznaczone". To CO INNEGO niz „nie".
    await post(app, `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', paczkomat: '' });
    expect(wiersz(id).paczkomat).toBe(null);

    // Czwarta wartosc zepsulaby filtr „bez oznaczenia paczkomatu" — wpada w brak.
    await post(app, `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', paczkomat: 'może' });
    expect(wiersz(id).paczkomat).toBe(null);
  });

  // ⚠️⚠️ REGULA PROGU 640 mm WYPADLA DECYZJA WLASCICIELA. Karta nie ma prawa jej wskrzesic
  // tylnymi drzwiami: zapis wymiarow nie dotyka oznaczenia paczkomatu ANI W JEDNA, ANI
  // W DRUGA strone.
  it('zapis wymiarow NIE wylicza paczkomatu', async () => {
    const maly = kartaO('Mały kandelabr', { paczkomat: null });
    const duzy = kartaO('Duży kandelabr', { paczkomat: 'tak' });
    const app = serwer();

    await post(app, `/magazyn/${maly}`, { nazwa: 'Mały kandelabr', szerokosc_cm: '10', wysokosc_cm: '15' });
    await post(app, `/magazyn/${duzy}`, { nazwa: 'Duży kandelabr', szerokosc_cm: '70', wysokosc_cm: '100' });

    expect(wiersz(maly).paczkomat).toBe(null);
    expect(wiersz(duzy).paczkomat).toBe('tak');
  });

  it('zapis stempluje date zmiany, a nie zostawia jej z chwili zalozenia', async () => {
    const id = utworzKarte(db, { nazwa: 'Kandelabr srebrny' }, { at: '2026-01-01T00:00:00.000Z' });
    await post(serwer(), `/magazyn/${id}`, { nazwa: 'Kandelabr srebrny', opis: 'Nowy' });
    expect(wiersz(id).zmieniony_at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('numer nieistniejacej karty odmawia zamiast zakladac cokolwiek', async () => {
    const r = await post(serwer(), '/magazyn/9999', { nazwa: 'Kandelabr srebrny' });
    expect(r.statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS c FROM karty_produktow').get().c).toBe(0);
  });

  it('bez naglowka Origin ochrona CSRF odmawia i NIC sie nie zapisuje', async () => {
    const id = kartaO('Kandelabr srebrny');
    const r = await post(serwer(), `/magazyn/${id}`, { nazwa: 'Podmieniona' },
      { authorization: auth.authorization });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(wiersz(id).nazwa).toBe('Kandelabr srebrny');
  });

  it('panel bez sklepow odmawia CZYTELNIE zamiast udawac, ze zapisal', async () => {
    const id = kartaO('Kandelabr srebrny');
    const app = buildOmsServer({ db, config });

    const r = await post(app, `/magazyn/${id}`, { nazwa: 'Podmieniona' });

    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('nie ma skąd czytać katalogu');
    // ⚠️ ODMOWA MA POPRZEDZAC ZAPIS, a nie po nim nastapic. Straznik postawiony ZA operacja
    // oddaje ten sam kod bledu i ten sam komunikat, a zmiana i tak siedzi juz w bazie —
    // czyli 503 klamie. Bez tej asercji przesuniecie straznika jest niewidoczne.
    expect(wiersz(id).nazwa).toBe('Kandelabr srebrny');
  });

  it('pole spoza formularza NIE trafia do bazy tylnymi drzwiami', async () => {
    const id = kartaO('Kandelabr srebrny');
    // Biala lista pol formularza karty jest wezsza niz `POLA_KARTY` w db/magazyn.js — kolumna,
    // ktora baza zna, ale formularz nie wysyla, nie wchodzi z zadania HTTP.
    const przed = wiersz(id).utworzony_at;
    const r = await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', utworzony_at: '1999-01-01T00:00:00.000Z', waga_g: '9999', constructor: 'x',
    });

    expect(r.statusCode).toBe(303);
    expect(wiersz(id).utworzony_at).toBe(przed);
    expect(wiersz(id).waga_g).toBe(null);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('GET /magazyn/:id — powiazane produkty i oferty', () => {
  it('pokazuje powiazany produkt z cena, odnosnikiem i kompletem kategorii', async () => {
    const id = kartaO('Kandelabr srebrny');
    const p = produktSklepu('Kandelabr srebrny – 70x100cm', {
      cena_gr: 7490, adres: 'https://pro.sklep-polcien.example.invalid/produkt/kandelabr',
      kategorie_json: JSON.stringify(['Lampy wiszące', 'Srebrne']),
    });
    powiazProdukt(db, p, id);

    const w = wierszProduktu((await get(serwer(), `/magazyn/${id}`)).body, 'Kandelabr srebrny – 70x100cm');
    expect(w).toContain('74.90');
    expect(w).toContain('href="https://pro.sklep-polcien.example.invalid/produkt/kandelabr"');
    // Nowa karta i `rel="noopener"` — odnosnik prowadzi poza panel.
    expect(w).toContain('target="_blank"');
    expect(w).toContain('rel="noopener noreferrer"');
    // Komplet kategorii, zeby wybor kategorii GLOWNEJ byl swiadomy.
    expect(w).toContain('Lampy wiszące');
    expect(w).toContain('Srebrne');
  });

  // ⚠️ ADRES PRZYCHODZI Z CUDZEGO API I LADUJE WPROST W ATRYBUCIE `href`. Ta sama bramka,
  // co przy adresach zdjec (`domain/miniatury.js`) i przy cenach na liscie magazynu.
  it('adres inny niz http(s) NIE staje sie odnosnikiem, a cena zostaje na ekranie', async () => {
    const id = kartaO('Kandelabr srebrny');
    const app = serwer();

    const zle = ['javascript:alert(1)', 'data:text/html,<script>x</script>', ' javascript:x'];
    for (const [i, zly] of zle.entries()) {
      // Nazwa NIE niesie tu ladunku (EJS ja i tak eskapuje) — badamy adres, ktory laduje
      // w atrybucie `href`, a nie w tresci.
      const p = produktSklepu(`Kandelabr adres ${i}`, { cena_gr: 7490, adres: zly });
      powiazProdukt(db, p, id);
      const w = wierszProduktu((await get(app, `/magazyn/${id}`)).body, `Kandelabr adres ${i}`);
      expect(w, zly).not.toMatch(/href="\s*(javascript|data):/i);
      // Adres, ktoremu odmawiamy, gasi WYLACZNIE odnosnik — wiersz dalej mowi o cenie.
      expect(w, zly).toContain('74.90');
    }
  });

  it('galeria pokazuje MINIATURY, a odnosnik prowadzi do oryginalu', async () => {
    const id = kartaO('Kandelabr srebrny');
    const p = produktSklepu('Kandelabr srebrny', {
      zdjecia_json: JSON.stringify([
        'https://pro.sklep-polcien.example.invalid/wp-content/uploads/kandelabr.jpg',
        'https://pro.sklep-polcien.example.invalid/wp-content/uploads/kandelabr-2.jpg',
      ]),
    });
    powiazProdukt(db, p, id);

    const w = wierszProduktu((await get(serwer(), `/magazyn/${id}`)).body, 'Kandelabr srebrny');
    // ⚠️ WARIANT 150 px, NIE ORYGINAL. Zmierzone przy zamowieniach: 87 KB → 4 KB, a galeria
    // karty potrafi miec kilkanascie zdjec z trzech kanalow naraz.
    expect(w).toContain('src="https://pro.sklep-polcien.example.invalid/wp-content/uploads/kandelabr-150x150.jpg"');
    expect(w).toContain('src="https://pro.sklep-polcien.example.invalid/wp-content/uploads/kandelabr-2-150x150.jpg"');
    // Klikniecie otwiera ORYGINAL — miniatura sluzy tylko ekranowi.
    expect(w).toContain('href="https://pro.sklep-polcien.example.invalid/wp-content/uploads/kandelabr.jpg"');
  });

  it('popsute `zdjecia_json` z cudzego API nie kladzie calej karty', async () => {
    const id = kartaO('Kandelabr srebrny');
    const p = produktSklepu('Kandelabr srebrny', { zdjecia_json: '{to nie jest JSON' });
    powiazProdukt(db, p, id);

    const r = await get(serwer(), `/magazyn/${id}`);
    expect(r.statusCode).toBe(200);
    expect(nazwyProduktow(r.body)).toEqual(['Kandelabr srebrny']);
  });

  it('produkt ZNIKNIETY ze sklepu zostaje na karcie, ale mowi, ze zniknal', async () => {
    const id = kartaO('Kandelabr srebrny');
    const p = produktSklepu('Kandelabr srebrny', { cena_gr: 7490 });
    powiazProdukt(db, p, id);
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?')
      .run('2026-08-12T06:00:00.000Z', p);

    const w = wierszProduktu((await get(serwer(), `/magazyn/${id}`)).body, 'Kandelabr srebrny');
    expect(w).toMatch(/wycofan|zniknął/i);
  });

  it('karta bez ani jednego produktu MOWI o tym, zamiast pokazywac pusta tabele', async () => {
    const id = kartaO('Kandelabr srebrny');
    const r = await get(serwer(), `/magazyn/${id}`);
    expect(nazwyProduktow(r.body)).toEqual([]);
    expect(sekcja(r.body, 'produkty-karty')).toMatch(/nie ma jeszcze ani jednego/i);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('odpinanie — produkt sklepowy ZBUDOWAL karte i odpiac go NIE WOLNO', () => {
  it('oferta Allegro ma przycisk „Odepnij", a produkt sklepowy go NIE MA', async () => {
    const id = kartaO('Kandelabr srebrny');
    const sklepowy = produktSklepu('Kandelabr srebrny – 70x100cm');
    const allegro = oferta('KANDELABR ozdobny wysoki');
    powiazProdukt(db, sklepowy, id);
    powiazProdukt(db, allegro, id);

    const body = (await get(serwer(), `/magazyn/${id}`)).body;
    expect(wierszProduktu(body, 'KANDELABR ozdobny wysoki')).toContain('Odepnij');
    // ⚠️ ODPIECIE OSIEROCILOBY KARTE: bez ceny, bez zdjecia, bez kategorii i bez sladu,
    // co ja osierocilo. Przycisku ma tu nie byc W OGOLE, a nie „byc i odmawiac".
    const w = wierszProduktu(body, 'Kandelabr srebrny – 70x100cm');
    expect(w).not.toContain('Odepnij');
    expect(w).toMatch(/zbudował tę kartę/i);
  });

  it('odpina oferte Allegro i wraca ona na liste kandydatow', async () => {
    const id = kartaO('Kandelabr srebrny');
    const allegro = oferta('KANDELABR ozdobny wysoki');
    powiazProdukt(db, allegro, id);
    const app = serwer();

    const r = await post(app, `/magazyn/${id}/odepnij`, { produktSklepowyId: String(allegro) });

    expect(r.statusCode).toBe(303);
    expect(kartaProduktu(allegro)).toBe(null);
    expect(nazwyKandydatow((await get(app, `/magazyn/${id}`)).body))
      .toContain('KANDELABR ozdobny wysoki');
  });

  // ⚠️⚠️ DRUGA POLOWA PARY I NAJWAZNIEJSZA BARIERA TEJ KARTY. Zadanie skladane recznie
  // (albo przyciskiem, ktory ktos kiedys dopisze) nie ma prawa odpiac produktu SKLEPOWEGO.
  it('zadanie odpiecia produktu SKLEPOWEGO odmawia, a powiazanie zostaje', async () => {
    const id = kartaO('Kandelabr srebrny');
    const sklepowy = produktSklepu('Kandelabr srebrny – 70x100cm');
    powiazProdukt(db, sklepowy, id);

    const r = await post(serwer(), `/magazyn/${id}/odepnij`, { produktSklepowyId: String(sklepowy) });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(sklepowy)).toBe(id);
  });

  // ⚠️ KARTA ODPINA WYLACZNIE SWOJE. `odepnijOferte` zna kanal, ale nie zna karty, na
  // ktorej stoimy — bez warunku „nalezy do TEJ karty" zadanie z cudzym numerem odpinaloby
  // oferte od CUDZEJ karty, i na tej karcie nie bylo by tego widac wcale.
  it('nie odpina oferty przypietej do INNEJ karty', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const lampion = kartaO('Lampion srebrny');
    const cudza = oferta('LAMPION ozdobny');
    powiazProdukt(db, cudza, lampion);

    const r = await post(serwer(), `/magazyn/${kandelabr}/odepnij`, { produktSklepowyId: String(cudza) });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(cudza)).toBe(lampion);
  });

  it('bez naglowka Origin ochrona CSRF odmawia i powiazanie zostaje', async () => {
    const id = kartaO('Kandelabr srebrny');
    const allegro = oferta('KANDELABR ozdobny');
    powiazProdukt(db, allegro, id);

    const r = await post(serwer(), `/magazyn/${id}/odepnij`, { produktSklepowyId: String(allegro) },
      { authorization: auth.authorization });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(allegro)).toBe(id);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('dopisanie oferty — PODPOWIEDZI PROPONUJA, wiaze klikniecie', () => {
  it('podpowiedzi stoja na karcie, ale NIC nie wiaza', async () => {
    const id = kartaO('Klosz mleczny');
    const o = oferta('KLOSZ MLECZNY');
    const app = serwer();

    // Ocena pelna — gdyby gdziekolwiek stal automat, ta oferta bylaby pierwsza, ktora zlapie.
    const r = await get(app, `/magazyn/${id}`);
    await get(app, `/magazyn/${id}`);

    expect(sekcja(r.body, 'dopisz-oferte')).toContain('Podpowiedzi');
    expect(nazwyKandydatow(r.body)).toContain('KLOSZ MLECZNY');
    expect(kartaProduktu(o)).toBe(null);
    expect(ilePowiazan()).toBe(0);
  });

  // ⚠️⚠️ ROZSTRZYGNIECIE 1 KONTROLERA: REGULA DOPASOWANIA MA BYC JEDNA. Karta liczy
  // podpowiedzi TA SAMA funkcja, co ekran powiazan — tyle ze z drugiej strony (dla karty
  // szukamy ofert, a nie dla oferty kart). Ocena tej samej pary MUSI wyjsc identyczna;
  // gdyby karta miala wlasna kopie reguly, rozjechalaby sie przy pierwszej zmianie.
  //
  // Para dobrana tak, zeby ROZSTRZYGAL ROZMIAR: nazwa oferty niesie „70x100cm", karta ma te
  // wartosci w kolumnach. Bez symetrii wymiarow karta liczy 50%, a ekran powiazan 63%.
  it('ocena kandydata jest TA SAMA, co na ekranie powiazan', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    oferta('KANDELABR srebrny duży 70x100cm');
    const app = serwer();

    const zKarty = /<span class="kandydat-ocena">(\d+)%<\/span>/
      .exec(wierszKandydata((await get(app, `/magazyn/${id}`)).body, 'KANDELABR srebrny duży 70x100cm'));
    const zEkranu = /<span class="kandydat-ocena">(\d+)%<\/span>/
      .exec((await get(app, '/magazyn/powiazania')).body);

    expect(zKarty, 'karta nie pokazuje oceny kandydata').not.toBe(null);
    expect(zEkranu, 'ekran powiazan nie pokazuje oceny kandydata').not.toBe(null);
    expect(zKarty[1]).toBe(zEkranu[1]);
  });

  it('wiaze oferte po kliknieciu i znika ona z kandydatow', async () => {
    const id = kartaO('Kandelabr srebrny');
    const o = oferta('KANDELABR ozdobny wysoki');
    const app = serwer();

    const r = await post(app, `/magazyn/${id}/powiaz`, { produktSklepowyId: String(o) });

    expect(r.statusCode).toBe(303);
    expect(kartaProduktu(o)).toBe(id);
    const body = (await get(app, `/magazyn/${id}`)).body;
    expect(nazwyProduktow(body)).toContain('KANDELABR ozdobny wysoki');
    expect(nazwyKandydatow(body)).not.toContain('KANDELABR ozdobny wysoki');
  });

  // ⚠️⚠️ BEZ TEGO TEN SAM PRODUKT TRAFILBY DO DWOCH KART, a wymiary, waga
  // i SKU poszlyby do sklepu z niewlasciwej karty.
  it('oferta przypieta do INNEJ karty odmawia przypiecia i zostaje przy swoim', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const lampion = kartaO('Lampion srebrny');
    const o = oferta('KANDELABR ozdobny');
    powiazProdukt(db, o, kandelabr);

    const r = await post(serwer(), `/magazyn/${lampion}/powiaz`, { produktSklepowyId: String(o) });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(o)).toBe(kandelabr);
  });

  // ⚠️ PRODUKT SKLEPOWY PRZYPIETY Z KARTY BYLBY NIE DO ODPIECIA (bariera wyzej), czyli
  // pomylka jednego klikniecia zostawalaby na zawsze. Karta dopisuje WYLACZNIE oferty Allegro.
  it('produktu SKLEPOWEGO nie da sie przypiac z karty', async () => {
    const id = kartaO('Kandelabr srebrny');
    const sklepowy = produktSklepu('Kandelabr srebrny – 70x100cm');

    const r = await post(serwer(), `/magazyn/${id}/powiaz`, { produktSklepowyId: String(sklepowy) });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(sklepowy)).toBe(null);
    // ...i nie stoi wsrod kandydatow, wiec droga do tej pomylki nie zaczyna sie na ekranie.
    expect(nazwyKandydatow((await get(serwer(), `/magazyn/${id}`)).body))
      .not.toContain('Kandelabr srebrny – 70x100cm');
  });

  it('bez naglowka Origin ochrona CSRF odmawia i nic sie nie wiaze', async () => {
    const id = kartaO('Kandelabr srebrny');
    const o = oferta('KANDELABR ozdobny');

    const r = await post(serwer(), `/magazyn/${id}/powiaz`, { produktSklepowyId: String(o) },
      { authorization: auth.authorization });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaProduktu(o)).toBe(null);
  });
});

describe('dopisanie oferty — WYSZUKIWARKA, nie sama lista podpowiedzi', () => {
  function katalog() {
    const id = kartaO('Kandelabr srebrny');
    oferta('KANDELABR ozdobny wysoki', { kanal: 'allegro_szkicownia' });
    oferta('Żarówka LED trójkąt E27', { kanal: 'allegro_amarka' });
    oferta('Abażur lniany duży', { kanal: 'allegro_szkicownia' });
    return id;
  }

  // ⚠️⚠️ POMIAR OBALIL ZALOZENIE PLANU: tytuly na Allegro sa SPRZEDAZOWE, nie katalogowe,
  // wiec podpowiedz trafia w mniejszosc przypadkow. Bez wyszukiwarki 447 powiazan to 447
  // przewinien pelnej listy.
  it('fraza znajduje oferte, ktorej podpowiedz NIE podsuwa', async () => {
    const id = katalog();
    const app = serwer();

    // „Żarówka LED trójkąt E27" nie ma z „Kandelabr srebrny" ani jednego wspolnego slowa,
    // wiec wsrod podpowiedzi go nie ma — i to jest poprawne zachowanie miary.
    expect(nazwyKandydatow((await get(app, `/magazyn/${id}`)).body))
      .not.toContain('Żarówka LED trójkąt E27');

    expect(nazwyKandydatow((await get(app, `/magazyn/${id}?fraza=trójkąt`)).body))
      .toEqual(['Żarówka LED trójkąt E27']);
  });

  it('filtr konta Allegro zaweza wyniki szukania', async () => {
    const id = katalog();
    expect(nazwyKandydatow((await get(serwer(), `/magazyn/${id}?fraza=&kanal=allegro_amarka`)).body))
      .toEqual(['Żarówka LED trójkąt E27']);
  });

  it('nierozpoznana wartosc filtru NIE zaweza wynikow do pustych', async () => {
    // Druga polowa pary: straznik ma milczec, gdy wartosci z adresu nie rozumie. Pusty
    // ekran wyglada jak „nie ma czego dopisac", a ofert jest 447.
    const id = katalog();
    const app = serwer();
    for (const zly of ['constructor', 'pro', 'nie-ma-takiego']) {
      const r = await get(app, `/magazyn/${id}?fraza=ozdobny&kanal=${zly}`);
      expect(r.statusCode, zly).toBe(200);
      expect(nazwyKandydatow(r.body), zly).toEqual(['KANDELABR ozdobny wysoki']);
    }
  });

  it('formularz szukania niesie dalej otwarta sekcje edycji, a nie zamyka jej po cichu', async () => {
    const id = katalog();
    const szukajka = /<form class="szukajka"[\s\S]*?<\/form>/
      .exec((await get(serwer(), `/magazyn/${id}?fraza=kandelabr&edytuj=dane`)).body)[0];
    // Niezmiennik 4.13b w wersji karty: szukanie oferty nie ma kasowac formularza, w ktorym
    // czlowiek wlasnie cos wpisal.
    expect(szukajka).toContain('<input type="hidden" name="edytuj" value="dane">');
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('karta produktu — czego NIE robi', () => {
  // ⚠️⚠️ ZAPIS SKU I WYMIAROW DO SKLEPU TO ZADANIE 15 i ma wlasny, obowiazkowy podglad.
  // W tej zmianie nie ma prawa pojawic sie ANI JEDNO zadanie modyfikujace do sklepu.
  it('zapis na karcie nie rusza ani sklepu, ani Allegro', async () => {
    const id = kartaO('Kandelabr srebrny', { sku: 'LMP-PLA-118' });
    const p = produktSklepu('Kandelabr srebrny', { sku_sklepu: 'STARE' });
    powiazProdukt(db, p, id);

    await post(serwer(), `/magazyn/${id}`, {
      nazwa: 'Kandelabr srebrny', sku: 'LMP-PLA-200', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    // Usluga magazynu (jedyna droga do sklepow i Allegro w tym module) nie zostala tkniete.
    expect(magazyn.start).not.toHaveBeenCalled();
    // Lustro tez nie: SKU sklepowe jest tym, co stoi W SKLEPIE, i karta go nie przepisuje.
    expect(db.prepare('SELECT sku_sklepu FROM produkty_sklepowe WHERE id = ?').get(p).sku_sklepu)
      .toBe('STARE');
  });

  it('trasa magazynu nie zna ani klienta sklepu, ani klienta Allegro', async () => {
    // Ta asercja pilnuje DROGI, a nie skutku: dopoki trasa nie ma czym zapytac sklepu,
    // zaden przyszly dopisek nie zrobi tego przez przeoczenie.
    const zrodlo = readFileSync(
      new URL('../../src/oms/web/routes/magazyn.js', import.meta.url), 'utf8',
    );
    expect(zrodlo).not.toMatch(/from '\.\.\/\.\.\/(woo|allegro)\//);
  });
});

describe('karta produktu — wejscie i wyglad', () => {
  it('lista magazynu prowadzi na karte odnosnikiem z nazwy karty', async () => {
    const id = kartaO('Kandelabr srebrny');
    // Bez tego odnosnika karta istnieje wylacznie dla kogos, kto zna adres.
    //
    // ⚠️ Odnosnik od Zadania 6 niesie DALEJ adres listy jako „?wroc=…" (dokladna wartosc ma
    // wlasny test w opisie „powrót z karty..."), wiec goly `href="/magazyn/{id}">` juz nie
    // wystapi — pilnujemy tu WYLACZNIE, ze nazwa linkuje na WLASCIWA karte (id sie zgadza).
    const dopasowanie = new RegExp(`<a href="/magazyn/${id}\\?wroc=[^"]*">Kandelabr srebrny</a>`)
      .exec((await get(serwer(), '/magazyn')).body);
    expect(dopasowanie).not.toBeNull();
  });

  it('widok karty nie ma ANI JEDNEGO koloru wpisanego wprost', async () => {
    // Paleta ma wariant jasny i ciemny; wartosc wpisana w widoku zadziala w jasnym
    // i po cichu zniknie w ciemnym, bo nikt nie oglada obu naraz.
    const tresc = readFileSync(
      new URL('../../src/oms/web/views/magazyn-karta.ejs', import.meta.url), 'utf8',
    );
    expect(tresc).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(tresc).not.toMatch(/rgba?\(/i);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// POWROT Z KARTY Z ZACHOWANIEM FILTROW (`wroc`, Zadanie 6).
//
// PO CO TO JEST: karta produktu dzis zawsze wraca „na start" (goly /magazyn), wiec kliknięcie
// karty z zawezonej listy (np. „braki SKU"), obejrzenie karty i powrot GUBI zawezenie —
// czlowiek ląduje na pelnej liscie i musi ustawiac filtry od nowa. `wroc` niesie adres
// listy PRZEZ karte i z powrotem (niezmiennik 4.13b w nowej odslonie: tym razem miedzy
// DWOMA ekranami, nie miedzy dwoma formularzami jednego).
//
// ⚠️⚠️ BARIERA ADRESU JEST SEDNEM TEGO ZADANIA. `wroc` przychodzi z paska adresu — string
// od czlowieka (albo od kogos, kto podesle spreparowany odnosnik) — wiec karta bez bariery
// bylaby przekaznikiem na DOWOLNY adres (open redirect). `bezpiecznyWroc` przepuszcza
// WYLACZNIE wlasny ekran magazynu.
describe('powrót z karty produktu z zachowaniem filtrów (wroc)', () => {
  it('link „Wróć" używa zwalidowanego ?wroc', async () => {
    const id = kartaO('Kandelabr srebrny');
    const wroc = '/magazyn?brak=sku&sort=braki';

    const r = await get(serwer(), `/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`);

    // ⚠️ Asercja celuje w odnosnik „Wróć" (`class="wroc"`), nie w gole wystapienie napisu —
    // pełny, rozpoznawalny fragment adresu tu wystarcza za kotwice.
    expect(r.body).toContain('<p class="wroc"><a href="/magazyn?brak=sku&amp;sort=braki">');
  });

  it('wroc spoza /magazyn jest ignorowane (open redirect guard)', async () => {
    const id = kartaO('Kandelabr srebrny');
    const app = serwer();

    for (const zly of ['https://evil.example', '//evil.example', '/zamowienia', '/magazynfalszywy']) {
      const r = await get(app, `/magazyn/${id}?wroc=${encodeURIComponent(zly)}`);
      const akapit = akapitWroc(r.body);
      // ⚠️⚠️ ASERCJE CELUJA W SAM ODNOSNIK (`akapitWroc`) I W SUROWA ZLA WARTOSC — obie
      // poprawki po recenzji (Zadanie 6). Pierwotna wersja robila dwie rzeczy nienosne:
      // (1) `not.toContain` na CALYM `body` dla „/zamowienia" przechodzil tylko dlatego, ze
      // uklad strony AKURAT nigdzie indziej nie linkuje tego adresu — przypadek, nie bariera;
      // (2) `zly.replace('//', '')` na „https://evil.example" daje „https:evil.example" —
      // napis-widmo, ktorego nie ma NIGDZIE niezaleznie od tego, czy bariera dziala. Teraz:
      // fallback ma stac W TEJ KOTWICE, a SUROWA (niezmutowana) zla wartosc ma jej NIE BYC
      // — w tej samej kotwicy, nie na calej stronie.
      expect(akapit, zly).toContain('href="/magazyn"');
      expect(akapit, zly).not.toContain(zly);
    }
  });

  it('lista linkuje karty z wroc niosącym bieżące zawężenie', async () => {
    const id = kartaO('Kandelabr srebrny');

    const r = await get(serwer(), '/magazyn?brak=sku');

    // ⚠️ ZNANY DEFEKT PRZYKŁADU Z BRIEFU: zakłada goły adres („…brak=sku"), ale KAŻDY
    // własny adres listy niesie DALEJ takze sort/kier (niezmiennik 4.13b, `adresMagazynu`
    // dokleja je zawsze — maja wartosci domyslne, wiec sa prawdziwe nawet bez klikniecia
    // w naglowek). Prawdziwy `wroc` ma wiec TRZY pola, nie jedno — dekodujemy go i
    // porownujemy CALY zestaw (ten sam wzorzec `URLSearchParams`, co `pola()` w
    // magazyn-lista.test.js), zamiast zakladac goła wartosc.
    const dopasowanie = new RegExp(`href="/magazyn/${id}\\?wroc=([^"]+)"`).exec(r.body);
    expect(dopasowanie, r.body).not.toBeNull();
    const wroc = decodeURIComponent(dopasowanie[1]);
    expect(Object.fromEntries(new URLSearchParams(wroc.slice(wroc.indexOf('?') + 1))))
      .toEqual({ brak: 'sku', sort: 'nazwa', kier: 'asc' });
  });

  // ⚠️ DRUGA POLOWA NIEZMIENNIKA 4.13b (poprawka po recenzji): `wroc` ma niesc DALEJ TAKZE
  // `widok=katalog`, nie tylko `sort`/`kier`/filtry — inaczej powrot z karty otwartej z
  // trybu katalogowego cichcem przelaczalby ekran z powrotem na porzadki.
  it('lista W TRYBIE KATALOGOWYM linkuje karty z wroc niosącym takze widok=katalog', async () => {
    const id = kartaO('Kandelabr srebrny');

    const r = await get(serwer(), '/magazyn?brak=sku&widok=katalog');

    const dopasowanie = new RegExp(`href="/magazyn/${id}\\?wroc=([^"]+)"`).exec(r.body);
    expect(dopasowanie, r.body).not.toBeNull();
    const wroc = decodeURIComponent(dopasowanie[1]);
    expect(Object.fromEntries(new URLSearchParams(wroc.slice(wroc.indexOf('?') + 1))))
      .toEqual({
        brak: 'sku', sort: 'nazwa', kier: 'asc', widok: 'katalog',
      });
  });

  // ⚠️ PIERWSZA POLOWA NIEZMIENNIKA 4.13b (poprawka po recenzji): karta otwarta Z `wroc`
  // ma niesc go DALEJ takze przez link „Edytuj" — inaczej otwarcie formularza edycji
  // cichcem gubiloby adres powrotu, mimo ze karta go dostala.
  it('link „Edytuj" NIESIE DALEJ wroc, gdy karta byla otwarta z adresu powrotu', async () => {
    const id = kartaO('Kandelabr srebrny');
    const wroc = '/magazyn?brak=sku';

    const dane = sekcja(
      (await get(serwer(), `/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`)).body, 'dane-karty',
    );

    // ⚠️ `&amp;` — EJS `<%= %>` html-escapuje domyslnie, wiec surowy `&` w adresie renderuje
    // sie jako encja (ta sama pulapka, co w tescie linku „Wróć" wyzej).
    expect(dane).toContain(`href="/magazyn/${id}?edytuj=dane&amp;wroc=${encodeURIComponent(wroc)}"`);
  });

  // ⚠️⚠️ PUŁAPKA FORMULARZY GET: przegladarka przy submicie WYRZUCA query string z `action`
  // i skleja nowy WYLACZNIE z named pol formularza (ten sam mechanizm, dla ktorego istnieje
  // `ukryteWSzukajce` z fraza/kanal/edytuj). Gdyby `wroc` jechal WYLACZNIE w adresie akcji
  // szukajki, szukanie oferty cichaczem gubiloby powrot — stad MUSI byc TAKZE ukrytym polem.
  it('formularz szukania niesie dalej wroc ukrytym polem (inaczej submit GET je gubi)', async () => {
    const id = kartaO('Kandelabr srebrny');
    const wroc = '/magazyn?brak=sku';

    const dane = sekcja(
      (await get(serwer(), `/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`)).body, 'dopisz-oferte',
    );

    expect(dane).toContain(`<input type="hidden" name="wroc" value="${wroc}">`);
  });

  it('zapis edycji z karty wraca pod adres z ?wroc, nie pod goly adres karty', async () => {
    const id = kartaO('Kandelabr srebrny');
    const wroc = '/magazyn?brak=sku';

    const r = await post(
      serwer(),
      `/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`,
      { nazwa: 'Kandelabr srebrny', szerokosc_cm: '70', wysokosc_cm: '100' },
    );

    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`);
  });

  // ⚠️⚠️ PUŁAPKA SKLEJANIA ADRESU (POPRAWIONY OPIS SKUTKU — sprostowanie po recenzji):
  // formularz „Odepnij" doklejal do tej pory `/odepnij` PO gotowym adresie karty
  // (`<%= adresKarty %>/odepnij`). Gdy `adresKarty` niesie `?wroc=…`, naiwne doklejenie
  // wsadza `/odepnij` W SRODEK wartosci parametru `wroc` zamiast za nim — sciezka w adresie
  // ZOSTAJE GOLA „/magazyn/:id" (wszystko po „/odepnij" ląduje w query string), wiec POST
  // trafia w handler ZAPISU karty (`POST /magazyn/:id`), a NIE w 404. Body odpiecia
  // (`produktSklepowyId`) nie ma zadnego pola formularza edycji, wiec `zmianyZFormularza`
  // widzi PUSTY zestaw zmian i milczy: karta „udaje" sukces (303 z powrotem), a oferta
  // ZOSTAJE przypieta — to GORSZE niz 404, bo wyglada na powodzenie. Ten test idzie PRZEZ
  // prawdziwa trase, nie tylko czyta HTML.
  it('odpiecie oferty Z OTWARTA KARTA PRZEZ wroc trafia we WLASCIWA trase i wraca z wroc', async () => {
    const id = kartaO('Kandelabr srebrny');
    const o = oferta('KANDELABR ozdobny wysoki');
    powiazProdukt(db, o, id);
    const wroc = '/magazyn?brak=sku';

    const r = await post(
      serwer(),
      `/magazyn/${id}/odepnij?wroc=${encodeURIComponent(wroc)}`,
      { produktSklepowyId: String(o) },
    );

    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`);
  });

  // ⚠️⚠️ DOPISANE PO RECENZJI — TEST WYZEJ POSTuje pod adres ZBUDOWANY RECZNIE w tescie, wiec
  // cofniecie poprawki konkatenacji w `magazyn-karta.ejs` (powrot do `<%= adresKarty %>/odepnij`)
  // zostawialoby GO zielonym mimo zepsutego widoku. Ten test czyta to, co NAPRAWDE renderuje
  // sie w `action=` obu formularzy — tylko on lapie regresje w SKLEJENIU widoku z trasa.
  it('formularze „Odepnij" i „Przypnij" RENDERUJA action z ?wroc (nie sklejaja go na piechote)', async () => {
    const id = kartaO('Kandelabr srebrny');
    const przypiety = oferta('KANDELABR ozdobny wysoki');
    powiazProdukt(db, przypiety, id);
    // Dzieli slowo z nazwa karty („Kandelabr"/„KANDELABR") — realny kandydat do „Przypnij"
    // w podpowiedziach, nie tylko w wyszukiwarce.
    oferta('KANDELABR zapasowy duzy');
    const wroc = '/magazyn?brak=sku';

    const body = (await get(serwer(), `/magazyn/${id}?wroc=${encodeURIComponent(wroc)}`)).body;

    expect(sekcja(body, 'produkty-karty'))
      .toContain(`action="/magazyn/${id}/odepnij?wroc=${encodeURIComponent(wroc)}"`);
    expect(sekcja(body, 'dopisz-oferte'))
      .toContain(`action="/magazyn/${id}/powiaz?wroc=${encodeURIComponent(wroc)}"`);
  });
});
