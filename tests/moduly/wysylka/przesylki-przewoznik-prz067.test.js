import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-067 (decyzja właściciela 13.10): zakładka Przesyłki filtruje i pokazuje PRAWDZIWEGO przewoźnika
// (DPD, InPost, DHL, ORLEN Paczka, Allegro One, Packeta), a nie kod drogi nadania
// (`allegro_wza`, `allegro`). Kolumna „Kurier” = logo, numer listu = link do śledzenia.

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = (nr) => ({
  zrodlo_id: nr, numer: `Z-${nr}`, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '50.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z', pozycje: [],
});

let db; let app; let nr = 0;
function paczka({ sklep = 'pro', kurier, numer, metoda = 'dpd', nazwa = null, carrier = null }) {
  nr += 1;
  const id = zapiszZamowienie(db, sklep, zmapowane(nr), {});
  db.prepare('UPDATE zamowienia SET metoda_wysylki = ?, metoda_wysylki_nazwa = ? WHERE id = ?').run(metoda, nazwa, id);
  const p = rozpocznijPrzesylke(db, id, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  db.prepare('UPDATE przesylki SET utworzona_at = ?, carrier_allegro = ? WHERE id = ?')
    .run('2026-08-21T10:00:00.000Z', carrier, p.id);
  return p.id;
}

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });
const wiersz = (body, numer) => body.split('<tr>').find((f) => f.includes(numer))?.split('</tr>')[0];
const komorki = (w) => [...w.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
  db = openOmsDb(':memory:');
  nr = 0;
  paczka({ kurier: 'dpd', numer: 'DPD-WLASNA' });
  paczka({ sklep: 'allegro_szkicownia', kurier: 'allegro_wza', numer: 'AD-WZA', metoda: 'allegro_dpd', nazwa: 'Allegro Kurier DPD' });
  paczka({ sklep: 'allegro_szkicownia', kurier: 'allegro', numer: 'AD-ALL', metoda: 'allegro_dpd', nazwa: 'Allegro Kurier DPD pobranie', carrier: 'ALLEGRO' });
  paczka({ kurier: 'inpost', numer: 'INP-1', metoda: 'inpost_paczkomat' });
  paczka({ sklep: 'allegro_szkicownia', kurier: 'allegro', numer: 'ONE-1', metoda: 'allegro_punkt', nazwa: 'Allegro One Box, One Kurier', carrier: 'ALLEGRO' });
  paczka({ sklep: 'allegro_szkicownia', kurier: 'allegro_wza', numer: 'NIEZNANY-1', metoda: 'allegro_punkt', nazwa: null });
  app = buildOmsServer({ db, config: CONFIG });
});

describe('filtr przewoźnika po prawdziwym przewoźniku', () => {
  it('?kurier=dpd zwraca DPD własne ORAZ Allegro z DPD (WzA i allegro), bez InPost/One/nieznanego', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd');
    expect(r.statusCode).toBe(200);
    for (const n of ['DPD-WLASNA', 'AD-WZA', 'AD-ALL']) expect(wiersz(r.body, n)).toBeDefined();
    for (const n of ['INP-1', 'ONE-1', 'NIEZNANY-1']) expect(r.body).not.toContain(n);
  });

  it('?kurier=allegro-one zwraca tylko One Box', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=allegro-one');
    expect(r.body).toContain('ONE-1');
    for (const n of ['DPD-WLASNA', 'AD-WZA', 'AD-ALL', 'INP-1', 'NIEZNANY-1']) expect(r.body).not.toContain(n);
  });

  it('lista rozwijana: nazwy przewoźników z kluczem w value, bez kodów allegro/allegro_wza, pełna po filtrze', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd');
    const select = r.body.match(/<select name="kurier">([\s\S]*?)<\/select>/)[1];
    const opcje = [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(opcje).toEqual([['', 'Wszystkie'], ['allegro-one', 'Allegro One'], ['dpd', 'DPD'], ['inpost', 'InPost']]);
    expect(select).toMatch(/<option value="dpd" selected>DPD<\/option>/);
  });

  it('ukryte pola „Ukryj” niosą klucz przewoźnika', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd');
    expect(wiersz(r.body, 'AD-WZA')).toContain('<input type="hidden" name="kurier" value="dpd">');
  });

  it('stary adres ?kurier=allegro_wza: pusta lista i wyjaśnienie, zamiast cichego „Wszystkie”', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=allegro_wza');
    expect(r.statusCode).toBe(200);
    for (const n of ['DPD-WLASNA', 'AD-WZA', 'INP-1']) expect(r.body).not.toContain(n);
    expect(r.body).toContain('Przewoźnik „allegro_wza” nie występuje');
  });
});

describe('kolumna Kurier i numer listu', () => {
  it('logo przewoźnika z alt = nazwa; dla Allegro pod logo nazwa usługi (z pobraniem)', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    const [, kurierDpd] = komorki(wiersz(r.body, 'DPD-WLASNA'));
    expect(kurierDpd).toContain('<img class="prz067-logo" src="/public/przewoznicy/dpd.svg" alt="DPD"');
    const [, kurierAll] = komorki(wiersz(r.body, 'AD-ALL'));
    expect(kurierAll).toContain('src="/public/przewoznicy/dpd.svg" alt="DPD"');
    expect(kurierAll).toContain('Allegro Kurier DPD pobranie');
    const [, kurierOne] = komorki(wiersz(r.body, 'ONE-1'));
    expect(kurierOne).toContain('src="/public/przewoznicy/allegro-one.png" alt="Allegro One"');
  });

  it('numer listu to link śledzenia przewoźnika w nowej karcie', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(wiersz(r.body, 'DPD-WLASNA')).toContain(
      '<a href="https://tracktrace.dpd.com.pl/parcelDetails?typ=1&amp;p1=DPD-WLASNA" target="_blank" rel="noopener noreferrer">DPD-WLASNA</a>',
    );
    expect(wiersz(r.body, 'AD-WZA')).toContain('href="https://tracktrace.dpd.com.pl/parcelDetails?typ=1&amp;p1=AD-WZA"');
    expect(wiersz(r.body, 'INP-1')).toContain('href="https://inpost.pl/sledzenie-przesylek?number=INP-1"');
    expect(wiersz(r.body, 'ONE-1')).toContain('href="https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=ONE-1"');
  });

  it('nieznany przewoźnik: tekst zamiast logo, numer bez linku — nigdy puste pole', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    const w = wiersz(r.body, 'NIEZNANY-1');
    const [, kurier, numer] = komorki(w);
    expect(kurier).not.toContain('<img');
    expect(kurier.trim()).not.toBe('');
    expect(kurier).toContain('Allegro punkt / automat');
    expect(numer.trim()).toBe('NIEZNANY-1');
    expect(w).not.toContain('target="_blank"');
  });

  it('numer ze znakami specjalnymi jest kodowany w adresie', async () => {
    db.prepare("UPDATE przesylki SET numer_listu = 'AB 1&2#3' WHERE numer_listu = 'DPD-WLASNA'").run();
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(r.body).toContain('href="https://tracktrace.dpd.com.pl/parcelDetails?typ=1&amp;p1=AB%201%262%233"');
  });
});
