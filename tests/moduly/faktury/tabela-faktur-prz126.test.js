import { describe, it, expect, vi, afterEach } from 'vitest';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { szewTwojeFaktury } from '../../../src/moduly/faktury/wczytaj-szew.ts';

const otwarte = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); }
});
function panel(o = {}) {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Sieć zabroniona'));
  if (o.infakt) {
    o.db = openOmsDb(':memory:');
    o.fakturyWidok = createFakturyWidok({ db: o.db, infakt: o.infakt });
  }
  const p = nowyPanel(o);
  otwarte.push(p);
  zalozKonto(p.db, { login: 'test', imie: 'Test', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'test').id, ['faktury']);
  p.headers = jako(p.db, 'test');
  return p;
}
const wiersz = (uuid, ksef_number = null) => ({
  uuid, number: `FV/${uuid}`, rodzaj: 'vat', invoice_date: '2026-10-14',
  net_price: 10895, gross_price: 13400, left_to_pay: 0, status: 'paid', ksef_number,
  client_company_name: 'Lampy Testowe', client_nip: '1234500011',
});
const tabela = (html) => html.match(/<table[^>]*>[\s\S]*?<\/table>/gu).find((t) => t.includes('prz065-tabela--dokumenty'));

describe('P36d tabela faktur', () => {
  it('HTML: Netto przed Brutto, kwoty z pól, bez kolumny KSeF i stanu otwarcia; inFakt z numerem bez plakietki', async () => {
    const p = panel({ infakt: {
      listaFaktur: async () => [wiersz('jest', 'NUMER-TESTOWY'), wiersz('czeka')],
      listaKorekt: async () => [], listaNieoplaconych: async () => [],
    } });
    p.db.prepare("INSERT INTO wysylki_ksef (uuid, zlecona_at) VALUES ('czeka', '2026-10-14T12:00:00Z')").run();
    const r = await get(p.app, '/faktury?miesiac=2026-10', p.headers);
    expect(r.statusCode).toBe(200);
    const t = tabela(r.body);
    expect(t).toMatch(/<th[^>]*>Netto<\/th>[\s\S]*?<th[^>]*>Brutto<\/th>/u);
    expect(t).not.toMatch(/<th[^>]*>KSeF<\/th>|otwarta|zamknięta/u);
    expect(t).toContain('108,95 zł');
    expect(t).toContain('134,00 zł');
    const jest = t.match(/<tr>[\s\S]*?<\/tr>/gu).find((tr) => tr.includes('FV/jest'));
    expect(jest).toContain('title="NUMER-TESTOWY"');
    expect(jest).not.toMatch(/czeka na|odrzucona w KSeF|błąd wysyłki/u);
    expect(t).toContain('czeka na numer');
  });

  it.skipIf(!szewTwojeFaktury)('stany KSeF adaptera i plakietki listy: VAT z numerem oraz korekta brak → czeka → blad → czeka → odrzucona', async () => {
    // Moduły opcjonalne ładujemy dopiero w teście chronionym obecnością szwu TF.
    const { dokument } = await vi.importActual('../../../src/moduly/faktury/db/twojefaktury.js');
    const { zapiszXml, oznaczNieWyslana, doPonowienia, zapiszWynik } = await vi.importActual('../../../src/moduly/faktury/db/twojefaktury-ksef.js');
    const p = panel({ env: { OMS_TRYB: 'proba', OMS_TWOJEFAKTURY: 'tak', OMS_PROGRAM_FAKTUROWY: 'twojefaktury' } });
    // Dane przez publiczny szew i adapter. Klient KSeF jest wyłącznie atrapą w pamięci.
    const klient = {
      otworzSesje: async () => ({ referenceNumber: 'SESJA-TESTOWA' }),
      wyslij: async () => ({ sesjaRef: 'SESJA-TESTOWA', fakturaRef: 'FAKTURA-TESTOWA' }),
      zamknij: async () => {},
      stanFaktury: async () => ({ kod: 200, opis: 'Test', szczegoly: [], numerKsef: '1234563218-20261014-0123456789AB-01' }),
    };
    const program = szewTwojeFaktury.programTwojeFaktury({
      db: p.db, teraz: () => '2026-10-14T12:00:00Z', log: vi.fn(), ksef: () => ({ klient }),
      sprzedawca: () => ({ nazwa: 'Pracownia Półcień', nip: '1234563218', ulica: 'Lampowa 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' }),
    });
    const nabywca = await program.przygotujNabywce({ firma: 'Lampy Testowe', nip: '1234500011', ulica: 'Kloszowa 7', kod: '30-001', miasto: 'Kraków', kraj: 'PL' });
    const pozycja = { name: 'Lampa', quantity: 1, gross_price: 13400, tax_symbol: '23' };
    const fv = await program.wystaw({ ...nabywca, services: [pozycja], invoice_date: '2026-10-14', payment_date: '2026-10-21' });
    await program.wyslijDokumentDoKsef(fv.uuid);
    const widok = createFakturyWidok({ db: p.db, program });
    async function sprawdzStan(id, ksef, plakietka) {
      expect((await program.stanDokumentu(id)).ksef).toBe(ksef);
      const lista = await widok.dokumenty({ miesiac: '2026-10' });
      expect(lista.find((d) => d.uuid === id)).toMatchObject({ stanDokumentu: { ksef }, plakietka });
    }
    await sprawdzStan(fv.uuid, 'jest', null);
    const korekta = await program.wystawKorekte({
      corrected_invoice_uuid: fv.uuid, corrected_invoice_number: fv.numer, corrected_invoice_date: '2026-10-14',
      correction_reason: 'Zwrot lampy', services: [
        { ...pozycja, group: 1, correction: false },
        { ...pozycja, quantity: 0, gross_price: 0, group: 1, correction: true },
      ],
    });
    const dokumentId = korekta.uuid;
    expect(await program.stanDokumentu(dokumentId)).toMatchObject({ ksef: 'brak', otwarty: true, zamknieta: null });
    await sprawdzStan(dokumentId, 'brak', 'czeka na wysyłkę');
    const r = await get(p.app, '/faktury?miesiac=2026-10', p.headers);
    expect(r.statusCode).toBe(200);
    expect(tabela(r.body)).toContain('czeka na wysyłkę');

    zapiszXml(p.db, dokumentId, { wersja: dokument(p.db, dokumentId).wersja, xml: Buffer.from('<Korekta/>') });
    await sprawdzStan(dokumentId, 'czeka', 'czeka na numer');

    oznaczNieWyslana(p.db, dokumentId, dokument(p.db, dokumentId).wersja);
    await sprawdzStan(dokumentId, 'blad', 'błąd wysyłki');

    doPonowienia(p.db, dokumentId, dokument(p.db, dokumentId).wersja);
    zapiszWynik(p.db, dokumentId, dokument(p.db, dokumentId).wersja, { status: 'niepewna' });
    await sprawdzStan(dokumentId, 'czeka', 'czeka na numer');

    zapiszWynik(p.db, dokumentId, dokument(p.db, dokumentId).wersja, { status: 'odrzucona', kod: 450 });
    await sprawdzStan(dokumentId, 'odrzucona', 'odrzucona w KSeF');
  });
});
