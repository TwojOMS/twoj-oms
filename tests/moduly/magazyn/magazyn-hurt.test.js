import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from './pliki-historyczne.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { utworzKarte, zastosujHurtem, kartyPoIdach } from '../../../src/oms/db/magazyn.js';
import { polecenieZFormularza, zmianyHurtem } from '../../../src/domena/magazyn-hurt.js';
import { dodajDoSlownika, nazwySlownika } from '../../../src/moduly/magazyn/services/slowniki-kart.js';

// EDYCJA HURTEM W MAGAZYNIE — ekran, ktory istnieje dla 645 kart bez wymiaru
// i 152 bez kategorii glownej.
// Bez niego trzeba by otworzyc 645 kart po kolei.
//
// ⚠️⚠️ SZESC RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) PUSTE POLE ZNACZY „NIE RUSZAJ" — i to jest ODWROTNIE niz na karcie produktu, gdzie
//       puste pole KASUJE wartosc. Gdyby hurtem puste kasowalo, ustawienie samej
//       glebokosci wyczysciloby szerokosc i kategorie 600 kartom jednym kliknieciem;
//   (2) PODGLAD JEST OBOWIAZKOWY — trasa podgladu nie zapisuje ANI JEDNEGO wiersza;
//   (3) zestaw zmian liczony PONOWNIE przy zatwierdzeniu, nie przepisany z ukrytego pola;
//   (4) puste zaznaczenie nie robi NICZEGO — „dotyczy wszystkiego" byloby najkrotsza droga
//       do nadpisania calego rejestru jednym kliknieciem;
//   (5) napis, ktorego nie rozumiemy, ODMAWIA CALEGO zapisu — nigdy cichego pominiecia;
//   (6) zapis hurtem idzie w JEDNEJ transakcji.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
// ⚠️ TE SAME poswiadczenia, ale BEZ `origin` — ochrona CSRF (src/security/csrf.js) stoi na
// naglowku zrodla, a nie na tokenie w formularzu.
const authBezZrodla = { authorization: auth.authorization };

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
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload, naglowki = auth) =>
  app.inject({
    method: 'POST',
    url,
    headers: naglowki,
    payload,
  });

const podglad = (app, payload, naglowki) => post(app, '/magazyn/hurt', payload, naglowki);
const zatwierdz = (app, payload, naglowki) => post(app, '/magazyn/hurt/zatwierdz', payload, naglowki);

function daneZPodgladu(body, odznaczone = []) {
  const dane = new URLSearchParams();
  for (const [input] of sekcja(body, 'zmiany-hurtem').matchAll(/<input\b[^>]*>/g)) {
    const atrybut = (nazwa) => new RegExp(`\\b${nazwa}="([^"]*)"`).exec(input)?.[1];
    const typ = atrybut('type');
    const nazwa = atrybut('name');
    const wartosc = atrybut('value');
    if (typ === 'hidden' || (typ === 'checkbox' && /\schecked\b/.test(input) && !odznaczone.includes(wartosc))) {
      dane.append(nazwa, wartosc);
    }
  }
  return dane.toString();
}

const zFormularza = { ...auth, 'content-type': 'application/x-www-form-urlencoded' };

describe('próg niskiego stanu hurtem', () => {
  // Próg ma sens tylko przy liczonych stanach, więc panel pokazuje go dopiero po ich włączeniu.
  it('pasek Edytuj ma pole progu i osobne pole wyboru „bez progu”', async () => {
    kartaO('Lampa Półcień');
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2025-01-01T00:00:00Z' });
    const r = await get(serwer(), '/magazyn');
    expect(r.statusCode).toBe(200);
    const pasek = sekcja(r.body, 'hurt-pasek');
    expect(pasek).toMatch(/<input[^>]*name="prog_niskiego_stanu"/);
    expect(pasek).toMatch(/<input type="checkbox" name="prog_niskiego_stanu_bez" value="tak"/);
  });

  it.each([
    [{ prog_niskiego_stanu: '' }, 5, null],
    [{ prog_niskiego_stanu: '0' }, 0, '0 szt.'],
    [{ prog_niskiego_stanu: '', prog_niskiego_stanu_bez: 'tak' }, null, 'bez progu'],
  ])('podgląd i zapis zmiany kart z formularza %j', async (pola, prog, opis) => {
    const id = kartaO('Lampa Półcień', { prog_niskiego_stanu: 5 });
    const app = serwer();
    const dane = new URLSearchParams({ zaznaczone: String(id), glebokosc_cm: '20', ...pola });
    const r = await podglad(app, dane.toString(), zFormularza);
    expect(r.statusCode).toBe(200);
    expect(wiersz(id).prog_niskiego_stanu).toBe(5);
    if (opis) {
      expect(r.body).toContain('<td>Próg niskiego stanu</td>');
      expect(r.body).toContain(`<b>${opis}</b>`);
    } else {
      expect(r.body).not.toContain('<td>Próg niskiego stanu</td>');
    }
    const zapis = await zatwierdz(app, daneZPodgladu(r.body), zFormularza);
    expect(zapis.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ prog_niskiego_stanu: prog, glebokosc_mm: 200 });
  });

  it.each(['/magazyn/hurt', '/magazyn/hurt/zatwierdz'])(
    'ujemny próg w %s odrzuca także zmianę głębokości',
    async (url) => {
      const id = kartaO('Lampa Półcień', { prog_niskiego_stanu: 5, glebokosc_mm: 100 });
      const dane = new URLSearchParams({ zaznaczone: String(id), prog_niskiego_stanu: '-1', glebokosc_cm: '20' });
      const r = await post(serwer(), url, dane.toString(), zFormularza);
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(/Próg niskiego stanu/);
      expect(wiersz(id)).toMatchObject({ prog_niskiego_stanu: 5, glebokosc_mm: 100 });
    },
  );
});

