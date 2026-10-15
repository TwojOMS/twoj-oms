import { describe, it, expect, vi, beforeAll, afterAll, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';

// Luka po neutralny-mail: klucz OMS_MAIL_* OBECNY, ale pusty (szablon .env) albo podana
// sama stopka. Gałąź `!== undefined` w konfiguracji buduje wtedy oprawę, więc neutralny
// podpis musi wyjść z jednego fallbacku domeny, a pusta marka nie może dać pustego nagłówka.
// Atrapą jest wyłącznie `createMailer`; `fetch` odrzuca.

vi.mock('../../../src/core/poczta/smtp.js', () => ({
  createMailer: () => ({ sendMail: async () => ({ messageId: 'atrapa' }) }),
}));

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  SMTP_HOST: 'smtp.fikcja.test', SMTP_USER: 'nadawca@fikcja.test', SMTP_PASS: 'fikcyjne' };
const STOPKA = 'ul. Testowa 1 <b>Testowo</b>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let transport: MockInstance<typeof fetch>;
beforeAll(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterAll(() => { expect(transport).not.toHaveBeenCalled(); transport.mockRestore(); });

// Ten sam deterministyczny wsad w każdym bootstrapie: różnica w mailu = różnica oprawy.
async function podglady(extra: Record<string, string>) {
  const a = await zbudujOms({ env: { ...env, ...extra } });
  try {
    const id = utworzZamowienieReczne(a.db, { klient: { email: 'klient@fikcja.test' },
      dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
      metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', utworzone_at: '2026-10-01T09:00:00.000Z' });
    dodajPozycjeReczna(a.db, id, { nazwa: 'Produkt fikcyjny', sku: 'FIK-1', ilosc: 2, cena_brutto: '10.00', brutto_linii: '20.00' });
    przeliczKwoteRecznego(a.db, id);
    const u = a.usluga<any>('wiadomosci', 'wiadomosci');
    return { potwierdzenie: await u.podglad(id, 'potwierdzenie'), przypomnienie: await u.podglad(id, 'przypomnienie') };
  } finally { try { await a.app.close(); } finally { a.db.close(); } }
}

describe('obecne, ale puste klucze oprawy poczty', () => {
  let neutralny: Awaited<ReturnType<typeof podglady>>;
  let puste: typeof neutralny;
  let samaStopka: typeof neutralny;
  beforeAll(async () => {
    neutralny = await podglady({});
    puste = await podglady({ OMS_MAIL_MARKA: '   ', OMS_MAIL_STOPKA: '' });
    samaStopka = await podglady({ OMS_MAIL_STOPKA: STOPKA });
  });

  for (const temat of ['potwierdzenie', 'przypomnienie'] as const) {
    it(`„${temat}”: puste OMS_MAIL_MARKA/OMS_MAIL_STOPKA dają bajtowo ten sam mail co ich brak`, () => {
      expect({ tekst: puste[temat].tekst, html: puste[temat].html })
        .toEqual({ tekst: neutralny[temat].tekst, html: neutralny[temat].html });
    });

    it(`„${temat}”: sama stopka — neutralny podpis domeny, stopka escapowana, reszta bez zmian`, () => {
      const p = samaStopka[temat];
      // Bez wiersza stopki koperty HTML ma być neutralnym mailem: bez nagłówka marki i z tym samym podpisem.
      const bezStopki = p.html.replace(/<tr><td class="mail-footer".*?<\/td><\/tr>/s, '');
      expect({ tekst: p.tekst, stopkaHtml: p.html.includes(esc(STOPKA)), surowa: p.html.includes('<b>Testowo</b>'),
        bezStopki: bezStopki === neutralny[temat].html })
        .toEqual({ tekst: `${neutralny[temat].tekst}\n\n${STOPKA}`, stopkaHtml: true, surowa: false, bezStopki: true });
    });
  }
});
