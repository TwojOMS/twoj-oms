// PRZ-102.04 — strona główna przez HTTP: konto Produkcja nie dostaje wierszy ostrzeżeń prowadzących
// do ekranów, których nie ma w swoich prawach (Wiadomości, Faktury). Klik dawał 403.
import { afterEach, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podmienLukiKsef, podmienPoTerminie } from '../../../src/oms/db/ostrzezenia.js';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const panele = [];
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });

function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'pakowacz-test', imie: 'Pakowacz', haslo: 'h', rola: 'produkcja' });
  zalozKonto(p.db, { login: 'sprzedawca-test', imie: 'Sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  podmienLukiKsef(p.db, [{ uuid: 'luka-1', numer: 'FV-LUKA-1', invoiceDate: '2020-01-01' }]);
  podmienPoTerminie(p.db, [{ uuid: 'dlug-1', numer: 'FV-DLUG-1', paymentDate: '2020-02-01', pozostaloGr: 4500 }]);
  zapiszWatek(p.db, {
    kanal: 'allegro', threadId: 'watek-1', interlocutorLogin: 'kupujacy_lampa',
    lastMessageDateTime: new Date(Date.now() - 3600 * 1000).toISOString(), ostatniaOdKupujacego: true,
  });
  return {
    ...p,
    admin: jako(p.db, 'admin-test'),
    produkcja: jako(p.db, 'pakowacz-test'),
    sprzedaz: jako(p.db, 'sprzedawca-test'),
  };
}

it('Produkcja: strona główna bez wiersza wiadomości i faktur, a przycisku do 403 nie ma', async () => {
  const { app, produkcja } = panel();
  const r = await get(app, '/', produkcja);
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('Nowa wiadomość z Allegro');
  expect(r.body).not.toContain('FV-LUKA-1');
  expect(r.body).not.toContain('po terminie płatności');
  expect(r.body).not.toMatch(/class="btn" href="\/wiadomosci"/u);
  expect(r.body).not.toMatch(/class="btn" href="\/faktury/u);
  // Sprawdzenie, że to naprawdę ekran bez prawa (inaczej filtr chowałby coś, co działa).
  expect((await get(app, '/wiadomosci', produkcja)).statusCode).toBe(403);
  expect((await get(app, '/faktury', produkcja)).statusCode).toBe(403);
});

it('administrator na tej samej bazie widzi wszystkie trzy wiersze', async () => {
  const { app, admin } = panel();
  const r = await get(app, '/', admin);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Nowa wiadomość z Allegro od kupujacy_lampa');
  expect(r.body).toContain('FV-LUKA-1');
  expect(r.body).toContain('po terminie płatności');
});

it('Sprzedaż (bez finansów) widzi wiadomość i faktury — ma prawo do obu ekranów', async () => {
  const { app, sprzedaz } = panel();
  const r = await get(app, '/', sprzedaz);
  expect(r.body).toContain('Nowa wiadomość z Allegro od kupujacy_lampa');
  expect(r.body).toContain('FV-LUKA-1');
  expect(r.body).toContain('po terminie płatności');
  expect((await get(app, '/finanse', sprzedaz)).statusCode).toBe(403);
});
