import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { LIMIT_PROB } from '../../../src/core/bezpieczenstwo/hamulec.js';
import { ostatnieLogowania, MAKS_DLUGOSC_LOGINU_W_DZIENNIKU } from '../../../src/core/bezpieczenstwo/konta.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const BASIC = 'Basic ' + Buffer.from('adam:x').toString('base64');
const JAK_PRZEGLADARKA = { accept: 'text/html,application/xhtml+xml' };
const ORIGIN = { origin: 'http://localhost' };

let db; let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
});

const ciastko = () => `${NAZWA_CIASTECZKA_OMS}=${podpisz(config.auth.user, odczytajSekret(db))}`;

describe('wejście przeglądarki bez zalogowania', () => {
  // ⚠️ TO JEST CALY POWOD TEJ ZMIANY. Systemowe okienko Chrome rysuje sie w odpowiedzi na
  // 401 i nie da sie go ani ostylowac, ani ominac inaczej niz NIE odpowiadajac 401.
  it('idzie na /login zamiast dostać 401 z okienkiem przeglądarki', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: JAK_PRZEGLADARKA });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^\/login\?powrot=/);
    expect(r.headers['www-authenticate']).toBeUndefined();
  });

  it('zapamiętuje, dokąd operator szedł', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia/17?edytuj=wysylka', headers: JAK_PRZEGLADARKA });
    expect(decodeURIComponent(r.headers.location.split('powrot=')[1])).toBe('/zamowienia/17?edytuj=wysylka');
  });

  it('sam ekran logowania jest dostępny bez niczego', async () => {
    const r = await app.inject({ method: 'GET', url: '/login' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Zaloguj się');
    // Bez gornego paska: na tym ekranie nie ma dokad nawigowac.
    expect(r.body).not.toContain('class="pas"');
  });
});

describe('żądania NIE-przeglądarkowe dalej dostają 401', () => {
  // ⚠️ Panel zamowien indywidualnych loguje sie do OMS-u Basic Authem („Dodaj do OMS").
  // Odeslanie go na ekran logowania zamienialoby czytelna odmowe w strone HTML,
  // ktora wolajacy uznalby za powodzenie.
  it('zapytanie bez nagłówka Accept: text/html', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json' } });
    expect(r.statusCode).toBe(401);
  });

  it('zapytanie z BŁĘDNYM Basic Auth — nie przekierowanie, tylko odmowa', async () => {
    const zly = 'Basic ' + Buffer.from('adam:ZLE').toString('base64');
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, authorization: zly } });
    expect(r.statusCode).toBe(401);
  });

  it('POST bez zalogowania nie jest przekierowywany', async () => {
    const r = await app.inject({ method: 'POST', url: '/motyw', headers: { ...JAK_PRZEGLADARKA, ...ORIGIN } });
    expect(r.statusCode).not.toBe(302);
  });
});

describe('logowanie formularzem', () => {
  it('poprawne dane wystawiają ciasteczko i odsyłają tam, gdzie operator szedł', async () => {
    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'adam', haslo: 'x', powrot: '/faktury' },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/faktury');
    expect(r.headers['set-cookie']).toContain(`${NAZWA_CIASTECZKA_OMS}=`);
    expect(r.headers['set-cookie']).toContain('HttpOnly');
    expect(r.headers['set-cookie']).toContain('SameSite=Lax');
  });

  it('ciasteczko wpuszcza do panelu BEZ Basic Auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: ciastko() } });
    expect(r.statusCode).toBe(200);
  });

  it('Basic Auth działa dalej BEZ ciasteczka — oba zamki naraz', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, authorization: BASIC } });
    expect(r.statusCode).toBe(200);
  });

  it('podrobione ciasteczko nie wpuszcza', async () => {
    const r = await app.inject({
      method: 'GET', url: '/',
      headers: { ...JAK_PRZEGLADARKA, cookie: `${NAZWA_CIASTECZKA_OMS}=zmyslone.podpis` },
    });
    expect(r.statusCode).toBe(302);
  });

  it.each([
    ['złe hasło', { uzytkownik: 'adam', haslo: 'ZLE' }],
    ['zły login', { uzytkownik: 'KTOS', haslo: 'x' }],
    ['puste pola', { uzytkownik: '', haslo: '' }],
  ])('%s odbija się z tym SAMYM komunikatem', async (_n, dane) => {
    const r = await app.inject({ method: 'POST', url: '/login', headers: ORIGIN, payload: { ...dane, powrot: '/' } });
    expect(r.statusCode).toBe(401);
    // ⚠️ Jeden komunikat na oba przypadki: „zly login" i „zle haslo" to dwie rozne
    // odpowiedzi, z ktorych zgadujacy odczytuje, ze nazwe konta juz trafil.
    expect(r.body).toContain('Nieprawidłowy login lub hasło');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('adres powrotu przechodzi przez bramkę — obcy host nie przejdzie', async () => {
    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'adam', haslo: 'x', powrot: '//obcy.pl/przejmij' },
    });
    expect(r.headers.location).toBe('/');
  });
});