describe('zaznaczenie w podglądzie hurtu', () => {
  it('odznaczona karta zostaje nietknięta, a dwa pola jednej karty mają wspólny checkbox', async () => {
    const ids = ['Bryza', 'Mgła', 'Iskra'].map((nazwa) => kartaO(nazwa));
    const przed = wiersz(ids[2]);
    const app = serwer();
    const r = await podglad(app, { zakres: 'pasujace', szerokosc_cm: '70', glebokosc_cm: '20' });
    const ekran = sekcja(r.body, 'zmiany-hurtem');
    expect(ileNaEkranie(r.body)).toBe('3');
    const zapis = await zatwierdz(app, daneZPodgladu(r.body, [String(ids[2])]), zFormularza);
    expect(zapis.statusCode).toBe(200);
    expect(ileNaEkranie(zapis.body)).toBe('2');
    expect(ids.slice(0, 2).map((id) => wiersz(id).szerokosc_mm)).toEqual([700, 700]);
    expect(wiersz(ids[2])).toEqual(przed);
    const checkboxy = [...ekran.matchAll(/<input\b[^>]*type="checkbox"[^>]*name="zaznaczone"[^>]*>/g)];
    expect(checkboxy).toHaveLength(3);
    for (const [input] of checkboxy) {
      expect(input).toMatch(/\schecked\b/);
      expect(input).toContain('form="zatwierdz-hurt"');
    }
    expect(ekran).not.toContain('Zaznacz wszystkie');
  });

  it('odznaczenie wszystkich daje odmowę bez zapisu', async () => {
    const id = kartaO('Bryza');
    const przed = wiersz(id);
    const app = serwer();
    const r = await podglad(app, { zaznaczone: String(id), glebokosc_cm: '20' });
    const zapis = await zatwierdz(app, daneZPodgladu(r.body, [String(id)]), zFormularza);
    expect(zapis.statusCode).toBe(400);
    expect(zapis.body).toMatch(/nie zaznaczono/i);
    expect(wiersz(id)).toEqual(przed);
  });

  it.each([10, 11])('pokazuje akcje dla całej tabeli począwszy od 11 kart (plan: %i)', async (ile) => {
    for (let i = 0; i < ile; i++) kartaO(`Klosz ${i}`);
    const r = await podglad(serwer(), { zakres: 'pasujace', glebokosc_cm: '20' });
    const ekran = sekcja(r.body, 'zmiany-hurtem');
    expect(ekran.includes('Zaznacz wszystkie')).toBe(ile > 10);
    expect(ekran.includes('Odznacz wszystkie')).toBe(ile > 10);
  });
});

describe('marka hurtem', () => {
  it('pokazuje słownik w pasku i zapisuje markę z listy jako ręczną', async () => {
    dodajDoSlownika(db, 'marki', 'Półcień');
    const id = kartaO('Lampa', { marka: 'Przed zmianą' });
    const app = serwer();
    const lista = await get(app, '/magazyn');
    const pasek = sekcja(lista.body, 'hurt-pasek');
    expect(pasek).toMatch(/<select name="marka">\s*<option value="">— nie zmieniaj —<\/option>/);
    expect(pasek).toContain('<option value="Półcień">Półcień</option>');
    expect(pasek).toMatch(/name="marka_nowa" maxlength="200"/);
    const r = await podglad(app, { zaznaczone: String(id), marka: 'Półcień' });
    expect(wierszZmiany(r.body, 'Lampa')).toMatch(/Marka[\s\S]*Przed zmianą[\s\S]*Półcień/);
    expect((await zatwierdz(app, daneZPodgladu(r.body), zFormularza)).statusCode).toBe(200);
    expect(wiersz(id).marka).toBe('Półcień');
    expect(
      db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'marka'").get(id),
    ).toEqual({ zrodlo: 'reczne', reczne: 1 });
  });

  it('dopiero zatwierdzenie dopisuje znormalizowaną markę i zmienia kartę', async () => {
    const id = kartaO('Lampa');
    const przed = wiersz(id);
    const app = serwer();
    const r = await podglad(app, { zaznaczone: String(id), marka: '', marka_nowa: '  Półcień  ' });
    expect(r.statusCode).toBe(200);
    expect(wierszZmiany(r.body, 'Lampa')).toContain('<b>Półcień</b>');
    expect(nazwySlownika(db, 'marki')).toEqual([]);
    expect(wiersz(id)).toEqual(przed);
    expect((await zatwierdz(app, daneZPodgladu(r.body), zFormularza)).statusCode).toBe(200);
    expect(nazwySlownika(db, 'marki')).toEqual(['Półcień']);
    expect(wiersz(id).marka).toBe('Półcień');
  });

  it.each([
    [{ marka: 'Wybrana', marka_nowa: 'Wpisana' }, /Wybierz markę z listy albo wpisz nową — nie obie naraz/],
    [{ marka: ['Pierwsza', 'Druga'] }, /dwa razy/],
    [{ marka_nowa: ['Pierwsza', 'Druga'] }, /dwa razy/],
  ])('odmawia całej operacji przy niejednoznacznej marce (%j)', async (pola, komunikat) => {
    const id = kartaO('Lampa', { marka: 'Półcień' });
    const przed = wiersz(id);
    const app = serwer();
    const dane = { zaznaczone: String(id), glebokosc_cm: '20', ...pola };
    for (const wyslij of [podglad, zatwierdz]) {
      const r = await wyslij(app, dane);
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(komunikat);
    }
    expect(wiersz(id)).toEqual(przed);
    expect(nazwySlownika(db, 'marki')).toEqual([]);
  });

  it('puste pola marki pozostawiają dotychczasową markę przy zmianie innego pola', async () => {
    const id = kartaO('Lampa', { marka: 'Półcień' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), glebokosc_cm: '20', marka: '', marka_nowa: ' ' });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ marka: 'Półcień', glebokosc_mm: 200 });
  });
});

