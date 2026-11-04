// PRZ-151.C01 — zakładka FAKTURY: korekta programu, który nie podaje numeru KSeF faktury pierwotnej (inFakt),
// dostaje `ksef_korygowanej` wyliczone przez panel (plan PRZ-151, D3), w tej kolejności:
//   1. `zwroty.korekta_uuid` = uuid korekty → `faktury.ksef_numer` zamówienia tego zwrotu — tylko gdy korekta nie
//      podaje `corrected_invoice_number` albo podaje numer TEJ faktury (recenzja: faktura mogła zostać zastąpiona);
//   2. `faktury.numer` = `corrected_invoice_number` korekty (tylko wiersz faktury TEGO programu);
//   3. wiersz VAT z tej samej listy o tym numerze, z `ksef_number`.
// Brak wszystkich → pole puste (nie wiemy = nie wysyłamy). Wiersz z własnym polem (TwojeFaktury) — nietknięty.
// Do tego D7: korekta z `zwroty.korekta_uuid` jest powiązana z zamówieniem, więc ślad wysyłki trafia do jego logu.
// Prawdziwa baza (:memory:), program w procesie, bez sieci. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zapiszKorekte } from '../../../src/oms/db/zwroty.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { fakturaSkasowanaWInfakcie } from '../../../src/moduly/faktury/db/faktury.js';

const KSEF_ZAMOWIENIA = '1234563218-20261003-0A1B2C3D4E5F-01';
const KSEF_PO_NUMERZE = '1234563218-20261004-1B2C3D4E5F60-02';
const KSEF_Z_LISTY = '1234563218-20261005-2C3D4E5F6071-03';
const KSEF_INNEGO_PROGRAMU = '1234563218-20261006-3D4E5F607182-04';
const NIP = '1234500011';

