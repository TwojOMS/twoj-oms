import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';

// Przycisk przekazuje zakres razem z nazwą akcji, żeby użytkownik widział,
// której części listy dotyczy podgląd. Licznik przy przycisku odpowiada liczbie kart w tabeli.
// Powtórzony parametr `zakres` wraca z Fastify jako tablica, którą parser zamienia na `null`.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

const STAN_PUSTY = {
  trwa: false,
  zaczety_at: null,
  skonczony_at: null,
  postep: null,
  kanaly: [],
  blad: null,
};
const atrapaMagazynu = () => ({ start: vi.fn(), stan: () => STAN_PUSTY });

let db;
let magazyn;
const serwer = (uslugaMagazynu = magazyn) => buildOmsServer({ db, config, magazyn: uslugaMagazynu });

beforeEach(() => {
  db = openOmsDb(':memory:');
  magazyn = atrapaMagazynu();
});

const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

function produktO(kartaId, { kanal = 'pro', sku = null } = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: `p${kartaId}-${kanal}`,
    wariant_id: '',
    nazwa: 'Produkt',
    sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  powiazProdukt(db, id, kartaId);
  return id;
}

const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload) =>
  app.inject({
    method: 'POST',
    url,
    headers: auth,
    payload,
  });
// Cialo zadania SUROWE — jedyna droga, zeby wyslac ten sam klucz DWA RAZY.
const postSurowy = (app, url, tresc) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: tresc,
  });

// ————————————————————————————————————————————————————————————————————————————————
// POMOCNIKI ASERCJI
// ————————————————————————————————————————————————————————————————————————————————

/**
 * JEDEN PANEL EKRANU — bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI KAZDEJ ASERCJI TUTAJ, i po tej poprawce
 * BARDZIEJ niz kiedykolwiek: na ekranie stoja teraz CZTERY podobne pary przyciskow, kazda
 * z napisem „dla zaznaczonych" i „dla wszystkich pasujacych". Asercja „na stronie jest
 * przycisk «dla wszystkich pasujacych»" jest wiec spelniona przez SASIEDNI panel i nie
 * mowi nic o tym, o czym mowi. Do tego wspolny uklad (`layout-oms.ejs`) jedzie w kazdej
 * stronie i niesie wlasne pola formularzy.
 *
 * RZUCA, gdy panelu nie ma — inaczej kazde `not.toContain` przechodziloby na pustym
 * napisie, czyli zielono i bez zadnej ochrony.
 *
 * ⚠️ `<section>` ALBO `<details>` (przebudowa 2026-08-25): cztery panele akcji zwinely sie
 * w cztery chipy `<details>` jednej przyklejonej belki. To JEDYNA rzecz, ktora ta suita
 * musiala przyjac do wiadomosci — `id` akcji, ich pola, `formaction` i pary przyciskow
 * zakresu zostaly CO DO ZNAKU te same, wiec kazda asercja nizej ma nadal to samo pokrycie.
 * Pomocnik bierze ten znacznik, ktory `id` niesie, i domyka go TYM SAMYM (`\1`).
 */
function panel(body, id) {
  const trafienie = new RegExp(`<(section|details)[^>]*id="${id}"[\\s\\S]*?</\\1>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie magazynu nie ma panelu „${id}"`);
  return trafienie[0];
}

/**
 * PRZYCISKI NIOSACE ZAKRES z podanego kawalka HTML-a: `{ wartosc, formaction, napis }`.
 *
 * ⚠️ Napis jest odarty ze znacznikow, bo liczba stoi w srodku przycisku (`<strong>`) —
 * a czlowiek czyta caly napis, nie znacznik.
 */
function przyciskiZakresu(html) {
  const znalezione = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const atrybuty = m[1];
    if (!/\bname="zakres"/.test(atrybuty)) continue;
    const wartosc = /\bvalue="([^"]*)"/.exec(atrybuty);
    const formaction = /\bformaction="([^"]*)"/.exec(atrybuty);
    znalezione.push({
      wartosc: wartosc ? wartosc[1] : null,
      formaction: formaction ? formaction[1] : null,
      napis: m[2]
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return znalezione;
}

/** JEDEN przycisk zakresu o danej wartosci. RZUCA, gdy go nie ma. */
function przyciskZakresu(html, wartosc) {
  const p = przyciskiZakresu(html).find((b) => b.wartosc === wartosc);
  if (!p) throw new Error(`W tym panelu nie ma przycisku o zakresie „${wartosc}"`);
  return p;
}

/**
 * Formularz akcji: jego `action` i przenoszone zawezenie — czyli DOKLADNIE to, co przegladarka
 * wyslalaby razem z klknietym przyciskiem. RZUCA, gdy formularza nie ma.
 */
function formularzAkcji(body) {
  const kawalek = body.split('<form ').find((f) => f.includes('name="zawezenie"'));
  if (!kawalek) throw new Error('Na ekranie magazynu nie ma formularza akcji (brak pola zawezenie)');
  const action = /^[^>]*\baction="([^"]*)"/.exec(kawalek);
  if (!action) throw new Error('Formularz akcji nie ma atrybutu action');
  const zawezenie = /name="zawezenie" value="([^"]*)"/.exec(kawalek);
  return { action: action[1], zawezenie: zawezenie ? zawezenie[1] : '' };
}

