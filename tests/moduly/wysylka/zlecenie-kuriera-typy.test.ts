import { describe, expect, it } from 'vitest';
import type { ZlecenieKuriera, ZamowienieDoWysylki } from '../../../src/core/kontrakty.ts';
import { createDpdClient, createInpostClient, createAllegroWzaClient } from '../../../src/integracje/fabryki.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';

const nadawca = { nazwa: 'Test', ulica: 'Testowa 1', kod: '00-001', miasto: 'Test', kraj: 'PL', phone: '500100200', email: 'test@przyklad.invalid' };
const zamowienie = { id: 1, sklep: 'sklep-test', zrodlo_id: 11, numer: 'TEST-11', metoda_wysylki: 'dpd',
  kwota_pobrania: null, pobranie: 0 as const, anulowane: 0 as const, punkt_odbioru: null, surowe_json: null,
  klient: null, dostawa: null, dostawa_reczna_json: null };
const paczka = { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 };

// Prawdziwe publiczne fabryki i ich nadaj(), bez rzutowania na Kurier ani any.
// Funkcja nie jest wywoływana: sprawdza odmowy kompilatora, bez operacji kurierskich.
function odmowyTypow() {
  const klient = createDpdClient({ url: 'https://przyklad.invalid', login: 'test', haslo: 'test', fid: '1',
    infoUrl: 'https://przyklad.invalid/info', channel: '1', nadawca });
  // @ts-expect-error id zamówienia w bazie jest liczbą
  void klient.nadaj({ zamowienie: { ...zamowienie, id: '1' }, paczka });
  // @ts-expect-error parser paczki zwraca wagę jako liczbę, nie tekst formularza
  void klient.nadaj({ zamowienie, paczka: { ...paczka, waga: '1,5' } });
  // @ts-expect-error zwykła paczka musi mieć wszystkie trzy wymiary
  void klient.nadaj({ zamowienie, paczka: { waga: 1, dlugosc: 40 } });
  // @ts-expect-error zlecenie wymaga tożsamości i danych dostawy zamówienia
  void klient.nadaj({ zamowienie: {}, paczka });
  // @ts-expect-error adres nie może być tekstem ani nieznanym obiektem
  void klient.nadaj({ zamowienie, paczka, adres: 'Testowa 1' });
  const inpost = createInpostClient({ url: 'https://przyklad.invalid', token: 'test', organizacja: 1, nadawca });
  // @ts-expect-error InPost przyjmuje wyłącznie A/B/C
  void inpost.nadaj({ zamowienie, paczka: { waga: 1, gabaryt: 'XL' } });
  const wza = createAllegroWzaClient({ allegroDla: () => null, metodaZywa: async () => null });
  // @ts-expect-error gabaryt Allegro wymaga oczekiwanego id metody i pełnych wymiarów
  void wza.nadaj({ zamowienie, paczka: { ...paczka, gabaryt: 'S' } });
}
void odmowyTypow;

describe('zawężone zlecenie rzeczywistego klienta kuriera', () => {
  it('przyjmuje paczkę po parserze i wysyła jej liczby w SOAP', async () => {
    const db = openOmsDb();
    const zapis = db.prepare('INSERT INTO zamowienia(sklep,zrodlo_id,numer,metoda_wysylki,kwota_brutto,utworzone_at) VALUES(?,?,?,?,?,?)')
      .run('sklep-test', 11, 'TEST-11', 'dpd', '100.00', '2026-09-30T10:00:00Z');
    const odczyt: ZamowienieDoWysylki = pobierzZamowienie(db, Number(zapis.lastInsertRowid));
    const koperty: string[] = [];
    const klient = createDpdClient({ url: 'https://przyklad.invalid', login: 'test', haslo: 'test', fid: '1',
      infoUrl: 'https://przyklad.invalid/info', channel: '1', nadawca,
      http: async (_url, init) => { koperty.push(String(init?.body)); return new Response('test', { status: 503 }); },
    });
    try {
      const zlecenie = { zamowienie: odczyt, paczka, adres: nadawca } satisfies ZlecenieKuriera;
      expect(odczyt).toMatchObject({ numer: 'TEST-11', pobranie: 0, anulowane: 0, klient: null, dostawa: null });
      await expect(klient.nadaj(zlecenie)).rejects.toThrow();
      expect(koperty).toHaveLength(1);
      expect(koperty[0]).toContain('<reference>TEST-11</reference>');
      expect(koperty[0]).toContain('<weight>1</weight><sizeX>40</sizeX><sizeY>30</sizeY><sizeZ>10</sizeZ>');
    } finally { db.close(); }
  });
});
