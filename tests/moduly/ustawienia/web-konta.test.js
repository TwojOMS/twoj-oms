import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  zalozKonto, kontoPoLoginie, ustawUprawnienia, dopiszLogowanie, ustawCzynne,
} from '../../../src/core/bezpieczenstwo/konta.js';
import { pozostanieCzynnyAdmin } from '../../../src/moduly/ustawienia/trasy/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

// ⚠️⚠️ TESTY TEGO PLIKU STOJA NA PRAWDZIWYM `buildOmsServer` (jak w tests/oms/logowanie-konta.test.js
// i w drugiej czesci tests/oms/straznik-uprawnienia.test.js — W5), NIE na mikropanelu. Mikropanel
// nie rejestruje ANI JEDNEGO widoku EJS ani haka `preHandler` (ktory liczy `reply.locals.motyw`/
// `menu`), wiec bledu w szablonie (dokladnie ta klasa, ktora K1 juz raz przepuscila na zielono,
// bo testy patrzyly WYLACZNIE na statusCode) mikropanel by nie zobaczyl.

const config = { auth: { user: 'serwis', pass: 'tajne-haslo' } };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const HTML = { accept: 'text/html' };
const ORIGIN = { origin: 'http://localhost' };

function nowyPanel() {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config, poller });
  return { db, app };
}