/**
 * KLIKNIECIE PRZYCISKU TAK, JAK ZROBILABY TO PRZEGLADARKA: czytamy ekran, bierzemy z niego
 * cel, nazwe i wartosc przycisku, i wysylamy TO, CO EKRAN OBIECUJE.
 *
 * ⚠️⚠️ I TO JEST CALY SENS TEJ FUNKCJI. Test, ktory sam wpisuje `zakres: 'pasujace'`,
 * sprawdza TRASE, a nie EKRAN — i przeszedlby tak samo wtedy, gdyby przycisk zniknal ze
 * strony albo niosl inna wartosc. Zgloszenie wlasciciela dotyczylo wlasnie EKRANU.
 */
async function klikniecie(app, adresListy, idPanelu, wartoscZakresu, dodatkowe = {}) {
  const strona = await get(app, adresListy);
  const { action, zawezenie } = formularzAkcji(strona.body);
  const przycisk = przyciskZakresu(panel(strona.body, idPanelu), wartoscZakresu);
  return post(app, przycisk.formaction ?? action, {
    zakres: przycisk.wartosc,
    zawezenie,
    ...dodatkowe,
  });
}

/** Hurt z zakresem „pasujace" wysłany wprost, z zawężeniem odczytanym z ekranu listy. */
async function pasujaceWprost(app, adresListy, dodatkowe = {}) {
  const strona = await get(app, adresListy);
  const { zawezenie } = formularzAkcji(strona.body);
  return post(app, '/magazyn/hurt', { zakres: 'pasujace', zawezenie, ...dodatkowe });
}

/** Nazwy kart z tabeli podgladu (hurt i SKU mają ten sam kształt wiersza). */
function nazwyWPodgladzie(body, idSekcji) {
  const s = new RegExp(`<section[^>]*id="${idSekcji}"[\\s\\S]*?</section>`).exec(body);
  if (!s) throw new Error(`W podgladzie nie ma sekcji „${idSekcji}"`);
  return [...s[0].matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);
}

/** Ile wierszy ma TABELA KART — liczone z jej wlasnej kolumny, nie z jakiejkolwiek cyfry. */
const ileWierszyTabeli = (body) => (body.match(/<td class="komorka-karta">/g) ?? []).length;

// Każdy testowany panel ma własną parę przycisków. Panel „Edytuj" (hurt-pasek) ma tylko
// przycisk dla zaznaczonych — sprawdza go osobny opis niżej.
const AKCJE = [
  { panel: 'sku-pasek', cel: '/magazyn/sku-podglad', slowo: 'numery' },
  { panel: 'zapis-pasek', cel: '/magazyn/podglad-zapisu', slowo: 'sklep' },
];

// ================================================================================
// (1) ZAKRES STOI PRZY AKCJI — KAZDEJ Z OSOBNA
// ================================================================================

describe('każda akcja niesie swój zakres w przyciskach, a nie w polu trzy sekcje wyżej', () => {
  it.each(AKCJE)('panel $panel ma DOKŁADNIE dwa przyciski zakresu', async ({ panel: id }) => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');

    const przyciski = przyciskiZakresu(panel(r.body, id));

    expect(przyciski.map((p) => p.wartosc)).toEqual(['zaznaczone', 'pasujace']);
  });

  // ⚠️ NAPIS MA MOWIC, CO SIE STANIE I NA CZYM. Sam „dla zaznaczonych" na przycisku bez
  // nazwy akcji jest przy podobnych parach nie do odroznienia od sasiada.
  it.each(AKCJE)('oba przyciski panelu $panel nazywają akcję i swój zakres', async ({ panel: id, slowo }) => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');
    const przyciski = przyciskiZakresu(panel(r.body, id));

    for (const p of przyciski) {
      expect(p.napis.toLowerCase()).toContain(slowo);
    }
    expect(przyciskZakresu(panel(r.body, id), 'zaznaczone').napis).toMatch(/zaznaczon/i);
    expect(przyciskZakresu(panel(r.body, id), 'pasujace').napis).toMatch(/pasując/i);
  });

  // ⚠️⚠️ TRASA BEZ PRZYCISKU JEST KODEM MARTWYM, a suita swieci wtedy na zielono. Kazda
  // para ma prowadzic na WLASNY PODGLAD — i nigdy wprost na zapis.
  it.each(AKCJE)('oba przyciski panelu $panel prowadzą na $cel', async ({ panel: id, cel }) => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');
    const { action } = formularzAkcji(r.body);
    const przyciski = przyciskiZakresu(panel(r.body, id));

    // ⚠️ BEZ TEJ LINIJKI ASERCJA JEST PUSTA: petla po zerowej liscie przechodzi na zielono
    // i test przeszedlby takze wtedy, gdyby panel nie mial ANI JEDNEGO przycisku.
    expect(przyciski).toHaveLength(2);
    for (const p of przyciski) {
      expect(p.formaction ?? action).toBe(cel);
    }
  });
});

