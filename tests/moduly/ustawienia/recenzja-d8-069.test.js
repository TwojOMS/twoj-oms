// PRZ-069 — poprawki po recenzji D8 r1 (P1-1 i P3 1–7). Każdy test był czerwony przed poprawką.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { utworzHamulec, KARA_MS } from '../../../src/core/bezpieczenstwo/hamulec.js';
import { wydajLink, aktywnyLink, uzyjLinku } from '../../../src/moduly/ustawienia/linki-hasla.js';
import { nowyPanel, jako, get, post, CONFIG } from '../../pomoc/konta-prz068.js';

const ADRES = 'https://panel.example.test';
const NOWE = { nowe: 'nowe-haslo-12345', nowe2: 'nowe-haslo-12345' };
const tokenZ = (t) => /\/haslo\/([A-Za-z0-9_-]{43})/.exec(t)?.[1];
const atrapa = () => ({ sendMail: vi.fn(async () => ({ messageId: 'atrapa' })) });
const teraz = () => new Date();

/**
 * Co prawdziwa przeglądarka wysyła przy zwykłym POST formularza na TEN SAM origin ze strony z danym
 * `Referrer-Policy`. ZMIERZONE 14.10.2026 w Chromium 149.0.7827.55 i Edge 155.0.4283.45 (serwer pomiarowy,
 * tabela w docs/prz069-odbior.md, „Recenzja D8 r1”). `app.inject` sam z siebie nie wie nic o polityce —
 * bez tego modelu testy dokładały gotowy Origin i nie widziały, że `no-referrer` daje `Origin: null` → 403.
 */
function naglowkiPrzegladarki(polityka, adresStrony) {
  const u = new URL(adresStrony);
  switch (polityka) {
    case 'no-referrer': return { origin: 'null' };
    case 'strict-origin': case 'origin': return { origin: u.origin, referer: `${u.origin}/` };
    case undefined: case 'same-origin': case 'strict-origin-when-cross-origin': case 'no-referrer-when-downgrade':
      return { origin: u.origin, referer: u.href };
    default: throw Error(`polityka spoza pomiaru: ${polityka}`);
  }
}

function panel({ env = {}, mailer = null } = {}) {
  const p = nowyPanel({ env, ...(mailer ? { nadpisania: { 'wiadomosci.mailer': mailer } } : {}) });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const id = zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
  const link = () => wydajLink(p.db, { kontoId: id, cel: 'reset', utworzylKontoId: null, teraz }).token;
  return { ...p, id, link, admin: jako(p.db, 'adam') };
}
const aktywne = (db, id) => db.prepare('SELECT count(*) AS n FROM linki_hasla WHERE konto_id = ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL').get(id).n;

describe('P1-1: Referrer-Policy stron z linkiem a CSRF po Origin (przeglądarka, nie app.inject)', () => {
  it('/haslo/:token — POST z nagłówkami, jakie przeglądarka wyśle przy polityce strony, ustawia hasło; Referer bez tokenu', async () => {
    const { db, app, link } = panel();
    const token = link();
    const strona = await get(app, `/haslo/${token}`, { host: 'localhost' });
    expect(strona.statusCode).toBe(200);
    const polityka = strona.headers['referrer-policy'];
    expect(polityka).toBe('strict-origin');
    const przegladarka = naglowkiPrzegladarki(polityka, `http://localhost/haslo/${token}`);
    expect(String(przegladarka.referer ?? '')).not.toContain(token);
    const r = await app.inject({ method: 'POST', url: `/haslo/${token}`, headers: { accept: 'text/html', host: 'localhost', ...przegladarka }, payload: NOWE });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login?haslo=ustawione');
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(1);
  });

  it('CSRF nie osłabiony: Origin „null” (np. polityka no-referrer albo sandbox) dalej 403, hasło bez zmian', async () => {
    const { db, app, link } = panel();
    const token = link();
    const r = await app.inject({ method: 'POST', url: `/haslo/${token}`, headers: { accept: 'text/html', host: 'localhost', origin: 'null', referer: `http://localhost/haslo/${token}` }, payload: NOWE });
    expect(r.statusCode).toBe(403);
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(0);
    expect(aktywnyLink(db, token, teraz)).not.toBeNull();
  });

  it('strona „Pokaż link”: kolejny formularz z tej strony przechodzi CSRF', async () => {
    const { db, app, id, admin } = panel();
    const strona = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    expect(strona.statusCode).toBe(200);
    expect(strona.headers['cache-control']).toBe('no-store');
    const polityka = strona.headers['referrer-policy'];
    expect(polityka).toBe('strict-origin');
    const przegladarka = naglowkiPrzegladarki(polityka, `http://localhost/ustawienia/konta/${id}/link`);
    const r = await app.inject({ method: 'POST', url: `/ustawienia/konta/${id}/email`, headers: { accept: 'text/html', host: 'localhost', ...admin, ...przegladarka }, payload: { email: 'ewa@example.test' } });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT email FROM konta_email WHERE konto_id = ?').get(id).email).toBe('ewa@example.test');
  });
});