/**
 * JEDNA SEKCJA EKRANU — bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI KAZDEJ ASERCJI TUTAJ. Wspolny uklad
 * (`layout-oms.ejs`) jedzie w KAZDEJ stronie i niesie wlasne pola formularzy (przelacznik
 * motywu, szukajka paska), a ekran hurtu pokazuje TE SAMA nazwe karty w kilku miejscach.
 * Asercja „na stronie jest X" bywa wiec spelniona przez cokolwiek innego niz to, o czym
 * mowi. RZUCA, gdy sekcji nie ma — inaczej kazde `not.toContain` przechodziloby na pustym
 * napisie, czyli zielono i bez zadnej ochrony.
 *
 * ⚠️ `<section>` ALBO `<details>` (przebudowa 2026-08-25): akcje ekranu magazynu przestaly
 * byc czterema panelami `<section>` i sa chipami `<details>` w jednej belce. Zmienil sie
 * WYLACZNIE znacznik nosnika — `id` i cala zawartosc zostaly te same, wiec pomocnik bierze
 * ten znacznik, ktory `id` niesie, i domyka go TYM SAMYM (`\1`). Ekrany podgladow
 * (`zmiany-hurtem`) sa nadal `<section>` i chodza ta sama droga.
 */
function sekcja(body, id) {
  const trafienie = new RegExp(`<(section|details)[^>]*id="${id}"[\\s\\S]*?</\\1>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}"`);
  return trafienie[0];
}

/** Wiersz JEDNEJ karty z tabeli podgladu — sam wiersz, bez reszty sekcji. */
function wierszZmiany(body, nazwa) {
  const znacznik = `<div class="nazwa-karty">${nazwa}</div>`;
  const w = sekcja(body, 'zmiany-hurtem')
    .split('<tr')
    .find((t) => t.includes(znacznik));
  if (!w) throw new Error(`W podgladzie nie ma karty „${nazwa}"`);
  return w;
}

const nazwyWPodgladzie = (body) =>
  [...sekcja(body, 'zmiany-hurtem').matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);

/**
 * LICZBA, ktora ekran podaje jako „tylu kart to dotyczy".
 *
 * ⚠️ WLASNY ZNACZNIK, a nie `toContain('645')` na calej stronie. Cyfry sa na tym ekranie
 * wszedzie — w numerach kart, w ukrytych polach zaznaczenia, w wymiarach — wiec asercja
 * na goly napis przechodzilaby takze wtedy, gdyby ekran zadnej liczby nie podawal. RZUCA,
 * gdy znacznika nie ma.
 */
function ileNaEkranie(body) {
  const m = /<strong class="hurt-ile">([^<]*)<\/strong>/.exec(body);
  if (!m) throw new Error('Ekran hurtu nie podaje liczby kart (brak znacznika hurt-ile)');
  return m[1];
}

/** Liczba kart pasujacych do zawezenia, podana w pasku akcji nad tabela (panel Edytuj
 * działa tylko na zaznaczonych, więc liczbę podaje panel numerów SKU). */
function ilePasujacych(body) {
  const m = /<strong class="sku-pasujace">([^<]*)<\/strong>/.exec(sekcja(body, 'sku-pasek'));
  if (!m) throw new Error('Pasek hurtu nie podaje liczby pasujacych kart');
  return m[1];
}

/** Wiersz JEDNEJ karty z tabeli listy magazynu — sam wiersz, bez reszty strony. */
function wierszListy(body, nazwa) {
  const znacznik = `>${nazwa}</a>`;
  const w = body.split('<tr').find((t) => t.includes(znacznik) && t.includes('komorka-karta'));
  if (!w) throw new Error(`Na liscie magazynu nie ma karty „${nazwa}"`);
  return w;
}