describe('panel Edytuj: jeden przycisk — dla zaznaczonych', () => {
  // Edycja wielu pól naraz na całym zawężeniu była zbyt łatwa do kliknięcia przez pomyłkę;
  // panel działa tylko na kartach zaznaczonych ręcznie.
  it('hurt-pasek ma wyłącznie przycisk „zaznaczone", prowadzący na /magazyn/hurt', async () => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');
    const { action } = formularzAkcji(r.body);
    const przyciski = przyciskiZakresu(panel(r.body, 'hurt-pasek'));

    expect(przyciski.map((p) => p.wartosc)).toEqual(['zaznaczone']);
    expect(przyciski[0].napis.toLowerCase()).toContain('zmieni');
    expect(przyciski[0].napis).toMatch(/zaznaczon/i);
    expect(przyciski[0].formaction ?? action).toBe('/magazyn/hurt');
  });
});

// ================================================================================
// (2) LICZBA PRZY PRZYCISKU — Z TEGO SAMEGO ODCZYTU, CO TABELA
// ================================================================================

describe('liczba stoi PRZY przycisku i jest tą samą, co długość tabeli', () => {
  // ⚠️ Czlowiek ma wiedziec, ze dotyka 277 kart, a nie dwudziestu, ktore widzi — i musi to
  // byc TA SAMA liczba, co dlugosc listy nizej, bo obie biora sie z JEDNEGO odczytu.
  it.each(AKCJE)('przycisk „wszystkich pasujących" w panelu $panel podaje liczbę', async ({ panel: id }) => {
    for (let i = 0; i < 3; i += 1) kartaO(`Bez numeru ${i}`);
    kartaO('Z numerem', { sku: 'PLC-001' });

    const r = await get(serwer(), '/magazyn?brak=sku');

    expect(ileWierszyTabeli(r.body)).toBe(3);
    expect(przyciskZakresu(panel(r.body, id), 'pasujace').napis).toContain('(3)');
  });

  it.each(AKCJE)('liczba w panelu $panel idzie za zawężeniem, a nie za całym katalogiem', async ({ panel: id }) => {
    for (let i = 0; i < 5; i += 1) kartaO(`Bez numeru ${i}`);
    kartaO('Z numerem', { sku: 'PLC-001' });

    const bezFiltru = await get(serwer(), '/magazyn');
    const zFiltrem = await get(serwer(), '/magazyn?brak=sku');

    expect(przyciskZakresu(panel(bezFiltru.body, id), 'pasujace').napis).toContain('(6)');
    expect(przyciskZakresu(panel(zFiltrem.body, id), 'pasujace').napis).toContain('(5)');
  });
});

// ================================================================================
// (3) POWTORZONY `zakres` NIE MA JAK POWSTAC
// ================================================================================

