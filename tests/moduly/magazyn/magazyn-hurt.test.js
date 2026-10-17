import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from './pliki-historyczne.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte, zastosujHurtem, kartyPoIdach } from '../../../src/oms/db/magazyn.js';
import { polecenieZFormularza, zmianyHurtem } from '../../../src/domena/magazyn-hurt.js';

// EDYCJA HURTEM W MAGAZYNIE — ekran, ktory istnieje dla 645 kart bez wymiaru, 965 bez
// oznaczenia paczkomatu i 152 bez kategorii glownej (zmierzone na produkcji 2026-08-12).
// Bez niego trzeba by otworzyc 645 kart po kolei.
//
// ⚠️⚠️ SIEDEM RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) PUSTE POLE ZNACZY „NIE RUSZAJ" — i to jest ODWROTNIE niz na karcie produktu, gdzie
//       puste pole KASUJE wartosc. Gdyby hurtem puste kasowalo, ustawienie samego
//       paczkomatu wyczysciloby wymiary i kategorie 600 kartom jednym kliknieciem;
//   (2) PODGLAD JEST OBOWIAZKOWY — trasa podgladu nie zapisuje ANI JEDNEGO wiersza;
//   (3) zestaw zmian liczony PONOWNIE przy zatwierdzeniu, nie przepisany z ukrytego pola;
//   (4) puste zaznaczenie nie robi NICZEGO — „dotyczy wszystkiego" byloby najkrotsza droga
//       do nadpisania calego rejestru jednym kliknieciem;
//   (5) napis, ktorego nie rozumiemy, ODMAWIA CALEGO zapisu — nigdy cichego pominiecia;
//   (6) zapis hurtem idzie w JEDNEJ transakcji;
//   (7) paczkomat wylacznie recznie, trzy stany, zero wyliczania z wymiarow.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
// ⚠️ TE SAME poswiadczenia, ale BEZ `origin` — ochrona CSRF (src/security/csrf.js) stoi na
// naglowku zrodla, a nie na tokenie w formularzu.
const authBezZrodla = { authorization: auth.authorization };

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
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload, naglowki = auth) => app.inject({
  method: 'POST', url, headers: naglowki, payload,
});

const podglad = (app, payload, naglowki) => post(app, '/magazyn/hurt', payload, naglowki);
const zatwierdz = (app, payload, naglowki) => post(app, '/magazyn/hurt/zatwierdz', payload, naglowki);

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
  const w = sekcja(body, 'zmiany-hurtem').split('<tr').find((t) => t.includes(znacznik));
  if (!w) throw new Error(`W podgladzie nie ma karty „${nazwa}"`);
  return w;
}

const nazwyWPodgladzie = (body) => [...sekcja(body, 'zmiany-hurtem')
  .matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);

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

