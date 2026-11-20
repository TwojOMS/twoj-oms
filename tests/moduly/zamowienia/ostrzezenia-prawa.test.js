// Odczyt migawki: konto Produkcja nie dostaje ostrzeżeń prowadzących
// do ekranów, których nie ma w swoich prawach (Wiadomości, Faktury). Klik dawał 403.
import { afterEach, it, expect } from 'vitest';
import { kontoPoLoginie, zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podmienLukiKsef, podmienPoTerminie } from '../../../src/oms/db/ostrzezenia.js';
import { powiadomieniaKonta } from '../../../src/oms/db/powiadomienia.js';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { nowyPanel, jako, get } from '../../pomoc/panel-konta-testowe.js';
import { przeliczPowiadomienia } from '../../pomoc/przelicz-powiadomienia.ts';

const panele = [];
afterEach(async () => {
  for (const p of panele.splice(0)) {
    await p.app.close();
    p.db.close();
  }
});

async function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'pakowacz-test', imie: 'Pakowacz', haslo: 'h', rola: 'produkcja' });
  zalozKonto(p.db, { login: 'sprzedawca-test', imie: 'Sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  podmienLukiKsef(p.db, [{ uuid: 'luka-1', numer: 'FV-LUKA-1', invoiceDate: '2020-01-01' }]);
  podmienPoTerminie(p.db, [{ uuid: 'dlug-1', numer: 'FV-DLUG-1', paymentDate: '2020-02-01', pozostaloGr: 4500 }]);
  zapiszWatek(p.db, {
    kanal: 'allegro',
    threadId: 'watek-1',
    interlocutorLogin: 'kupujacy_lampa',
    lastMessageDateTime: new Date(Date.now() - 3600 * 1000).toISOString(),
    ostatniaOdKupujacego: true,
  });
  await przeliczPowiadomienia(p.app);
  return {
    ...p,
    aktualne: (login) => powiadomieniaKonta(p.db, kontoPoLoginie(p.db, login)).aktualne,
    produkcja: jako(p.db, 'pakowacz-test'),
    sprzedaz: jako(p.db, 'sprzedawca-test'),
  };
}

it('Produkcja: odczyt migawki pomija ostrzeżenia z odnośnikami do ekranów bez dostępu', async () => {
  const { app, produkcja, aktualne } = await panel();
  const wiersze = aktualne('pakowacz-test');
  expect(wiersze.map((w) => w.tekst)).not.toContainEqual(expect.stringContaining('Nowa wiadomość z Allegro'));
  expect(wiersze.map((w) => w.tekst)).not.toContainEqual(expect.stringContaining('FV-LUKA-1'));
  expect(wiersze.map((w) => w.tekst)).not.toContainEqual(expect.stringContaining('po terminie płatności'));
  expect(wiersze.some((w) => /^\/(wiadomosci|faktury)/u.test(w.przycisk?.href ?? ''))).toBe(false);
  // Sprawdzenie, że to naprawdę ekran bez prawa (inaczej filtr chowałby coś, co działa).
  expect((await get(app, '/wiadomosci', produkcja)).statusCode).toBe(403);
  expect((await get(app, '/faktury', produkcja)).statusCode).toBe(403);
});

it('administrator na tej samej bazie widzi oba wiersze faktur, a wiadomości nie ma wśród ostrzeżeń', async () => {
  const { aktualne } = await panel();
  const teksty = aktualne('admin-test').map((w) => w.tekst);
  // Wiadomość sygnalizuje licznik przy „Wiadomości” w menu, nie wiersz ostrzeżenia.
  expect(teksty).not.toContainEqual(expect.stringContaining('Nowa wiadomość z Allegro od kupujacy_lampa'));
  expect(teksty).toContainEqual(expect.stringContaining('FV-LUKA-1'));
  expect(teksty).toContainEqual(expect.stringContaining('po terminie płatności'));
});

it('Sprzedaż (bez finansów) widzi faktury — ma prawo do tego ekranu', async () => {
  const { app, sprzedaz, aktualne } = await panel();
  const teksty = aktualne('sprzedawca-test').map((w) => w.tekst);
  expect(teksty).toContainEqual(expect.stringContaining('FV-LUKA-1'));
  expect(teksty).toContainEqual(expect.stringContaining('po terminie płatności'));
  expect((await get(app, '/finanse', sprzedaz)).statusCode).toBe(403);
});