// ————————————————————————————————————————————————————————————————————————————————
// ⚠️⚠️ ROZSTRZYGNIECIE NAJWAZNIEJSZE. Na KARCIE puste pole kasuje wartosc — czlowiek patrzy
// na jedna karte i widzi, co robi. HURTEM puste pole ZNACZY „NIE RUSZAJ", bo formularz ma
// kilka pol naraz: gdyby puste kasowalo, ustawienie samej glebokosci wyczyscilo by wymiary
// i kategorie 600 kartom jednym kliknieciem, bez sladu i bez mozliwosci cofniecia.
describe('puste pole ZNACZY „nie ruszaj" — para: wypelnione zmienia, puste zostawia', () => {
  it('pole WYPELNIONE zmienia wartosc', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(wiersz(id).szerokosc_mm).toBe(700);
    expect(wiersz(id).wysokosc_mm).toBe(1000);
  });

  // ⚠️ SPRAWDZONE NA KARCIE, KTORA TE WARTOSCI MA. Karta z pustymi kolumnami przeszlaby
  // ten test takze wtedy, gdyby puste pole KASOWALO — bo kasowanie pustego nie widac.
  it('pole PUSTE zostawia STARA wartosc nietknieta', async () => {
    const id = kartaO('Kandelabr', {
      szerokosc_mm: 300,
      wysokosc_mm: 400,
      kategoria_glowna: 'Aplikacje',
      glebokosc_mm: 100,
    });

    // Ustawiamy WYLACZNIE glebokosc; pozostale wymiary i kategoria jada puste.
    await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '',
      wysokosc_cm: '',
      kategoria_glowna: '',
      glebokosc_cm: '20',
    });

    const w = wiersz(id);
    expect(w.glebokosc_mm).toBe(200);
    // To sa trzy wartosci, ktore jedno klikniecie skasowaloby 600 kartom.
    expect(w.szerokosc_mm).toBe(300);
    expect(w.wysokosc_mm).toBe(400);
    expect(w.kategoria_glowna).toBe('Aplikacje');
  });

  it('pole NIEPRZYSLANE zostawia stara wartosc — brak pola to nie pole puste', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400, kategoria_glowna: 'Aplikacje' });

    await zatwierdz(serwer(), { zaznaczone: String(id), glebokosc_cm: '20' });

    const w = wiersz(id);
    expect(w.szerokosc_mm).toBe(300);
    expect(w.kategoria_glowna).toBe('Aplikacje');
  });

  it('kategorie ustawia sie hurtem, a wymiary zostaja', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await zatwierdz(serwer(), { zaznaczone: String(id), kategoria_glowna: 'Lampy wiszące' });

    expect(wiersz(id).kategoria_glowna).toBe('Lampy wiszące');
    expect(wiersz(id).szerokosc_mm).toBe(300);
  });

  // Puste pole nie ma prawa kasowac takze WTEDY, gdy sasiednie pole tej samej pary jest
  // wypelnione: „ustaw sama szerokosc" to zdanie o szerokosci, nie o wysokosci.
  it('sama szerokosc nie kasuje wysokosci', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '' });

    expect(wiersz(id).szerokosc_mm).toBe(700);
    expect(wiersz(id).wysokosc_mm).toBe(400);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('podglad jest OBOWIAZKOWY — para: podglad milczy w bazie, zatwierdzenie zapisuje', () => {
  it('podglad NIE ZAPISUJE ani jednego wiersza', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });
    const przed = wiersz(id);

    const r = await podglad(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(wiersz(id).szerokosc_mm).toBe(300);
    expect(wiersz(id).wysokosc_mm).toBe(400);
    // Takze data zmiany ma zostac nietknieta — inaczej „nic nie zapisalem" bylo by nieprawda.
    expect(wiersz(id).zmieniony_at).toBe(przed.zmieniony_at);
  });

  it('zatwierdzenie zapisuje — ten sam formularz, druga trasa', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100' });

    expect(wiersz(id).szerokosc_mm).toBe(700);
  });

  it('podglad mowi ILE kart zmieni i Z CZEGO NA CO', async () => {
    const a = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });
    const b = kartaO('Chmurka');

    const r = await podglad(serwer(), {
      zaznaczone: [String(a), String(b)],
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    // Liczba stoi na ekranie — czlowiek ma wiedziec, ilu kart dotyka.
    expect(ileNaEkranie(r.body)).toBe('2');
    // „Z czego na co", a nie sama nowa wartosc: bez starej nie widac, co sie traci.
    const wKandelabrze = wierszZmiany(r.body, 'Kandelabr');
    expect(wKandelabrze).toContain('30 cm');
    expect(wKandelabrze).toContain('70 cm');
    // Karta bez wymiaru pokazuje BRAK jako brak, a nie jako pusta komorke.
    expect(wierszZmiany(r.body, 'Chmurka')).toContain('70 cm');
  });

  it('podglad ma przycisk zatwierdzenia prowadzacy na trase zapisu', async () => {
    const id = kartaO('Kandelabr');
    const r = await podglad(serwer(), { zaznaczone: String(id), glebokosc_cm: '20' });
    expect(r.body).toContain('action="/magazyn/hurt/zatwierdz"');
  });

  // ⚠️ KARTA, KTORA JUZ MA TE WARTOSC, NIE JEST ZMIANA. Podglad obiecujacy „zmienie 645"
  // i zmieniajacy 200 klamie o wlasnym skutku.
  it('karta, ktora juz ma te wartosc, nie wchodzi do podgladu ani do liczby', async () => {
    const stary = kartaO('Kandelabr', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    const nowy = kartaO('Chmurka');

    const r = await podglad(serwer(), {
      zaznaczone: [String(stary), String(nowy)],
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(nazwyWPodgladzie(r.body)).toEqual(['Chmurka']);
  });

  it('karta bez zmiany nie dostaje nowej daty zmiany', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    const przed = wiersz(id).zmieniony_at;

    await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100' });

    expect(wiersz(id).zmieniony_at).toBe(przed);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// ⚠️ Zestaw zmian liczony PONOWNIE przy zatwierdzeniu — inaczej odczyt katalogow miedzy
// podgladem a klknieciem zmienilby zbior po cichu. Formularz przynosi IDENTYFIKATORY
// i WARTOSCI, nigdy gotowego „z czego na co".
describe('zestaw zmian liczony PONOWNIE przy zatwierdzeniu', () => {
  it('karta zmieniony miedzy podgladem a zatwierdzeniem liczy sie ze stanu BIEZACEGO', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await podglad(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100' });
    // Ktos w drugiej karcie ustawil dokladnie to, co mial ustawic hurt.
    db.prepare('UPDATE karty_produktow SET szerokosc_mm = 700, wysokosc_mm = 1000 WHERE id = ?').run(id);
    const przed = wiersz(id).zmieniony_at;

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    // Nie ma czego zmieniac — i ekran ma to powiedziec, a nie zameldowac „zmieniono 1".
    expect(ileNaEkranie(r.body)).toBe('0');
    expect(wiersz(id).zmieniony_at).toBe(przed);
  });

  it('karta skasowany miedzy podgladem a zatwierdzeniem po prostu wypada', async () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    await podglad(serwer(), { zaznaczone: [String(a), String(b)], glebokosc_cm: '20' });
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(b);

    const r = await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)], glebokosc_cm: '20' });

    expect(r.statusCode).toBe(200);
    expect(wiersz(a).glebokosc_mm).toBe(200);
  });

  // ⚠️ Gdyby trasa zatwierdzajaca ufala ukrytemu polu z gotowym zestawem, ten test bylby
  // jedynym miejscem, w ktorym by to widac.
  it('trasa zatwierdzajaca nie przyjmuje gotowego zestawu z ukrytego pola', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    // Podrzucamy „gotowy zestaw" obok prawdziwych pol. Ma zostac zignorowany.
    await zatwierdz(serwer(), {
      zaznaczone: String(id),
      glebokosc_cm: '20',
      zmiany: JSON.stringify([{ id, zmiany: { szerokosc_mm: 9999 } }]),
      plan: JSON.stringify([{ id, zmiany: { kategoria_glowna: 'Podrzucona' } }]),
    });

    const w = wiersz(id);
    expect(w.glebokosc_mm).toBe(200);
    expect(w.szerokosc_mm).toBe(300);
    expect(w.kategoria_glowna).toBe(null);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('zaznaczenie musi byc JAWNE — para: puste odmawia, niepuste dziala', () => {
  // ⚠️ Puste zaznaczenie, ktore „dotyczy wszystkiego", to najkrotsza droga do nadpisania
  // calego rejestru jednym kliknieciem.
  it('puste zaznaczenie nie robi NICZEGO i mowi o tym', async () => {
    kartaO('Kandelabr');
    kartaO('Chmurka');

    const r = await zatwierdz(serwer(), { zaznaczone: [], glebokosc_cm: '20' });

    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE glebokosc_mm IS NOT NULL').get().c).toBe(0);
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  it('brak pola `zaznaczone` w ogole nie robi NICZEGO', async () => {
    kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), { glebokosc_cm: '20' });

    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE glebokosc_mm IS NOT NULL').get().c).toBe(0);
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  it('niepuste zaznaczenie dziala — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), { zaznaczone: String(id), glebokosc_cm: '20' });

    expect(wiersz(id).glebokosc_mm).toBe(200);
    expect(r.body).not.toMatch(/nie zaznaczono/i);
  });

  it('nie dotyka kart NIEZAZNACZONYCH', async () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    await zatwierdz(serwer(), { zaznaczone: String(a), szerokosc_cm: '70', wysokosc_cm: '100' });

    expect(wiersz(a).szerokosc_mm).toBe(700);
    expect(wiersz(b).szerokosc_mm).toBe(null);
  });

  // Numer, ktorego nie da sie odczytac, nie ma prawa zamienic sie w „wszystkie".
  it('smiec w miejscu numeru nie poszerza zbioru', async () => {
    const id = kartaO('Kandelabr');

    await zatwierdz(serwer(), { zaznaczone: ['abc', '__proto__', String(id)], glebokosc_cm: '20' });

    expect(wiersz(id).glebokosc_mm).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE glebokosc_mm IS NOT NULL').get().c).toBe(1);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('„zaznacz wszystkie pasujace do zawezenia" — liczba z TEGO SAMEGO zapytania, co lista', () => {
  it('obejmuje wszystkie pasujace do filtru, nie tylko widoczne', async () => {
    const bez = [];
    for (let i = 0; i < 5; i += 1) bez.push(kartaO(`Bez wymiaru ${i}`));
    kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    for (const id of bez) expect(wiersz(id).szerokosc_mm).toBe(700);
  });

  // ⚠️ Filtr, ktorego zapytanie nie zna, oddaje PUSTO (`1 = 0`) — i tak ma zostac takze tutaj.
  // Cicho zignorowany filtr znaczylby hurtowa zmiane na CALYM katalogu zamiast na brakach.
  it('zawezenie NIE poszerza sie o karty, ktore do niego nie pasuja', async () => {
    const zWymiarem = kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });
    kartaO('Bez wymiaru');

    await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(wiersz(zWymiarem).szerokosc_mm).toBe(300);
  });

  it('podglad zakresu „pasujace" pokazuje LICZBE kart, ktorych dotyka', async () => {
    for (let i = 0; i < 7; i += 1) kartaO(`Bez wymiaru ${i}`);

    const r = await podglad(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(ileNaEkranie(r.body)).toBe('7');
  });

  it('zakres „pasujace" bez ani jednego trafienia nie zapisuje niczego', async () => {
    const id = kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(wiersz(id).szerokosc_mm).toBe(300);
    expect(r.statusCode).toBe(200);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// ⚠️ Napis niezrozumialy → ODMOWA CALEGO ZAPISU. Nigdy ciche pominiecie i nigdy zgadywanie:
// wymiar zgadniety jest gorszy niz brak wymiaru, bo to on trafia do sklepu, na etykiete
// i do wyliczenia gabarytu paczki.
describe('napis niezrozumialy ODMAWIA — para: odmawia i nie zapisuje / liczba przechodzi', () => {
  it('literowka w wymiarze odmawia i NIE ZAPISUJE ANI JEDNEGO POLA', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '70 cm',
      wysokosc_cm: '100',
      glebokosc_cm: '20',
    });

    expect(r.statusCode).toBe(400);
    const w = wiersz(id);
    expect(w.szerokosc_mm).toBe(300);
    expect(w.wysokosc_mm).toBe(400);
    // ⚠️ ODMOWA JEST CALOSCIOWA — glebokosc z tego samego zadania tez nie wchodzi.
    expect(w.glebokosc_mm).toBe(null);
  });

  it('odmowa mowi, CZEGO nie zrozumiala', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70 cm' });
    expect(r.body).toContain('70 cm');
  });

  it('sama liczba przechodzi — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '10,5',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(wiersz(id).szerokosc_mm).toBe(105);
  });

  it('podglad tez odmawia, zamiast pokazywac zgadniety zestaw', async () => {
    const id = kartaO('Kandelabr');
    const r = await podglad(serwer(), { zaznaczone: String(id), szerokosc_cm: 'siedemdziesiat' });
    expect(r.statusCode).toBe(400);
  });

  it('zadna zmiana w formularzu odmawia — puste wszystko nie jest operacja', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300 });

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: '',
      wysokosc_cm: '',
      kategoria_glowna: '',
      glebokosc_cm: '',
    });

    expect(r.statusCode).toBe(400);
    expect(wiersz(id).szerokosc_mm).toBe(300);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// ⚠️ Biala lista pol, ODPORNA na `Object.prototype`. Pole dopisane recznie do zadania HTTP
// nie ma prawa siegnac dalej, niz ekran pozwala — `sku` ustawia
// generator SKU, a `opis` formularz karty.
describe('biala lista pol — para: pole z listy wchodzi, pole spoza NIE', () => {
  it('pole Z listy wchodzi', async () => {
    const id = kartaO('Kandelabr');
    await zatwierdz(serwer(), { zaznaczone: String(id), kategoria_glowna: 'Lampy wiszące' });
    expect(wiersz(id).kategoria_glowna).toBe('Lampy wiszące');
  });

  it('kolumna SPOZA listy zostaje nietknieta, mimo ze baza ja zna', async () => {
    const id = kartaO('Kandelabr', { sku: 'SKU-1', opis: 'stary opis', waga_g: 1200 });

    await zatwierdz(serwer(), {
      zaznaczone: String(id),
      kategoria_glowna: 'Lampy wiszące',
      sku: 'PODRZUCONE',
      opis: 'podrzucony',
      waga_g: '5',
      nazwa: 'Podrzucona',
    });

    const w = wiersz(id);
    expect(w.kategoria_glowna).toBe('Lampy wiszące');
    expect(w.sku).toBe('SKU-1');
    expect(w.opis).toBe('stary opis');
    expect(w.waga_g).toBe(1200);
    expect(w.nazwa).toBe('Kandelabr');
  });

  it('klucz z prototypu nie przechodzi przez biala liste', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      constructor: 'x',
      hasOwnProperty: 'y',
      toString: 'z',
    });

    // Nic do zmiany — a nie pieciusetka i nie zapis czegokolwiek.
    expect(r.statusCode).toBe(400);
    expect(wiersz(id).nazwa).toBe('Kandelabr');
  });

  it('pole przyslane DWA RAZY (tablica) odmawia, zamiast trafic do SQL-a', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300 });

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id),
      szerokosc_cm: ['70', '100'],
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(400);
    expect(wiersz(id).szerokosc_mm).toBe(300);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('CSRF i straznik sesji — para: bez zrodla odmawia, ze zrodlem przechodzi', () => {
  it('zadanie bez naglowka zrodla odmawia i nie zapisuje', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(
      serwer(),
      { zaznaczone: String(id), glebokosc_cm: '20' },
      {
        ...authBezZrodla,
        origin: 'http://obcy.example',
      },
    );

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(wiersz(id).glebokosc_mm).toBe(null);
  });

  it('zadanie z wlasnego zrodla przechodzi — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), glebokosc_cm: '20' });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id).glebokosc_mm).toBe(200);
  });

  it('bez uwierzytelnienia odmawia i nie zapisuje', async () => {
    const id = kartaO('Kandelabr');

    const r = await post(
      serwer(),
      '/magazyn/hurt/zatwierdz',
      {
        zaznaczone: String(id),
        glebokosc_cm: '20',
      },
      { origin: 'http://localhost' },
    );

    expect(r.statusCode).toBe(401);
    expect(wiersz(id).glebokosc_mm).toBe(null);
  });

  it('panel bez sklepow odmawia hurtu zamiast zapisywac', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(null), { zaznaczone: String(id), glebokosc_cm: '20' });
    expect(r.statusCode).toBe(503);
    expect(wiersz(id).glebokosc_mm).toBe(null);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('zastosujHurtem — JEDNA transakcja', () => {
  it('zapisuje komplet i oddaje liczbe zmienionych', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    const ile = zastosujHurtem(
      db,
      [
        { id: a, zmiany: { glebokosc_mm: 200 } },
        { id: b, zmiany: { glebokosc_mm: 200 } },
      ],
      { at: '2026-08-12T10:00:00.000Z' },
    );

    expect(ile).toBe(2);
    expect(wiersz(a).glebokosc_mm).toBe(200);
    expect(wiersz(b).zmieniony_at).toBe('2026-08-12T10:00:00.000Z');
  });

  // ⚠️⚠️ CZESCIOWO ZAPISANY ZESTAW JEST GORSZY NIZ ODMOWA. Bez transakcji pierwsza karta
  // zostalaby zmieniona, druga nie, a ekran nie mialby jak o tym powiedziec.
  it('blad na drugiej karcie COFA takze pierwsza', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    expect(() =>
      zastosujHurtem(db, [
        { id: a, zmiany: { kategoria_glowna: 'Lampy wiszące' } },
        // Wartosci, ktorej node:sqlite nie zwiaze — awaria w POLOWIE przebiegu.
        { id: b, zmiany: { kategoria_glowna: { obiekt: true } } },
      ]),
    ).toThrow();

    expect(wiersz(a).kategoria_glowna).toBe(null);
    expect(wiersz(b).kategoria_glowna).toBe(null);
  });

  // ⚠️⚠️ KOLUMNA, KTORA BAZA ZNA, ALE KTOREJ HURTEM RUSZAC NIE WOLNO. To jest jedyny ksztalt
  // tego testu, ktory cokolwiek chroni. Wersja z `{ cena: 10 }` i `toThrow(/cena/)` byla
  // FALSZYWA ZIELENIA: po usunieciu bialej listy SQLite sam rzuca „no such column: cena",
  // co ta sama asercja spelnia — czyli test przechodzil TAKZE bez straznika. `utworzony_at`
  // istnieje naprawde, wiec bez bialej listy zapis po prostu BY SIE UDAL i po cichu
  // przepisal date zalozenia setkom kart.
  it('kolumna spoza bialej listy odmawia, choc baza ja zna', () => {
    const a = kartaO('Kandelabr');
    const przed = wiersz(a).utworzony_at;

    expect(() => zastosujHurtem(db, [{ id: a, zmiany: { utworzony_at: '2000-01-01T00:00:00.000Z' } }])).toThrow(
      /nieznane pole/,
    );

    expect(wiersz(a).utworzony_at).toBe(przed);
  });

  it('pole, ktorego baza w ogole nie ma, odmawia NASZYM zdaniem, a nie bledem SQLite', () => {
    const a = kartaO('Kandelabr');
    expect(() => zastosujHurtem(db, [{ id: a, zmiany: { cena: 10 } }])).toThrow(/zastosujHurtem: nieznane pole/);
  });

  // ⚠️ Straznik stoi PRZED `BEGIN`: jeden zly krok wstrzymuje CALY plan, takze te kroki,
  // ktore same w sobie byly poprawne.
  it('jeden zly krok wstrzymuje caly plan — poprawne kroki tez nie wchodza', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    expect(() =>
      zastosujHurtem(db, [
        { id: a, zmiany: { kategoria_glowna: 'Lampy wiszące' } },
        { id: b, zmiany: { utworzony_at: '2000-01-01T00:00:00.000Z' } },
      ]),
    ).toThrow(/nieznane pole/);

    expect(wiersz(a).kategoria_glowna).toBe(null);
  });

  it('pusty plan nie rusza niczego i oddaje zero', () => {
    const a = kartaO('Kandelabr');
    const przed = wiersz(a).zmieniony_at;
    expect(zastosujHurtem(db, [])).toBe(0);
    expect(wiersz(a).zmieniony_at).toBe(przed);
  });

  it('kartyPoIdach oddaje wylacznie istniejace karty', () => {
    const a = kartaO('Kandelabr');
    expect(kartyPoIdach(db, [a, a + 999]).map((w) => w.id)).toEqual([a]);
  });

  it('kartyPoIdach na pustej liscie nie pyta bazy o wszystko', () => {
    kartaO('Kandelabr');
    expect(kartyPoIdach(db, [])).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('reguly czyste — domain/magazyn-hurt.js', () => {
  it('puste pola daja polecenie PUSTE, a nie polecenie kasujace', () => {
    const { polecenie, blad } = polecenieZFormularza({
      szerokosc_cm: '',
      wysokosc_cm: '',
      kategoria_glowna: '',
      glebokosc_cm: '',
      informacja_bezpieczenstwa: '',
      informacja_bezpieczenstwa_domyslna: '',
    });
    expect(blad).toBe(null);
    expect(Object.keys(polecenie)).toEqual([]);
  });

  it('wypelnione pole trafia do polecenia w MILIMETRACH', () => {
    const { polecenie } = polecenieZFormularza({ szerokosc_cm: '70' });
    expect(polecenie.szerokosc_mm).toBe(700);
  });

  it('napisu, ktorego nie rozumie, nie zgaduje — oddaje blad', () => {
    const { polecenie, blad } = polecenieZFormularza({ szerokosc_cm: '70x100' });
    expect(polecenie).toBe(null);
    expect(blad).toMatch(/70x100/);
  });

  it('zmianyHurtem pomija karty, ktore juz maja te wartosc', () => {
    const plan = zmianyHurtem(
      [
        { id: 1, nazwa: 'A', szerokosc_mm: 700 },
        { id: 2, nazwa: 'B', szerokosc_mm: 300 },
      ],
      { szerokosc_mm: 700 },
    );
    expect(plan.map((p) => p.id)).toEqual([2]);
  });

  it('zmianyHurtem opisuje zmiane Z CZEGO NA CO', () => {
    const [zmiana] = zmianyHurtem([{ id: 1, nazwa: 'A', szerokosc_mm: 300 }], { szerokosc_mm: 700 });
    expect(zmiana.opisy).toEqual([{ pole: 'Szerokość', z: '30 cm', na: '70 cm' }]);
  });

  it('zmianyHurtem opisuje BRAK jako brak, a nie jako pusty napis', () => {
    const [zmiana] = zmianyHurtem([{ id: 1, nazwa: 'A', szerokosc_mm: null }], { szerokosc_mm: 700 });
    expect(zmiana.opisy[0].z).toBe(null);
  });

  it('zmianyHurtem nie doklada do zmian ani jednego pola spoza polecenia', () => {
    const [zmiana] = zmianyHurtem(
      [{ id: 1, nazwa: 'A', szerokosc_mm: null, wysokosc_mm: 400, kategoria_glowna: 'X' }],
      { szerokosc_mm: 700 },
    );
    expect(Object.keys(zmiana.zmiany)).toEqual(['szerokosc_mm']);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('lista magazynu — zaznaczanie i pasek akcji', () => {
  it('kazdy wiersz ma pole wyboru z numerem karty', async () => {
    const id = kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');
    expect(wierszListy(r.body, 'Kandelabr')).toMatch(
      new RegExp(`<input type="checkbox" name="zaznaczone" value="${id}"[^>]*aria-label="Zaznacz kartę Kandelabr`),
    );
  });

  it('pasek akcji prowadzi na PODGLAD, nie na zapis', async () => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn');
    expect(r.body).toContain('action="/magazyn/hurt"');
    expect(r.body).not.toContain('action="/magazyn/hurt/zatwierdz"');
  });

  // ⚠️ Czlowiek ma wiedziec, ze dotyka 645 kart, a nie 20 widocznych — liczba liczona
  // TYM SAMYM zapytaniem, co lista.
  it('opcja „wszystkie pasujace" pokazuje LICZBE pasujacych', async () => {
    for (let i = 0; i < 3; i += 1) kartaO(`Bez wymiaru ${i}`);
    kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await get(serwer(), '/magazyn?brak=wymiary');

    expect(ilePasujacych(r.body)).toBe('3');
  });

  // ⚠️⚠️ ZAWEZENIE JEDZIE JEDNYM POLEM, a nie siedmioma osobnymi. Gdy formularz hurtowy
  // ma pole o tej samej nazwie co filtr (np. `marka` do ustawienia i `marka` do
  // zawezenia), te same nazwy w jednym formularzu wracaja z Fastify jako TABLICA, czyli
  // zawezenie i ustawiana wartosc kasowalyby sie nawzajem. Jedno pole zbiorcze usuwa
  // zderzenie tych dwoch slownikow RAZ NA ZAWSZE, a nie do nastepnego dopisanego filtru.
  it('pasek akcji niesie zawezenie JEDNYM polem, nie osobnymi', async () => {
    kartaO('Kandelabr');
    const r = await get(serwer(), '/magazyn?brak=wymiary&fraza=Kan');
    const pasek = sekcja(r.body, 'hurt-pasek');
    const m = /name="zawezenie" value="([^"]*)"/.exec(pasek);
    if (!m) throw new Error('Pasek hurtu nie niesie zawezenia');
    expect(m[1]).toContain('brak=wymiary');
    expect(m[1]).toContain('fraza=Kan');
    // Ani jednego pola o nazwie filtru — to one zderzalyby sie z polami ustawiajacymi.
    expect(pasek).not.toContain('name="brak"');
    expect(pasek).not.toContain('name="fraza"');
  });

  // ⚠️ PARA DO POWYZSZEGO: zawezenie z filtru i USTAWIANA wartosc w jednym zadaniu
  // dzialaja razem — zmiana trafia tylko do kart z zawezenia.
  it('zawezenie po kategorii ogranicza zmiane do kart z zawezenia', async () => {
    const wZawezeniu = kartaO('Kandelabr', { kategoria_glowna: 'Aplikacje' });
    const pozaZawezeniem = kartaO('Chmurka', { kategoria_glowna: 'Kinkiety' });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'kategoria=Aplikacje',
      glebokosc_cm: '20',
    });

    expect(r.statusCode).toBe(200);
    expect(wiersz(wZawezeniu).glebokosc_mm).toBe(200);
    // Karta spoza zawezenia zostaje bez zmiany.
    expect(wiersz(pozaZawezeniem).glebokosc_mm).toBe(null);
  });

  it('widok hurtu nie ma ANI JEDNEGO koloru wpisanego wprost', () => {
    const tresc = readFileSync(new URL('../../src/oms/web/views/magazyn-hurt.ejs', import.meta.url), 'utf8');
    expect(tresc).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(tresc).not.toMatch(/rgba?\(/i);
  });

  // ⚠️ Zapis do sklepow to Zadanie 15 z wlasnym podgladem. W tej zmianie nie ma prawa
  // pojawic sie import klienta sklepu — asercja pilnuje DROGI, nie skutku.
  it('ani trasa, ani reguly hurtu nie znaja klienta sklepu i Allegro', () => {
    for (const plik of ['web/routes/magazyn.js', 'domain/magazyn-hurt.js']) {
      const zrodlo = readFileSync(new URL(`../../src/oms/${plik}`, import.meta.url), 'utf8');
      expect(zrodlo).not.toMatch(/from '.*\/(woo|allegro)\//);
    }
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// ⚠️⚠️ SKALA PRODUKCYJNA. To jest przypadek, DLA KTOREGO ten ekran powstal: 645 kart bez
// wymiaru, jedno klikniecie, 70×100 cm. Na dwoch kartach kazda z tych regul wyglada
// tak samo — dopiero tutaj widac, ze zapis idzie jednym przebiegiem i niczego po drodze
// nie gubi ani nie kasuje.
describe('skala produkcyjna — 645 kart bez wymiaru', () => {
  it('ustawia 70×100 cm 645 kartom, nie ruszajac ani jednego innego pola', async () => {
    const bezWymiaru = [];
    for (let i = 0; i < 645; i += 1) {
      bezWymiaru.push(
        kartaO(`Lampa ${i}`, {
          kategoria_glowna: 'Aplikacje',
          marka: 'Półcień',
          sku: `SKU-${i}`,
          opis: `opis ${i}`,
        }),
      );
    }
    // Kontrola: karta, ktora wymiar JUZ MA i ktorej zawezenie nie obejmuje.
    const zWymiarem = kartaO('Ma wymiar', { szerokosc_mm: 450, wysokosc_mm: 650 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('645');

    const zmienione = db
      .prepare('SELECT COUNT(*) c FROM karty_produktow WHERE szerokosc_mm = 700 AND wysokosc_mm = 1000')
      .get().c;
    expect(zmienione).toBe(645);

    // ⚠️ POZOSTALE POLA NIETKNIETE — to jest ta polowa rozstrzygniecia, ktora na jednej
    // karcie widac slabo, a ktora hurtem kosztuje caly katalog.
    const potluczone = db
      .prepare(
        "SELECT COUNT(*) c FROM karty_produktow WHERE kategoria_glowna IS NOT 'Aplikacje'" +
          " AND nazwa LIKE 'Lampa %'",
      )
      .get().c;
    expect(potluczone).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM karty_produktow WHERE marka = 'Półcień'").get().c).toBe(645);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE sku IS NULL').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE opis IS NULL').get().c).toBe(1);

    // Karta spoza zawezenia zachowuje SWOJ wymiar.
    expect(wiersz(zWymiarem).szerokosc_mm).toBe(450);
    expect(wiersz(zWymiarem).wysokosc_mm).toBe(650);
  });

  it('645 kart dostaje JEDEN wspolny znacznik czasu — po nim da sie cofnac pomylke masowa', async () => {
    for (let i = 0; i < 645; i += 1) kartaO(`Lampa ${i}`);

    await zatwierdz(serwer(), {
      zakres: 'pasujace',
      zawezenie: 'brak=wymiary',
      szerokosc_cm: '70',
      wysokosc_cm: '100',
    });

    const znaczniki = db
      .prepare('SELECT COUNT(DISTINCT zmieniony_at) c FROM karty_produktow WHERE szerokosc_mm = 700')
      .get().c;
    expect(znaczniki).toBe(1);
  });
});
