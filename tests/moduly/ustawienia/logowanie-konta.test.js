import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, ustawCzynne, ustawAdmina, ustawUprawnienia, ostatnieLogowania } from '../../../src/core/bezpieczenstwo/konta.js';
import { sprawdz, podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

// ⚠️⚠️ W4 (recenzja 2026-09-12): DO TEGO DNIA `tests/oms/logowanie.test.js` chodzil na
// PUSTEJ tabeli kont, czyli wylacznie po galezi `.env` — mutacja usuwajaca `zTabeli.czynne
// &&` (a wiec wpuszczajaca konto WYLACZONE z dobrym haslem) przechodzila na ZIELONO, bo
// ani jeden test nie zakladal konta w tabeli. Ten plik pokrywa galaz `zTabeli` osobno.

// `config.auth` to poswiadczenia SERWISOWE z `.env` — login CELOWO rozny od kazdego loginu
// w tabeli, zeby galaz `zTabeli` (kontoPoLoginie) i galaz `.env` nigdy sie nie mylily.
const config = { auth: { user: 'serwis', pass: 'haslo-env' } };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const ORIGIN = { origin: 'http://localhost' };

let db; let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
});

describe('logowanie kontem z tabeli', () => {
  it('dobre haslo daje 302 i ciasteczko podpisane LOGINEM Z TABELI, z zachowaniem powrotu', async () => {
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'sekret123', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'ewa', haslo: 'sekret123', powrot: '/koszty' },
    });

    expect(r.statusCode).toBe(302);
    // W4: `powrot` dziala po zalogowaniu kontem z tabeli, tak samo jak dla konta z `.env`.
    expect(r.headers.location).toBe('/koszty');

    const ciastko = String(r.headers['set-cookie']).match(new RegExp(`${NAZWA_CIASTECZKA_OMS}=([^;]+)`))[1];
    const sesja = sprawdz(ciastko, odczytajSekret(db));
    // ⚠️ Ciasteczko MUSI niesc login z tabeli, nie login serwisowy — inaczej straznik
    // (dopuscZalogowanego) szukalby konta, ktorego login nie zgadza sie z tym, kto sie
    // wlasnie zalogowal.
    expect(sesja.uzytkownik).toBe('ewa');

    const [wpis] = ostatnieLogowania(db, 1);
    expect(wpis.wynik).toBe('udane');
    expect(wpis.login).toBe('ewa');
  });

  it('zle haslo konta z tabeli daje 401 i wpis "zle-haslo" w dzienniku', async () => {
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'sekret123', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'ewa', haslo: 'ZLE', powrot: '/' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    const [wpis] = ostatnieLogowania(db, 1);
    expect(wpis.wynik).toBe('zle-haslo');
    expect(wpis.login).toBe('ewa');
  });

  // ⚠️⚠️ TO JEST TEST, KTORY MUTACJA Z W4 PRZECHODZILA NA ZIELONO. Usuniecie
  // `zTabeli.czynne &&` w logowanie.js wpuszczaloby to konto — czynne czy nie.
  it('konto WYLACZONE z DOBRYM haslem NIE loguje sie — 401 i wpis "konto-wylaczone"', async () => {
    const id = zalozKonto(db, { login: 'pako', imie: 'Pakowanie', haslo: 'haslo-ok', rola: 'produkcja', admin: false });
    ustawCzynne(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'pako', haslo: 'haslo-ok', powrot: '/' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    const [wpis] = ostatnieLogowania(db, 1);
    // D5: haslo BYLO poprawne (sprawdzone, W2) — jedyny powod odmowy jest „konto wylaczone",
    // wiec dziennik ma mowic wlasnie to, nie ogolne „zle haslo".
    expect(wpis.wynik).toBe('konto-wylaczone');
    expect(wpis.login).toBe('pako');
  });

  it.each([
    ['zly login (nie ma go ani w tabeli, ani nie jest kontem z .env)', { uzytkownik: 'ktos-obcy', haslo: 'cokolwiek' }],
    ['zle haslo konta z tabeli', { uzytkownik: 'ewa', haslo: 'ZLE' }],
    ['konto wylaczone z DOBRYM haslem', { uzytkownik: 'pako', haslo: 'haslo-ok' }],
  ])('%s — ekran pokazuje TEN SAM komunikat, dziennik i tak rozroznia', async (_n, dane) => {
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'sekret123', rola: 'sprzedaz', admin: false });
    const idPako = zalozKonto(db, { login: 'pako', imie: 'Pakowanie', haslo: 'haslo-ok', rola: 'produkcja', admin: false });
    ustawCzynne(db, idPako, false);

    const r = await app.inject({ method: 'POST', url: '/login', headers: ORIGIN, payload: { ...dane, powrot: '/' } });

    expect(r.statusCode).toBe(401);
    // ⚠️ Komunikat NIE MOWI, ktore pole bylo zle ani czy konto istnieje/jest czynne —
    // z tego samego powodu, co przy koncie z `.env` (logowanie.js, `blad: 'zle-dane'`).
    expect(r.body).toContain('Nieprawidłowy login lub hasło');
  });

  // ⚠️⚠️ MUTACJA Z RECENZJI (druga fala 2026-09-12): stara regula w dzienniku pisala
  // „konto-wylaczone" gdy `zTabeli` istnialo i bylo NIECZYNNE — BEZ SPRAWDZENIA HASLA. Taka
  // regula przechodzila cala suite na zielono, bo test wyzej sprawdza WYLACZNIE galaz
  // z DOBRYM haslem. Tutaj haslo jest ZLE, a konto DODATKOWO wylaczone — dziennik ma mowic
  // „zle-haslo", bo to jest pierwsza rzecz, ktorej nie ustalilismy; „konto-wylaczone" ma
  // znaczyc „sprawdzilismy haslo i ono PASOWALO", nigdy „zgadujemy z automatu".
  it('konto WYLACZONE ZE ZLYM haslem loguje w dzienniku "zle-haslo", NIE "konto-wylaczone"', async () => {
    const id = zalozKonto(db, { login: 'pako', imie: 'Pakowanie', haslo: 'haslo-ok', rola: 'produkcja', admin: false });
    ustawCzynne(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: 'pako', haslo: 'ZUPELNIE-INNE', powrot: '/' },
    });

    expect(r.statusCode).toBe(401);
    const [wpis] = ostatnieLogowania(db, 1);
    expect(wpis.wynik).toBe('zle-haslo');
  });
});

