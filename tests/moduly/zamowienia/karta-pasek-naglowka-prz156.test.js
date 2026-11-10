// PRZ-156 (decyzja właściciela 11.11.2026): tytuł „Zamówienie N” na karcie zamówienia stoi w pasku (tło, ramka) — jak dawna
// `.belka` sprzed PRZ-154.E2.1. Pasek ma TYLKO karta zamówienia; reszta ekranów zostaje przy wspólnym nagłówku bez tła.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const CSS = readFileSync(new URL('../../../src/public/oms-design.css', import.meta.url), 'utf8');
// Pierwszy <header> na stronie to górny pasek panelu (`oms-topbar`) — szukamy nagłówka ekranu po jego klasie.
const naglowek = (html) => /<header class="(naglowek-ekranu[^"]*)"[^>]*>[\s\S]*?<h1>([^<]*)<\/h1>/u.exec(html);

describe('PRZ-156 pasek nagłówka karty zamówienia', () => {
  it('karta zamówienia ma pasek, lista zamówień nie; pasek ma tło i ramkę', async () => {
    const p = nowyPanel();
    try {
      zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
      const admin = jako(p.db, 'adam');
      const id = zapiszZamowienie(p.db, 'pro', {
        zrodlo_id: 9561, numer: '9561', klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
        metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', status_woo: 'processing',
        oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-17T09:00:00',
        pozycje: [{ nazwa: 'Lampa', sku: null, cena_brutto: '100.00', vat: '23', zdjecie_url: null, zrodlo_id: 1, produkt_id: null, oferta_id: null, wariant_id: null, ilosc: 1 }],
      }, {});

      const karta = await get(p.app, `/zamowienia/${id}`, admin);
      expect(karta.statusCode).toBe(200);
      const [, klasyKarty, tytul] = naglowek(karta.body);
      expect(tytul).toBe('Zamówienie 9561');
      expect(klasyKarty.split(/\s+/u)).toEqual(['naglowek-ekranu', 'naglowek-ekranu--pasek']);

      const lista = await get(p.app, '/', admin); // lista zamówień stoi pod „/”
      expect(lista.statusCode).toBe(200);
      expect(naglowek(lista.body)[1]).toBe('naglowek-ekranu');

      const regula = /\.naglowek-ekranu--pasek\{([^}]*)\}/u.exec(CSS)?.[1] ?? '';
      expect(regula).toMatch(/background:var\(--powierzchnia\)/u);
      expect(regula).toMatch(/border:1px solid var\(--ramka\)/u);
    } finally { await p.app.close(); p.db.close(); }
  });
});
