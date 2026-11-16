// Ekran logowania z marką Twój OMS: formularz po lewej, zielona połowa marki po prawej.
// W demo publicznym gość wchodzi jednym przyciskiem (bez pól), a formularz konta stoi tylko pod /login?konto.
// Produkcja: formularz, nazwa firmy z adresu nadawcy, zdanie o sieci lokalnej i 90 dniach.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA } from '../../../src/core/bezpieczenstwo/sesja.js';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const LOGIN = 'gosc';
const HASLO = 'pokaz-demo-2026';
const wspolne = { OMS_USER: 'serwis', OMS_PASS: 'serwis-haslo', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const envDemo = { ...ENV_DEMO, ...wspolne, OMS_DEMO_LOGIN: LOGIN, OMS_DEMO_HASLO: HASLO };
const envProdukcja = { ...ENV_DEMO, ...wspolne, OMS_TRYB: 'produkcja', DPD_NADAWCA_NAZWA: 'Lampy Zenit sp. z o.o.' };
const bezAdresu = { DPD_NADAWCA_NAZWA: '', DPD_NADAWCA_ULICA: '', DPD_NADAWCA_KOD: '', DPD_NADAWCA_MIASTO: '' };
const origin = { origin: 'http://localhost' };

afterEach(() => vi.unstubAllGlobals());

async function panel(env) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
  const a = await zbudujOms({ env });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'admin-haslo-123', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: LOGIN, imie: 'Gość demo', haslo: HASLO, rola: 'sprzedaz' });
  return a;
}
const strona = async (a, url) => { const r = await a.app.inject(url); expect(r.statusCode, r.body).toBe(200); return r.body; };
const ciasteczko = (r) => [].concat(r.headers['set-cookie'] ?? [])
  .find((c) => [NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA].some((n) => c.startsWith(`${n}=`)));
