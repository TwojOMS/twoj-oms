import { describe, it, expect, beforeEach } from 'vitest';
import {
  MOTYW_DOMYSLNY, motywZNaglowka, przeciwnyMotyw, ciasteczkoMotywu, bezpiecznyPowrot,
} from '../../src/domena/motyw.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

describe('motywZNaglowka', () => {
  it('czyta motyw z ciasteczka', () => {
    expect(motywZNaglowka('oms_motyw=ciemny')).toBe('ciemny');
    expect(motywZNaglowka('oms_motyw=jasny')).toBe('jasny');
  });

  it('znajduje swoje ciasteczko wśród innych', () => {
    expect(motywZNaglowka('cos=1; oms_motyw=ciemny; inne=2')).toBe('ciemny');
  });

  // Zepsute ciasteczko nie ma prawa wywalic KAZDEJ strony panelu naraz.
  it.each([
    ['brak nagłówka', undefined],
    ['pusty', ''],
    ['obcy motyw', 'oms_motyw=neonowy'],
    ['sam znak równości', 'oms_motyw='],
    ['śmieć bez znaku równości', 'popsute'],
    ['podobna nazwa, nie ta sama', 'oms_motywy=ciemny'],
  ])('%s daje motyw domyślny, nie błąd', (_nazwa, wejscie) => {
    expect(motywZNaglowka(wejscie)).toBe(MOTYW_DOMYSLNY);
  });
});

describe('przeciwnyMotyw', () => {
  it('przełącza w obie strony', () => {
    expect(przeciwnyMotyw('jasny')).toBe('ciemny');
    expect(przeciwnyMotyw('ciemny')).toBe('jasny');
  });
});

describe('ciasteczkoMotywu', () => {
  it('zapisuje motyw na rok, na całą ścieżkę', () => {
    const c = ciasteczkoMotywu('ciemny');
    expect(c).toContain('oms_motyw=ciemny');
    expect(c).toContain('Path=/');
    expect(c).toMatch(/Max-Age=\d{6,}/);
  });

  // ⚠️ Ciasteczka nie czyta ani jedna linia JavaScriptu, a zadanie z obcej strony nie ma
  // prawa go ustawiac — panel stoi za Basic Auth, wiec przegladarka doklada haslo sama.
  it('jest niedostępne dla skryptów i odcięte od obcych stron', () => {
    const c = ciasteczkoMotywu('ciemny');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });

  it('nieznana wartość zapisuje się jako domyślna, nie jako śmieć', () => {
    expect(ciasteczkoMotywu('neonowy')).toContain(`oms_motyw=${MOTYW_DOMYSLNY}`);
  });
});

// ⚠️ BRAMKA NA PRZEKIEROWANIE. Adres powrotu przychodzi z pola formularza.
describe('bezpiecznyPowrot', () => {
  it('przepuszcza ścieżkę własną panelu razem z zapytaniem', () => {
    expect(bezpiecznyPowrot('/zamowienia/12?edytuj=pozycje')).toBe('/zamowienia/12?edytuj=pozycje');
  });

  it.each([
    ['obcy adres wprost', 'https://obcy.example/haslo'],
    ['adres bez protokołu', '//obcy.example/haslo'],
    ['ukośnik w drugą stronę', '/\\obcy.example'],
    ['pusty', ''],
    ['sama nazwa', 'obcy.example'],
    ['rozszczepienie nagłówka', '/lista\r\nLocation: https://obcy.example'],
  ])('%s wraca na stronę główną', (_nazwa, wejscie) => {
    expect(bezpiecznyPowrot(wejscie)).toBe('/');
  });
});