/** Liczba kart pasujacych do zawezenia, podana w pasku akcji nad tabela. */
function ilePasujacych(body) {
  const m = /<strong class="hurt-pasujace">([^<]*)<\/strong>/.exec(sekcja(body, 'hurt-pasek'));
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
// kilka pol naraz: gdyby puste kasowalo, ustawienie samego paczkomatu wyczyscilo by wymiary
// i kategorie 600 kartom jednym kliknieciem, bez sladu i bez mozliwosci cofniecia.
describe('puste pole ZNACZY „nie ruszaj" — para: wypelnione zmienia, puste zostawia', () => {
  it('pole WYPELNIONE zmienia wartosc', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await zatwierdz(serwer(), {
      zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(wiersz(id).szerokosc_mm).toBe(700);
    expect(wiersz(id).wysokosc_mm).toBe(1000);
  });

  // ⚠️ SPRAWDZONE NA KARCIE, KTORA TE WARTOSCI MA. Karta z pustymi kolumnami przeszlaby
  // ten test takze wtedy, gdyby puste pole KASOWALO — bo kasowanie pustego nie widac.
  it('pole PUSTE zostawia STARA wartosc nietknieta', async () => {
    const id = kartaO('Kandelabr', {
      szerokosc_mm: 300, wysokosc_mm: 400, kategoria_glowna: 'Aplikacje', paczkomat: 'tak',
    });

    // Ustawiamy WYLACZNIE paczkomat; wymiary i kategoria jada puste.
    await zatwierdz(serwer(), {
      zaznaczone: String(id), szerokosc_cm: '', wysokosc_cm: '', kategoria_glowna: '',
      paczkomat: 'nie',
    });

    const w = wiersz(id);
    expect(w.paczkomat).toBe('nie');
    // To sa trzy wartosci, ktore jedno klikniecie skasowaloby 600 kartom.
    expect(w.szerokosc_mm).toBe(300);
    expect(w.wysokosc_mm).toBe(400);
    expect(w.kategoria_glowna).toBe('Aplikacje');
  });

  it('pole NIEPRZYSLANE zostawia stara wartosc — brak pola to nie pole puste', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400, kategoria_glowna: 'Aplikacje' });

    await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nie' });

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
      zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100',
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
      zaznaczone: [String(a), String(b)], szerokosc_cm: '70', wysokosc_cm: '100',
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
    const r = await podglad(serwer(), { zaznaczone: String(id), paczkomat: 'nie' });
    expect(r.body).toContain('action="/magazyn/hurt/zatwierdz"');
  });

  // ⚠️ KARTA, KTORA JUZ MA TE WARTOSC, NIE JEST ZMIANA. Podglad obiecujacy „zmienie 645"
  // i zmieniajacy 200 klamie o wlasnym skutku.
  it('karta, ktora juz ma te wartosc, nie wchodzi do podgladu ani do liczby', async () => {
    const stary = kartaO('Kandelabr', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    const nowy = kartaO('Chmurka');

    const r = await podglad(serwer(), {
      zaznaczone: [String(stary), String(nowy)], szerokosc_cm: '70', wysokosc_cm: '100',
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
// i WARTOSCI (decyzja czlowieka), nigdy gotowego „z czego na co".
describe('zestaw zmian liczony PONOWNIE przy zatwierdzeniu', () => {
  it('karta zmieniony miedzy podgladem a zatwierdzeniem liczy sie ze stanu BIEZACEGO', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    await podglad(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100' });
    // Ktos w drugiej karcie ustawil dokladnie to, co mial ustawic hurt.
    db.prepare('UPDATE karty_produktow SET szerokosc_mm = 700, wysokosc_mm = 1000 WHERE id = ?').run(id);
    const przed = wiersz(id).zmieniony_at;

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100',
    });

    // Nie ma czego zmieniac — i ekran ma to powiedziec, a nie zameldowac „zmieniono 1".
    expect(ileNaEkranie(r.body)).toBe('0');
    expect(wiersz(id).zmieniony_at).toBe(przed);
  });

  it('karta skasowany miedzy podgladem a zatwierdzeniem po prostu wypada', async () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    await podglad(serwer(), { zaznaczone: [String(a), String(b)], paczkomat: 'nie' });
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(b);

    const r = await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)], paczkomat: 'nie' });

    expect(r.statusCode).toBe(200);
    expect(wiersz(a).paczkomat).toBe('nie');
  });

  // ⚠️ Gdyby trasa zatwierdzajaca ufala ukrytemu polu z gotowym zestawem, ten test bylby
  // jedynym miejscem, w ktorym by to widac.
  it('trasa zatwierdzajaca nie przyjmuje gotowego zestawu z ukrytego pola', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300, wysokosc_mm: 400 });

    // Podrzucamy „gotowy zestaw" obok prawdziwych pol. Ma zostac zignorowany.
    await zatwierdz(serwer(), {
      zaznaczone: String(id),
      paczkomat: 'nie',
      zmiany: JSON.stringify([{ id, zmiany: { szerokosc_mm: 9999 } }]),
      plan: JSON.stringify([{ id, zmiany: { kategoria_glowna: 'Podrzucona' } }]),
    });

    const w = wiersz(id);
    expect(w.paczkomat).toBe('nie');
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

    const r = await zatwierdz(serwer(), { zaznaczone: [], paczkomat: 'nie' });

    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE paczkomat IS NOT NULL').get().c).toBe(0);
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  it('brak pola `zaznaczone` w ogole nie robi NICZEGO', async () => {
    kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), { paczkomat: 'nie' });

    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE paczkomat IS NOT NULL').get().c).toBe(0);
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  it('niepuste zaznaczenie dziala — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nie' });

    expect(wiersz(id).paczkomat).toBe('nie');
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

    await zatwierdz(serwer(), { zaznaczone: ['abc', '__proto__', String(id)], paczkomat: 'nie' });

    expect(wiersz(id).paczkomat).toBe('nie');
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE paczkomat IS NOT NULL').get().c).toBe(1);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('„zaznacz wszystkie pasujace do zawezenia" — liczba z TEGO SAMEGO zapytania, co lista', () => {
  it('obejmuje wszystkie pasujace do filtru, nie tylko widoczne', async () => {
    const bez = [];
    for (let i = 0; i < 5; i += 1) bez.push(kartaO(`Bez wymiaru ${i}`));
    kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
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
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(wiersz(zWymiarem).szerokosc_mm).toBe(300);
  });

  it('podglad zakresu „pasujace" pokazuje LICZBE kart, ktorych dotyka', async () => {
    for (let i = 0; i < 7; i += 1) kartaO(`Bez wymiaru ${i}`);

    const r = await podglad(serwer(), {
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(ileNaEkranie(r.body)).toBe('7');
  });

  it('zakres „pasujace" bez ani jednego trafienia nie zapisuje niczego', async () => {
    const id = kartaO('Z wymiarem', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
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
      zaznaczone: String(id), szerokosc_cm: '70 cm', wysokosc_cm: '100', paczkomat: 'nie',
    });

    expect(r.statusCode).toBe(400);
    const w = wiersz(id);
    expect(w.szerokosc_mm).toBe(300);
    expect(w.wysokosc_mm).toBe(400);
    // ⚠️ ODMOWA JEST CALOSCIOWA — paczkomat z tego samego zadania tez nie wchodzi.
    expect(w.paczkomat).toBe(null);
  });

  it('odmowa mowi, CZEGO nie zrozumiala', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70 cm' });
    expect(r.body).toContain('70 cm');
  });

  it('sama liczba przechodzi — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id), szerokosc_cm: '10,5', wysokosc_cm: '100',
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
      zaznaczone: String(id), szerokosc_cm: '', wysokosc_cm: '', kategoria_glowna: '', paczkomat: '',
    });

    expect(r.statusCode).toBe(400);
    expect(wiersz(id).szerokosc_mm).toBe(300);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('paczkomat hurtem — trzy stany, wylacznie recznie', () => {
  it('zapisuje decyzje czlowieka', async () => {
    const id = kartaO('Kandelabr');
    await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'tak' });
    expect(wiersz(id).paczkomat).toBe('tak');
  });

  // ⚠️ „nieoznaczone" to OSOBNY, JAWNY wybor kasujacy decyzje — nie skutek pustego pola.
  // To jedyna droga powrotu po hurtowej pomylce na 600 kartach.
  it('wartosc „nieoznaczone" CZYSCI decyzje jawnym wyborem', async () => {
    const id = kartaO('Kandelabr', { paczkomat: 'tak' });
    await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nieoznaczone' });
    expect(wiersz(id).paczkomat).toBe(null);
  });

  it('puste pole paczkomatu NIE czysci decyzji', async () => {
    const id = kartaO('Kandelabr', { paczkomat: 'tak' });
    await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: '', kategoria_glowna: 'X' });
    expect(wiersz(id).paczkomat).toBe('tak');
  });

  it('wartosc spoza trzech stanow odmawia, zamiast wpisac czwarty stan', async () => {
    const id = kartaO('Kandelabr', { paczkomat: 'tak' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'moze' });
    expect(r.statusCode).toBe(400);
    expect(wiersz(id).paczkomat).toBe('tak');
  });

  // ⚠️ ZERO WYLICZANIA Z WYMIAROW (decyzja wlasciciela). Ustawienie wymiarow hurtem nie ma
  // prawa dotknac kolumny paczkomatu ani razu.
  it('ustawienie wymiarow nie dotyka paczkomatu', async () => {
    const id = kartaO('Kandelabr', { paczkomat: 'tak' });
    await zatwierdz(serwer(), { zaznaczone: String(id), szerokosc_cm: '70', wysokosc_cm: '100' });
    expect(wiersz(id).paczkomat).toBe('tak');
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('skracanie nazwy o rozmiar — hurtem, wylacznie w rejestrze', () => {
  it('skraca nazwe, gdy poproszono', async () => {
    const id = kartaO('Klosz dymny – 60x62cm');
    await zatwierdz(serwer(), { zaznaczone: String(id), nazwa_bez_rozmiaru: 'tak' });
    expect(wiersz(id).nazwa).toBe('Klosz dymny');
  });

  it('bez zaznaczenia tego pola nazwy NIE rusza', async () => {
    const id = kartaO('Klosz dymny – 60x62cm');
    await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nie' });
    expect(wiersz(id).nazwa).toBe('Klosz dymny – 60x62cm');
  });

  // ⚠️ Nazwa zlozona z samego rozmiaru nie moze zniknac — regula stoi w domain/rozmiar.js
  // i hurt nie ma prawa jej obchodzic.
  it('nazwy zlozonej z samego rozmiaru nie kasuje', async () => {
    const id = kartaO('70x100cm');
    await zatwierdz(serwer(), { zaznaczone: String(id), nazwa_bez_rozmiaru: 'tak' });
    expect(wiersz(id).nazwa).toBe('70x100cm');
  });

  it('nazwa bez rozmiaru nie wchodzi do podgladu jako zmiana', async () => {
    const bezRozmiaru = kartaO('Szpulka (Buk)');
    kartaO('Klosz dymny – 60x62cm');

    const r = await podglad(serwer(), {
      zakres: 'pasujace', nazwa_bez_rozmiaru: 'tak',
    });

    expect(nazwyWPodgladzie(r.body)).toEqual(['Klosz dymny – 60x62cm']);
    expect(wiersz(bezRozmiaru).nazwa).toBe('Szpulka (Buk)');
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
      sku: 'PODRZUCONE', opis: 'podrzucony', waga_g: '5', nazwa: 'Podrzucona',
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
      zaznaczone: String(id), constructor: 'x', hasOwnProperty: 'y', toString: 'z',
    });

    // Nic do zmiany — a nie pieciusetka i nie zapis czegokolwiek.
    expect(r.statusCode).toBe(400);
    expect(wiersz(id).nazwa).toBe('Kandelabr');
  });

  it('pole przyslane DWA RAZY (tablica) odmawia, zamiast trafic do SQL-a', async () => {
    const id = kartaO('Kandelabr', { szerokosc_mm: 300 });

    const r = await zatwierdz(serwer(), {
      zaznaczone: String(id), szerokosc_cm: ['70', '100'], wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(400);
    expect(wiersz(id).szerokosc_mm).toBe(300);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('CSRF i straznik sesji — para: bez zrodla odmawia, ze zrodlem przechodzi', () => {
  it('zadanie bez naglowka zrodla odmawia i nie zapisuje', async () => {
    const id = kartaO('Kandelabr');

    const r = await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nie' }, {
      ...authBezZrodla, origin: 'http://obcy.example',
    });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(wiersz(id).paczkomat).toBe(null);
  });

  it('zadanie z wlasnego zrodla przechodzi — straznik MILCZY', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(), { zaznaczone: String(id), paczkomat: 'nie' });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id).paczkomat).toBe('nie');
  });

  it('bez uwierzytelnienia odmawia i nie zapisuje', async () => {
    const id = kartaO('Kandelabr');

    const r = await post(serwer(), '/magazyn/hurt/zatwierdz', {
      zaznaczone: String(id), paczkomat: 'nie',
    }, { origin: 'http://localhost' });

    expect(r.statusCode).toBe(401);
    expect(wiersz(id).paczkomat).toBe(null);
  });

  it('panel bez sklepow odmawia hurtu zamiast zapisywac', async () => {
    const id = kartaO('Kandelabr');
    const r = await zatwierdz(serwer(null), { zaznaczone: String(id), paczkomat: 'nie' });
    expect(r.statusCode).toBe(503);
    expect(wiersz(id).paczkomat).toBe(null);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
describe('zastosujHurtem — JEDNA transakcja', () => {
  it('zapisuje komplet i oddaje liczbe zmienionych', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    const ile = zastosujHurtem(db, [
      { id: a, zmiany: { paczkomat: 'nie' } },
      { id: b, zmiany: { paczkomat: 'nie' } },
    ], { at: '2026-08-12T10:00:00.000Z' });

    expect(ile).toBe(2);
    expect(wiersz(a).paczkomat).toBe('nie');
    expect(wiersz(b).zmieniony_at).toBe('2026-08-12T10:00:00.000Z');
  });

  // ⚠️⚠️ CZESCIOWO ZAPISANY ZESTAW JEST GORSZY NIZ ODMOWA. Bez transakcji pierwsza karta
  // zostalaby zmieniona, druga nie, a ekran nie mialby jak o tym powiedziec.
  it('blad na drugiej karcie COFA takze pierwsza', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    expect(() => zastosujHurtem(db, [
      { id: a, zmiany: { kategoria_glowna: 'Lampy wiszące' } },
      // Wartosci, ktorej node:sqlite nie zwiaze — awaria w POLOWIE przebiegu.
      { id: b, zmiany: { kategoria_glowna: { obiekt: true } } },
    ])).toThrow();

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

    expect(() => zastosujHurtem(db, [{ id: a, zmiany: { utworzony_at: '2000-01-01T00:00:00.000Z' } }]))
      .toThrow(/nieznane pole/);

    expect(wiersz(a).utworzony_at).toBe(przed);
  });

  it('pole, ktorego baza w ogole nie ma, odmawia NASZYM zdaniem, a nie bledem SQLite', () => {
    const a = kartaO('Kandelabr');
    expect(() => zastosujHurtem(db, [{ id: a, zmiany: { cena: 10 } }]))
      .toThrow(/zastosujHurtem: nieznane pole/);
  });

  // ⚠️ Straznik stoi PRZED `BEGIN`: jeden zly krok wstrzymuje CALY plan, takze te kroki,
  // ktore same w sobie byly poprawne.
  it('jeden zly krok wstrzymuje caly plan — poprawne kroki tez nie wchodza', () => {
    const a = kartaO('Kandelabr');
    const b = kartaO('Chmurka');

    expect(() => zastosujHurtem(db, [
      { id: a, zmiany: { kategoria_glowna: 'Lampy wiszące' } },
      { id: b, zmiany: { utworzony_at: '2000-01-01T00:00:00.000Z' } },
    ])).toThrow(/nieznane pole/);

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
      szerokosc_cm: '', wysokosc_cm: '', kategoria_glowna: '', paczkomat: '',
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
      [{ id: 1, nazwa: 'A', szerokosc_mm: 700 }, { id: 2, nazwa: 'B', szerokosc_mm: 300 }],
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
    expect(wierszListy(r.body, 'Kandelabr'))
      .toContain(`<input type="checkbox" name="zaznaczone" value="${id}">`);
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

  // ⚠️⚠️ ZAWEZENIE JEDZIE JEDNYM POLEM, a nie siedmioma osobnymi. Formularz hurtowy ma
  // WLASNE pole `paczkomat` (wartosc do ustawienia), a filtr ma pole `paczkomat` (czym
  // zawezic) — te same nazwy w jednym formularzu wracaja z Fastify jako TABLICA, czyli
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

  // ⚠️ PARA DO POWYZSZEGO: filtr paczkomatu i USTAWIANA wartosc paczkomatu w jednym
  // zadaniu musza sie NIE ZDERZAC. Bez tego „zawez do nieoznaczonych i ustaw «nie»"
  // — czyli droga typowa wlasciciela — nie dzialaloby wcale.
  it('zawezenie po paczkomacie nie zderza sie z ustawiana wartoscia paczkomatu', async () => {
    const nieoznaczony = kartaO('Kandelabr');
    const oznaczony = kartaO('Chmurka', { paczkomat: 'tak' });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace', zawezenie: 'paczkomat=nieoznaczone', paczkomat: 'nie',
    });

    expect(r.statusCode).toBe(200);
    expect(wiersz(nieoznaczony).paczkomat).toBe('nie');
    // Karta spoza zawezenia zostaje ze swoim oznaczeniem.
    expect(wiersz(oznaczony).paczkomat).toBe('tak');
  });

  it('widok hurtu nie ma ANI JEDNEGO koloru wpisanego wprost', () => {
    const tresc = readFileSync(
      new URL('../../src/oms/web/views/magazyn-hurt.ejs', import.meta.url), 'utf8',
    );
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
      bezWymiaru.push(kartaO(`Lampa ${i}`, {
        kategoria_glowna: 'Aplikacje', paczkomat: 'tak', sku: `SKU-${i}`, opis: `opis ${i}`,
      }));
    }
    // Kontrola: karta, ktora wymiar JUZ MA i ktorej zawezenie nie obejmuje.
    const zWymiarem = kartaO('Ma wymiar', { szerokosc_mm: 450, wysokosc_mm: 650 });

    const r = await zatwierdz(serwer(), {
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('645');

    const zmienione = db.prepare(
      'SELECT COUNT(*) c FROM karty_produktow WHERE szerokosc_mm = 700 AND wysokosc_mm = 1000',
    ).get().c;
    expect(zmienione).toBe(645);

    // ⚠️ POZOSTALE POLA NIETKNIETE — to jest ta polowa rozstrzygniecia, ktora na jednej
    // karcie widac slabo, a ktora hurtem kosztuje caly katalog.
    const potluczone = db.prepare(
      "SELECT COUNT(*) c FROM karty_produktow WHERE kategoria_glowna IS NOT 'Aplikacje'"
      + " AND nazwa LIKE 'Lampa %'",
    ).get().c;
    expect(potluczone).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM karty_produktow WHERE paczkomat = 'tak'").get().c).toBe(645);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE sku IS NULL').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM karty_produktow WHERE opis IS NULL').get().c).toBe(1);

    // Karta spoza zawezenia zachowuje SWOJ wymiar.
    expect(wiersz(zWymiarem).szerokosc_mm).toBe(450);
    expect(wiersz(zWymiarem).wysokosc_mm).toBe(650);
  });

  it('645 kart dostaje JEDEN wspolny znacznik czasu — po nim da sie cofnac pomylke masowa', async () => {
    for (let i = 0; i < 645; i += 1) kartaO(`Lampa ${i}`);

    await zatwierdz(serwer(), {
      zakres: 'pasujace', zawezenie: 'brak=wymiary', szerokosc_cm: '70', wysokosc_cm: '100',
    });

    const znaczniki = db.prepare(
      'SELECT COUNT(DISTINCT zmieniony_at) c FROM karty_produktow WHERE szerokosc_mm = 700',
    ).get().c;
    expect(znaczniki).toBe(1);
  });
});
