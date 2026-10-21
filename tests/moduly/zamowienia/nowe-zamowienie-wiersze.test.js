import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-103 (21.10.2026): ekran „Nowe zamówienie" — wiersze pozycji do dodania i skasowania
// (bez JavaScriptu przez `formaction`, jak „Pobierz z GUS"; z JavaScriptem bez przeładowania)
// oraz sprawniejsze „Dodaj z magazynu".

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const ekran = () => app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek });
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const wiersze = (html) => (html.match(/name="poz_ilosc"/g) ?? []).length;
const ileZamowien = () => db.prepare('SELECT COUNT(*) AS ile FROM zamowienia').get().ile;

const trzy = {
  w_nazwa: 'Anna Kowalska',
  poz_nazwa: ['Lampa Grzybek', 'Kinkiet Sowa', 'Abażur lniany'],
  poz_sku: ['LMP-1', 'KNK-2', 'ABZ-3'],
  poz_ilosc: ['1', '2', '3'],
  poz_cena_netto: ['', '', ''],
  poz_cena_brutto: ['74.90', '129.00', '45.00'],
  poz_produkt_id: ['101', '202', '303'],
  poz_wariant_id: ['', '', ''],
  poz_cena_katalogowa: ['', '', ''],
};

describe('wiersze pozycji — bez JavaScriptu', () => {
  it('ekran startuje z jednym wierszem, ma „Dodaj wiersz" i „Usuń" przy wierszu', async () => {
    const body = (await ekran()).body;
    expect(wiersze(body)).toBe(1);
    expect(body).toContain('formaction="/zamowienia/nowe/wiersz/dodaj#pozycje"');
    expect((body.match(/formaction="\/zamowienia\/nowe\/wiersz\/usun#pozycje"/g) ?? []).length).toBe(1);
    expect(body).toContain('id="pozycje"');
  });

  // Prośba właściciela 21.10: „możliwość zmiany ilości strzałkami” — pole liczbowe jak na karcie (PRZ-074).
  it('ilość w wierszu pozycji to pole liczbowe ze strzałkami (całe sztuki od 1), nieobowiązkowe', async () => {
    const pole = (await ekran()).body.match(/<input[^>]*name="poz_ilosc"[^>]*>/)[0];
    expect(pole).toContain('type="number"');
    expect(pole).toContain('min="1"');
    expect(pole).toContain('step="1"');
    expect(pole).not.toContain('required');
  });

  it('„Dodaj wiersz" oddaje formularz z jednym wierszem więcej i NICZEGO nie zapisuje', async () => {
    const r = await wyslij('/zamowienia/nowe/wiersz/dodaj', trzy);
    expect(r.statusCode).toBe(200);
    expect(wiersze(r.body)).toBe(4);
    expect(r.body).toContain('value="Abażur lniany"');
    expect(r.body).toContain('name="w_nazwa" value="Anna Kowalska"');
    expect(ileZamowien()).toBe(0);
  });

  it('„Usuń" kasuje wskazany wiersz, a pozostałe zachowują swoje ceny i produkty', async () => {
    const r = await wyslij('/zamowienia/nowe/wiersz/usun', { ...trzy, usun_wiersz: '1' });
    expect(r.statusCode).toBe(200);
    expect(wiersze(r.body)).toBe(2);
    expect(r.body).not.toContain('Kinkiet Sowa');
    // Kolejność pól w wierszu: nazwa → … → produkt_id → … → cena brutto. Abażur musi
    // nieść SWÓJ produkt (303) i SWOJĄ cenę (45.00), nie te po skasowanym kinkiecie.
    const abazur = r.body.slice(r.body.indexOf('value="Abażur lniany"'));
    expect(abazur.match(/name="poz_produkt_id" value="([^"]*)"/)[1]).toBe('303');
    expect(abazur.match(/name="poz_cena_brutto" value="([^"]*)"/)[1]).toBe('45.00');
    expect(ileZamowien()).toBe(0);
  });

  it('skasowane wiersze nie wracają po innym przycisku formularza (np. „Skopiuj dane do wysyłki")', async () => {
    const dwa = { poz_nazwa: ['A', 'B'], poz_ilosc: ['1', '1'], poz_cena_brutto: ['1.00', '2.00'] };
    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', dwa);
    expect(wiersze(r.body)).toBe(2);
  });

  it('zapis po skasowaniu wiersza zakłada zamówienie z pozostałymi pozycjami', async () => {
    const poUsunieciu = { ...trzy };
    for (const k of Object.keys(trzy).filter((k) => k.startsWith('poz_'))) poUsunieciu[k] = trzy[k].filter((_, i) => i !== 1);
    const r = await wyslij('/zamowienia/nowe', { ...poUsunieciu, dostawa: 'dpd', platnosc: 'przelew' });
    expect(r.statusCode).toBeLessThan(400);
    const nazwy = pobierzZamowienie(db, 1).pozycje.map((p) => p.nazwa);
    expect(nazwy).toEqual(['Lampa Grzybek', 'Abażur lniany']);
  });
});