// ⚠️⚠️ N2 (druga fala 2026-09-12): `bezpiecznyPowrot(req.url)` w straznik.js (galaz konta
// wylaczonego/sesji niewaznej) brala KAZDY adres, takze trasy WYLACZNIE POST-owe. Operator
// klikajacy „Wyloguj" na koncie, ktore wlasnie wylaczono, dostawal `/login?powrot=%2Fwyloguj`
// — a po zalogowaniu na inne konto ladowal `302 /wyloguj`, ktory przegladarka odwiedza
// GET-em (przekierowania zawsze ida GET-em), czyli `404` (trasa jest WYLACZNIE POST).
describe('N2 — adres powrotu przy koncie wylaczonym nie wraca na trase POST-owa', () => {
  it('/wyloguj na koncie WYLACZONYM przekierowuje na SAM /login, bez powrotu na siebie', async () => {
    const id = zalozKonto(db, { login: 'pako', imie: 'Pakowanie', haslo: 'h', rola: 'produkcja', admin: false });
    const ciastko = `${NAZWA_CIASTECZKA_OMS}=${podpisz('pako', odczytajSekret(db))}`;
    ustawCzynne(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/wyloguj',
      headers: { accept: 'text/html', cookie: ciastko, ...ORIGIN },
    });

    expect(r.statusCode).toBe(302);
    // ⚠️ PRZED poprawka: `/login?powrot=%2Fwyloguj`. Po zalogowaniu na inne konto operator
    // szedlby wtedy na `302 /wyloguj` → przegladarka idzie za nim GET-em → `404`.
    expect(r.headers.location).toBe('/login');
  });

  it('stary /wyloguj-wszystkie na wyłączonym koncie nie niesie powrotu na siebie', async () => {
    const id = zalozKonto(db, { login: 'pako', imie: 'Pakowanie', haslo: 'h', rola: 'produkcja', admin: false });
    const ciastko = `${NAZWA_CIASTECZKA_OMS}=${podpisz('pako', odczytajSekret(db))}`;
    ustawCzynne(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/wyloguj-wszystkie',
      headers: { accept: 'text/html', cookie: ciastko, ...ORIGIN },
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login');
  });
});

