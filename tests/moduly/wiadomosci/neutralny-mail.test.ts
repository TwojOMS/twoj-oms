import { wzorzecNazw } from '../../pomoc/skroty-nazw-firmy.js';
import { describe, it, expect, vi, beforeAll, afterAll, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';

// PRZ-029 RED: mail do klienta składany przez RZECZYWISTE usługi domyślnego bootstrapu nie może
// nieść marki ani stopki konkretnej firmy zaszytej w kodzie. Proponowana umowa (bez rozszerzeń):
//   OMS_MAIL_MARKA  — podpis pod mailem; brak → neutralne „Obsługa sklepu”,
//   OMS_MAIL_STOPKA — stopka maila; brak → bez stopki.
// Tekst i HTML mają ten sam podpis; w HTML-u wartości z konfiguracji są escapowane.
// Atrapą jest wyłącznie `createMailer` (przechwytuje wywołanie, niczego nie wysyła); `fetch` odrzuca.

const poczta = vi.hoisted(() => ({ wyslane: [] as any[] }));
vi.mock('../../../src/core/poczta/smtp.js', () => ({
  createMailer: () => ({ sendMail: async (m: any) => { poczta.wyslane.push(m); return { messageId: 'atrapa' }; } }),
}));

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  SMTP_HOST: 'smtp.fikcja.test', SMTP_USER: 'nadawca@fikcja.test', SMTP_PASS: 'fikcyjne' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}`, origin: 'http://localhost' };
const FIRMY = wzorzecNazw([{"wzor": "\\p{L}{8}", "skrot": "3876cd847a24f6d3a8f3542919b9f6545e500e2eea8583bb58583508cefe9a57", "bezWielkosci": true}, {"wzor": "\\p{L}{8}", "skrot": "a2ac0b2e157811634f85a0cd5e7ec6ae46b6123e724924eba975ef822566f72e", "bezWielkosci": true}]);
const MARKA = 'Pracownia <Fikcja> & Syn';
const STOPKA = 'ul. Testowa 1 <b>Testowo</b>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Oms = Awaited<ReturnType<typeof zbudujOms>>;
let transport: MockInstance<typeof fetch>;
beforeAll(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterAll(() => { expect(transport).not.toHaveBeenCalled(); transport.mockRestore(); });

const zamowienie = (a: Oms) => {
  const id = utworzZamowienieReczne(a.db, { klient: { email: 'klient@fikcja.test' },
    dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
    metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', utworzone_at: '2026-10-01T09:00:00.000Z' });
  dodajPozycjeReczna(a.db, id, { nazwa: 'Produkt fikcyjny', sku: 'FIK-1', ilosc: 2, cena_brutto: '10.00', brutto_linii: '20.00' });
  przeliczKwoteRecznego(a.db, id);
  return id;
};
// Podgląd z usługi, wysyłka prawdziwą trasą karty — i to, co przechwyciła atrapa SMTP.
const podgladIWysylka = async (a: Oms, temat: string) => {
  const id = zamowienie(a);
  const p = await a.usluga<any>('wiadomosci', 'wiadomosci').podglad(id, temat);
  const przed = poczta.wyslane.length;
  const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/wiadomosc/${temat}`, headers });
  return { p, status: r.statusCode, m: poczta.wyslane.slice(przed) };
};
const ostatniaLinia = (t: string) => t.trimEnd().split('\n').at(-1);

for (const temat of ['potwierdzenie', 'przypomnienie']) {
  describe(`neutralny mail „${temat}” — domyślny bootstrap bez marki w konfiguracji`, () => {
    let a: Oms | undefined;
    let w: Awaited<ReturnType<typeof podgladIWysylka>>;
    beforeAll(async () => { a = await zbudujOms({ env }); w = await podgladIWysylka(a, temat); });
    afterAll(async () => { try { if (a) await a.app.close(); } finally { a?.db.close(); } });

    it('podgląd i wysyłka to ten sam mail (jedno wywołanie atrapy SMTP)', () => {
      expect({ status: w.status, n: w.m.length, text: w.m[0]?.text, html: w.m[0]?.html })
        .toEqual({ status: 302, n: 1, text: w.p.tekst, html: w.p.html });
    });

    it('tekst i HTML bez marki firmy zaszytej w kodzie', () => {
      expect({ tekst: FIRMY.test(w.p.tekst), html: FIRMY.test(w.p.html) })
        .toEqual({ tekst: false, html: false });
    });

    it('podpis to neutralne „Obsługa sklepu” — ten sam w tekście i w HTML-u', () => {
      expect({ tekst: ostatniaLinia(w.p.tekst), html: w.p.html.includes('Obsługa sklepu') })
        .toEqual({ tekst: 'Obsługa sklepu', html: true });
    });
  });

  describe(`mail „${temat}” z jawną marką i stopką z konfiguracji`, () => {
    let a: Oms | undefined;
    let w: Awaited<ReturnType<typeof podgladIWysylka>>;
    beforeAll(async () => {
      a = await zbudujOms({ env: { ...env, OMS_MAIL_MARKA: MARKA, OMS_MAIL_STOPKA: STOPKA } });
      w = await podgladIWysylka(a, temat);
    });
    afterAll(async () => { try { if (a) await a.app.close(); } finally { a?.db.close(); } });

    it('tekst podpisany marką z konfiguracji, ze stopką, bez firmy z kodu', () => {
      expect({ podpis: w.p.tekst.includes(`Pozdrawiamy,\n${MARKA}`), stopka: w.p.tekst.includes(STOPKA),
        firma: FIRMY.test(w.p.tekst) }).toEqual({ podpis: true, stopka: true, firma: false });
    });

    it('HTML ma tę samą markę i stopkę, escapowane — surowy znacznik z konfiguracji nie przechodzi', () => {
      expect({ marka: w.p.html.includes(esc(MARKA)), stopka: w.p.html.includes(esc(STOPKA)),
        surowe: w.p.html.includes('<Fikcja>') || w.p.html.includes('<b>Testowo</b>'),
        firma: FIRMY.test(w.p.html) }).toEqual({ marka: true, stopka: true, surowe: false, firma: false });
    });

    it('wysłany mail jest dokładnie podglądem', () => {
      expect({ status: w.status, text: w.m[0]?.text, html: w.m[0]?.html }).toEqual({ status: 302, text: w.p.tekst, html: w.p.html });
    });
  });
}
