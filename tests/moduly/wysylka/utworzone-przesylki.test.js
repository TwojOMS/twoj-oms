import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const zmapowane = (nr) => ({
  zrodlo_id: nr, numer: `Z-${nr}`,
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '50.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-09-14T10:00:00Z', pozycje: [],
});

let db; let app; let ids; let nr = 0;
function paczka(numer, {
  sklep = 'pro', kurier = 'dpd', pdf = null, zpl = null, reczna = false,
  etap = null, kod = null, at = '2026-09-18T10:00:00.000Z',
} = {}) {
  const zamowienieId = zapiszZamowienie(db, sklep, zmapowane(++nr), {});
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, {
    numerListu: numer, etykietaSciezka: pdf, etykietaZplSciezka: zpl, surowa: '<x/>',
  });
  db.prepare('UPDATE przesylki SET utworzona_at = ?, etykieta_reczna = ?, status_kuriera_kod = ? WHERE id = ?')
    .run(at, reczna ? 1 : null, kod, p.id);
  if (etap) zapiszStatusDpd(db, p.id, { opis: etap, at: '2026-09-18T11:00:00.000Z' });
  ids[numer] = p.id;
}

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });
const wiersze = (body) => body.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
const chipy = (body) => body.match(/<p class="chipy-filtrow">([\s\S]*?)<\/p>/)?.[1] ?? '';
const filtry = (body) => body.match(/<form class="filtry"([\s\S]*?)<\/form>/)?.[1] ?? '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
  db = openOmsDb(':memory:');
  ids = {};
  nr = 0;
  paczka('U-PDF', { pdf: '/tmp/e.pdf' });
  paczka('U-ZPL', { zpl: '/tmp/e.zpl', at: '2026-09-14T10:00:00.000Z' });
  paczka('U-MAN', { reczna: true, kurier: 'inpost' });
  paczka('U-PENDING', { sklep: 'allegro_szkicownia', kurier: 'allegro', kod: 'PENDING' });
  paczka('U-REG', { etap: 'Zarejestrowano dane przesyłki, jeszcze nie nadana' });
  paczka('NO-PROOF');
  paczka('MOVED', { pdf: '/tmp/e.pdf', etap: 'Przesyłka odebrana przez Kuriera' });
  paczka('DELIVERED', { pdf: '/tmp/e.pdf', etap: 'Przesyłka doręczona' });
  paczka('HIDDEN', { pdf: '/tmp/e.pdf' });
  db.prepare('UPDATE przesylki SET ukryta_at = ?, ukryta_przez = ? WHERE id = ?')
    .run('2026-09-19T10:00:00Z', 'adam', ids.HIDDEN);
  paczka('OLD', { pdf: '/tmp/e.pdf', at: '2026-07-01T10:00:00.000Z' });
  app = buildOmsServer({ db, config: CONFIG });
});

