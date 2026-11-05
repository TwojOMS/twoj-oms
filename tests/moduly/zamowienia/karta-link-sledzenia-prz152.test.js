// PRZ-152.G7: numer paczki Allegro „Wysyłam z Allegro” (WzA) wiezionej przez DPD ma być linkiem do śledzenia DPD
// na KARCIE zamówienia i w mailu „Zamówienie wysłane” — tym samym, co w zakładce Przesyłki. Wszystkie trzy miejsca
// liczą link jedną funkcją domeny (`linkSledzeniaPaczki`, domena/przewoznik-przesylki.js). Do 04.11 karta i mail
// brały go po samym kodzie drogi nadania (`linkDoSledzenia(p.kurier)`), a `allegro_wza` nie mówi, kto wiezie.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { paczkiDoMaila } from '../../../src/domena/wiadomosc-wyslane.js';
import { linkSledzeniaPaczki } from '../../../src/domena/przewoznik-przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const DPD = (n) => `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${n}`;
const INPOST = (n) => `https://inpost.pl/sledzenie-przesylek?number=${n}`;
// EJS ucieka `&` w atrybucie.
const wHtml = (url) => url.replaceAll('&', '&amp;');

const zam = (nr) => ({
  zrodlo_id: nr, numer: `Z-${nr}`, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@example.com' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Polna 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '50.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-20T10:00:00Z',
  pozycje: [{ nazwa: 'Szablon próbny', sku: 'S-1', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00', vat: null }],
});

let db; let app; let nr = 0;
// Zapis jak prawdziwy: WzA ma `kurier = allegro_wza`, przewoźnika (DPD) tylko w `odpowiedz_surowa`
// (transportingInfo.carrierId) i nazwie usługi zamówienia; `carrier_allegro` przy WzA zostaje puste.
function paczka({ sklep = 'pro', kurier, numer, metoda, nazwa = null, surowa = '<x/>' }) {
  nr += 1;
  const id = zapiszZamowienie(db, sklep, zam(9000 + nr), {});
  db.prepare('UPDATE zamowienia SET metoda_wysylki = ?, metoda_wysylki_nazwa = ? WHERE id = ?').run(metoda, nazwa, id);
  const p = rozpocznijPrzesylke(db, id, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa });
  db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run('2026-10-21T10:00:00.000Z', p.id);
  return id;
}

const surowaWza = (waybill) => JSON.stringify({
  carrier: 'ALLEGRO',
  packages: [{ waybill, transportingInfo: { carrierId: 'DPD', carrierWaybill: '00000123456789' } }],
});

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });
const hrefyNumeru = (html, numer) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)]
  .filter((m) => m[2].trim() === numer).map((m) => m[1]);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T10:00:00Z'));
  db = openOmsDb(':memory:');
  nr = 0;
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] }, poller });
  await app.ready();
});

describe('link do śledzenia: karta, mail i zakładka Przesyłki mówią to samo', () => {
  const PRZYPADKI = [
    { opis: 'WzA wieziona przez DPD', kurier: 'allegro_wza', numer: 'AD0001112223', metoda: 'allegro_dpd',
      nazwa: 'Allegro Kurier DPD', sklep: 'allegro_proba', surowa: surowaWza('AD0001112223'), link: DPD('AD0001112223') },
    { opis: 'DPD na własnej umowie (bez zmian)', kurier: 'dpd', numer: '0000999888777U', metoda: 'dpd',
      link: DPD('0000999888777U') },
    { opis: 'InPost (bez zmian)', kurier: 'inpost', numer: '620000111222333444555666', metoda: 'inpost_paczkomat',
      link: INPOST('620000111222333444555666') },
  ];

  for (const c of PRZYPADKI) {
    it(`${c.opis}: ten sam link na karcie, w mailu i na liście Przesyłki`, async () => {
      const id = paczka(c);

      const karta = await pobierz(`/zamowienia/${id}`);
      expect(karta.statusCode, karta.body).toBe(200);
      expect(hrefyNumeru(karta.body, c.numer)).toContain(wHtml(c.link));

      const z = pobierzZamowienie(db, id);
      expect(paczkiDoMaila(z).map((p) => p.link)).toEqual([c.link]);
      expect(linkSledzeniaPaczki(z.przesylki[0], z)).toBe(c.link);

      const lista = await pobierz('/przesylki?pokaz=wszystkie');
      expect(lista.statusCode).toBe(200);
      expect(hrefyNumeru(lista.body, c.numer)).toEqual([wHtml(c.link)]);
    });
  }

  it('paczka bez rozpoznanego przewoźnika: bez linku (nigdy zgadnięty adres)', async () => {
    const id = paczka({ sklep: 'allegro_proba', kurier: 'allegro_wza', numer: 'AD0009998887', metoda: 'allegro_punkt' });
    const z = pobierzZamowienie(db, id);
    expect(linkSledzeniaPaczki(z.przesylki[0], z)).toBeNull();
    expect(paczkiDoMaila(z).map((p) => p.link)).toEqual([null]);
    expect(hrefyNumeru((await pobierz(`/zamowienia/${id}`)).body, 'AD0009998887')).toEqual([]);
  });
});
