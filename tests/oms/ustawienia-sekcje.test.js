import { beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';
import { zalozKonto, ustawUprawnienia } from '../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';

const CONFIG = { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] };
const BASIC = { authorization: `Basic ${Buffer.from('serwis:haslo-env').toString('base64')}` };
const ORIGIN = { origin: 'http://localhost' };

let db;
let app;

const fragmentGlownejKolumny = (html) => html.slice(html.indexOf('<main class="kolumna-glowna">'));
const jako = (login) => ({ cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, odczytajSekret(db))}` });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: CONFIG,
    lacznosc: { sprawdz: async () => [] },
    stanyKanalow: () => [{
      kanal: 'allegro_szkicownia', pilne: false, uprzedzenie: false, zostaloDni: 21,
      kontoAllegro: 'szkicownia-pl', powod: null, wolnoWiazac: false,
    }],
  });
  await app.ready();
});

describe('pięć sekcji Ustawień', () => {
  it('wejście /ustawienia prowadzi do Zamówień i wysyłki', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia', headers: BASIC });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/zamowienia-i-wysylka');
  });

  it('nie wyświetla dowolnej treści z parametru potwierdzenia', async () => {
    const r = await app.inject({
      method: 'GET', url: '/ustawienia/zamowienia-i-wysylka?zapisano=%3Cscript%3Eobcy%3C%2Fscript%3E', headers: BASIC,
    });

    expect(r.statusCode).toBe(200);
    expect(fragmentGlownejKolumny(r.body)).not.toContain('&lt;script&gt;obcy&lt;/script&gt;');
  });

  it('sekcja wysyłkowa zawiera komplet paczki i kosztów, bez kontrolek z innych sekcji', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/zamowienia-i-wysylka', headers: BASIC });
    const tresc = fragmentGlownejKolumny(r.body);

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>Zamówienia i wysyłka</title>');
    expect(tresc).toContain('<h1>Zamówienia i wysyłka</h1>');
    for (const pole of ['waga', 'dlugosc', 'szerokosc', 'wysokosc', 'dpd', 'inpost_paczkomat', 'odbior_osobisty']) {
      expect(tresc).toContain(`name="${pole}"`);
    }
    expect(tresc).not.toContain('name="tresc"');
    expect(tresc).not.toContain('Konto Allegro:');
    expect(tresc).not.toContain('wyloguj-wszystkie');
  });

  it('sekcja Integracje pokazuje tożsamość zdrowego kanału i nie pokazuje paczki', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/integracje', headers: BASIC });
    const tresc = fragmentGlownejKolumny(r.body);

    expect(r.statusCode).toBe(200);
    expect(tresc).toContain('<h1>Integracje</h1>');
    expect(tresc).toContain('Konto Allegro: <strong>szkicownia-pl</strong>');
    expect(tresc).toContain('ważne jeszcze 21 dni');
    expect(tresc).not.toContain('name="waga"');
  });

  it('sekcja automatyzacji ma wszystkie pola autorespondera i nie ma pól paczki', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/wiadomosci-i-automatyzacje', headers: BASIC });
    const tresc = fragmentGlownejKolumny(r.body);

    expect(r.statusCode).toBe(200);
    expect(tresc).toContain('<h1>Wiadomości i automatyzacje</h1>');
    for (const pole of ['wlaczona', 'tresc', 'od', 'do', 'dni', 'karencja']) {
      expect(tresc).toContain(`name="${pole}"`);
    }
    expect((tresc.match(/name="dni"/g) ?? [])).toHaveLength(7);
    expect(tresc).not.toContain('name="waga"');
  });

  it('Diagnostyka ma własny tytuł, H1 i jedną aktywną pozycję podmenu', async () => {
    const r = await app.inject({ method: 'GET', url: '/ustawienia/lacznosc', headers: BASIC });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>Diagnostyka</title>');
    expect(fragmentGlownejKolumny(r.body)).toContain('<h1>Diagnostyka</h1>');
    const aktywne = r.body.match(/<li class="aktywna">\s*<a href="\/ustawienia\/lacznosc">/g) ?? [];
    // Ten sam model jest renderowany raz w menu desktopowym i raz w zwijanym menu telefonu.
    expect(aktywne).toHaveLength(2);
  });

  it('błąd autorespondera renderuje tę samą sekcję i zachowuje wszystkie wpisane wartości', async () => {
    const r = await app.inject({
      method: 'POST', url: '/ustawienia/formulka', headers: { ...BASIC, ...ORIGIN },
      payload: {
        wlaczona: 'on', tresc: 'x'.repeat(2001), od: '19', do: '7', dni: ['2', '6'], karencja: '17',
      },
    });
    const tresc = fragmentGlownejKolumny(r.body);

    expect(r.statusCode).toBe(400);
    expect(tresc).toContain('<h1>Wiadomości i automatyzacje</h1>');
    expect(tresc).toMatch(/name="wlaczona"[^>]*checked/);
    expect(tresc).toContain(`>${'x'.repeat(2001)}</textarea>`);
    expect(tresc).toContain('name="od" min="0" max="23" value="19"');
    expect(tresc).toContain('name="do" min="0" max="23" value="7"');
    expect(tresc).toContain('name="karencja" min="0" value="17"');
    expect(tresc).toMatch(/name="dni" value="2"[^>]*checked/);
    expect(tresc).toMatch(/name="dni" value="6"[^>]*checked/);
  });

  it.each([
    ['/ustawienia/paczka', { waga: '2', dlugosc: '100', szerokosc: '70', wysokosc: '5' }, '/ustawienia/zamowienia-i-wysylka?zapisano=paczka', 'Zapisano domyślną paczkę.'],
    ['/ustawienia/dostawa', { dpd: '19', inpost_paczkomat: '13', odbior_osobisty: '0' }, '/ustawienia/zamowienia-i-wysylka?zapisano=dostawa', 'Zapisano koszty dostawy.'],
    ['/ustawienia/formulka', { tresc: '', od: '18', do: '8', karencja: '10' }, '/ustawienia/wiadomosci-i-automatyzacje?zapisano=formulka', 'Zapisano ustawienia autorespondera.'],
  ])('%s po zapisie wraca do własnej sekcji i pokazuje komunikat', async (url, payload, location, komunikat) => {
    const r = await app.inject({ method: 'POST', url, headers: { ...BASIC, ...ORIGIN }, payload });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(location);
    const ekran = await app.inject({ method: 'GET', url: r.headers.location, headers: BASIC });
    expect(fragmentGlownejKolumny(ekran.body)).toContain(komunikat);
  });

  it('udane rozpoczęcie wiązania wraca do Integracji', async () => {
    const wiazanieApp = buildOmsServer({
      db: openOmsDb(':memory:'), config: CONFIG,
      stanyKanalow: () => [],
      wiazanieKanalow: { stan: () => null, rozpocznij: async () => ({ ok: true }) },
    });
    const r = await wiazanieApp.inject({
      method: 'POST', url: '/ustawienia/kanaly/allegro_szkicownia/wiazanie',
      headers: { ...BASIC, ...ORIGIN }, payload: {},
    });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/integracje?zapisano=kanal');
    const ekran = await wiazanieApp.inject({ method: 'GET', url: r.headers.location, headers: BASIC });
    expect(fragmentGlownejKolumny(ekran.body)).toContain('Rozpoczęto wiązanie kanału Allegro.');
    await wiazanieApp.close();
  });

  it('konto z prawem ustawień, lecz bez admina, widzi cztery pozycje i dostaje 403 na Kontach', async () => {
    const id = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawUprawnienia(db, id, ['ustawienia']);

    const wysylka = await app.inject({ method: 'GET', url: '/ustawienia/zamowienia-i-wysylka', headers: jako('ewa') });
    const konta = await app.inject({ method: 'GET', url: '/ustawienia/konta', headers: jako('ewa') });

    expect(wysylka.statusCode).toBe(200);
    expect(wysylka.body).not.toContain('href="/ustawienia/konta"');
    expect(konta.statusCode).toBe(403);
  });
});