describe('Przesyłki → Utworzone', () => {
  it('pokazuje etykiety bez odbioru: PDF, ZPL, ręczne potwierdzenie i rejestrację u przewoźnika', async () => {
    const r = await pobierz('/przesylki?pokaz=utworzone');
    expect(r.statusCode).toBe(200);
    const body = wiersze(r.body);
    for (const nrListu of ['U-PDF', 'U-ZPL', 'U-MAN', 'U-PENDING', 'U-REG']) {
      expect(body).toContain(nrListu);
    }
    for (const nrListu of ['NO-PROOF', 'MOVED', 'DELIVERED', 'HIDDEN', 'OLD']) {
      expect(body).not.toContain(nrListu);
    }
    expect(chipy(r.body)).toMatch(/href="\/przesylki\?pokaz=utworzone"[^>]*>Utworzone \(5\)<\/a>/);
  });

  it('W drodze nie liczy już utworzonych; sam numer bez dowodu etykiety zachowuje dotychczasowy widok', async () => {
    const r = await pobierz('/przesylki?pokaz=w_drodze');
    expect(wiersze(r.body)).toContain('MOVED');
    expect(wiersze(r.body)).toContain('NO-PROOF');
    expect(wiersze(r.body)).not.toContain('U-PDF');
    expect(wiersze(r.body)).not.toContain('U-PENDING');
    expect(chipy(r.body)).toMatch(/W drodze \(2\)/);
    expect(chipy(r.body)).toMatch(/Utworzone \(5\)/);
    expect(chipy(r.body)).toMatch(/Wszystkie \(8\)/);
  });

  it('pierwszy skan przenosi paczkę z Utworzonych do W drodze', async () => {
    zapiszStatusDpd(db, ids['U-PDF'], {
      opis: 'Przesyłka odebrana przez Kuriera', at: '2026-09-21T11:00:00.000Z',
    });
    const utworzone = await pobierz('/przesylki?pokaz=utworzone');
    const wDrodze = await pobierz('/przesylki?pokaz=w_drodze');
    expect(wiersze(utworzone.body)).not.toContain('U-PDF');
    expect(wiersze(wDrodze.body)).toContain('U-PDF');
    expect(chipy(wDrodze.body)).toMatch(/Utworzone \(4\)/);
    expect(chipy(wDrodze.body)).toMatch(/W drodze \(3\)/);
  });

  it('Bez ruchu pozostaje alertem przekrojowym także dla nieodebranej etykiety', async () => {
    const r = await pobierz('/przesylki?pokaz=bez_ruchu');
    expect(wiersze(r.body)).toContain('U-ZPL');
    expect(chipy(r.body)).toMatch(/Bez ruchu \(1\)/);
  });

  it('filtry i skróty dat zachowują chip Utworzone, a wyczyszczenie usuwa same filtry', async () => {
    const r = await pobierz('/przesylki?pokaz=utworzone&kurier=dpd&sklep=pro&od=2026-09-18&do=2026-09-21');
    expect(wiersze(r.body)).toContain('U-PDF');
    expect(wiersze(r.body)).toContain('U-REG');
    expect(wiersze(r.body)).not.toContain('U-ZPL');
    expect(wiersze(r.body)).not.toContain('U-MAN');
    expect(filtry(r.body)).toContain('name="pokaz" value="utworzone"');
    expect(r.body).toContain('pokaz=utworzone&amp;od=2026-09-01');
    expect(r.body).toContain('href="/przesylki?pokaz=utworzone"');
    expect(chipy(r.body)).toContain('pokaz=w_drodze&amp;od=2026-09-18');
  });

  it('ukrycie i przywrócenie wracają na Utworzone oraz aktualizują liczniki', async () => {
    const hide = await app.inject({
      method: 'POST', url: `/przesylki/${ids['U-PDF']}/ukryj`,
      headers: { ...AUTH, origin: 'http://localhost' },
      payload: { pokaz: 'utworzone', kurier: 'dpd' },
    });
    expect(hide.statusCode).toBe(302);
    expect(hide.headers.location).toBe('/przesylki?pokaz=utworzone&kurier=dpd');
    const hidden = await pobierz('/przesylki?pokaz=utworzone');
    expect(wiersze(hidden.body)).not.toContain('U-PDF');
    expect(chipy(hidden.body)).toMatch(/Utworzone \(4\)/);
    expect(chipy(hidden.body)).toMatch(/Ukryte \(2\)/);

    const restore = await app.inject({
      method: 'POST', url: `/przesylki/${ids['U-PDF']}/przywroc`,
      headers: { ...AUTH, origin: 'http://localhost' },
      payload: { pokaz: 'utworzone', kurier: 'dpd' },
    });
    expect(restore.headers.location).toBe('/przesylki?pokaz=utworzone&kurier=dpd');
    const back = await pobierz('/przesylki?pokaz=utworzone');
    expect(wiersze(back.body)).toContain('U-PDF');
    expect(chipy(back.body)).toMatch(/Utworzone \(5\)/);
  });

  it('domyślne 60 dni nie ukrywa starszych paczek przy jawnym filtrze daty', async () => {
    const recent = await pobierz('/przesylki?pokaz=utworzone');
    expect(wiersze(recent.body)).not.toContain('OLD');
    const july = await pobierz('/przesylki?pokaz=utworzone&od=2026-07-01&do=2026-07-01');
    expect(wiersze(july.body)).toContain('OLD');
    expect(wiersze(july.body)).not.toContain('U-PDF');
  });

  it('pusty widok Utworzone wyjaśnia stan, bez ogólnego tekstu o W drodze', async () => {
    const r = await pobierz('/przesylki?pokaz=utworzone&kurier=nieistniejacy');
    expect(r.statusCode).toBe(200);
    expect(wiersze(r.body)).toBe('');
    expect(r.body).toContain('Nie ma przesyłek oczekujących na odbiór przez kuriera');
    expect(r.body).not.toContain('schodzą z widoku „W drodze” po doręczeniu');
  });
});