// PRZ-106 — uwagi właściciela z piaskownicy 21.10: „ilość w wierszu — albo ustawiamy 1 jako wartość
// domyślną albo zostawiamy pole puste. Teraz pole podpowiada "1" i wygląda jakby to już było
// ustawione.” oraz „dodaj wiersz przenieś pod wiersze, nad RAZEM”.
describe('PRZ-106: ilość 1 w nowym wierszu i „+ Dodaj wiersz” nad „Razem”', () => {
  it('pierwsze wejście: ilość to WARTOŚĆ 1, nie podpowiedź', async () => {
    const pole = (await ekran()).body.match(/<input[^>]*name="poz_ilosc"[^>]*>/)[0];
    expect(pole).toContain('value="1"');
    expect(pole).not.toContain('placeholder');
  });

  it('nietknięty wiersz z ilością 1 nie blokuje zapisu — zamówienie bez pozycji powstaje', async () => {
    const r = await wyslij('/zamowienia/nowe', {
      dostawa: 'dpd', platnosc: 'przelew',
      poz_nazwa: '', poz_sku: '', poz_ilosc: '1', poz_cena_netto: '', poz_cena_brutto: '',
      poz_produkt_id: '', poz_wariant_id: '', poz_cena_katalogowa: '',
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, 1).pozycje).toEqual([]);
  });

  it('wyczyszczona ilość wraca z formularzem pusta — nie podstawiamy 1 drugi raz', async () => {
    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { poz_nazwa: ['Lampa'], poz_ilosc: [''] });
    expect(r.body.match(/<input[^>]*name="poz_ilosc"[^>]*>/)[0]).toContain('value=""');
  });

  it('„+ Dodaj wiersz” bez JavaScriptu dokłada wiersz z ilością 1', async () => {
    const r = await wyslij('/zamowienia/nowe/wiersz/dodaj', trzy);
    const ilosci = [...r.body.matchAll(/name="poz_ilosc" value="([^"]*)"/g)].map((m) => m[1]);
    expect(ilosci).toEqual(['1', '2', '3', '1']);
  });

  it('„+ Dodaj wiersz” stoi w stopce tabeli, nad wierszem „Razem”', async () => {
    const body = (await ekran()).body;
    const stopka = body.slice(body.indexOf('<tfoot>'), body.indexOf('</tfoot>'));
    expect(stopka).toContain('data-dodaj-wiersz');
    expect(stopka.indexOf('data-dodaj-wiersz')).toBeLessThan(stopka.indexOf('wiersz-razem'));
  });
});

describe('„Dodaj z magazynu" na ekranie zakładania', () => {
  it('przykład w polu szukania to „lampa", nie dawny szablon', async () => {
    const body = (await ekran()).body;
    expect(body).toContain('np. „lampa”');
    expect(body).not.toContain('pieszy');
  });

  it('karta zamówienia też podpowiada „lampa"', () => {
    const widok = readFileSync(new URL('../../../src/moduly/zamowienia/widoki/zamowienie.ejs', import.meta.url), 'utf8');
    expect(widok).toContain('np. „lampa”');
    expect(widok).not.toContain('pieszy');
  });

  // Po „Dodaj" operator szuka następnego produktu — kursor ma czekać w polu szukania.
  it('po dodaniu produktu pole szukania dostaje fokus; przy zwykłym wejściu nie', async () => {
    expect((await ekran()).body).not.toMatch(/name="magazyn"[^>]*autofocus/);
    zapiszProduktSklepowy(db, {
      kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', nazwa: 'Lampa stołowa Grzybek',
      sku_sklepu: 'LMP-GRZ-30', cena_gr: 7490, rozmiar_tekst: '', kategorie: [], zdjecia: [],
      adres: 'https://sklep.example/grzybek', odczytane_at: '2026-10-21T08:00:00',
    });
    const r = await wyslij('/zamowienia/nowe/magazyn/dodaj', {
      magazyn: 'lampa', cennik: 'szkicownia', wybrany: '0',
      mag_kanal: 'szkicownia', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '1',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Dodano do zamówienia');
    expect(r.body).toMatch(/name="magazyn"[^>]*autofocus/);
    // Ilość przy wyniku też ze strzałkami.
    const ilosc = r.body.match(/<input[^>]*name="mag_ilosc"[^>]*>/)[0];
    expect(ilosc).toContain('type="number"');
    expect(ilosc).toContain('min="1"');
  });

  it('ekran ładuje skrypt wierszy i klawiatury', async () => {
    expect((await ekran()).body).toMatch(/<script type="module" src="\/public\/pozycje-wiersze\.js/);
  });
});