describe('flaga Secure idzie za połączeniem', () => {
  // ⚠️ Wpisana na sztywno zabilaby logowanie: po HTTP przegladarka odrzuca ciasteczko
  // z flaga Secure w calosci, wiec ekran logowania „nic by nie robil".
  it('po HTTP ciasteczko NIE MA Secure', async () => {
    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'adam', haslo: 'x', powrot: '/' },
    });
    expect(r.headers['set-cookie']).not.toContain('Secure');
  });

  it('za proxy po HTTPS ciasteczko dostaje Secure', async () => {
    const r = await app.inject({
      method: 'POST', url: '/login',
      headers: { ...ORIGIN, 'x-forwarded-proto': 'https' },
      payload: { uzytkownik: 'adam', haslo: 'x', powrot: '/' },
    });
    expect(r.headers['set-cookie']).toContain('Secure');
  });
});

describe('hamulec na zgadywanie hasła', () => {
  const zlaProba = () => app.inject({
    method: 'POST', url: '/login', headers: ORIGIN,
    payload: { uzytkownik: 'adam', haslo: 'ZLE', powrot: '/' },
  });

  it('blokuje dokładnie przy piątej nieudanej próbie', async () => {
    for (let i = 0; i < LIMIT_PROB - 1; i++) expect((await zlaProba()).statusCode).toBe(401);
    // Proba, ktora zapala kare, oddaje 429 razem z komunikatem o karze — status i tresc
    // musza mowic to samo, inaczej log i ekran opowiadaja dwie rozne historie.
    const piata = await zlaProba();
    expect(piata.statusCode).toBe(429);
    expect(piata.body).toContain('Za dużo nieudanych prób');
  });

  it('po zablokowaniu nie wpuszcza nawet z POPRAWNYM hasłem', async () => {
    for (let i = 0; i < LIMIT_PROB; i++) await zlaProba();
    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'adam', haslo: 'x', powrot: '/' },
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('mówi, ile zostało czekania', async () => {
    for (let i = 0; i < LIMIT_PROB; i++) await zlaProba();
    expect((await zlaProba()).body).toMatch(/Spróbuj ponownie za \d+ s/);
  });
});

// ⚠️⚠️ N1 (druga fala 2026-09-12): DWIE osobne usterki na tej samej scieżce. (1) kazde
// zadanie w trakcie trwajacej kary pisalo wlasny wiersz „zablokowane" do dziennika — bez
// scryptu, ktory by je spowolnil, wiec pukanie 2 s dawalo (zmierzone na zywym serwerze)
// 291 wierszy. (2) `login` szedl do dziennika bez zadnego ograniczenia dlugosci — 291 zadan
// ze 100 kB loginem dalo 29,1 MB w samej tej kolumnie.
describe('N1 — dziennik przy zapalonej karze nie puchnie bez ograniczenia', () => {
  const zlaProba = (uzytkownik = 'adam') => app.inject({
    method: 'POST', url: '/login', headers: ORIGIN,
    payload: { uzytkownik, haslo: 'ZLE', powrot: '/' },
  });

  it('kara + dziesiec kolejnych zadan daje DOKLADNIE JEDEN wpis "zablokowane"', async () => {
    for (let i = 0; i < LIMIT_PROB; i++) await zlaProba();
    // Kara juz trwa (piata proba wyzej ja zapalila) — walimy w nia dziesiecioma dalszymi.
    for (let i = 0; i < 10; i++) await zlaProba();
    const zablokowane = ostatnieLogowania(db, 100).filter((w) => w.wynik === 'zablokowane');
    // ⚠️ Mutacja z recenzji: usuniecie wpisu w ogole (`if` bez ciala) tez przechodzilo
    // starsza suite na zielono — stad `toHaveLength(1)`, nie samo "wieksze niz 0".
    expect(zablokowane).toHaveLength(1);
  });

  it('login w dzienniku jest przyciety do rozsadnej dlugosci, tresc zachowana do granicy', async () => {
    const dlugiLogin = 'x'.repeat(2000);
    for (let i = 0; i < LIMIT_PROB; i++) await zlaProba(dlugiLogin);
    await zlaProba(dlugiLogin); // trafia juz w trwajaca kare
    for (const wpis of ostatnieLogowania(db, 100)) {
      expect(wpis.login.length).toBeLessThanOrEqual(MAKS_DLUGOSC_LOGINU_W_DZIENNIKU);
    }
    const [najnowszy] = ostatnieLogowania(db, 1);
    expect(najnowszy.login).toBe('x'.repeat(MAKS_DLUGOSC_LOGINU_W_DZIENNIKU));
  });
});

describe('wylogowanie', () => {
  it('kasuje ciasteczko tego urządzenia', async () => {
    const r = await app.inject({ method: 'POST', url: '/wyloguj', headers: { ...ORIGIN, cookie: ciastko() } });
    expect(r.headers.location).toBe('/login');
    expect(r.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('„wszystkie urządzenia" unieważnia ciasteczko wydane wcześniej', async () => {
    const stare = ciastko();
    expect((await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: stare } })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/ustawienia/konta/wyloguj-wszystkie', headers: { ...ORIGIN, cookie: stare } });

    const po = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: stare } });
    expect(po.statusCode).toBe(302);
    expect(po.headers.location).toMatch(/^\/login/);
  });

  it('Basic Auth przeżywa odcięcie wszystkich urządzeń — panel indywidualny nie traci dostępu', async () => {
    await app.inject({ method: 'POST', url: '/ustawienia/konta/wyloguj-wszystkie', headers: ORIGIN });
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, authorization: BASIC } });
    expect(r.statusCode).toBe(200);
  });
});