describe('P3-1: zmiana hasła inną drogą unieważnia linki', () => {
  it('/konto/haslo (własne hasło) unieważnia nieużyty link', async () => {
    const { db, app, id, link } = panel();
    const token = link();
    const r = await post(app, '/konto/haslo', jako(db, 'ewa'), { obecne: 'stare-haslo-123', nowe: 'inne-haslo-12345', nowe2: 'inne-haslo-12345' });
    expect(r.statusCode).toBe(302);
    expect(aktywne(db, id)).toBe(0);
    expect((await get(app, `/haslo/${token}`)).statusCode).toBe(410);
  });

  it('stara trasa admina /ustawienia/konta/:id/haslo unieważnia nieużyty link', async () => {
    const { db, app, id, link, admin } = panel();
    const token = link();
    expect((await post(app, `/ustawienia/konta/${id}/haslo`, admin, { haslo: 'haslo-od-admina-1' })).statusCode).toBe(302);
    expect(aktywne(db, id)).toBe(0);
    expect((await get(app, `/haslo/${token}`)).statusCode).toBe(410);
  });
});

describe('P3-2 i P3-5: wysyłka mailem nie zabija poprzedniego linku przed udaną wysyłką', () => {
  it('błąd SMTP: nowy link wycofany, poprzedni nadal działa, komunikat mówi to wprost', async () => {
    const mailer = { sendMail: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const { db, app, id, admin } = panel({ env: { OMS_ADRES_PANELU: ADRES }, mailer });
    db.prepare("INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (?, 'ewa@example.test', 'x')").run(id);
    const pokaz = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    const poprzedni = tokenZ(pokaz.body);
    const r = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'mail' });
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('Nie udało się wysłać maila');
    expect(r.body).toContain('Poprzedni link, jeśli był, nadal działa');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const wyslany = tokenZ(mailer.sendMail.mock.calls[0][0].text);
    expect(aktywnyLink(db, wyslany, teraz)).toBeNull();
    expect(aktywne(db, id)).toBe(1);
    expect((await get(app, `/haslo/${poprzedni}`)).statusCode).toBe(200);
  });

  it('udana wysyłka: poprzedni link unieważniony dopiero po niej, aktywny jest wyłącznie wysłany', async () => {
    const mailer = atrapa();
    const { db, app, id, admin } = panel({ env: { OMS_ADRES_PANELU: ADRES }, mailer });
    db.prepare("INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (?, 'ewa@example.test', 'x')").run(id);
    const poprzedni = tokenZ((await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' })).body);
    const r = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'mail' });
    expect(r.statusCode).toBe(302);
    const wyslany = tokenZ(mailer.sendMail.mock.calls[0][0].text);
    expect(aktywne(db, id)).toBe(1);
    expect(aktywnyLink(db, wyslany, teraz)).not.toBeNull();
    expect(aktywnyLink(db, poprzedni, teraz)).toBeNull();
  });

  it('dwa aktywne linki naraz (okno wysyłki maila): użycie jednego unieważnia drugi', () => {
    const { db, id } = panel();
    const pierwszy = wydajLink(db, { kontoId: id, cel: 'reset', teraz }).token;
    const drugi = wydajLink(db, { kontoId: id, cel: 'reset', teraz, zastapPoprzednie: false }).token;
    expect(aktywne(db, id)).toBe(2);
    expect(uzyjLinku(db, { token: pierwszy, haslo: 'nowe-haslo-12345', teraz })).toEqual({ login: 'ewa' });
    expect(aktywnyLink(db, drugi, teraz)).toBeNull();
    expect(aktywne(db, id)).toBe(0);
  });
});

describe('P3-3: hamulec /haslo/ — zerowanie, wygaszanie, przycinanie', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('udane użycie linku zeruje licznik prób', async () => {
    const { app, link } = panel();
    const zly = 'x'.repeat(43);
    for (let i = 1; i <= 4; i++) expect((await get(app, `/haslo/${zly}`)).statusCode, `próba ${i}`).toBe(410);
    expect((await post(app, `/haslo/${link()}`, {}, NOWE)).statusCode).toBe(302);
    for (let i = 1; i <= 4; i++) expect((await get(app, `/haslo/${zly}`)).statusCode, `po użyciu ${i}`).toBe(410);
    expect((await get(app, `/haslo/${zly}`)).statusCode).toBe(429);
  });

  it('po wygaśnięciu kary licznik startuje od zera (nie każda kolejna pomyłka = nowa kara)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    const { app } = panel();
    const zly = 'x'.repeat(43);
    for (let i = 1; i <= 4; i++) await get(app, `/haslo/${zly}`);
    expect((await get(app, `/haslo/${zly}`)).statusCode).toBe(429);
    vi.setSystemTime(new Date(Date.now() + KARA_MS + 1000));
    expect((await get(app, `/haslo/${zly}`)).statusCode).toBe(410);
  });

  it('hamulec z wygasaniem: martwe wpisy znikają, mapa nie rośnie ponad maksKluczy', () => {
    const T = 1_770_000_000_000;
    const h = utworzHamulec({ wygasanieMs: KARA_MS, maksKluczy: 3 });
    for (let i = 0; i < 10; i++) h.odnotujBlad(`10.0.0.${i}`, T + i);
    expect(h.rozmiar()).toBeLessThanOrEqual(3);
    h.odnotujBlad('10.0.1.1', T + 2 * KARA_MS);
    expect(h.rozmiar()).toBe(1);
    expect(h.proby('10.0.0.9')).toBe(0);
  });

  it('hamulec bez opcji (logowanie) zachowuje się po staremu: po karze następna pomyłka od razu karze', () => {
    const T = 1_770_000_000_000;
    const h = utworzHamulec();
    for (let i = 0; i < 5; i++) h.odnotujBlad('ip', T);
    h.odnotujBlad('ip', T + KARA_MS + 1);
    expect(h.sprawdz('ip', T + KARA_MS + 2).wolno).toBe(false);
  });
});

