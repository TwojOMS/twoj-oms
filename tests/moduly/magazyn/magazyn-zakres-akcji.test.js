import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';

// ZAKRES PRZY AKCJI — wada uzytecznosci zgloszona przez wlasciciela wprost:
// „nie ma opcji zaznaczania wszystkich produktow. Musze kliknac ponad 100 razy zeby
// zaznaczyc te produkty do przejecia".
//
// ⚠️⚠️ FUNKCJA ISTNIALA. Pole wyboru „Zastosuj do" z pozycja „wszystkich pasujacych do
// zawezenia" stalo w panelu EDYCJI HURTEM, a przyciski trzech pozostalych akcji — SKU,
// przejecia numerow i zapisu do sklepow — TRZY SEKCJE NIZEJ, w osobnych panelach. Wszystko
// siedzialo w jednym `<form>`, wiec DZIALALO: klikniecie „Pokaz numery do przejecia" bralo
// zakres z pola, ktorego czlowiek przy tym przycisku nie widzial. W kodzie stal komentarz
// „Zakres bierze sie z pola «Zastosuj do» wyzej"; na ekranie nie stalo nic. To jest wada
// EKRANU, nie uzytkownika: akcja i jej zakres musza byc widoczne RAZEM.
//
// ⚠️⚠️ CZTERY RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) KAZDA z czterech akcji ma WLASNA pare przyciskow niosacych zakres w sobie —
//       zaden nie odsyla do pola stojacego gdzie indziej;
//   (2) LICZBA stoi PRZY przycisku „wszystkich pasujacych" i jest TA SAMA, co dlugosc
//       tabeli nizej (jeden odczyt, nie drugie zapytanie);
//   (3) `zakres` NIE MA JAK przyjsc dwa razy — bo na ekranie nie ma juz zadnego pola
//       o tej nazwie, sa wylacznie przyciski, a formularz wysyla TYLKO ten klikniety.
//       Ta pulapka wystapila juz raz w tym module: powtorzony parametr wraca z Fastify
//       jako TABLICA, parser scina ja do `null` i filtr znika w formularzu, ktory sluzy
//       do jego ustawiania;
//   (4) klikniecie „dla zaznaczonych" bierze ZAZNACZONE, a „dla wszystkich pasujacych"
//       bierze CALE ZAWEZENIE — i ANI RAZU ODWROTNIE.

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
let magazyn;
const serwer = (uslugaMagazynu = magazyn) => buildOmsServer({ db, config, magazyn: uslugaMagazynu });

beforeEach(() => {
  db = openOmsDb(':memory:');
  magazyn = atrapaMagazynu();
});

const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

/** Produkt w lustrze, powiazany z kartą — zeby przejecie numeru mialo co przejmowac. */
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
const post = (app, url, payload) => app.inject({
  method: 'POST', url, headers: auth, payload,
});
// Cialo zadania SUROWE — jedyna droga, zeby wyslac ten sam klucz DWA RAZY.
const postSurowy = (app, url, tresc) => app.inject({
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
      napis: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
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
    zakres: przycisk.wartosc, zawezenie, ...dodatkowe,
  });
}

/** Nazwy kart z tabeli podgladu (hurt, przejecie, SKU maja ten sam ksztalt wiersza). */
function nazwyWPodgladzie(body, idSekcji) {
  const s = new RegExp(`<section[^>]*id="${idSekcji}"[\\s\\S]*?</section>`).exec(body);
  if (!s) throw new Error(`W podgladzie nie ma sekcji „${idSekcji}"`);
  return [...s[0].matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);
}

/** Ile wierszy ma TABELA KART — liczone z jej wlasnej kolumny, nie z jakiejkolwiek cyfry. */
const ileWierszyTabeli = (body) => (body.match(/<td class="komorka-karta">/g) ?? []).length;