describe('parametr zakresu nie ma jak przyjść dwa razy', () => {
  // ⚠️⚠️ PULAPKA UDOKUMENTOWANA W TYM MODULE: pole wyslane DWA RAZY wraca z Fastify jako
  // TABLICA, `pole()` scina ja do `null` i zakres znika w formularzu, ktory sluzy do jego
  // wyboru. Stare pole `<select name="zakres">` plus nowe przyciski o tej samej nazwie
  // dawalyby DOKLADNIE to. Dlatego pola nie ma: zostaly wylacznie przyciski, a formularz
  // wysyla TYLKO ten klikniety.
  it('na ekranie nie ma ANI JEDNEGO pola o nazwie zakres — są wyłącznie przyciski', async () => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');

    expect(r.body).not.toMatch(/<select[^>]*name="zakres"/);
    expect(r.body).not.toMatch(/<input[^>]*name="zakres"/);

    // Kazde wystapienie nazwy `zakres` na stronie ma byc przyciskiem — inaczej powtorka
    // wroci tylnymi drzwiami przy nastepnym dopisanym polu.
    const wszystkie = (r.body.match(/name="zakres"/g) ?? []).length;
    expect(wszystkie).toBeGreaterThan(0);
    expect(przyciskiZakresu(r.body)).toHaveLength(wszystkie);
  });

  // ⚠️ A GDYBY JEDNAK PRZYSZEDL DWA RAZY (recznie sklecone zadanie), rozstrzygniecie jest
  // JAWNE: tablica spada do `null`, a `null` do zakresu WEZSZEGO. Nierozpoznany zakres nigdy
  // nie ma prawa rozszerzyc zbioru — bo szerszy zbior to caly katalog.
  it('zakres przysłany dwa razy spada do węższego zbioru, nigdy do „wszystkich"', async () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    const r = await postSurowy(serwer(), '/magazyn/hurt', 'zakres=pasujace&zakres=pasujace&zawezenie=&szerokosc_cm=70');

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie zaznaczono/i);
    expect(wiersz(a).szerokosc_mm).toBeNull();
    expect(wiersz(b).szerokosc_mm).toBeNull();
  });
});

// ================================================================================
// (4) PARA: ZAZNACZONE vs WSZYSTKIE PASUJACE — I ANI RAZU ODWROTNIE
// ================================================================================