describe('P3-4: login konta serwisowego z .env jest zarezerwowany', () => {
  for (const login of [CONFIG.auth.user, CONFIG.auth.user.toUpperCase()]) {
    it(`zaproszenie z loginem „${login}” → 400, konto nie powstaje`, async () => {
      const { db, app, admin } = panel();
      const r = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'X', login, email: '', rola: 'produkcja', sposob: 'pokaz' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('zarezerwowany dla konta serwisowego');
      expect(kontoPoLoginie(db, login)).toBeNull();
    });
  }

  it('stara trasa /nowe z hasłem: login serwisowy → 400', async () => {
    const { db, app, admin } = panel();
    const r = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'X', login: CONFIG.auth.user, haslo: 'haslo-ok-12345', rola: 'produkcja' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('zarezerwowany dla konta serwisowego');
    expect(kontoPoLoginie(db, CONFIG.auth.user)).toBeNull();
  });
});

describe('P3-6: wyścig o ten sam e-mail albo login → 400, nie 500', () => {
  // Wyzwalacz wstawia ten sam adres „między” sprawdzeniem w kodzie a INSERT — tak jak drugi proces na tej samej bazie.
  const wyscigEmail = (db, kontoId, email) => db.exec(`CREATE TEMP TRIGGER wyscig BEFORE INSERT ON konta_email WHEN NEW.email = '${email}'
    BEGIN INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (${kontoId}, NEW.email, 'x'); END`);

  it('zaproszenie: e-mail zajęty w wyścigu → 400 z tym samym komunikatem, konto nie powstaje', async () => {
    const { db, app, admin } = panel();
    wyscigEmail(db, kontoPoLoginie(db, 'adam').id, 'nowa@example.test');
    const r = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowa', login: 'nowa', email: 'nowa@example.test', rola: 'produkcja', sposob: 'pokaz' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Ten adres e-mail ma już inne konto.');
    expect(kontoPoLoginie(db, 'nowa')).toBeNull();
  });

  it('e-mail konta: zajęty w wyścigu → 400', async () => {
    const { db, app, id, admin } = panel();
    wyscigEmail(db, kontoPoLoginie(db, 'adam').id, 'ewa@example.test');
    const r = await post(app, `/ustawienia/konta/${id}/email`, admin, { email: 'ewa@example.test' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Ten adres e-mail ma już inne konto.');
  });

  it('zaproszenie: login zajęty w wyścigu → 400 z tym samym komunikatem co kontrola w kodzie', async () => {
    const { db, app, admin } = panel();
    db.exec(`CREATE TEMP TRIGGER wyscig BEFORE INSERT ON konta WHEN NEW.login = 'nowa' AND NEW.imie <> 'drugi'
      BEGIN INSERT INTO konta (login, imie, hash_hasla, rola, czynne, admin, utworzone_at) VALUES ('nowa', 'drugi', 'x', 'produkcja', 1, 0, 'x'); END`);
    const r = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowa', login: 'nowa', email: '', rola: 'produkcja', sposob: 'pokaz' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Login „nowa” jest już zajęty przez inne konto — wybierz inny.');
  });
});

describe('P3-7: kształt tokenu i prefiks otwarty', () => {
  it('token o złym kształcie nie pasuje, nawet gdy jego skrót jest w bazie', () => {
    const { db, id } = panel();
    const krotki = 'abc';
    db.prepare(`INSERT INTO linki_hasla (konto_id, hash_tokenu, cel, utworzone_at, wygasa_at) VALUES (?, ?, 'reset', ?, ?)`)
      .run(id, createHash('sha256').update(krotki).digest('hex'), new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());
    expect(aktywnyLink(db, krotki, teraz)).toBeNull();
  });

  it('GET /haslo/<token> bez sesji daje formularz, nie przekierowanie na /login', async () => {
    const { app, link } = panel();
    const r = await get(app, `/haslo/${link()}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers.location).toBeUndefined();
    expect(r.body).toContain('name="nowe"');
  });
});
