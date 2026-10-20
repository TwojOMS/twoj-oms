// PRZ-102.09: daty kompletności danych (podłoga kosztów, początek zwrotów, pierwszy dzień statystyk) w panelu —
// Finanse → Kompletność danych. Plik konfiguracji wygrywa (409), zapis tylko administrator, działa bez restartu.
import { it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}`, origin: 'http://localhost' };
const url = '/finanse?od=2026-05-01&do=2026-05-31';
async function zapisz(app: any, klucz: string, wartosc: string, h: Record<string, string> = headers, reszta: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/finanse/pokrycie', headers: h, payload: { klucz, wartosc, ...reszta } });
}
const zapisyRaportow = (z: any) => z.db.prepare("SELECT COUNT(*) AS n FROM ustawienia WHERE klucz LIKE 'raporty.%'").get()?.n;
async function zaloguj(z: any, login: string, uprawnienia: string[] | null) {
  const id = zalozKonto(z.db, { login, imie: 'Operator', haslo: 'fixture', rola: 'sprzedaz' });
  if (uprawnienia) ustawUprawnienia(z.db, id, uprawnienia);
  const odp = await z.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost' }, payload: { uzytkownik: login, haslo: 'fixture' } });
  return { cookie: String(odp.headers['set-cookie']).split(';')[0], origin: 'http://localhost' };
}

it('bez env odmowa Finansów pyta o miesiąc wprost; zapis administratora liczy od maja bez restartu', async () => {
  const z = await zbudujOms({ env });
  try {
    const brak = await z.app.inject({ url, headers });
    expect(brak.statusCode).toBe(400);
    expect(brak.body).toContain('Od którego miesiąca koszty w OMS-ie są kompletne?');
    expect(brak.body).toContain('action="/finanse/pokrycie"');
    expect(brak.body).toContain('name="klucz" value="podlogaKosztow"');
    expect(brak.body).toContain('href="/finanse/pokrycie"');
    expect(brak.headers['content-type']).toContain('text/html'); // ekran panelu, nie samo zdanie w text/plain
    // Formularz z ekranu odmowy wraca na ten sam adres Finansów.
    const zapis = await zapisz(z.app, 'podlogaKosztow', '2026-05', headers, { powrot: url });
    expect(zapis.statusCode).toBe(303);
    expect(zapis.headers.location).toBe(url);
    const maj = await z.app.inject({ url, headers });
    expect(maj.statusCode).toBe(200);
    expect(maj.body).toContain('Rachunek zaczyna się od <strong>2026-05</strong>');
    const kwiecien = await z.app.inject({ url: '/finanse?od=2026-04-01&do=2026-04-30', headers });
    expect(kwiecien.statusCode).toBe(400);
    expect(kwiecien.body).toContain('Rachunek zarządczy zaczyna się od 2026-05');
    expect(z.db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get('raporty.podlogaKosztow')?.wartosc).toBe('2026-05');
    // Zmiana z panelu działa od następnego żądania — ta sama instancja, bez restartu.
    expect((await zapisz(z.app, 'podlogaKosztow', '2026-04')).headers.location).toBe('/finanse/pokrycie?zapisano=1');
    expect((await z.app.inject({ url: '/finanse?od=2026-04-01&do=2026-04-30', headers })).statusCode).toBe(200);
  } finally { await z.app.close(); z.db.close(); }
});

it('powrót po zapisie tylko na /finanse — obcy adres kończy na ekranie kompletności danych', async () => {
  const z = await zbudujOms({ env });
  try {
    for (const powrot of ['//zly.example/finanse', 'https://zly.example/', '/finansex', '/ustawienia']) {
      const odp = await zapisz(z.app, 'podlogaKosztow', '2026-05', headers, { powrot });
      expect(odp.statusCode).toBe(303);
      expect(odp.headers.location).toBe('/finanse/pokrycie?zapisano=1');
    }
  } finally { await z.app.close(); z.db.close(); }
});

for (const [klucz, nazwa, wartosc] of [
  ['podlogaKosztow', 'OMS_RAPORTY_PODLOGA_KOSZTOW', '2026-05'],
  ['podlogaZwrotow', 'OMS_RAPORTY_PODLOGA_ZWROTOW', '2026-05-02'],
  ['pierwszyDzienOms', 'OMS_STATYSTYKI_PIERWSZY_DZIEN', '2026-05-03'],
]) {
  it(`${klucz}: env wygrywa nad zapisem w bazie i odmawia zapisu 409`, async () => {
    const z = await zbudujOms({ env: { ...env, [nazwa]: wartosc } });
    try {
      z.db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run(`raporty.${klucz}`, klucz === 'podlogaKosztow' ? '2026-01' : '2026-01-01', new Date().toISOString());
      const odmowa = await zapisz(z.app, klucz, klucz === 'podlogaKosztow' ? '2026-06' : '2026-06-01');
      expect(odmowa.statusCode).toBe(409);
      expect(odmowa.body).toContain(nazwa);
      expect(z.db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`raporty.${klucz}`)?.wartosc).not.toContain('2026-06');
      const ekran = await z.app.inject({ url: '/finanse/pokrycie', headers });
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).toContain(`value="${wartosc}"`);
      expect(ekran.body).toContain(`plik konfiguracji — ${nazwa}`);
      // Wartość z env jest tą, którą liczą ekrany — zapis w bazie nie przeważa.
      if (klucz === 'podlogaKosztow') {
        const przed = await z.app.inject({ url: '/finanse?od=2026-04-01&do=2026-04-30', headers });
        expect(przed.statusCode).toBe(400);
        expect(przed.body).toContain('zaczyna się od 2026-05');
      } else if (klucz === 'podlogaZwrotow') {
        expect((await z.app.inject({ url: '/raporty?od=2026-05-01&do=2026-05-01', headers })).body).toContain('od 2026-05-02');
      } else {
        expect((await z.app.inject({ url: '/statystyki?od=2026-05-01&do=2026-05-31', headers })).body).toContain('3.05.2026');
      }
    } finally { await z.app.close(); z.db.close(); }
  });
}

it('daty zwrotów i statystyk działają w tej samej instancji po zapisie', async () => {
  const z = await zbudujOms({ env });
  try {
    const raportPrzed = await z.app.inject({ url: '/raporty?od=2026-05-01&do=2026-05-01', headers });
    expect(raportPrzed.statusCode).toBe(200);
    expect(raportPrzed.body).toContain('brak danych</strong> o początku rejestru zwrotów');
    const statPrzed = await z.app.inject({ url: '/statystyki?od=2026-05-01&do=2026-05-31', headers });
    expect(statPrzed.statusCode).toBe(200);
    // Pusta baza bez daty: pasek wskazuje panel (plik jako druga droga) i nie zna 3.05.
    expect(statPrzed.body).toContain('<a href="/finanse/pokrycie">Kompletność danych</a>');
    expect(statPrzed.body).not.toContain('3.05.2026');
    expect((await zapisz(z.app, 'podlogaZwrotow', '2026-05-02')).statusCode).toBe(303);
    expect((await zapisz(z.app, 'pierwszyDzienOms', '2026-05-03')).statusCode).toBe(303);
    const raport = await z.app.inject({ url: '/raporty?od=2026-05-01&do=2026-05-01', headers });
    expect(raport.statusCode).toBe(200);
    expect(raport.body).toContain('od 2026-05-02');
    const stat = await z.app.inject({ url: '/statystyki?od=2026-05-01&do=2026-05-31', headers });
    expect(stat.statusCode).toBe(200);
    expect(stat.body).toContain('3.05.2026');
    const ekran = await z.app.inject({ url: '/finanse/pokrycie?zapisano=1', headers });
    expect(ekran.body).toContain('value="2026-05-02"');
    expect(ekran.body).toContain('Źródło: panel OMS');
  } finally { await z.app.close(); z.db.close(); }
});

it('nieadministrator z prawem do Finansów widzi prośbę do admina i dostaje 403 przy zapisie', async () => {
  const z = await zbudujOms({ env });
  try {
    const h = await zaloguj(z, 'sprzedawca', ['finanse']);
    const odmowa = await z.app.inject({ url, headers: h });
    expect(odmowa.statusCode).toBe(400);
    expect(odmowa.body).toContain('Poproś administratora');
    expect(odmowa.body).not.toContain('action="/finanse/pokrycie"');
    const ekran = await z.app.inject({ url: '/finanse/pokrycie', headers: h });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('Poproś administratora');
    expect(ekran.body).not.toContain('action="/finanse/pokrycie"');
    expect((await zapisz(z.app, 'podlogaKosztow', '2026-05', h)).statusCode).toBe(403);
    expect(zapisyRaportow(z)).toBe(0);
  } finally { await z.app.close(); z.db.close(); }
});

it('konto bez prawa do Finansów nie widzi ekranu i nie zapisuje', async () => {
  const z = await zbudujOms({ env });
  try {
    const h = await zaloguj(z, 'magazyn', null);
    expect((await z.app.inject({ url: '/finanse/pokrycie', headers: h })).statusCode).toBe(403);
    expect((await zapisz(z.app, 'podlogaKosztow', '2026-05', h)).statusCode).toBe(403);
    expect(zapisyRaportow(z)).toBe(0);
  } finally { await z.app.close(); z.db.close(); }
});

for (const [klucz, wartosc] of [['podlogaKosztow', '2026-13'], ['podlogaKosztow', '2026-05-01'], ['podlogaZwrotow', '2026-02-30'], ['pierwszyDzienOms', '2026-05'], ['obcy', '2026-05'], ['podlogaKosztow', '']]) {
  it(`odrzuca ${klucz}=${wartosc} kodem 400 bez zapisu`, async () => {
    const z = await zbudujOms({ env });
    try {
      expect((await zapisz(z.app, klucz, wartosc)).statusCode).toBe(400);
      expect(zapisyRaportow(z)).toBe(0);
    } finally { await z.app.close(); z.db.close(); }
  });
}