describe('odnawianie ciasteczka w locie', () => {
  // Ciasteczko wazne 90 dni przesuwa termin przy uzyciu, wiec przy codziennej pracy nie
  // wygasa nigdy. Przepisujemy je dopiero po dobie — przegladarka nie ma dostawac
  // Set-Cookie przy kazdym kliknieciu.
  const stareODobe = () => `${NAZWA_CIASTECZKA_OMS}=${podpisz(config.auth.user, odczytajSekret(db), Date.now() - 25 * 60 * 60 * 1000)}`;

  it('świeże ciasteczko NIE jest przepisywane', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: ciastko() } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('ciasteczko starsze niż doba dostaje świeży termin', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: stareODobe() } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toContain(`${NAZWA_CIASTECZKA_OMS}=`);
  });

  // ⚠️ TE DWA PRZYPADKI ZOSTALY DOPISANE PO WERYFIKACJI MUTACYJNEJ. Podmiana
  // `polaczenieBezpieczne(req)` na `true` W STRAZNIKU przechodzila bez czerwonego testu:
  // flage Secure sprawdzalismy wylacznie na trasie /login, a sciezka odnowienia ustawia
  // wlasne ciasteczko i nie miala ani jednej asercji. Po HTTP dokleiloby to flage, ktora
  // kaze przegladarce ciasteczko ODRZUCIC — operator wylatywalby z panelu po dobie pracy.
  it('odnowione po HTTP nie ma Secure', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { ...JAK_PRZEGLADARKA, cookie: stareODobe() } });
    expect(r.headers['set-cookie']).not.toContain('Secure');
  });

  it('odnowione za proxy po HTTPS ma Secure', async () => {
    const r = await app.inject({
      method: 'GET', url: '/',
      headers: { ...JAK_PRZEGLADARKA, cookie: stareODobe(), 'x-forwarded-proto': 'https' },
    });
    expect(r.headers['set-cookie']).toContain('Secure');
  });
});

describe('menu konta i administracja sesjami', () => {
  it('podstrona ustawień niesie motyw i własne wylogowanie w menu konta', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/zamowienia-i-wysylka', headers: { ...JAK_PRZEGLADARKA, cookie: ciastko() } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('action="/motyw"');
    expect(r.body).toContain('action="/wyloguj"');
    expect(r.body).not.toContain('wyloguj-wszystkie');
  });

  it('globalne wylogowanie jest wyłącznie na stronie Kont', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/konta', headers: { ...JAK_PRZEGLADARKA, cookie: ciastko() } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('action="/ustawienia/konta/wyloguj-wszystkie"');
  });

  it('NIE pokazuje samego sekretu — to jest poświadczenie', async () => {
    const sekret = odczytajSekret(db);
    const r = await app.inject({ method: 'GET', url: '/ustawienia/konta', headers: { ...JAK_PRZEGLADARKA, cookie: ciastko() } });
    expect(r.body).not.toContain(sekret);
  });
});

describe('zasoby ekranu logowania', () => {
  // ⚠️ TEN TEST ISTNIEJE, BO USTERKA PRZESZLA PRZEZ CALA SUITE. Ekran logowania oddawal 200
  // i miał poprawną treść, ale jego ARKUSZ dostawal 401 — bo zadanie o CSS nie ma naglowka
  // `Accept: text/html`, wiec straznik nie uznawal go za wejscie przegladarki. Efekt: ekran
  // bez jednej barwy marki, czcionka systemowa. Widac to wylacznie w przegladarce.
  it('arkusz stylów jest dostępny BEZ zalogowania', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/app.css', headers: { accept: 'text/css,*/*;q=0.1' } });
    expect(r.statusCode).toBe(200);
  });

  it('to samo dotyczy skryptu htmx', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/htmx.min.js', headers: { accept: '*/*' } });
    expect(r.statusCode).toBe(200);
  });
});