const jako = (db, login) => ({ cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db))}` });

function sekcjaKonta(html, id) {
  const poczatek = html.indexOf(`id="konto-${id}"`);
  const nastepna = html.indexOf('id="konto-', poczatek + 1);
  const koniec = nastepna >= 0 ? nastepna : html.indexOf('<h2>Ostatnie logowania</h2>', poczatek);
  return html.slice(poczatek, koniec >= 0 ? koniec : undefined);
}

function glownaKolumna(html) {
  const poczatek = html.indexOf('<main class="kolumna-glowna">');
  return poczatek < 0 ? '' : html.slice(poczatek);
}

function komunikatBledu(html) {
  const poczatek = html.indexOf('<div class="pas-uprzedzenie">');
  return poczatek < 0 ? '' : html.slice(poczatek, html.indexOf('</div>', poczatek));
}

describe('ekran kont', () => {
  it('udane operacje wracają na Konta z komunikatem ze skończonego klucza', async () => {
    const przypadki = [
      {
        klucz: 'nowe', komunikat: 'Założono konto.',
        url: () => '/ustawienia/konta/nowe',
        payload: () => ({ login: 'nowe-konto', imie: 'Nowa Osoba', haslo: 'sekret', rola: 'produkcja' }),
      },
      {
        klucz: 'uprawnienia', komunikat: 'Zapisano uprawnienia.',
        url: (id) => `/ustawienia/konta/${id}/uprawnienia`, payload: () => ({ ekran: ['magazyn'] }),
      },
      {
        klucz: 'haslo', komunikat: 'Zmieniono hasło.',
        url: (id) => `/ustawienia/konta/${id}/haslo`, payload: () => ({ haslo: 'nowy-sekret' }),
      },
      {
        klucz: 'czynne', komunikat: 'Zmieniono stan konta.',
        url: (id) => `/ustawienia/konta/${id}/czynne`, payload: () => ({ czynne: '0' }),
      },
    ];

    for (const przypadek of przypadki) {
      const { db, app } = nowyPanel();
      zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
      const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
      const naglowki = { ...HTML, ...ORIGIN, ...jako(db, 'adam') };

      const zapis = await app.inject({
        method: 'POST', url: przypadek.url(idEwa), headers: naglowki, payload: przypadek.payload(),
      });
      expect(zapis.statusCode).toBe(302);
      expect(zapis.headers.location).toBe(`/ustawienia/konta?zapisano=${przypadek.klucz}`);

      const ekran = await app.inject({ method: 'GET', url: zapis.headers.location, headers: { ...HTML, ...jako(db, 'adam') } });
      expect(ekran.body).toContain(przypadek.komunikat);
    }
  });

  it('nie wypisuje dowolnego parametru zapisano na stronie Kont', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const znacznik = 'NIE-ZAUFANY-KOMUNIKAT';

    const r = await app.inject({
      method: 'GET', url: `/ustawienia/konta?zapisano=${znacznik}`,
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(glownaKolumna(r.body)).not.toContain(znacznik);
  });

  it('błąd nowego konta zachowuje pola niesekretne, ale nigdy nie odtwarza hasła', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const sekret = 'HASLO-NIE-MOZE-WROCIC-DO-HTML';

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: '  nowa-osoba  ', imie: 'Nowa Osoba', haslo: sekret, rola: 'rola-spoza-listy' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(r.body).toContain('value="  nowa-osoba  "');
    expect(r.body).toContain('value="Nowa Osoba"');
    expect(r.body).toContain('value="rola-spoza-listy" selected disabled');
    expect(r.body).not.toContain(sekret);
  });

  it('błąd edycji zachowuje wybrane uprawnienia konkretnego konta', async () => {
    const { db, app } = nowyPanel();
    const idAdam = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idAdam}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['magazyn', 'api'] },
    });

    expect(r.statusCode).toBe(400);
    const sekcja = sekcjaKonta(r.body, idAdam);
    expect(sekcja).toMatch(/name="ekran" value="magazyn" checked/);
    expect(sekcja).toMatch(/name="ekran" value="api" checked/);
    expect(sekcja).not.toMatch(/name="ekran" value="zamowienia" checked/);
  });

  it('puste hasło oddaje pełny widok 400 i każe wpisać hasło ponownie', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'stare', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/haslo`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') }, payload: { haslo: '' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(r.body).toMatch(/wpisz je ponownie/i);
    expect(r.body).not.toContain('value="stare"');
  });

  it('KONTO BEZ FLAGI admin NIE WCHODZI, nawet majac ptaszek na Ustawieniach', async () => {
    const { db, app } = nowyPanel();
    // ewa: rola sprzedaz + recznie dodany ptaszek `ustawienia` — dowodzi, ze ekran kont
    // patrzy WYLACZNIE na flage `admin`, a nie na to, czy dana osoba widzi zakladke Ustawienia.
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawUprawnienia(db, idEwa, ['ustawienia']);

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'ewa') },
    });

    expect(r.statusCode).toBe(403);
    // ⚠️ TRESC, NIE TYLKO KOD — dokladnie ta klasa bledu (K1 w straznik.js) przeszla juz raz
    // cala suite na zielono, bo test patrzyl wylacznie na statusCode, a ekran odmowy nie
    // renderowal sie ani razu (wybuchal na `<%= motyw %>` niezdefiniowanym poza layoutem).
    expect(r.body).toContain('Brak dostępu');
    // Regresja na inna odmiane tego samego bledu: `brak-dostepu.ejs` jest SAMODZIELNYM
    // dokumentem (`<!doctype html>`) — bez `wlasnyUklad: true` layout-oms.ejs opakowalby go
    // w DRUGI dokument. Dokladnie jeden `<!doctype html>` w odpowiedzi dowodzi, ze tego nie ma.
    expect((r.body.match(/<!doctype html>/gi) || []).length).toBe(1);
  });

  it('administrator zaklada konto, ktore od razu ma uprawnienia swojej roli', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: 'pako', imie: 'Pakowanie', haslo: 'haslo-ok', rola: 'produkcja' },
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/konta?zapisano=nowe');
    const konto = kontoPoLoginie(db, 'pako');
    expect(konto).not.toBeNull();
    expect(konto.uprawnienia).toEqual(new Set([
      'zamowienia', 'przesylki', 'faktury-zamowienia', 'zwroty-zamowienia',
    ]));
  });

  it('formularz oddaje KOMPLET ptaszkow — odznaczony ptaszek ZNIKA', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['magazyn'] },
    });

    expect(r.statusCode).toBe(302);
    // Rola sprzedaz ma domyslnie ponad dziesiec ekranow — PODMIANA (nie doklejanie) musi
    // zostawic WYLACZNIE `magazyn`, zaden z pozostalych presetu.
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn']));
  });

  // ⚠️ K1 (recenzja 2026-09-12): TEN test mial w bazie JEDNO konto, wiec w istocie odpalal
  // bezpiecznik „ostatni czynny admin" (D3 wyzej), nie ten, ktorego nazwa nosi — usuniecie
  // WYLACZNIE bezpiecznika „nie odbierz sobie" (ponizej, w routes/konta.js) przechodziloby
  // ta suita na zielono, bo „ostatni admin" i tak by zablokowal operacje. DRUGIE czynne konto
  // administratora czyni scenariusz prawdziwym: „odbieram admina SOBIE, choc zostaje KTOS
  // INNY" — i komunikat NIE ma mowic o ostatnim adminie, bo nim nie jest.
  it('⚠️ BEZPIECZNIK: nie da sie odebrac `admin` SAMEMU SOBIE, TAKZE gdy zostaje INNY czynny administrator', async () => {
    const { db, app } = nowyPanel();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${id}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['zamowienia'] }, // brak pola "admin" = ptaszek odznaczony
    });

    expect(r.statusCode).toBe(400);
    // Rozroznienie od D3/„ostatni admin": Kasia zostaje czynnym adminem, wiec komunikat
    // NIE ma wspominac „ostatniego" — to bezpiecznik samo-zamkniecia, inny powod odmowy.
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(komunikatBledu(r.body)).not.toMatch(/ostatni/i);
    expect(kontoPoLoginie(db, 'adam').admin).toBe(true);
  });

  it('⚠️ BEZPIECZNIK: nie da sie wylaczyc WLASNEGO konta', async () => {
    const { db, app } = nowyPanel();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${id}/czynne`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { czynne: '0' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(kontoPoLoginie(db, 'adam').czynne).toBe(true);
  });

  it('ekran pokazuje „Sprzedaż + zmiany", gdy ptaszki odeszly od presetu', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    // Odbieramy jeden ptaszek z presetu sprzedazy — ekran ma to zauwazyc i przestac powtarzac
    // sama etykiete roli, jakby nic sie nie zmienilo.
    ustawUprawnienia(db, idEwa, ['zamowienia']);

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Sprzedaż + zmiany');
  });

  it('dziennik logowan jest NA TYM SAMYM ekranie i pokazuje proby nieudane', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    dopiszLogowanie(db, { login: 'ktos-obcy', usluga: 'oms', wynik: 'zle-haslo' });

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    // D1 (recenzja 2026-09-12): odkad ekran mapuje identyfikator na tekst dla czlowieka,
    // szuka sie TEKSTU ("Złe hasło"), nie surowego klucza bazy — patrz testy D1/D2 nizej,
    // ktore dowodza wprost, ze surowy identyfikator NIE wyciega sie juz do HTML-a.
    expect(r.body).toContain('Złe hasło');
  });

  it('K2: cztery trasy ZAPISUJACE (nie tylko GET) odrzucaja konto bez flagi `admin`, choc ma ptaszek na Ustawieniach', async () => {
    // ⚠️ To NIE jest teoria: ekranDlaAdresu('/ustawienia/konta') oddaje 'ustawienia', wiec
    // konto Sprzedaz z RECZNIE dodanym ptaszkiem „Ustawienia" PRZECHODZI przez straznika —
    // zatrzymuje je WYLACZNIE `tylkoAdmin` w TYM pliku. Usuniecie go z ktorejkolwiek z tych
    // czterech tras osobno przechodzilo dotad zielono, bo zaden test nie sprawdzal ZAPISU.
    const przypadki = [
      ['POST', () => '/ustawienia/konta/nowe', () => ({ login: 'ktos-nowy', imie: 'Ktos', haslo: 'h', rola: 'produkcja' })],
      ['POST', (id) => `/ustawienia/konta/${id}/uprawnienia`, () => ({ ekran: ['zamowienia'] })],
      ['POST', (id) => `/ustawienia/konta/${id}/haslo`, () => ({ haslo: 'nowe-tajne-haslo' })],
      ['POST', (id) => `/ustawienia/konta/${id}/czynne`, () => ({ czynne: '1' })],
    ];

    for (const [metoda, urlZId, payloadZ] of przypadki) {
      const { db, app } = nowyPanel();
      const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
      ustawUprawnienia(db, idEwa, ['ustawienia']);

      const r = await app.inject({
        method: metoda, url: urlZId(idEwa),
        headers: { ...HTML, ...ORIGIN, ...jako(db, 'ewa') },
        payload: payloadZ(),
      });

      expect(r.statusCode).toBe(403);
      expect(r.body).toContain('Brak dostępu');
    }
  });

  it('W1: filtruje `ekran` do znanych kluczy — nieistniejace slowa i sciezki NIE wchodza', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['magazyn', 'nieistniejacy', '../etc', 'finanse'] },
    });

    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn', 'finanse']));
  });

  it('W2: pole `ekran` w trzech postaciach — brak, pojedynczy napis, tablica', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    // Brak pola (zero zaznaczonych ptaszkow) — formularz oddaje KOMPLET, wiec zero ptaszkow
    // ma wyczyscic uprawnienia do zera, nie zostawic starych.
    let r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: {},
    });
    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set());

    // JEDEN zaznaczony ptaszek przychodzi z przegladarki jako NAPIS, nie tablica
    // jednoelementowa — to jest DOKLADNIE mutacja, ktora ginela po cichu na produkcji.
    r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: 'magazyn' },
    });
    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn']));

    // Kilka zaznaczonych ptaszkow przychodzi jako tablica.
    r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idEwa}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['magazyn', 'finanse'] },
    });
    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn', 'finanse']));
  });

  it('W3: `admin` przy zakladaniu konta wynika z presetu ROLI, nie ze sztywnej wartosci', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: 'pako', imie: 'Pakowanie', haslo: 'haslo-ok', rola: 'produkcja' },
    });
    await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: 'aga2', imie: 'Ewa Druga', haslo: 'haslo-ok', rola: 'sprzedaz' },
    });
    await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: 'nowyadmin', imie: 'Nowy Admin', haslo: 'haslo-ok', rola: 'administrator' },
    });

    // Konto „Produkcja" (i „Sprzedaz") wybite jako admin przechodziloby cala reszte
    // suity — dowod wymaga sprawdzenia OBU kierunkow, nie tylko „administrator = true".
    expect(kontoPoLoginie(db, 'pako').admin).toBe(false);
    expect(kontoPoLoginie(db, 'aga2').admin).toBe(false);
    expect(kontoPoLoginie(db, 'nowyadmin').admin).toBe(true);
  });

  it('W6: koduje HTML w imieniu i loginie na ekranie — bez `<%- %>`', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const zly = '<script>alert(1)</script>';
    zalozKonto(db, { login: zly, imie: zly, haslo: 'h', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script>alert(1)</script>');
    // Dwa wystapienia — imie i login sa wypisywane w DWOCH miejscach kazde (naglowek karty
    // konta i tabela kont u gory) — liczba nie jest tu istotna, istotne jest, ze ANI RAZU
    // nie przeszedl surowy znacznik.
    expect(r.body).toContain('&lt;script&gt;');
  });

  it('W6: koduje HTML we wpisie dziennika logowan — login czlowieka trafia tam takze', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    dopiszLogowanie(db, { login: '<script>alert(2)</script>', usluga: 'oms', wynik: 'zle-haslo' });

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script>alert(2)</script>');
    expect(r.body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  // ——— POPRAWKI CZESCI A ——————————————————————————————————————————————————————————————

  it('W4: POST /haslo na NIEISTNIEJACYM koncie oddaje 404 — tak samo jak dwie pozostale trasy', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const idNieistniejace = await app.inject({
      method: 'POST', url: '/ustawienia/konta/9999/haslo',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { haslo: 'nowe-haslo-123' },
    });
    expect(idNieistniejace.statusCode).toBe(404);

    const idNieliczbowe = await app.inject({
      method: 'POST', url: '/ustawienia/konta/abc/haslo',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { haslo: 'nowe-haslo-123' },
    });
    expect(idNieliczbowe.statusCode).toBe(404);
  });

  it('W5: duplikat loginu pokazuje pas-uprzedzenie zamiast 500 z surowym bledem SQL-a', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: 'ewa', imie: 'Barbara Druga', haslo: 'HASLO-DUPLIKAT-SENTINEL', rola: 'sprzedaz' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('pas-uprzedzenie');
    expect(r.body).not.toContain('ERR_SQLITE_ERROR');
    expect(r.body).not.toContain('UNIQUE constraint failed');
    expect(r.body).toContain('name="login" required placeholder="np. anna" value="ewa"');
    expect(r.body).toContain('name="imie" required placeholder="np. Anna" value="Barbara Druga"');
    expect(r.body).toMatch(/value="sprzedaz" selected/);
    expect(r.body).not.toContain('HASLO-DUPLIKAT-SENTINEL');
    // Drugie konto „ewa" NIE powstalo — sprawdzenie duplikatu poszlo PRZED zapisem.
    expect(kontoPoLoginie(db, 'ewa').imie).toBe('Barbara');
  });

  it('D8: login jest przycinany z bialych znakow PRZED zapisem i PRZED sprawdzeniem duplikatu', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: '  ewa  ', imie: 'Barbara', haslo: 'haslo-ok', rola: 'sprzedaz' },
    });

    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa')).not.toBeNull();
    expect(kontoPoLoginie(db, '  ewa  ')).toBeNull();

    // Duplikat z bialymi znakami ma zostac ZLAPANY, nie zalozony jako „inny" login.
    const drugie = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { login: ' ewa', imie: 'Barbara Druga', haslo: 'haslo-ok', rola: 'sprzedaz' },
    });
    expect(drugie.statusCode).toBe(400);
  });

  it('D3: przy ZERO czynnych adminow operacja, ktora niczego nie pogarsza, MA przejsc', async () => {
    const { db, app } = nowyPanel();
    // Jedyny admin w bazie jest WYLACZONY — zero czynnych adminow, dokladnie scenariusz D3.
    const idAdmin = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    ustawCzynne(db, idAdmin, false);
    const idSprzedaz = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    // Konto SERWISOWE (haslo z .env) jest jedyna droga wejscia na ten ekran, gdy nie ma
    // zadnego czynnego admina — dokladnie ten przypadek z brief-u „ktos odzyskuje panel".
    const auth = { authorization: `Basic ${Buffer.from(`${config.auth.user}:${config.auth.pass}`).toString('base64')}` };
    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idSprzedaz}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...auth },
      payload: { ekran: ['zamowienia'], admin: '1' },
    });

    expect(r.statusCode).toBe(302);
    expect(r.body).not.toMatch(/ostatni/i);
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(true);
  });

  it('D3: jednostkowo — pozostanieCzynnyAdmin() nie blokuje operacji, ktora nie schodzi ponizej zera', () => {
    const { db } = nowyPanel();
    const idAdmin = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    ustawCzynne(db, idAdmin, false);

    // Ponowny zapis TEGO SAMEGO, dalej WYLACZONEGO konta jako admina — przed i po jest
    // zero czynnych adminow, wiec operacja niczego nie pogarsza.
    expect(pozostanieCzynnyAdmin(db, idAdmin, { czynne: false, admin: true })).toBe(true);

    // Mianowanie INNEGO, aktywnego konta adminem — jedyna droga odzyskania panelu bez SSH.
    const idSprzedaz = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    expect(pozostanieCzynnyAdmin(db, idSprzedaz, { czynne: true, admin: true })).toBe(true);
  });

  it('D1+D2: dziennik logowan pokazuje CZYTELNY opis wyniku i kolumne IP', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    dopiszLogowanie(db, { login: 'ktos-obcy', usluga: 'oms', wynik: 'zle-haslo', ip: '10.20.30.40' });

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('10.20.30.40');
    expect(r.body).toContain('Złe hasło');
    // Surowy identyfikator nie ma wyciekac do widoku jako WARTOSC KOMORKI (moze legalnie
    // pojawic sie np. w atrybucie CSS-owym, ale nie jako tekst wyniku w tabeli).
    expect(r.body).not.toMatch(/>zle-haslo</);
  });

  it('D1: NIEZNANY `wynik` w dzienniku NIE znika — pokazuje surowy identyfikator zamiast milczec', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    dopiszLogowanie(db, { login: 'ktos', usluga: 'oms', wynik: 'przyszly-typ-logowania' });

    const r = await app.inject({
      method: 'GET', url: '/ustawienia/konta',
      headers: { ...HTML, ...jako(db, 'adam') },
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('przyszly-typ-logowania');
  });
});

// ⚠️⚠️ TRZECI BEZPIECZNIK, KTOREGO BRIEF NIE PRZEWIDUJE (wykryty w recenzji strażnika):
// dopoki `czyIstniejeCzynnyAdmin` (db/konta.js) oddaje `false`, haslo z `.env` jest PELNYM
// adminem (straznik.js, `dopuscSerwisowe`). Gdyby dalo sie wylaczyc albo odebrac admina
// OSTATNIEMU czynnemu administratorowi, brama degradacji zamykalaby sie na zawias — kto zna
// haslo z `.env`, odzyskiwalby pelne uprawnienia jednym kliknieciem. Dziala NIEZALEZNIE od
// tego, czy admin odbiera uprawnienia sobie, czy komus innemu — liczy sie WYLACZNIE to, czy
// po operacji zostanie choc jeden czynny admin.
describe('trzeci bezpiecznik: ostatni czynny administrator', () => {
  it('pozostanieCzynnyAdmin() liczy STAN CALEJ BAZY, nie tozsamosc tego, kto pyta', () => {
    const { db } = nowyPanel();
    const idSolo = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    // Jedyny czynny admin: odebranie admina ALBO wylaczenie zostawia zero — obie operacje
    // maja byc zablokowane, niezaleznie od tego, KTO o nie pyta (funkcja nie zna `req.konto`).
    expect(pozostanieCzynnyAdmin(db, idSolo, { czynne: true, admin: false })).toBe(false);
    expect(pozostanieCzynnyAdmin(db, idSolo, { czynne: false, admin: true })).toBe(false);
    // Zachowanie admina i aktywnosci jest zawsze ok, choc trywialnie (nic sie nie zmienia).
    expect(pozostanieCzynnyAdmin(db, idSolo, { czynne: true, admin: true })).toBe(true);

    // Z DRUGIM czynnym adminem w bazie ta sama operacja na PIERWSZYM koncie jest juz OK —
    // dowod, ze funkcja liczy WSZYSTKICH czynnych adminow, a nie traktuje `kontoId` szczegolnie.
    const idDrugi = zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });
    expect(pozostanieCzynnyAdmin(db, idSolo, { czynne: false, admin: true })).toBe(true);
    expect(pozostanieCzynnyAdmin(db, idDrugi, { czynne: false, admin: true })).toBe(true);
  });

  it('HTTP: jedyny czynny administrator NIE MOZE odebrac sobie admina — komunikat mowi wprost o OSTATNIM administratorze', async () => {
    const { db, app } = nowyPanel();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${id}/uprawnienia`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { ekran: ['zamowienia'] },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(r.body).toMatch(/ostatni/i);
    expect(kontoPoLoginie(db, 'adam').admin).toBe(true);
  });

  it('HTTP: jedyny czynny administrator NIE MOZE wylaczyc SIEBIE ani ZOSTAC WYLACZONY przez kogos innego (tu nie ma nikogo innego, wiec sprawdzamy siebie)', async () => {
    const { db, app } = nowyPanel();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${id}/czynne`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { czynne: '0' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(r.body).toMatch(/ostatni/i);
    expect(kontoPoLoginie(db, 'adam').czynne).toBe(true);
  });

  it('HTTP: z DRUGIM czynnym adminem w bazie mozna bezpiecznie deaktywowac/odebrac admina INNEMU kontu', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const idKasia = zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${idKasia}/czynne`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { czynne: '0' },
    });

    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'kasia').czynne).toBe(false);
  });

  // ⚠️ ROZROZNIENIE OD BEZPIECZNIKA "NIE WYLACZAJ SIEBIE" (brief, bezwarunkowy): ten test
  // dowodzi, ze TAMTEN bezpiecznik dziala TAKZE gdy zostaliby inni czynni admini — self-lock
  // jest zakazany ZAWSZE, nie tylko wtedy, gdy jest sie ostatnim. Komunikat NIE wspomina
  // "ostatniego", bo Kasia zostaje czynnym adminem — to inny powod odmowy niz wyzej.
  it('BEZPIECZNIK "nie wylaczaj siebie" dziala TAKZE gdy zostalby INNY czynny administrator', async () => {
    const { db, app } = nowyPanel();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: `/ustawienia/konta/${id}/czynne`,
      headers: { ...HTML, ...ORIGIN, ...jako(db, 'adam') },
      payload: { czynne: '0' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<h1>Użytkownicy i uprawnienia</h1>');
    expect(komunikatBledu(r.body)).not.toMatch(/ostatni/i);
    expect(kontoPoLoginie(db, 'adam').czynne).toBe(true);
  });
});

