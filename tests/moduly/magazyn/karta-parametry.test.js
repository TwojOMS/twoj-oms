import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajParametr, wartosciKarty, ustawWartoscKarty } from '../../../src/oms/db/parametry-kart.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

// Sekcja „Parametry" karty produktu: wartości parametrów zdefiniowanych w Ustawieniach, edycja jak „Dane karty"
// (domyślnie do odczytu, formularz po „Zmień"), puste pole kasuje wartość, walidacja z domeny.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY } });
const get = (app, url, headers = auth) => app.inject({ method: 'GET', url, headers });
const post = (app, url, payload, headers = auth) => app.inject({ method: 'POST', url, headers, payload });

function sekcja(body, id) {
  const trafienie = new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(body);
  if (!trafienie) throw new Error(`Na karcie produktu nie ma sekcji „${id}"`);
  return trafienie[0];
}

let karta;
let moc;
let kolor;
let opisWzoru;

beforeEach(() => {
  db = openOmsDb(':memory:');
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LP-1' });
});

function zdefiniujParametry() {
  moc = dodajParametr(db, { nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W' }).id;
  kolor = dodajParametr(db, { nazwa: 'Kolor', typ: 'lista', wartosci: ['czarny', 'biały'], wymagany: true }).id;
  opisWzoru = dodajParametr(db, { nazwa: 'Wzór', typ: 'tekst' }).id;
}

const wartosci = () => Object.fromEntries(wartosciKarty(db, karta));

async function kontoBez(app, login, rola) {
  zalozKonto(db, { login, imie: 'Ola', haslo: 'x', rola, admin: false });
  const r = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin: auth.origin },
    payload: { uzytkownik: login, haslo: 'x' },
  });
  expect(r.statusCode).toBe(302);
  const cookie = []
    .concat(r.headers['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return { origin: auth.origin, cookie };
}

describe('karta — sekcja Parametry: odczyt', () => {
  it('bez parametrów własnych sekcja jest (stałe pola), admin widzi zachętę z odnośnikiem do Ustawień', async () => {
    const app = serwer();
    const r = await get(app, `/magazyn/${karta}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="parametry-karty"');
    expect(r.body).toContain('href="/magazyn/ustawienia/parametry"');
    expect(r.body).toContain('Dodaj parametry kart w Ustawieniach');
  });

  it('konto bez prawa do Ustawień nie widzi odnośnika', async () => {
    const app = serwer();
    const naglowki = await kontoBez(app, 'sprzedawca', 'sprzedaz');
    const r = await get(app, `/magazyn/${karta}`, naglowki);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Dodaj parametry kart w Ustawieniach');
  });

  it('pokazuje „Nazwa: wartość jednostka", brak wartości to „—", wymagany bez wartości ma plakietkę', async () => {
    zdefiniujParametry();
    ustawWartoscKarty(db, karta, moc, '12,5');
    const app = serwer();
    const s = sekcja((await get(app, `/magazyn/${karta}`)).body, 'parametry-karty');
    expect(s).toContain('<h2');
    expect(s).toContain('Parametry kart w ustawieniach magazynu');
    expect(s).toMatch(/Moc żarówki[\s\S]*?12,5 W/);
    expect(s).toMatch(/Wzór[\s\S]*?—/);
    // Plakietka tylko przy wymaganym bez wartości.
    expect(s).toMatch(/Kolor[\s\S]*?brak wartości/);
    expect(s.match(/brak wartości/g)).toHaveLength(1);
    expect(s).not.toContain('<form');
    expect(s).toContain(`/magazyn/${karta}?edytuj=parametry`);
  });

  it('wymagany z wartością nie ma plakietki', async () => {
    zdefiniujParametry();
    ustawWartoscKarty(db, karta, kolor, 'czarny');
    const app = serwer();
    const s = sekcja((await get(app, `/magazyn/${karta}`)).body, 'parametry-karty');
    expect(s).toMatch(/Kolor[\s\S]*?czarny/);
    expect(s).not.toContain('brak wartości');
  });

  it('„Zmień" otwiera formularz z polami każdego typu', async () => {
    zdefiniujParametry();
    ustawWartoscKarty(db, karta, moc, '12.5');
    const app = serwer();
    const s = sekcja((await get(app, `/magazyn/${karta}?edytuj=parametry`)).body, 'parametry-karty');
    expect(s).toContain(`action="/magazyn/${karta}/parametry"`);
    expect(s).toMatch(new RegExp(`<input[^>]*name="parametr_${moc}"[^>]*value="12,5"`));
    expect(s).toMatch(new RegExp(`<input[^>]*name="parametr_${opisWzoru}"`));
    expect(s).toMatch(new RegExp(`<select[^>]*name="parametr_${kolor}"`));
    expect(s).toContain('— brak —');
    expect(s).toMatch(/<button[^>]*class="btn[^"]*"[^>]*type="submit"|<button[^>]*type="submit"[^>]*class="btn/);
  });
});

describe('karta — sekcja Parametry: zapis', () => {
  it('zapisuje wartości wszystkich typów i wraca na kartę (303)', async () => {
    zdefiniujParametry();
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}/parametry`, {
      [`parametr_${moc}`]: '12,5',
      [`parametr_${kolor}`]: 'Biały',
      [`parametr_${opisWzoru}`]: '  kratka  ',
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toContain(`/magazyn/${karta}`);
    expect(wartosci()).toEqual({ [moc]: '12.5', [kolor]: 'biały', [opisWzoru]: 'kratka' });
  });

  it('puste pole kasuje wartość — każdy typ', async () => {
    zdefiniujParametry();
    ustawWartoscKarty(db, karta, moc, '7');
    ustawWartoscKarty(db, karta, kolor, 'czarny');
    ustawWartoscKarty(db, karta, opisWzoru, 'paski');
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}/parametry`, {
      [`parametr_${moc}`]: '',
      [`parametr_${kolor}`]: '',
      [`parametr_${opisWzoru}`]: ' ',
    });
    expect(r.statusCode).toBe(303);
    expect(wartosci()).toEqual({});
  });

  it('wartość spoza listy → 400, komunikat w sekcji, nic nie zapisane (także inne pola)', async () => {
    zdefiniujParametry();
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}/parametry`, {
      [`parametr_${moc}`]: '40',
      [`parametr_${kolor}`]: 'zielony',
    });
    expect(r.statusCode).toBe(400);
    const s = sekcja(r.body, 'parametry-karty');
    expect(s).toContain('Kolor');
    expect(s).toContain('<form');
    // Formularz zachowuje to, co wpisano.
    expect(s).toMatch(new RegExp(`name="parametr_${moc}"[^>]*value="40"`));
    expect(wartosci()).toEqual({});
  });

  it('niepoprawna liczba → 400 bez zapisu', async () => {
    zdefiniujParametry();
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}/parametry`, { [`parametr_${moc}`]: 'dużo' });
    expect(r.statusCode).toBe(400);
    expect(sekcja(r.body, 'parametry-karty')).toContain('Moc żarówki');
    expect(wartosci()).toEqual({});
  });

  it('pole parametru, którego formularz nie przysłał, zostaje bez zmian', async () => {
    zdefiniujParametry();
    ustawWartoscKarty(db, karta, opisWzoru, 'paski');
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}/parametry`, { [`parametr_${moc}`]: '5' });
    expect(r.statusCode).toBe(303);
    expect(wartosci()).toEqual({ [moc]: '5', [opisWzoru]: 'paski' });
  });

  it('nieznana karta → 404', async () => {
    zdefiniujParametry();
    const app = serwer();
    const r = await post(app, `/magazyn/99999/parametry`, { [`parametr_${moc}`]: '5' });
    expect(r.statusCode).toBe(404);
  });

  it('konto bez prawa do Magazynu nie zapisze (403)', async () => {
    zdefiniujParametry();
    const app = serwer();
    const naglowki = await kontoBez(app, 'pakowacz', 'produkcja');
    const r = await post(app, `/magazyn/${karta}/parametry`, { [`parametr_${moc}`]: '5' }, naglowki);
    expect(r.statusCode).toBe(403);
    expect(wartosci()).toEqual({});
  });
});