// Pola formularza tak, jak wysłałaby je przeglądarka: wartości ukryte i wpisane z HTML-a jednego <form>.
function polaFormularza(html, znacznik) {
  const form = html.split('<form').slice(1).map((f) => f.split('</form>')[0]).find((f) => f.includes(znacznik));
  expect(form, `brak formularza z „${znacznik}”`).toBeTruthy();
  return Object.fromEntries([...form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

describe('ekran logowania — produkcja', () => {
  it('logo Twój OMS, formularz, nazwa firmy po prawej i dwa zdania stopki', async () => {
    const html = await strona(await panel(envProdukcja), '/login');
    expect(html).toContain('/public/twojoms-logo.svg');
    expect(html).toContain('oms-logowanie.css');
    expect(html).toContain('<h1>Zaloguj się</h1>');
    expect(html).toContain('name="uzytkownik"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Lampy Zenit sp. z o.o.');
    expect(html).toContain('Panel zamówień');
    expect(html).toContain('wyłącznie w&nbsp;sieci lokalnej');
    expect(html).toContain('90&nbsp;dni');
    expect(html).not.toContain('Wejdź do demo');
    expect(html).not.toContain('Darmowy system do obsługi zamówień');
  });

  it('bez nazwy firmy w pliku i w Ustawieniach: sam napis „Panel zamówień”', async () => {
    const html = await strona(await panel({ ...envProdukcja, ...bezAdresu }), '/login');
    expect(html).toMatch(/<h2 class="lg-haslo">Panel zamówień<\/h2>/);
    expect(html).not.toContain('lg-znacznik-marki');
  });

  it('złe hasło: ten sam ekran z komunikatem, bez wskazania pola', async () => {
    const a = await panel(envProdukcja);
    const r = await a.app.inject({ method: 'POST', url: '/login', headers: origin, payload: { uzytkownik: 'adam', haslo: 'zle', powrot: '/' } });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain('Nieprawidłowy login lub hasło.');
    expect(r.body).toContain('type="password"');
  });

  it('krój i logo dostępne bez logowania', async () => {
    const a = await panel(envProdukcja);
    const logo = await a.app.inject('/public/twojoms-logo.svg');
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toMatch(/image\/svg\+xml/);
    for (const plik of ['schibsted-grotesk-latin.woff2', 'schibsted-grotesk-latin-ext.woff2']) {
      const r = await a.app.inject(`/public/fonts/${plik}`);
      expect(r.statusCode, plik).toBe(200);
    }
  });
});

describe('ekran logowania — demo publiczne', () => {
  it('przycisk „Wejdź do demo” bez pól do wpisania; bez zdań o 90 dniach i o gościu', async () => {
    const html = await strona(await panel(envDemo), '/login');
    expect(html).toContain('Wejdź do demo');
    expect(html).toContain('Zobacz panel od środka');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('90&nbsp;dni');
    expect(html).not.toContain('wyłącznie w');
    expect(html).not.toContain('Wchodzisz jako gość');
    expect(html).not.toContain('Zaloguj się innym kontem');
    expect(html).toContain('Darmowy system do obsługi zamówień z&nbsp;otwartym kodem.');
    expect(html).toContain('href="https://twojoms.pl"');
    expect(html).toContain('href="https://github.com/TwojOMS/twoj-oms"');
    // Programy do faktur z katalogu integracji (dostępne, bez KSeF).
    expect(html).toContain('<dd>inFakt albo Fakturownia, wysyłka do KSeF</dd>');
  });

  it('nazwa firmy demo bez dopisku „(demo)” i reset z konfiguracji', async () => {
    const html = await strona(await panel(envDemo), '/login');
    expect(html).toContain('Firma „Pracownia Półcień” i&nbsp;jej zamówienia są zmyślone.');
    expect(html).toContain('wszystko wraca do stanu początkowego co godzinę.');
  });

  it('przycisk loguje gościa: pola ukryte formularza wystarczą', async () => {
    const a = await panel(envDemo);
    const pola = polaFormularza(await strona(a, '/login'), 'Wejdź do demo');
    expect(pola).toMatchObject({ uzytkownik: LOGIN, haslo: HASLO });
    const r = await a.app.inject({ method: 'POST', url: '/login', headers: origin, payload: pola });
    expect(r.statusCode, r.body).toBe(302);
    expect(ciasteczko(r)).toBeTruthy();
  });

  it('/login?konto: zwykły formularz dla administratora, bez przycisku gościa', async () => {
    const a = await panel(envDemo);
    const html = await strona(a, '/login?konto');
    expect(html).toContain('<h1>Zaloguj się</h1>');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Wejdź do demo');
    expect(html).not.toContain('wyłącznie w');
    const pola = { ...polaFormularza(html, 'type="password"'), uzytkownik: 'adam', haslo: 'admin-haslo-123' };
    const r = await a.app.inject({ method: 'POST', url: '/login', headers: origin, payload: pola });
    expect(r.statusCode, r.body).toBe(302);
  });

  it('złe hasło w formularzu konta wraca do formularza, nie do przycisku gościa', async () => {
    const a = await panel(envDemo);
    const pola = { ...polaFormularza(await strona(a, '/login?konto'), 'type="password"'), uzytkownik: 'adam', haslo: 'zle' };
    const r = await a.app.inject({ method: 'POST', url: '/login', headers: origin, payload: pola });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain('Nieprawidłowy login lub hasło.');
    expect(r.body).toContain('type="password"');
    expect(r.body).not.toContain('Wejdź do demo');
  });

  it('termin resetu instancji zostaje na ekranie (pasek demo poznaje po nim restart)', async () => {
    const html = await strona(await panel({ ...envDemo, DEMO_RESET_PLANOWY: '2026-11-16T21:00:00.000Z' }), '/login');
    expect(html).toContain('data-demo-reset="2026-11-16T21:00:00.000Z"');
  });
});