// ⚠️ PIERWSZY KONTAKT WLASCICIELA (takze kogos, kto kupil ten kod) Z PANELEM: od poprzedniego
// zadania `/login` odrzuca haslo z `.env`, gdy w tabeli jest CZYNNY admin — ale na PUSTEJ
// tabeli nie ma go skad odrzucic (straznik.js, `dopuscSerwisowe`: `pelnia` jest `true`).
// Bez tego wejscia nie ma jak zalozyc PIERWSZEGO konta inaczej niz zapytaniem SQL.
describe('pierwszy start: konto serwisowe na pustej tabeli', () => {
  it('konto serwisowe (haslo z .env) wchodzi na /ustawienia/konta na PUSTEJ tabeli i zaklada pierwsze konto', async () => {
    const { db, app } = nowyPanel();
    const auth = { authorization: `Basic ${Buffer.from(`${config.auth.user}:${config.auth.pass}`).toString('base64')}` };

    const wejscie = await app.inject({ method: 'GET', url: '/ustawienia/konta', headers: { ...HTML, ...auth } });
    expect(wejscie.statusCode).toBe(200);
    expect(wejscie.body).toContain('Nowe konto');

    const zalozenie = await app.inject({
      method: 'POST', url: '/ustawienia/konta/nowe',
      headers: { ...HTML, ...ORIGIN, ...auth },
      payload: { login: 'adam', imie: 'Adam', haslo: 'pierwsze-haslo', rola: 'administrator' },
    });

    expect(zalozenie.statusCode).toBe(302);
    const konto = kontoPoLoginie(db, 'adam');
    expect(konto.admin).toBe(true);
    expect(konto.czynne).toBe(true);
  });
});
