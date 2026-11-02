// PRZ-122.B07h — firma zwolniona z VAT (TwojeFaktury + zapisane zwolnienie, art. 113) i nabywca z numerem VAT UE:
// to nie WDT (decyzja właściciela 27.10). Kartoteka klienta (lista, karta, pasek wyboru przy nowym zamówieniu) nie podpowiada
// „WDT 0% … ÷1,23”, a mail z fakturą nie niesie „Potwierdzenia wywozu”.
// Kontrolnie: TwojeFaktury bez zwolnienia i inFakt z zapisanym zwolnieniem — dopisek i potwierdzenie jak dotąd.
// Dane zmyślone („Pracownia Półcień”, DE123456789); poczta to atrapa (`sendMail` z vi.fn).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { znormalizujKlienta, opisKlienta } from '../../../src/domena/klient-staly.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zapiszZwolnienie, PODSTAWA_ART_113 } from '../../../src/moduly/faktury/db/zwolnienie-vat.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';

const UE = 'DE123456789';
const DOPISEK = '÷1,23';

/** TwojeFaktury w kontrakcie: program testowy z `opis.wbudowany` (lista stawek z „zw”). */
function programWbudowany() {
  const p = programTestowy({ id: 'twojefaktury' });
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}
/** inFakt w kontrakcie: program bez „zw” — zapisane zwolnienie go nie dotyczy. */
const programInfaktu = () => programTestowy({ id: 'infakt' });

const SPRZEDAWCA = {
  nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' },
  proforma: { nip: '1234563218', rachunek: '34109010140000000000000000' },
};

const bazaZeZwolnieniem = (zwolniona) => {
  const db = openOmsDb(':memory:');
  if (zwolniona) zapiszZwolnienie(db, { zwolniona: true, podstawa: PODSTAWA_ART_113, rodzaj: 'ustawa' });
  return db;
};

describe('opisKlienta — flaga firmy zwolnionej', () => {
  const klient = { nazwa: 'Leuchten Muster GmbH', nip: UE };
  it('bez flagi (firma z VAT) — dopisek WDT jak dotąd', () => {
    expect(opisKlienta(klient)).toContain(DOPISEK);
  });
  it('firma zwolniona — numer UE nie daje dopisku WDT', () => {
    expect(opisKlienta(klient, { zwolniona: true })).not.toContain(DOPISEK);
    expect(opisKlienta(klient, { zwolniona: true })).toContain(`NIP ${UE}`);
  });
});

describe('mail „Faktura” — potwierdzenie wywozu', () => {
  function zestaw(program, { zwolniona }) {
    const db = bazaZeZwolnieniem(zwolniona);
    const id = zapiszZamowienie(db, 'pro', {
      zrodlo_id: 3101, numer: '3101',
      klient: { first_name: 'Hans', last_name: 'Testmann', company: 'Leuchten Muster GmbH', email: 'hans@polcien.invalid',
        address_1: 'Musterweg 1', postcode: '10115', city: 'Berlin' },
      dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: UE, kwota_brutto: '123.00',
      status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-27T09:00:00',
      pozycje: [{ nazwa: 'Klosz lniany Półcień', sku: null, ilosc: 1, cena_brutto: '123.00', vat: null }],
    }, {});
    const f = rozpocznijFakture(db, id);
    zakonczFakture(db, f.id, { uuid: 'u-31', numer: 'FV/1/10/2026', ksefStatus: null }, { program: program.opis.id });
    const mailer = { sendMail: vi.fn().mockResolvedValue({}) };
    const wiadomosci = createWiadomosci({ db, mailer, program, config: SPRZEDAWCA, teraz: () => '2026-10-27T12:00:00.000Z' });
    return { id, mailer, wiadomosci };
  }
  const koperta = async (program, opcje) => {
    const { id, mailer, wiadomosci } = zestaw(program, opcje);
    await wiadomosci.wyslij(id, 'faktura');
    return mailer.sendMail.mock.calls[0][0];
  };

  it('firma zwolniona (TwojeFaktury) — sama faktura, ani słowa o wywozie', async () => {
    const mail = await koperta(programWbudowany(), { zwolniona: true });
    expect(mail.attachments.map((a) => a.filename)).toEqual(['Faktura_FV_1_10_2026.pdf']);
    expect(mail.text).not.toContain('wywozu');
  });
  it('kontrolnie: TwojeFaktury bez zwolnienia — potwierdzenie wywozu jak dotąd', async () => {
    const mail = await koperta(programWbudowany(), { zwolniona: false });
    expect(mail.attachments.map((a) => a.filename)).toContain('Potwierdzenie_wywozu_FV_1_10_2026.pdf');
  });
  it('kontrolnie: inFakt z zapisanym zwolnieniem — potwierdzenie wywozu jak dotąd', async () => {
    const mail = await koperta(programInfaktu(), { zwolniona: true });
    expect(mail.attachments.map((a) => a.filename)).toContain('Potwierdzenie_wywozu_FV_1_10_2026.pdf');
  });
});

describe('kartoteka klienta na ekranach (prawdziwy skład modułów)', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: '2026-10-27T12:00:00', ostatni_blad: null }) };
  let app;
  afterEach(async () => { await app?.close(); app = null; });

  async function panel(program, { zwolniona }) {
    const db = bazaZeZwolnieniem(zwolniona);
    const id = dopiszKlienta(db, znormalizujKlienta({ klucz: 'muster-de', nazwa: 'Leuchten Muster GmbH', nip: UE }));
    app = buildOmsServer({ db, config, poller, infakt: program });
    await app.ready();
    const get = async (url) => (await app.inject({ method: 'GET', url, headers: naglowek })).body;
    const nowe = (await app.inject({ method: 'POST', url: '/zamowienia/nowe/klient', headers: naglowek,
      payload: { klient_klucz: 'muster-de' } })).body;
    return { lista: await get('/klienci'), karta: await get(`/klienci/${id}`), nowe };
  }

  it('firma zwolniona — lista, karta i pasek wyboru bez dopisku WDT', async () => {
    const { lista, karta, nowe } = await panel(programWbudowany(), { zwolniona: true });
    for (const html of [lista, karta, nowe]) {
      expect(html).toContain('Leuchten Muster GmbH');
      expect(html).not.toContain(DOPISEK);
    }
  });
  it('kontrolnie: TwojeFaktury bez zwolnienia — dopisek WDT na liście, karcie i pasku', async () => {
    const { lista, karta, nowe } = await panel(programWbudowany(), { zwolniona: false });
    for (const html of [lista, karta, nowe]) expect(html).toContain(DOPISEK);
  });
  it('kontrolnie: inFakt z zapisanym zwolnieniem — dopisek WDT jak dotąd', async () => {
    const { lista, karta, nowe } = await panel(programInfaktu(), { zwolniona: true });
    for (const html of [lista, karta, nowe]) expect(html).toContain(DOPISEK);
  });
});