describe('przełącznik motywu w panelu', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config, poller });
    await app.ready();
  });

  it('bez ciasteczka strona renderuje się w motywie jasnym', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('data-motyw="jasny"');
  });

  it('z ciasteczkiem strona renderuje się w motywie ciemnym', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...naglowek, cookie: 'oms_motyw=ciemny' } });
    expect(r.body).toContain('data-motyw="ciemny"');
  });

  // Sam znacznik na <html> nic nie daje, jesli arkusz nie ma czego podmienic.
  it('arkusz niesie obie palety', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.body).toContain('html[data-motyw="ciemny"]');
    expect(r.body).toContain('color-scheme: dark');
  });

  it('przełącznik ustawia ciasteczko i wraca tam, gdzie operator był', async () => {
    const r = await app.inject({
      method: 'POST', url: '/motyw', headers: naglowek,
      payload: { powrot: '/zamowienia/7?edytuj=pozycje' },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/zamowienia/7?edytuj=pozycje');
    expect(String(r.headers['set-cookie'])).toContain('oms_motyw=ciemny');
  });

  it('przełącznik przełącza W OBIE STRONY, nie tylko na ciemny', async () => {
    const r = await app.inject({
      method: 'POST', url: '/motyw', headers: { ...naglowek, cookie: 'oms_motyw=ciemny' },
      payload: { powrot: '/' },
    });
    expect(String(r.headers['set-cookie'])).toContain('oms_motyw=jasny');
  });

  it('obcy adres powrotu nie wyprowadza operatora poza panel', async () => {
    const r = await app.inject({
      method: 'POST', url: '/motyw', headers: naglowek,
      payload: { powrot: 'https://obcy.example/zbieram-hasla' },
    });
    expect(r.headers.location).toBe('/');
  });

  it('pasek górny prowadzi do ekranów', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.body).toContain('href="/raporty"');
    expect(r.body).toContain('href="/ustawienia"');
  });

  it('przełącznik motywu jest dostępny w menu użytkownika', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    const poczatek = r.body.indexOf('<form method="post" action="/motyw"');
    const menu = r.body.slice(poczatek, r.body.indexOf('</form>', poczatek));
    expect(menu).toContain('action="/motyw"');
    expect(menu).toContain('name="powrot" value="/"');
  });

  it('przełącznik motywu jest dostępny z podstrony ustawień przez menu użytkownika', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/zamowienia-i-wysylka', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('action="/motyw"');
    // Przelacznik oddaje operatora TAM, GDZIE KLIKNAL — czyli na ustawienia. Adres powrotu
    // dalej jedzie w ukrytym polu i dalej przechodzi przez bramke `bezpiecznyPowrot`.
    expect(r.body).toContain('value="/ustawienia/zamowienia-i-wysylka"');
  });

  // ⚠️ TEST PILNUJACY ZASADY, NIE WYGLADU. Motyw ciemny dziala WYLACZNIE dlatego, ze zaden
  // kolor nie jest wpisany wprost w regule — kazdy idzie przez zmienna, ktora obie palety
  // definiuja. Kolor dopisany na skroty zadziala w jasnym motywie i zostanie w ciemnym taki
  // sam: bialy prostokat na ciemnym tle albo czarny tekst na czarnym. Nikt tego nie zauwazy,
  // bo nikt nie oglada obu motywow na raz.
  it('arkusz nie ma ani jednego koloru poza paletami', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    const arkusz = r.body.slice(r.body.indexOf('<style>'), r.body.indexOf('</style>'));
    // Wycinamy OBIE palety — tam kolory wprost są jedynym dopuszczalnym miejscem.
    const bezPalet = arkusz
      .replace(/:root\s*\{[\s\S]*?\}/, '')
      .replace(/html\[data-motyw="ciemny"\]\s*\{[\s\S]*?\}/, '');
    const zostaly = bezPalet.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(zostaly, `kolory wpisane wprost w reguły: ${zostaly.join(', ')}`).toEqual([]);
  });

  // Sanity na sam test wyzej: gdyby wycinanie palet zjadalo caly arkusz, powyzsze
  // przechodziloby zawsze — takze na arkuszu pelnym kolorow wprost.
  it('sprawdzanie palet nie zjada całego arkusza', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    const arkusz = r.body.slice(r.body.indexOf('<style>'), r.body.indexOf('</style>'));
    const bezPalet = arkusz
      .replace(/:root\s*\{[\s\S]*?\}/, '')
      .replace(/html\[data-motyw="ciemny"\]\s*\{[\s\S]*?\}/, '');
    expect(bezPalet.length).toBeGreaterThan(arkusz.length / 2);
    expect(bezPalet).toContain('var(--tlo)');
  });

  // ⚠️ OBA EKRANY PRZESTALY BYC „PUSTE CELOWO": /ustawienia 2026-08-09 (przelacznik motywu
  // i obsluga dostepu), /raporty 2026-08-13 (sprzedaz w zakresie dat — tresc pilnuje
  // tests/oms/raporty-ekran.test.js). Zostaje sprawdzian, ze oba adresy z gornego paska
  // otwieraja sie i maja swoj tytul, bo ikona prowadzaca w 404 wyglada jak usterka panelu.
  //
  // ⚠️ DAWNE `toMatch(/jeszcze pusta|w budowie|niczego tu jeszcze/i)` BYLO FALSZYWA ZIELENIA:
  // trafialo w KOMENTARZ w arkuszu stylow („Strony w budowie (raporty, ustawienia)"), ktory
  // jedzie z layoutem na KAZDA strone panelu — wiec przechodzilo takze dla ekranu pelnego
  // tresci i nie chronilo niczego.
  it.each([
    ['/raporty', 'Raporty'],
    ['/statystyki', 'Statystyki'],
    ['/cele', 'Cele'],
    ['/ustawienia/zamowienia-i-wysylka', 'Paczki i koszty dostawy'],
  ])('%s otwiera się i ma swój tytuł', async (url, tytul) => {
    const r = await app.inject({ method: 'GET', url, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<title>${tytul}</title>`);
  });
});