// Cztery akcje ekranu. Kazda ma WLASNY nosnik (`id`) i WLASNA pare przyciskow.
const AKCJE = [
  { panel: 'hurt-pasek', cel: '/magazyn/hurt', slowo: 'zmieni' },
  { panel: 'sku-pasek', cel: '/magazyn/sku-podglad', slowo: 'numery' },
  { panel: 'przejecie-pasek', cel: '/magazyn/przejmij-podglad', slowo: 'przej' },
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
  // nazwy akcji jest przy czterech podobnych parach nie do odroznienia od sasiada.
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
  // z czterech par ma prowadzic na WLASNY PODGLAD — i nigdy wprost na zapis.
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

    const r = await postSurowy(
      serwer(),
      '/magazyn/hurt',
      'zakres=pasujace&zakres=pasujace&zawezenie=&szerokosc_cm=70',
    );

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
      zaznaczone: String(kandelabr), szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem')).toEqual(['Kandelabr']);
  });

  it('„dla wszystkich pasujących" bierze CAŁE zawężenie, także karty nigdy nieklikane', async () => {
    const { kandelabr } = trzyBezWymiaru();

    const r = await klikniecie(serwer(), '/magazyn?brak=wymiary', 'hurt-pasek', 'pasujace', {
      zaznaczone: String(kandelabr), szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem').sort()).toEqual(['Chmurka', 'Kandelabr', 'Sowa']);
  });

  // ⚠️ ZAWEZENIE MA BYC ZAWEZENIEM: „wszystkie pasujace" to nie „wszystko".
  it('„dla wszystkich pasujących" nie wychodzi poza zawężenie', async () => {
    trzyBezWymiaru();
    kartaO('Zmierzona', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await klikniecie(serwer(), '/magazyn?brak=wymiary', 'hurt-pasek', 'pasujace', {
      szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(nazwyWPodgladzie(r.body, 'zmiany-hurtem')).not.toContain('Zmierzona');
  });
});

describe('przejęcie numerów: kliknięty przycisk rozstrzyga zbiór', () => {
  // 277 kart czekajacych na przejecie numeru to DOKLADNIE ta sytuacja, ktora wlasciciel
  // zglosil: „musze kliknac ponad 100 razy".
  function trzyDoPrzejecia() {
    const idy = {};
    for (const [klucz, nazwa] of [['a', 'Bursztyn'], ['b', 'Kandelabr'], ['c', 'Sowa']]) {
      idy[klucz] = kartaO(nazwa);
      produktO(idy[klucz], { sku: `SKU-${nazwa.toUpperCase()}-1` });
    }
    return idy;
  }

  it('„dla zaznaczonych" bierze WYŁĄCZNIE zaznaczone', async () => {
    const { a } = trzyDoPrzejecia();

    const r = await klikniecie(serwer(), '/magazyn?brak=sku', 'przejecie-pasek', 'zaznaczone', {
      zaznaczone: String(a),
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'przejecie-pozycje')).toEqual(['Bursztyn']);
  });

  // ⚠️⚠️ TO JEST ZGLOSZENIE WLASCICIELA, PRZELOZONE NA TEST: jedno klikniecie ma objac cale
  // zawezenie, bez ani jednego pola wyboru.
  it('„dla wszystkich pasujących" obejmuje cały zestaw JEDNYM kliknięciem, bez zaznaczania', async () => {
    trzyDoPrzejecia();

    const r = await klikniecie(serwer(), '/magazyn?brak=sku', 'przejecie-pasek', 'pasujace');

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'przejecie-pozycje').sort())
      .toEqual(['Bursztyn', 'Kandelabr', 'Sowa']);
  });

  // ⚠️⚠️ PODGLAD JEST OBOWIAZKOWY I ZOSTAJE OBOWIAZKOWY. Zmieniamy sposob wyboru zakresu,
  // a nie bariery: klikniecie „dla wszystkich pasujacych" ma POKAZAC, a nie zapisac.
  it('kliknięcie „dla wszystkich pasujących" niczego nie zapisuje', async () => {
    const { a, b, c } = trzyDoPrzejecia();

    await klikniecie(serwer(), '/magazyn?brak=sku', 'przejecie-pasek', 'pasujace');

    for (const id of [a, b, c]) expect(wiersz(id).sku).toBeNull();
  });
});