let licznik = 5100;
function zamowienie(db) {
  licznik += 1;
  const numer = String(licznik);
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${numer}`, numer, klient: { first_name: 'Ida' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP,
    kwota_brutto: '158.99', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
  return { id, numer };
}

// Faktura zamówienia w bazie panelu. `program`/`dokument_id` jak po `zakonczFakture`; `program: null` = wiersz inFaktu.
function faktura(db, zamowienieId, { program = 'infakt', dokumentId, numer, ksefNumer = null }) {
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, ksef_numer, utworzona_at) VALUES (?,?,?,?,?,?)',
  ).run(zamowienieId, program, dokumentId, numer, ksefNumer, '2026-10-03T09:00:00Z');
}

// Zwrot z korektą wystawioną z panelu (uuid korekty zapisany przy zwrocie).
function zwrotZKorekta(db, zamowienieId, korektaUuid) {
  const z = dodajZwrot(db, zamowienieId, { data: '2026-11-02', kwota: '27.00', powod: 'zwrot towaru' });
  zapiszKorekte(db, zamowienieId, z.id, { uuid: korektaUuid, numer: '1/KOR/11/2026' });
}

const vat = (uuid, number, nadpisz = {}) => ({
  uuid, number, rodzaj: 'vat', invoice_date: '2026-11-03', sale_date: '2026-11-03', ksef_number: null,
  client_company_name: 'Pracownia Półcień', client_tax_code: NIP, gross_price: 15899, left_to_pay: 0, ...nadpisz,
});
const korekta = (uuid, korygowana, nadpisz = {}) => ({
  uuid, number: `${uuid}/KOR/11/2026`, rodzaj: 'korekta', invoice_date: '2026-11-03', sale_date: '2026-11-03',
  corrected_invoice_number: korygowana, client_company_name: 'Pracownia Półcień', client_tax_code: NIP,
  gross_price: -2700, left_to_pay: 0, ...nadpisz,
});

// Surowy klient programu bez opisu (jak inFakt w etapie A) — `zProgramu` traktuje go jako inFakt.
const programZ = (faktury, korekty) => ({
  listaFaktur: async () => faktury,
  listaKorekt: async () => korekty,
  listaNieoplaconych: async () => [],
});

async function wiersz(db, faktury, korekty, uuid) {
  const w = createFakturyWidok({ db, infakt: programZ(faktury, korekty) });
  const lista = await w.dokumenty({ miesiac: '2026-11', pole: 'invoice_date' });
  return lista.find((d) => d.uuid === uuid);
}

describe('PRZ-151.C01 — korekta bez numeru KSeF pierwotnej: panel wylicza `ksef_korygowanej` (D3)', () => {
  it('źródło 1: korekta zwrotu z panelu bez numeru korygowanej → numer KSeF faktury zamówienia tego zwrotu', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-1', numer: 'FV 1/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    zwrotZKorekta(db, z.id, 'U-KOR-1');
    // Program nie podał numeru korygowanej — źródła 2 i 3 nie mają czego szukać, rozstrzyga powiązanie zwrotu.
    const k = await wiersz(db, [], [korekta('U-KOR-1', null)], 'U-KOR-1');
    expect(k.ksef_korygowanej).toBe(KSEF_ZAMOWIENIA);
    db.close();
  });

  it('źródło 1 tylko dla korygowanej faktury: A skasowana, B z KSeF → korekta A nie dostaje numeru B', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-A', numer: 'FV A/10/2026', ksefNumer: null });
    zwrotZKorekta(db, z.id, 'U-KOR-A');
    fakturaSkasowanaWInfakcie(db, z.id);
    faktura(db, z.id, { dokumentId: 'U-FV-B', numer: 'FV B/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    // Numer korygowanej (A) ≠ numer obecnej faktury zamówienia (B) — źródło 1 milknie, 2 i 3 nic nie mają.
    const k = await wiersz(db, [], [korekta('U-KOR-A', 'FV A/10/2026')], 'U-KOR-A');
    expect(k.ksef_korygowanej).toBeNull();
    // Gdy lista ma wiersz A z numerem KSeF — dalej po kolei, do źródła 3 (nie numer B).
    const k3 = await wiersz(
      db,
      [vat('U-FV-A', 'FV A/10/2026', { ksef_number: KSEF_Z_LISTY })],
      [korekta('U-KOR-A', 'FV A/10/2026')],
      'U-KOR-A',
    );
    expect(k3.ksef_korygowanej).toBe(KSEF_Z_LISTY);
    db.close();
  });

  it('źródło 2: numer pierwotnej z tabeli faktur (gdy korekty nie ma przy żadnym zwrocie)', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-2', numer: 'FV 2/10/2026', ksefNumer: KSEF_PO_NUMERZE });
    const k = await wiersz(db, [], [korekta('U-KOR-2', 'FV 2/10/2026')], 'U-KOR-2');
    expect(k.ksef_korygowanej).toBe(KSEF_PO_NUMERZE);
    db.close();
  });

  it('źródło 2 bierze tylko fakturę TEGO programu — ten sam numer w innym programie nie wystarcza', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, {
      program: 'twojefaktury', dokumentId: 'TF-9', numer: 'FV 9/10/2026', ksefNumer: KSEF_INNEGO_PROGRAMU,
    });
    const k = await wiersz(db, [], [korekta('U-KOR-9', 'FV 9/10/2026')], 'U-KOR-9');
    expect(k.ksef_korygowanej).toBeNull();
    db.close();
  });

  it('źródło 3: wiersz VAT z tej samej listy o numerze pierwotnej, z numerem KSeF', async () => {
    const db = openOmsDb(':memory:');
    const k = await wiersz(
      db,
      [vat('U-FV-3', 'FV 3/11/2026', { ksef_number: KSEF_Z_LISTY })],
      [korekta('U-KOR-3', 'FV 3/11/2026')],
      'U-KOR-3',
    );
    expect(k.ksef_korygowanej).toBe(KSEF_Z_LISTY);
    db.close();
  });

  it('żadne źródło → pole puste (pierwotna bez KSeF w bazie i na liście, korekta bez zwrotu)', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-4', numer: 'FV 4/10/2026', ksefNumer: null });
    const z2 = zamowienie(db);
    faktura(db, z2.id, { dokumentId: 'U-FV-5', numer: 'FV 5/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    // Zwrot drugiego zamówienia ma INNĄ korektę — nie może pożyczyć numeru korekcie U-KOR-4.
    zwrotZKorekta(db, z2.id, 'U-KOR-INNA');
    const k = await wiersz(
      db,
      [vat('U-FV-4', 'FV 4/10/2026', { ksef_number: null })],
      [korekta('U-KOR-4', 'FV 4/10/2026')],
      'U-KOR-4',
    );
    expect(k.ksef_korygowanej).toBeNull();
    db.close();
  });

  it('kolejność przy sprzecznych danych: 1 przed 2 przed 3', async () => {
    const db = openOmsDb(':memory:');
    // Ten sam numer „FV 6/10/2026” ma też faktura innego zamówienia, zapisana WCZEŚNIEJ (źródło 2 bierze pierwszą).
    const z2 = zamowienie(db);
    faktura(db, z2.id, { dokumentId: 'U-FV-7', numer: 'FV 6/10/2026', ksefNumer: KSEF_PO_NUMERZE });
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-6', numer: 'FV 6/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    zwrotZKorekta(db, z.id, 'U-KOR-6');
    const faktury = [
      vat('U-FV-6', 'FV 6/10/2026', { ksef_number: KSEF_Z_LISTY }),
    ];
    // K6: numer korygowanej = faktura zamówienia zwrotu, więc źródło 1 (ZAMOWIENIA) obowiązuje; 2 mówi PO_NUMERZE,
    // 3 mówi Z_LISTY — wygrywa 1. K7: bez zwrotu — źródło 2 (baza) wygrywa z wierszem listy (3).
    const korekty = [korekta('U-KOR-6', 'FV 6/10/2026'), korekta('U-KOR-7', 'FV 6/10/2026')];
    const w = createFakturyWidok({ db, infakt: programZ(faktury, korekty) });
    const lista = await w.dokumenty({ miesiac: '2026-11', pole: 'invoice_date' });
    expect(lista.find((d) => d.uuid === 'U-KOR-6').ksef_korygowanej).toBe(KSEF_ZAMOWIENIA);
    expect(lista.find((d) => d.uuid === 'U-KOR-7').ksef_korygowanej).toBe(KSEF_PO_NUMERZE);
    db.close();
  });

  it('wiersz z własnym polem (TwojeFaktury) — nietknięty, także `null` i także przy pasujących źródłach', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-8', numer: 'FV 8/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    zwrotZKorekta(db, z.id, 'U-KOR-8');
    const faktury = [vat('U-FV-8', 'FV 8/10/2026', { ksef_number: KSEF_Z_LISTY })];
    const korekty = [
      korekta('U-KOR-8', 'FV 8/10/2026', { ksef_korygowanej: null }),
      korekta('U-KOR-81', 'FV 8/10/2026', { ksef_korygowanej: KSEF_INNEGO_PROGRAMU }),
    ];
    const w = createFakturyWidok({ db, infakt: programZ(faktury, korekty) });
    const lista = await w.dokumenty({ miesiac: '2026-11', pole: 'invoice_date' });
    expect(lista.find((d) => d.uuid === 'U-KOR-8').ksef_korygowanej).toBeNull();
    expect(lista.find((d) => d.uuid === 'U-KOR-81').ksef_korygowanej).toBe(KSEF_INNEGO_PROGRAMU);
    // Faktura VAT nie dostaje pola wcale (kształt wiersza bez zmian).
    expect(Object.hasOwn(lista.find((d) => d.uuid === 'U-FV-8'), 'ksef_korygowanej')).toBe(false);
    db.close();
  });
});

describe('PRZ-151.C01 — korekta zwrotu powiązana z zamówieniem (D7)', () => {
  it('wiersz korekty ma `zamowienie` zwrotu; faktura zamówienia — dalej swoje', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { dokumentId: 'U-FV-10', numer: 'FV 10/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    zwrotZKorekta(db, z.id, 'U-KOR-10');
    const w = createFakturyWidok({
      db, infakt: programZ([vat('U-FV-10', 'FV 10/10/2026')], [korekta('U-KOR-10', 'FV 10/10/2026')]),
    });
    const lista = await w.dokumenty({ miesiac: '2026-11', pole: 'invoice_date' });
    expect(lista.find((d) => d.uuid === 'U-KOR-10').zamowienie).toEqual({ id: z.id, numer: z.numer });
    expect(lista.find((d) => d.uuid === 'U-FV-10').zamowienie).toEqual({ id: z.id, numer: z.numer });
    db.close();
  });

  it('kolizja uuid: dokument jest fakturą jednego zamówienia i korektą zwrotu innego → wygrywa faktura', async () => {
    const db = openOmsDb(':memory:');
    const z1 = zamowienie(db);
    faktura(db, z1.id, { dokumentId: 'U-WSPOLNY', numer: 'FV 12/10/2026', ksefNumer: null });
    const z2 = zamowienie(db);
    zwrotZKorekta(db, z2.id, 'U-WSPOLNY');
    const k = await wiersz(db, [vat('U-WSPOLNY', 'FV 12/10/2026')], [], 'U-WSPOLNY');
    expect(k.zamowienie).toEqual({ id: z1.id, numer: z1.numer });
    db.close();
  });

  it('wysyłka korekty z panelu → wpis „zlecono wysyłkę do KSeF” w logu zamówienia zwrotu', async () => {
    const db = openOmsDb(':memory:');
    const z = zamowienie(db);
    faktura(db, z.id, { program: 'wbudowany-testowy', dokumentId: 'V-11', numer: 'FV 11/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
    zwrotZKorekta(db, z.id, 'K-11');
    const wyslane = [];
    // Program, który już dziś wysyła korekty (flaga usługi = program wbudowany); ślad zależy tylko od powiązania.
    const program = {
      opis: {
        id: 'wbudowany-testowy', wbudowany: true, regulaVat: 'wierszami', zdolnosci: ['wyslijDoKsef'],
        wystawienieWysylaDoKsef: false,
        nazwa: Object.freeze({ mianownik: 'Program', dopelniacz: 'Programu', miejscownik: 'Programie', narzednik: 'Programem' }),
        limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4 },
        adres: 'https://program.invalid', ekran: '/ustawienia/integracje/program',
      },
      listaFaktur: async () => [],
      listaKorekt: async () => [korekta('K-11', 'FV 11/10/2026', { ksef_korygowanej: KSEF_ZAMOWIENIA })],
      listaNieoplaconych: async () => [],
      wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return { odpowiedzInfaktu: { ok: true, uuid } }; },
    };
    const fakturyWidok = createFakturyWidok({ db, program });
    const wysylkaKsef = createWysylkaKsef({ db, program, fakturyWidok, log: () => {} });
    await wysylkaKsef.wyslij({ uuids: ['K-11'], miesiac: '2026-11', pole: 'invoice_date' }, 'adam');
    expect(wyslane).toEqual(['K-11']);
    const wpisy = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ksef'").all(z.id)
      .map((w) => w.wynik);
    expect(wpisy).toContain('(adam) zlecono wysyłkę do KSeF z panelu (K-11/KOR/11/2026) — czeka na numer KSeF');
    db.close();
  });
});
