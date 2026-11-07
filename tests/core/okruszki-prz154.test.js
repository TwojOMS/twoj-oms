import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';
import { utworzKarte } from '../../src/oms/db/magazyn.js';
import { dopiszKlienta } from '../../src/oms/db/klienci.js';
import { zapewnijOkres } from '../../src/oms/db/okresy.js';
import { znormalizujKlienta } from '../../src/domena/klient-staly.js';

const pasek = html => html.match(/<div class="oms-breadcrumb">[\s\S]*?<\/div>/)?.[0] ?? '';
it('Ustawienia mają jeden rząd okruszków z linkami i nie powtarzają aktywnej zakładki w h2', async () => {
  const { app, db } = nowyPanel();
  try {
    const r = await get(app, '/ustawienia/firma', BASIC);
    expect(r.statusCode).toBe(200);
    expect(pasek(r.body)).toContain('href="/ustawienia/firma">Ustawienia</a>');
    expect(pasek(r.body)).toContain('href="/ustawienia/firma">Firma</a>');
    expect(pasek(r.body)).not.toContain('Panel');
    expect(r.body).not.toContain('ust-okruszki');
    expect(r.body).not.toMatch(/<h2[^>]*>Dane i logo<\/h2>/);
    expect(r.body).toContain('<h2>Logo</h2>');
    const css = readFileSync('src/public/oms-ustawienia.css', 'utf8');
    expect(css).not.toContain('ust-okruszki');
    expect(css).not.toMatch(/\.oms-shell--ustawienia \.oms-breadcrumb\s*\{\s*display:\s*none/);
  } finally { await app.close(); db.close(); }
});
it('partial zachowuje nazwę formularza różną od aktywnej zakładki', async () => {
  const html = await ejs.renderFile('src/core/web/widoki/_naglowek-ekranu.ejs', {
    tytul: 'Edycja szablonu', nawigacja: { kontekst: {
      dzialy: [{ etykieta: 'Komunikacja', aktywna: true }],
      zakladki: [{ etykieta: 'Szablony wiadomości', aktywna: true }],
    } },
  });
  expect(html).toContain('<h2 class="naglowek-formularza">Edycja szablonu</h2>');
});
it('produkt, klient, edycja klienta i okres mają nadrzędne linki', async () => {
  const { app, db } = nowyPanel({ magazyn: { gotowy: () => true } });
  try {
    const produkt = utworzKarte(db, { nazwa: 'Produkt testowy' });
    const klient = dopiszKlienta(db, znormalizujKlienta({ nazwa: 'Klient testowy', klucz: 'testowy' }));
    const okres = zapewnijOkres(db, { klientKlucz: 'testowy', rok: 2026, miesiac: 11 });
    for (const [url, linki, koniec] of [
      [`/magazyn/${produkt}`, [['/magazyn', 'Magazyn']], 'Produkt testowy'],
      [`/klienci/${klient}`, [['/klienci', 'Stali klienci']], 'Klient testowy'],
      [`/klienci/${klient}/edytuj`, [['/klienci', 'Stali klienci'], [`/klienci/${klient}`, 'Klient testowy']], 'Edycja'],
      [`/okresy/${okres.id}`, [['/okresy', 'Okresy']], '2026-11'],
    ]) {
      const r = await get(app, url, BASIC);
      expect(r.statusCode, url).toBe(200);
      const html = pasek(r.body);
      for (const [href, tekst] of linki) expect(html, url).toContain(`href="${href}">${tekst}</a>`);
      expect(html, url).toContain(koniec);
    }
  } finally { await app.close(); db.close(); }
});
it('lista Przesyłki nie ma powrotu, karta zamówienia zachowuje wyrażenie href i nową etykietę', async () => {
  const { app, db } = nowyPanel();
  try {
    const r = await get(app, '/przesylki', BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('← Wróć');
    const widok = readFileSync('src/moduly/zamowienia/widoki/zamowienie.ejs', 'utf8');
    expect(widok).toContain('<a href="<%= adresPowrotu %>">← Zamówienia</a>');
    const id = Number(db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('reczne', 15423, 'TEST-15423', '0.00', '2026-11-07T00:00:00Z')").run().lastInsertRowid);
    const powrot = '/?status=nowe&kanal=pro';
    const karta = await get(app, `/zamowienia/${id}?powrot=${encodeURIComponent(powrot)}`, BASIC);
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain(`<a href="/?status=nowe&amp;kanal=pro#zamowienie-${id}">← Zamówienia</a>`);
  } finally { await app.close(); db.close(); }
});
it('miesiąc finansów i podjazd mają link do listy nadrzędnej', async () => {
  const { app, db } = nowyPanel({ podjazdy: { sprawdz: async () => ({ id: 7, stan: 'utworzony', command_id: 'testowa-komenda' }) } });
  try {
    for (const [url, href, tekst, koniec] of [
      ['/finanse/dane/2026-01', '/finanse', 'Finanse', '2026-01'],
      ['/przesylki/podjazdy/7', '/przesylki', 'Przesyłki', 'Podjazd 7'],
    ]) {
      const r = await get(app, url, BASIC);
      expect(r.statusCode, url).toBe(200);
      expect(pasek(r.body)).toContain(`href="${href}">${tekst}</a>`);
      expect(pasek(r.body)).toContain(koniec);
    }
  } finally { await app.close(); db.close(); }
});
it('powrót edycji automatyzacji prowadzi do karty reguły i nosi jej nazwę', () => {
  const widok = readFileSync('src/moduly/automatyzacje/widoki/automatyzacje-regula.ejs', 'utf8');
  expect(widok).toContain('href="<%= regula ? `/ustawienia/automatyzacje/${regula.id}` : \'/ustawienia/automatyzacje\' %>">← <%= regula ? regula.nazwa : \'Automatyzacje\' %></a>');
});
