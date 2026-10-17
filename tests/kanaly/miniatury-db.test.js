import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie, listaZamowien } from '../../src/oms/db/zamowienia.js';
import { metodyPlatnosciWBazie } from '../../src/oms/db/filtry.js';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

// Zapis adresu zdjęcia produktu (miniatury na stronie głównej) i lista metod płatności
// do pola wyboru nad tabelą.

const surowe = (nad = {}) => ({
  id: 1281, number: '1281', total: '318.00', status: 'processing',
  date_created: '2026-07-31T20:58:39', payment_method_title: 'Przelew tradycyjny',
  shipping_lines: [{ instance_id: 1, method_id: 'flat_rate' }],
  line_items: [{
    id: 25, name: 'Lampa Kałamarz', sku: 'PRO-KAL', quantity: 1, total: '258.54', total_tax: '59.46',
    image: { id: 1092, src: 'https://pro.szkicownia.pl/wp-content/uploads/2026/07/kalamarz.jpg' },
  }],
  ...nad,
});

// Od Etapu 2 to CALA tablica dostaw sklepu, nie sama mapa instancji
// (domain/mapowanie-wysylki.js).
const mapa = {
  instancje: { 1: { metoda: 'dpd' }, 2: { metoda: 'dpd', pobranie: true } },
  poPozycji: [],
};

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('adres zdjęcia z pozycji', () => {
  it('zapisuje się razem z zamówieniem i wraca na listę', () => {
    zapiszZamowienie(db, 'pro', mapujZamowienie(surowe(), mapa), surowe());
    const [z] = listaZamowien(db);
    expect(z.pozycje[0].zdjecie_url).toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/kalamarz.jpg');
  });

  it('pozycja bez zdjęcia dostaje NULL, a nie pusty napis', () => {
    const bez = surowe({ line_items: [{ id: 25, name: 'X', quantity: 1, total: '10.00' }] });
    zapiszZamowienie(db, 'pro', mapujZamowienie(bez, mapa), bez);
    expect(listaZamowien(db)[0].pozycje[0].zdjecie_url).toBe(null);
  });

  // ⚠️ To jest test przeliczenia wstecz. Poller chodzi po kursorze `date_modified`, więc
  // zamówienie niezmienione w sklepie NIE ZOSTANIE odczytane ponownie nigdy (przewodnik
  // OMS, 4.7). Bez tego miniatury pojawiłyby się wyłącznie przy nowych zamówieniach —
  // czyli funkcja wyglądałaby na „częściowo działającą".
  // Test idzie na PLIK, bo dwa razy ':memory:' to dwie osobne bazy i nie sprawdzałoby niczego.
  it('przeliczenie uzupełnia adresy w zamówieniach zapisanych PRZED dołożeniem kolumny', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-mini-')), 'oms.sqlite');
    const pierwsza = openOmsDb(plik);
    const id = zapiszZamowienie(pierwsza, 'pro', mapujZamowienie(surowe(), mapa), surowe());
    // Stan sprzed zmiany: stary poller nie znał jeszcze adresu zdjęcia.
    pierwsza.prepare('UPDATE pozycje SET zdjecie_url = NULL WHERE zamowienie_id = ?').run(id);
    expect(listaZamowien(pierwsza)[0].pozycje[0].zdjecie_url).toBe(null);
    pierwsza.close();

    // Przeliczenia wykonują się przy otwarciu bazy — dokładnie jak przy starcie panelu.
    const druga = openOmsDb(plik);
    expect(listaZamowien(druga)[0].pozycje[0].zdjecie_url)
      .toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/kalamarz.jpg');
    druga.close();
  });

  it('przeliczenie nie tyka pozycji dopisanych ręcznie — sklep o nich nie wie', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-mini2-')), 'oms.sqlite');
    const pierwsza = openOmsDb(plik);
    const id = zapiszZamowienie(pierwsza, 'pro', mapujZamowienie(surowe(), mapa), surowe());
    pierwsza.prepare(
      "INSERT INTO pozycje (zamowienie_id, nazwa, sku, ilosc, cena_brutto, zrodlo) VALUES (?,?,?,?,?,'reczna')",
    ).run(id, 'Dopłata za montaż', null, 1, '90.00');
    pierwsza.prepare('UPDATE pozycje SET zdjecie_url = NULL WHERE zamowienie_id = ?').run(id);
    pierwsza.close();

    const druga = openOmsDb(plik);
    const pozycje = listaZamowien(druga)[0].pozycje;
    const reczna = pozycje.find((p) => p.zrodlo === 'reczna');
    expect(reczna.zdjecie_url).toBe(null);
    expect(pozycje.find((p) => p.zrodlo === 'sklep').zdjecie_url).toContain('kalamarz.jpg');
    druga.close();
  });
});

describe('metodyPlatnosciWBazie', () => {
  it('oddaje nazwy faktycznie występujące w zamówieniach, posortowane, bez powtórzeń', () => {
    const a = surowe({ id: 1, number: '1', payment_method_title: 'Za pobraniem' });
    const b = surowe({ id: 2, number: '2', payment_method_title: 'Przelew tradycyjny' });
    const c = surowe({ id: 3, number: '3', payment_method_title: 'Za pobraniem' });
    for (const s of [a, b, c]) zapiszZamowienie(db, 'pro', mapujZamowienie(s, mapa), s);
    expect(metodyPlatnosciWBazie(db)).toEqual(['Przelew tradycyjny', 'Za pobraniem']);
  });

  it('pomija puste i nieustawione — pole wyboru nie ma pokazywać pustej pozycji', () => {
    const a = surowe({ id: 1, number: '1', payment_method_title: '' });
    zapiszZamowienie(db, 'pro', mapujZamowienie(a, mapa), a);
    expect(metodyPlatnosciWBazie(db)).toEqual([]);
  });

  it('pusta baza daje pustą listę, a nie błąd', () => {
    expect(metodyPlatnosciWBazie(db)).toEqual([]);
  });
});