describe('karta — paczkomat zniknął z „Dane karty"', () => {
  it('ani w odczycie, ani w formularzu', async () => {
    const app = serwer();
    const odczyt = sekcja((await get(app, `/magazyn/${karta}`)).body, 'dane-karty');
    const edycja = sekcja((await get(app, `/magazyn/${karta}?edytuj=dane`)).body, 'dane-karty');
    for (const s of [odczyt, edycja]) {
      expect(s.toLowerCase()).not.toContain('paczkomat');
    }
  });

  it('zapis karty nie pisze już kolumny paczkomat', async () => {
    db.prepare("UPDATE karty_produktow SET paczkomat = 'tak' WHERE id = ?").run(karta);
    const app = serwer();
    const r = await post(app, `/magazyn/${karta}`, { nazwa: 'Lampa Półcień', sku: 'LP-1', paczkomat: 'nie' });
    expect(r.statusCode).toBe(303);
    expect(db.prepare('SELECT paczkomat FROM karty_produktow WHERE id = ?').get(karta).paczkomat).toBe('tak');
  });
});

describe('karta — okno Parametry z wymiarami i wagą', () => {
  const kartaZWymiarami = () =>
    utworzKarte(db, {
      nazwa: 'Lampa Wymiarowa',
      sku: 'LW-1',
      szerokosc_mm: 700,
      wysokosc_mm: 500,
      glebokosc_mm: 20,
      waga_g: 1250,
    });
  const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

  it('bez parametrów własnych okno pokazuje wymiary i wagę, a „Dane karty” już nie', async () => {
    const id = kartaZWymiarami();
    const app = serwer();
    const body = (await get(app, `/magazyn/${id}`)).body;
    const okno = sekcja(body, 'parametry-karty');
    expect(okno).toMatch(/<dt>Wymiary<\/dt>\s*<dd>70 × 50 × 2 cm<\/dd>/);
    expect(okno).toMatch(/<dt>Waga<\/dt>\s*<dd>1,25 kg<\/dd>/);
    const dane = sekcja(body, 'dane-karty');
    expect(dane).not.toContain('<dt>Wymiary</dt>');
    expect(dane).not.toContain('<dt>Waga</dt>');
  });

  it('karta bez wymiarów i wagi: „bez wymiarów” i „—”', async () => {
    const app = serwer();
    const okno = sekcja((await get(app, `/magazyn/${karta}`)).body, 'parametry-karty');
    expect(okno).toMatch(/<dt>Wymiary<\/dt>\s*<dd><span[^>]*>bez wymiarów<\/span><\/dd>/);
    expect(okno).toMatch(/<dt>Waga<\/dt>\s*<dd><span[^>]*>—<\/span><\/dd>/);
  });

  it('okno stoi wewnątrz układu „Dane karty”, za sekcją danych', async () => {
    const body = (await get(serwer(), `/magazyn/${karta}`)).body;
    const uklad = /<div class="karta-dane-uklad">([\s\S]*?)\n<\/div>\n/.exec(body)?.[1] ?? '';
    expect(uklad).toContain('id="parametry-karty"');
    expect(uklad.indexOf('id="dane-karty"')).toBeLessThan(uklad.indexOf('id="parametry-karty"'));
  });

  it('formularz „Zmień” zaczyna się od czterech pól wymiarów i wagi z wartościami', async () => {
    const id = kartaZWymiarami();
    const s = sekcja((await get(serwer(), `/magazyn/${id}?edytuj=parametry`)).body, 'parametry-karty');
    const pole = (n) => new RegExp(`<input[^>]*name="${n}"[^>]*>`).exec(s)?.[0] ?? '';
    expect(pole('szerokosc_cm')).toContain('value="70"');
    expect(pole('wysokosc_cm')).toContain('value="50"');
    expect(pole('glebokosc_cm')).toContain('value="2"');
    expect(pole('waga_kg')).toContain('value="1.25"');
    expect(pole('szerokosc_cm')).toContain('inputmode="decimal"');
  });

  it('formularz „Dane karty” nie ma już pól wymiarów i wagi', async () => {
    const id = kartaZWymiarami();
    const s = sekcja((await get(serwer(), `/magazyn/${id}?edytuj=dane`)).body, 'dane-karty');
    for (const n of ['szerokosc_cm', 'wysokosc_cm', 'glebokosc_cm', 'waga_kg']) expect(s).not.toContain(`name="${n}"`);
  });

  it('zapis „Dane karty” bez pól wymiarów nie rusza wymiarów ani wagi', async () => {
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}`, { nazwa: 'Lampa Wymiarowa', sku: 'LW-2', opis: 'Nowy opis' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({
      szerokosc_mm: 700,
      wysokosc_mm: 500,
      glebokosc_mm: 20,
      waga_g: 1250,
      sku: 'LW-2',
    });
  });

  it('zapis okna Parametry: wymiar i parametr własny razem', async () => {
    zdefiniujParametry();
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}/parametry`, { szerokosc_cm: '80', [`parametr_${moc}`]: '9' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 800, wysokosc_mm: 500, waga_g: 1250 });
    expect(Object.fromEntries(wartosciKarty(db, id))).toEqual({ [moc]: '9' });
  });

  it('zły wymiar → 400, formularz z wpisanym tekstem, parametr własny i wymiary bez zapisu', async () => {
    zdefiniujParametry();
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}/parametry`, { szerokosc_cm: 'abc', [`parametr_${moc}`]: '9' });
    expect(r.statusCode).toBe(400);
    const s = sekcja(r.body, 'parametry-karty');
    expect(s).toContain('abc');
    expect(s).toMatch(/<input[^>]*name="szerokosc_cm"[^>]*value="abc"/);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 700 });
    expect(Object.fromEntries(wartosciKarty(db, id))).toEqual({});
  });

  it('zły parametr własny → 400, wymiar z tego samego zapisu też nie wchodzi', async () => {
    zdefiniujParametry();
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}/parametry`, { szerokosc_cm: '80', [`parametr_${moc}`]: 'dużo' });
    expect(r.statusCode).toBe(400);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 700 });
  });

  it('błąd w trakcie zapisu parametrów cofa też wymiary (jedna transakcja)', async () => {
    zdefiniujParametry();
    const id = kartaZWymiarami();
    // Wartość przeszła walidację, a zapis i tak się wywala (np. wyścig z Ustawieniami) — wymiary mają wrócić.
    db.exec(`CREATE TRIGGER zepsuj BEFORE INSERT ON karty_parametry BEGIN SELECT RAISE(ABORT, 'zepsute'); END`);
    const app = serwer();
    const r = await post(app, `/magazyn/${id}/parametry`, { szerokosc_cm: '80', [`parametr_${moc}`]: '9' });
    expect(r.statusCode).toBe(500);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 700 });
  });

  it('pusta waga kasuje wagę, nieprzysłane pola wymiarów zostają', async () => {
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}/parametry`, { waga_kg: '' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ waga_g: null, szerokosc_mm: 700, glebokosc_mm: 20 });
  });

  it('z ciała zapisu parametrów liczą się tylko cztery pola stałe — nazwa i SKU nie zmieniają karty', async () => {
    const id = kartaZWymiarami();
    const r = await post(serwer(), `/magazyn/${id}/parametry`, {
      szerokosc_cm: '75',
      nazwa: 'Podmieniona nazwa',
      sku: 'PODMIENIONE',
      cena_zl: '1',
    });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ nazwa: 'Lampa Wymiarowa', sku: 'LW-1', szerokosc_mm: 750 });
  });
});

describe('karta — odnośniki edycji prowadzą do swojej sekcji', () => {
  it('„Zmień” parametry kończy się kotwicą sekcji parametrów', async () => {
    zdefiniujParametry();
    const body = (await get(serwer(), `/magazyn/${karta}`)).body;
    const s = sekcja(body, 'parametry-karty');
    expect(s).toMatch(/<a class="link-edytuj" href="[^"]*edytuj=parametry[^"]*#parametry-karty">Zmień<\/a>/);
    expect(body).toContain('id="parametry-karty"');
  });

  it('„Edytuj” dane karty kończy się kotwicą sekcji danych', async () => {
    const body = (await get(serwer(), `/magazyn/${karta}`)).body;
    const s = sekcja(body, 'dane-karty');
    expect(s).toMatch(/<a class="link-edytuj" href="[^"]*edytuj=dane[^"]*#dane-karty">Edytuj<\/a>/);
    expect(body).toContain('id="dane-karty"');
  });
});
