// PRZ-108.04: odmowa raportu (zamówienie o sklepie, którego konfiguracja nie zna) była gołym tekstem
// `text/plain` bez menu panelu — człowiek po instalacji demo zostawał na białej stronie bez drogi dalej.
// Teraz to ekran panelu z menu i wskazówką, co sprawdzić. Kod 400 zostaje.
import { it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}`, origin: 'http://localhost' };

function zamowienieObcegoSklepu(db: any, sklep: string) {
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: 1, numer: 'XYZ-0001',
    klient: { first_name: 'Janina', last_name: 'Wyssana-Testowa', email: 'janina.testowa@email.invalid', phone: '' },
    dostawa: { first_name: 'Janina', last_name: 'Wyssana-Testowa', address_1: 'Ulica Wymyslona 7', city: 'Testowo', postcode: '00-000', country: 'PL' },
    metoda_wysylki: 'odbior_osobisty', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00',
    koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: new Date().toISOString(), uwagi: '',
    pozycje: [{ nazwa: 'Produkt testowy', sku: 'T-1', ilosc: 1, cena_brutto: '10.00', cena_netto: '8.13', brutto_linii: '10.00', netto_linii: '8.13', vat: 23 }],
  }, {});
}

it('odmowa raportu przez nieznany sklep to ekran panelu (menu, tytuł, wskazówka), a nie goły tekst', async () => {
  const z = await zbudujOms({ env });
  try {
    zamowienieObcegoSklepu(z.db, 'xyz');
    for (const url of ['/raporty', '/raporty/eksport.csv']) {
      const odp = await z.app.inject({ url, headers });
      expect(odp.statusCode, url).toBe(400);
      expect(odp.headers['content-type'], url).toContain('text/html');
      // Menu panelu: nawigacja zakładek analiz z linkiem do Raportów, tytuł strony.
      expect(odp.body, url).toContain('aria-label="Analizy i finanse"');
      expect(odp.body, url).toContain('<title>Raporty</title>');
      // Co się stało i co sprawdzić: numer zamówienia, klucz sklepu, OMS_KANALY / Ustawienia.
      expect(odp.body, url).toContain('XYZ-0001');
      expect(odp.body, url).toContain('xyz');
      expect(odp.body, url).toContain('OMS_KANALY');
      expect(odp.body, url).toContain('href="/ustawienia');
      // Dane klienta nie trafiają na ekran odmowy — tylko numer zamówienia.
      for (const sekret of ['Janina', 'Wyssana', 'janina.testowa', 'Ulica Wymyslona']) expect(odp.body, url).not.toContain(sekret);
    }
  } finally { await z.app.close(); z.db.close(); }
});

it('odmowa Finansów przez nieznany sklep też jest ekranem panelu', async () => {
  const z = await zbudujOms({ env: { ...env, OMS_RAPORTY_PODLOGA_KOSZTOW: '2026-01' } });
  try {
    zamowienieObcegoSklepu(z.db, 'xyz');
    const odp = await z.app.inject({ url: "/finanse?skrot=ten-miesiac", headers });
    expect(odp.statusCode).toBe(400);
    expect(odp.headers['content-type']).toContain('text/html');
    expect(odp.body).toContain('aria-label="Analizy i finanse"');
    expect(odp.body).toContain('OMS_KANALY');
    expect(odp.body).not.toContain('janina.testowa');
  } finally { await z.app.close(); z.db.close(); }
});