describe('edycja hurtem: kliknięty przycisk rozstrzyga zbiór', () => {
  const trzyBezWymiaru = () => ({
    kandelabr: kartaO('Kandelabr'),
    chmurka: kartaO('Chmurka'),
    sowa: kartaO('Sowa'),
  });

  it('„dla zaznaczonych" bierze WYŁĄCZNIE zaznaczone', async () => {
    const { kandelabr } = trzyBezWymiaru();

    const r = await klikniecie(serwer(), '/magazyn?brak=wymiary', 'hurt-pasek', 'zaznaczone', {
      zaznaczone: String(kandelabr),
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem')).toEqual(['Kandelabr']);
  });

  // Ekran nie ma już przycisku „wszystkich pasujących" w panelu Edytuj, ale trasa nadal
  // przyjmuje ten zakres — zawężenie bierzemy z ekranu, zakres wpisujemy wprost.
  it('zakres „pasujace" bierze CAŁE zawężenie, także karty nigdy nieklikane', async () => {
    const { kandelabr } = trzyBezWymiaru();

    const r = await pasujaceWprost(serwer(), '/magazyn?brak=wymiary', {
      zaznaczone: String(kandelabr),
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem').sort()).toEqual(['Chmurka', 'Kandelabr', 'Sowa']);
  });

  // ⚠️ ZAWEZENIE MA BYC ZAWEZENIEM: „wszystkie pasujace" to nie „wszystko".
  it('zakres „pasujace" nie wychodzi poza zawężenie', async () => {
    trzyBezWymiaru();
    kartaO('Zmierzona', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await pasujaceWprost(serwer(), '/magazyn?brak=wymiary', {
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem')).not.toContain('Zmierzona');
  });

  // Konto ERLI nie ma lustra — zawężenie po nim czyta aktywne oferty z rejestru, także przy hurcie.
  it('zakres „pasujace" przy kanale ERLI bierze tylko karty z aktywną ofertą', async () => {
    const app = buildOmsServer({
      db,
      config,
      magazyn,
      nadpisania: {
        'kanaly.klienciKanalow': { erli_polcien: {} },
        'kanaly.repozytoriumKanalow': {
          listaTypu: (typ) => (typ === 'erli' ? [{ klucz: 'erli_polcien', nazwa: 'ERLI Półcień' }] : []),
          zapisyZablokowane: () => false,
        },
      },
    });
    await app.ready();
    const oferta = (karta, stan) =>
      wstawOferte(db, { kartaId: karta, kanal: 'erli_polcien', idZewnetrzne: `E-${karta}`, stan });
    oferta(kartaO('Kandelabr'), 'aktywna');
    oferta(kartaO('Chmurka'), 'do_wyslania');
    kartaO('Sowa');

    const r = await pasujaceWprost(app, '/magazyn?kanal=erli_polcien', { szerokosc_cm: '70', wysokosc_cm: '100' });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem')).toEqual(['Kandelabr']);
    await app.close();
  });
});

describe('generator SKU przy istniejącym numerze sklepu', () => {
  it('pokazuje powód pominięcia i do zatwierdzenia wysyła tylko kartę bez produktu', async () => {
    const zeSklepu = kartaO('Kandelabr');
    produktO(zeSklepu, { sku: ' PP-001 ' });
    const bezProduktu = kartaO('Sowa');
    const r = await klikniecie(serwer(), '/magazyn?brak=sku', 'sku-pasek', 'pasujace', {
      wzorzec: 'NOWY',
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kandelabr — sklep ma numer PP-001 — uzupełni import');
    expect(nazwyWPodgladzie(r.body, 'sku-propozycje')).toEqual(['Sowa']);
    expect(r.body).toContain(`name="zaznaczone" value="${bezProduktu}"`);
    expect(r.body).not.toContain(`name="zaznaczone" value="${zeSklepu}"`);
    expect(wiersz(bezProduktu).sku).toBeNull();
  });

  it('przelicza barierę przy zapisie, gdy sklep uzyskał numer dopiero po podglądzie', async () => {
    const zeSklepu = kartaO('Kandelabr');
    const bezProduktu = kartaO('Sowa');
    const app = serwer();
    const payload = {
      zakres: 'zaznaczone',
      zaznaczone: [String(zeSklepu), String(bezProduktu)],
      wzorzec: 'NOWY-{nnn}',
    };
    const podglad = await post(app, '/magazyn/sku-podglad', payload);
    expect(nazwyWPodgladzie(podglad.body, 'sku-propozycje')).toEqual(['Kandelabr', 'Sowa']);

    produktO(zeSklepu, { sku: 'PP-001' });
    const zapis = await post(app, '/magazyn/sku-zapisz', payload);

    expect(zapis.statusCode).toBe(200);
    expect(zapis.body).toContain('Kandelabr — sklep ma numer PP-001 — uzupełni import');
    expect(wiersz(zeSklepu).sku).toBeNull();
    expect(wiersz(bezProduktu).sku).toBe('NOWY-001');
  });

  it('przy zapisie pomija kartę, której produkty mają różne numery w sklepach', async () => {
    const karta = kartaO('Kandelabr');
    produktO(karta, { sku: 'PP-001' });
    produktO(karta, { kanal: 'woo2', sku: 'PP-002' });

    const zapis = await post(serwer(), '/magazyn/sku-zapisz', {
      zakres: 'zaznaczone',
      zaznaczone: [String(karta)],
      wzorzec: 'NOWY-{nnn}',
    });

    expect(zapis.statusCode).toBe(200);
    expect(wiersz(karta).sku).toBeNull();
  });

  it('przy zapisie pomija kartę, której numer ze sklepu jest zajęty przez inną kartę', async () => {
    kartaO('Bursztyn', { sku: 'PP-001' });
    const karta = kartaO('Kandelabr');
    produktO(karta, { sku: 'PP-001' });

    const zapis = await post(serwer(), '/magazyn/sku-zapisz', {
      zakres: 'zaznaczone',
      zaznaczone: [String(karta)],
      wzorzec: 'NOWY-{nnn}',
    });

    expect(zapis.statusCode).toBe(200);
    expect(wiersz(karta).sku).toBeNull();
  });

  it('przy zapisie pomija obie karty w sporze o ten sam numer ze sklepu', async () => {
    const pierwsza = kartaO('Kandelabr');
    const druga = kartaO('Sowa');
    produktO(pierwsza, { sku: 'PP-009' });
    produktO(druga, { sku: 'PP-009' });

    const zapis = await post(serwer(), '/magazyn/sku-zapisz', {
      zakres: 'zaznaczone',
      zaznaczone: [String(pierwsza), String(druga)],
      wzorzec: 'NOWY-{nnn}',
    });

    expect(zapis.statusCode).toBe(200);
    expect([wiersz(pierwsza).sku, wiersz(druga).sku]).toEqual([null, null]);
  });

  it('w podglądzie pokazuje powód pominięcia karty z rozbieżnością numerów', async () => {
    const karta = kartaO('Kandelabr');
    produktO(karta, { sku: 'PP-001' });
    produktO(karta, { kanal: 'woo2', sku: 'PP-002' });

    const podglad = await post(serwer(), '/magazyn/sku-podglad', {
      zakres: 'zaznaczone',
      zaznaczone: [String(karta)],
      wzorzec: 'NOWY-{nnn}',
    });

    expect(podglad.statusCode).toBe(200);
    expect(podglad.body).toMatch(
      /<li>Kandelabr — Produkty tej karty mają w sklepach różne numery: .*PP-001.*PP-002.*<\/li>/,
    );
    expect(podglad.body).not.toContain('sklep ma numer  —');
  });
});
