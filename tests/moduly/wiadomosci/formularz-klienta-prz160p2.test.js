import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { dopiszKlienta, klientPoId } from '../../../src/oms/db/klienci.js';
import { znormalizujKlienta } from '../../../src/domena/klient-staly.js';
import { runInNewContext } from 'node:vm';

const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}`, origin: 'http://localhost' };
let db, app, klient, gus;
const get = url => app.inject({ method: 'GET', url, headers });
const post = payload => app.inject({ method: 'POST', url: '/klienci', headers, payload });
beforeEach(async () => {
  db = openOmsDb(':memory:');
  gus = { firmaPoNip: vi.fn() };
  app = buildOmsServer({ db, config: { auth: { user: 'tester', pass: 'x' } }, gus });
  await app.ready();
  klient = klientPoId(db, dopiszKlienta(db, znormalizujKlienta({ nazwa: 'Pracownia Półcień' })));
});
afterEach(async () => { await app.close(); db.close(); });

describe('PRZ-160 P2.05b: osobny formularz klienta', () => {
  it('lista ma szer-tabela, oba formularze szer-karta i nie zawierają listy', async () => {
    const lista = (await get('/klienci')).body;
    expect(lista).toContain('szer-tabela');
    expect(lista).toContain('href="/klienci/nowy"');
    expect(lista).not.toContain('name="nazwa"');
    for (const adres of ['/klienci/nowy', `/klienci/${klient.id}`]) {
      const ekran = await get(adres);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).toContain('szer-karta');
      expect(ekran.body).not.toContain('szer-formularz');
      expect(ekran.body).not.toContain('<th>Klient</th>');
      expect(ekran.body).toMatch(/Nazwa klienta\s*<input name="nazwa"/);
      expect(ekran.body).not.toContain('name="klucz"');
      expect(ekran.body).toContain('href="/klienci">Zamknij');
    }
  });
  it('stare adresy przekierowują 303 na osobne ekrany', async () => {
    for (const [stary, nowy] of [['/klienci?nowy', '/klienci/nowy'], [`/klienci?edytuj=${klient.id}`, `/klienci/${klient.id}`], [`/klienci/${klient.id}/edytuj`, `/klienci/${klient.id}`]]) {
      const r = await get(stary);
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe(nowy);
    }
  });
  it('pierwszy submit zapisuje zamiast pobierać GUS (domyślna akcja Enter)', async () => {
    const html = (await get('/klienci/nowy')).body;
    const form = html.match(/<form method="post" action="(\/klienci)"[^>]*>([\s\S]*?)<\/form>/);
    const pierwszy = form[2].match(/<button\b([^>]*)>([^<]*)<\/button>/);
    expect(pierwszy[2]).toBe('Zapisz');
    expect(pierwszy[1]).toContain('class="poza-okiem"');
    expect(pierwszy[1]).not.toContain('formaction');
    const r = await app.inject({ method: 'POST', url: form[1], headers, payload: { nazwa: 'Nowa Pracownia' } });
    expect(r.headers.location).toBe('/klienci');
    expect(gus.firmaPoNip).not.toHaveBeenCalled();
  });
  it('błąd zachowuje dane i sam formularz, zapis nowego i edycji wraca na listę', async () => {
    for (const id of ['', String(klient.id)]) {
      const blad = await post({ id, nazwa: 'Wpisana nazwa', rabat_procent: '150' });
      expect(blad.statusCode).toBe(400);
      expect(blad.body).toContain('value="Wpisana nazwa"');
      expect(blad.body).toContain('szer-karta');
      expect(blad.body).not.toContain('<th>Klient</th>');
      expect((await post({ id, nazwa: id ? 'Pracownia Półcień' : 'Nowy klient' })).headers.location).toBe('/klienci');
    }
  });
  it('ustalenia handlowe mają kolejność 1–8 i przełączniki bez cenowych podpowiedzi', async () => {
    const html = (await get(`/klienci/${klient.id}`)).body;
    const ustalenia = html.slice(html.indexOf('<h2>Ustalenia handlowe</h2>'));
    const pola = ['b2b', 'rozliczenie_zbiorcze', 'rabat_procent', 'metoda_wysylki', 'koszt_dostawy_brutto', 'prog_darmowej_dostawy_wlaczony', 'prog_darmowej_dostawy', 'oplata_obslugi_wlaczony', 'oplata_obslugi', 'platnosc', 'termin_platnosci'];
    let poprzedni = -1;
    for (const pole of pola) {
      const pozycja = ustalenia.indexOf(`name="${pole}"`);
      expect(pozycja).toBeGreaterThan(poprzedni);
      poprzedni = pozycja;
    }
    expect(html).not.toContain('<h2>Rozliczenie zbiorcze</h2>');
    expect(html).toContain('Liczony w raportach jako kanał B2B (hurt)');
    expect(html).toContain('puste = kwota domyślna z Ustawień, 0 = wysyłka gratis');
    expect(html).toContain('doliczana jako osobna pozycja „Obsługa zamówienia”, gdy paczkę nadaje klient na swojej etykiecie');
    for (const [pole, id] of [['prog_darmowej_dostawy', 'prog-dostawy'], ['oplata_obslugi', 'oplata-obslugi']]) {
      expect(html).toContain(`aria-controls="${id}"`);
      expect(html.match(new RegExp(`<input[^>]*name="${pole}"[^>]*>`))[0]).not.toContain('placeholder');
    }
  });
  it('bez JS ignoruje odznaczone kwoty i zachowuje jawne zero po włączeniu', async () => {
    for (const wlaczony of [false, true]) {
      const r = await post({ id: String(klient.id), nazwa: 'Pracownia Półcień', prog_darmowej_dostawy: '0', oplata_obslugi: '0', ...(wlaczony ? { prog_darmowej_dostawy_wlaczony: 'on', oplata_obslugi_wlaczony: 'on' } : {}) });
      expect(r.statusCode).toBe(302);
      const zapisany = klientPoId(db, klient.id);
      expect(zapisany.prog_darmowej_dostawy_gr).toBe(wlaczony ? 0 : null);
      expect(zapisany.oplata_obslugi_gr).toBe(wlaczony ? 0 : null);
    }
  });
  it('przełączniki aktywują pola kwot po zaznaczeniu, bez kasowania wpisanej wartości', async () => {
    const html = (await get('/klienci/nowy')).body;
    const skrypt = html.match(/<script id="przelaczniki-kwot-klienta">([\s\S]*?)<\/script>/)[1];
    const pola = new Map();
    const przelaczniki = ['prog-dostawy', 'oplata-obslugi'].map((id, i) => {
      pola.set(id, { value: '0', disabled: false });
      return { checked: Boolean(i), getAttribute: () => id, addEventListener: function (_, fn) { this.zmiana = fn; } };
    });
    runInNewContext(skrypt, { document: { querySelectorAll: () => przelaczniki, getElementById: id => pola.get(id) } });
    expect(pola.get('prog-dostawy').disabled).toBe(true);
    expect(pola.get('oplata-obslugi').disabled).toBe(false);
    for (const p of przelaczniki) { p.checked = !p.checked; p.zmiana(); }
    expect(pola.get('prog-dostawy').disabled).toBe(false);
    expect(pola.get('oplata-obslugi').disabled).toBe(true);
    expect([...pola.values()].map(p => p.value)).toEqual(['0', '0']);
  });
});