describe('globalna rotacja sesji', () => {
  it('stary adres jest niedostępny i nie obraca sekretu', async () => {
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const przed = odczytajSekret(db);

    const r = await app.inject({
      method: 'POST', url: '/wyloguj-wszystkie',
      headers: { accept: 'text/html', ...ORIGIN, cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('adam', przed)}` },
    });

    expect(r.statusCode).not.toBe(302);
    expect(odczytajSekret(db)).toBe(przed);
  });

  it('nieadministrator dostaje 403 przed jakimkolwiek skutkiem', async () => {
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const id = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawUprawnienia(db, id, ['ustawienia']);
    const przed = odczytajSekret(db);

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/wyloguj-wszystkie',
      headers: { accept: 'text/html', ...ORIGIN, cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('ewa', przed)}` },
    });

    expect(r.statusCode).toBe(403);
    expect(odczytajSekret(db)).toBe(przed);
  });

  it('administrator obraca wspólny sekret, czyści swoją sesję i wraca do logowania', async () => {
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const przed = odczytajSekret(db);

    const r = await app.inject({
      method: 'POST', url: '/ustawienia/konta/wyloguj-wszystkie',
      headers: { accept: 'text/html', ...ORIGIN, cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('adam', przed)}` },
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login');
    expect(String(r.headers['set-cookie'])).toContain(`${NAZWA_CIASTECZKA_OMS}=`);
    expect(odczytajSekret(db)).not.toBe(przed);
  });
});

// ⚠️⚠️ Punkt 5 (druga fala 2026-09-12, decyzja wlasciciela): `/login` ma odrzucac haslo
// z `.env`, gdy w tabeli jest juz czynny admin — inaczej takie ciasteczko otwiera 9 tras
// `/api/*` z zapisami, a udane logowanie serwisowe kasuje licznik prob zgadujacego.
describe('Punkt 5 — /login odrzuca haslo z .env, gdy jest juz czynny admin', () => {
  it('CZYNNY ADMIN W TABELI: dobre haslo z .env dostaje TAKA SAMA odmowe jak zle haslo', async () => {
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: config.auth.user, haslo: config.auth.pass, powrot: '/' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body).toContain('Nieprawidłowy login lub hasło');
    const [wpis] = ostatnieLogowania(db, 1);
    // ⚠️ Dziennik ROZROZNIA to od zwyklego zgadywania: administrator ma widziec, ze ktos
    // ZNA haslo serwisowe, nie ze zgaduje na slepo.
    expect(wpis.wynik).toBe('serwisowe-odrzucone');
  });

  it('ADMIN ISTNIEJE, ALE JEST WYLACZONY: .env dalej wpuszcza — bramka patrzy na CZYNNEGO', async () => {
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    ustawCzynne(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: config.auth.user, haslo: config.auth.pass, powrot: '/' },
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers['set-cookie']).toContain(`${NAZWA_CIASTECZKA_OMS}=`);
  });

  it('KONTO SPRZEDAZY BEZ ADMINA: .env dalej wpuszcza — liczy sie CZYNNY ADMIN, nie "jakiekolwiek konto"', async () => {
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: config.auth.user, haslo: config.auth.pass, powrot: '/' },
    });

    expect(r.statusCode).toBe(302);
  });

  it('PUSTA TABELA: .env dalej wpuszcza — jedyna droga pierwszego uruchomienia', async () => {
    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: config.auth.user, haslo: config.auth.pass, powrot: '/' },
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers['set-cookie']).toContain(`${NAZWA_CIASTECZKA_OMS}=`);
  });

  it('ADMIN ODEBRANY FLAGA (ustawAdmina false): .env znowu wpuszcza, brama sledzi STAN, nie historie', async () => {
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    ustawAdmina(db, id, false);

    const r = await app.inject({
      method: 'POST', url: '/login', headers: ORIGIN,
      payload: { uzytkownik: config.auth.user, haslo: config.auth.pass, powrot: '/' },
    });

    expect(r.statusCode).toBe(302);
  });
});

// ⚠️⚠️ N4 / mutacja z recenzji (druga fala 2026-09-12): usuniecie `?? ATRAPA_HASLA` w
// logowanie.js sprawia, ze dla konta NIEISTNIEJACEGO `zgodneHaslo` dostaje `undefined` zamiast
// haszu i konczy sie natychmiast, bez scryptu — WRACA dokladnie ten sam kanal czasowy, ktory
// ATRAPA_HASLA mial zamknac (mozna zgadnac, ktore loginy istnieja, z samego czasu odpowiedzi).
// Test byl trudny i dlatego go nie bylo — zrobiony mimo to, ale ODPORNIE (patrz margines nizej).
describe('N4 — kanał czasowy: konto istniejące ze złym hasłem vs nieistniejące', () => {
  // ⚠️ Margines jest SZEROKI (60%, nie 90-95%) CELOWO. Zmierzone na tej maszynie:
  // PO poprawce oba przypadki ~44 ms (roznica 0,2 ms — scrypt liczy sie ZAWSZE, dla obu).
  // PRZED poprawka (mutacja opisana wyzej): 47,6 ms (istniejace) wobec 6,8 ms (nieistniejace)
  // — 14% z 47,6. 60% wiec lezy WYSOKO nad szumem PO poprawce (~99,5%) i WYSOKO nad wynikiem
  // PRZED nia (14%) — odroznia oba stany bez migotania na wolniejszym/obciazonym CI. NIE
  // DOCIAGAC tego do 90-95%: zwykly szum pomiaru (GC, planista systemu) zaczalby wtedy dawac
  // czerwien bez zadnej regresji w kodzie — to WLASNIE dlatego ten test wczesniej nie istnial.
  //
  // ⚠️ Hamulec kluczuje po `req.ip` — KAZDA proba idzie z INNEGO adresu (remoteAddress),
  // inaczej piata proba zapalalaby kare i mierzylibysmy czas odpowiedzi 429 (bez scryptu),
  // nie 401.
  it('login nieistniejący trwa co najmniej 60% czasu loginu istniejącego ze złym hasłem', async () => {
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'sekret123', rola: 'sprzedaz', admin: false });

    const PROBY = 5;
    const zmierzMediane = async (uzytkownik, pasmoIp) => {
      const czasyMs = [];
      for (let i = 0; i < PROBY; i += 1) {
        const start = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        await app.inject({
          method: 'POST', url: '/login', headers: ORIGIN,
          remoteAddress: `10.77.${pasmoIp}.${i + 1}`,
          payload: { uzytkownik, haslo: 'ZUPELNIE-INNE-HASLO', powrot: '/' },
        });
        czasyMs.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      czasyMs.sort((a, b) => a - b);
      return czasyMs[Math.floor(czasyMs.length / 2)];
    };

    const medianaIstniejace = await zmierzMediane('ewa', 1);
    const medianaNieistniejace = await zmierzMediane('konto-ktorego-nie-ma', 2);

    expect(medianaNieistniejace).toBeGreaterThanOrEqual(medianaIstniejace * 0.6);
  });
});
