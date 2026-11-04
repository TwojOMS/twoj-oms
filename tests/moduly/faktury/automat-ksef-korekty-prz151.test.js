// PRZ-151.C02 — usługa wysyłki KSeF i automat dzienny wysyłają korekty programu, który sam wysyła do KSeF
// (zdolność `wyslijDoKsef`), a nie tylko programu wbudowanego (plan PRZ-151, D2). Program jak inFakt: surowy klient
// przez `infakt:` (adapter `programInfakt`, zdolności z metod klienta), bez sieci — `wyslijDokumentDoKsef` to atrapa.
// Numer KSeF faktury pierwotnej liczy panel (C01, D3): tu przez zwrot z korektą (źródło 1) albo numer z tabeli
// faktur (źródło 2). Uzgodnienie wstrzymanych automatu (`uzgodnijWstrzymane`) zostaje tylko przy programie
// wbudowanym. Prawdziwa baza (:memory:). Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zapiszKorekte } from '../../../src/oms/db/zwroty.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createAutomatKsef } from '../../../src/moduly/faktury/services/ksef-automat.js';
import { zapiszUstawieniaAutomatu, wczytajAutomatKsef, wstrzymajFakture } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { POWOD_KOREKTA_CZEKA, POWOD_KONSUMENCKA } from '../../../src/domena/wysylka-ksef.js';

const NIP = '1234500011';
const KSEF_ZAMOWIENIA = '1234563218-20261003-0A1B2C3D4E5F-01';
const KSEF_PO_NUMERZE = '1234563218-20261004-1B2C3D4E5F60-02';
const ZDANIE_CZEKA = 'Korekta czeka na fakturę pierwotną — wyślesz ją do KSeF, gdy pierwotna dostanie numer KSeF.';
const ARGS = (uuids) => ({ uuids, miesiac: '2026-11', pole: 'invoice_date' });

let licznik = 7100;
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

function faktura(db, zamowienieId, { dokumentId, numer, ksefNumer }) {
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, ksef_numer, utworzona_at) VALUES (?,?,?,?,?,?)',
  ).run(zamowienieId, 'infakt', dokumentId, numer, ksefNumer, '2026-10-03T09:00:00Z');
}

const vat = (uuid, number, nadpisz = {}) => ({
  uuid, number, rodzaj: 'vat', invoice_date: '2026-11-03', sale_date: '2026-11-03', ksef_number: null,
  client_company_name: 'Pracownia Półcień', client_tax_code: NIP, gross_price: 15899, left_to_pay: 0, ...nadpisz,
});
const korekta = (uuid, number, korygowana, nadpisz = {}) => ({
  uuid, number, rodzaj: 'korekta', invoice_date: '2026-11-03', sale_date: '2026-11-03', ksef_number: null,
  corrected_invoice_number: korygowana, client_company_name: 'Pracownia Półcień', client_tax_code: NIP,
  gross_price: -2700, left_to_pay: 0, ...nadpisz,
});

// Zestaw jak na koncie inFaktu: V — faktura VAT; KZ — korekta zwrotu z panelu, koryguje fakturę
// swojego zamówienia FV 1/10/2026 (pierwotna w KSeF przez zwrot; od poprawionego C01 źródło 1 wymaga zgodnego numeru);
// K0 — korekta faktury spoza panelu (pierwotnej nie znamy → czeka); KB — korekta konsumencka (bez NIP-u),
// pierwotna w KSeF przez numer z tabeli faktur.
// `dataKZ` — data wystawienia korekty KZ (domyślnie ta sama co V; późniejsza stawia ją na liście przed V).
function zestaw({ wyslijDoKsef = true, odmowa = null, wpisTf = null, dataKZ = '2026-11-03' } = {}) {
  const db = openOmsDb(':memory:');
  const z = zamowienie(db);
  faktura(db, z.id, { dokumentId: 'U-FV-1', numer: 'FV 1/10/2026', ksefNumer: KSEF_ZAMOWIENIA });
  const zw = dodajZwrot(db, z.id, { data: '2026-11-02', kwota: '27.00', powod: 'zwrot towaru' });
  zapiszKorekte(db, z.id, zw.id, { uuid: 'KZ', numer: '1/KOR/11/2026' });
  const z2 = zamowienie(db);
  faktura(db, z2.id, { dokumentId: 'U-FV-2', numer: 'FV 2/10/2026', ksefNumer: KSEF_PO_NUMERZE });

  const dokumenty = [
    vat('V', 'FV 3/11/2026'),
    korekta('KZ', '1/KOR/11/2026', 'FV 1/10/2026', { invoice_date: dataKZ }),
    korekta('K0', '2/KOR/11/2026', 'FV 99/09/2026'),
    korekta('KB', '3/KOR/11/2026', 'FV 2/10/2026', { client_tax_code: '', client_company_name: '', client_first_name: 'Ida', client_last_name: 'Nowak' }),
  ];
  const wyslane = [];
  const zakres = (rodzaj) => async ({ od, do: koniec, pole = 'invoice_date' } = {}) => dokumenty
    .filter((d) => d.rodzaj === rodzaj && (!od || (String(d[pole]) >= od && String(d[pole]) <= koniec)))
    .map((d) => ({ ...d }));
  const klient = {
    listaFaktur: zakres('vat'),
    listaKorekt: zakres('korekta'),
    listaNieoplaconych: async () => [],
    ...(wyslijDoKsef ? {
      wyslijDokumentDoKsef: async (uuid) => {
        if (odmowa && odmowa === uuid) throw Object.assign(new Error('odmowa 422'), { dlaOperatora: true, status: 422 });
        wyslane.push(uuid);
        return { odpowiedzInfaktu: { ok: true, uuid } };
      },
    } : {}),
  };
  const fakturyWidok = createFakturyWidok({ db, infakt: klient });
  const wysylkaKsef = createWysylkaKsef({ db, infakt: klient, fakturyWidok, log: () => {}, wpisTf });
  const automat = (teraz) => createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz: () => new Date(teraz), log: () => {} });
  return { db, z, wyslane, wysylkaKsef, automat };
}
const wlacz = (db) => zapiszUstawieniaAutomatu(db, { wlaczony: true, godzina: '20:00', ostatniPrzebieg: null, login: 'adam' });
// 20:01 w Warszawie (CET) 4 listopada.
const PRZEBIEG = '2026-11-04T19:01:00Z';

describe('PRZ-151.C02 — usługa: program z `wyslijDoKsef` (nie wbudowany) wysyła korekty', () => {
  it('flaga `korekty` włączona; program bez wysyłki do KSeF — flaga wyłączona i `niedostepna`', () => {
    const z = zestaw();
    const bez = zestaw({ wyslijDoKsef: false });
    try {
      expect(z.wysylkaKsef.korekty).toBe(true);
      expect(z.wysylkaKsef.niedostepna).toBeNull();
      expect(bez.wysylkaKsef.korekty).toBe(false);
      expect(bez.wysylkaKsef.niedostepna).toEqual(expect.any(String));
    } finally { z.db.close(); bez.db.close(); }
  });

  it('podgląd: korekta z pierwotną w KSeF „do wysłania”, bez — POWOD_KOREKTA_CZEKA znak w znak', async () => {
    const z = zestaw();
    try {
      expect(POWOD_KOREKTA_CZEKA).toBe(ZDANIE_CZEKA);
      const p = await z.wysylkaKsef.podglad(ARGS(['V', 'KZ', 'K0']));
      expect(p.doWyslania.map((d) => d.uuid)).toEqual(['V', 'KZ']);
      expect(p.pominiete).toEqual([{ numer: '2/KOR/11/2026', powod: ZDANIE_CZEKA }]);
    } finally { z.db.close(); }
  });

  it('zatwierdzenie: `wyslijDokumentDoKsef` z uuid korekty, rezerwacja z jej numerem, ślad w logu zamówienia, '
    + 'drugi raz — odmowa „już zlecił”', async () => {
    const z = zestaw();
    try {
      const w = await z.wysylkaKsef.wyslij(ARGS(['KZ']), 'adam');
      expect(z.wyslane).toEqual(['KZ']);
      expect(w.wyslane.map((d) => d.uuid)).toEqual(['KZ']);
      expect(z.db.prepare('SELECT numer FROM wysylki_ksef WHERE uuid = ?').get('KZ')).toEqual({ numer: '1/KOR/11/2026' });
      const wpisy = z.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ksef'").all(z.z.id)
        .map((x) => x.wynik);
      expect(wpisy).toContain('(adam) zlecono wysyłkę do KSeF z panelu (1/KOR/11/2026) — czeka na numer KSeF');

      const drugi = await z.wysylkaKsef.wyslij(ARGS(['KZ']), 'adam');
      expect(z.wyslane).toEqual(['KZ']);
      expect(drugi.wyslane).toEqual([]);
      expect(drugi.pominiete).toHaveLength(1);
      expect(drugi.pominiete[0].powod).toMatch(/^Panel już zlecił wysyłkę tego dokumentu do KSeF/);
    } finally { z.db.close(); }
  });

  it('korekta konsumencka przy wyłączonej wysyłce B2C — odmowa konsumencka, nic nie poszło', async () => {
    const z = zestaw();
    try {
      const p = await z.wysylkaKsef.podglad(ARGS(['KB']));
      expect(p.doWyslania).toEqual([]);
      expect(p.pominiete).toEqual([{ numer: '3/KOR/11/2026', powod: POWOD_KONSUMENCKA }]);
      const w = await z.wysylkaKsef.wyslij(ARGS(['KB']), 'adam');
      expect(z.wyslane).toEqual([]);
      expect(w.pominiete).toEqual([{ numer: '3/KOR/11/2026', powod: POWOD_KONSUMENCKA }]);
    } finally { z.db.close(); }
  });

  it('`uzgodnijWstrzymane` NIE wołane dla programu nie wbudowanego (wpisTf podany jak w modul.ts)', async () => {
    const wpisTf = { stanKsef: vi.fn(() => null), otwartaNieWyslana: vi.fn(() => false) };
    const z = zestaw({ wpisTf });
    try {
      wstrzymajFakture(z.db, { uuid: 'V', numer: 'FV 3/11/2026', dzien: '2026-11-03', powod: 'próba', kod: 'nie-wyslano', wersja: 1 });
      await z.wysylkaKsef.wyslij(ARGS(['V']), 'adam');
      expect(z.wyslane).toEqual(['V']);
      expect(wpisTf.stanKsef).not.toHaveBeenCalled();
      expect(wczytajAutomatKsef(z.db).wstrzymane.map((x) => x.uuid)).toEqual(['V']);
    } finally { z.db.close(); }
  });
});

describe('PRZ-151.C02 — automat dzienny: korekty razem z fakturami', () => {
  it('ten sam przebieg wysyła V i KZ; K0 i KB w „po zasadzie” z powodem', async () => {
    const z = zestaw();
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect([...z.wyslane].sort()).toEqual(['KZ', 'V']);
      expect(w.stan).toBe('ok');
      expect(w.poZasadzie).toEqual(expect.arrayContaining([
        { numer: '2/KOR/11/2026', powod: ZDANIE_CZEKA },
        { numer: '3/KOR/11/2026', powod: POWOD_KONSUMENCKA },
      ]));
      expect(w.poZasadzie.map((x) => x.numer)).not.toContain('1/KOR/11/2026');
    } finally { z.db.close(); }
  });

  it('pewna odmowa (422) przy korekcie — przebieg staje, korekta wstrzymana jak faktura', async () => {
    const z = zestaw({ odmowa: 'KZ' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('blad');
      expect(z.wyslane).not.toContain('KZ');
      expect(z.wyslane).toEqual(['V']);
      expect(w.wyslane.map((d) => d.uuid)).toEqual(['V']);
      expect(wczytajAutomatKsef(z.db).wstrzymane.map((x) => ({ uuid: x.uuid, numer: x.numer })))
        .toEqual([{ uuid: 'KZ', numer: '1/KOR/11/2026' }]);
      expect(z.db.prepare('SELECT 1 FROM wysylki_ksef WHERE uuid = ?').get('KZ')).toBeUndefined();
    } finally { z.db.close(); }
  });

  // Recenzja C02: lista jest od najnowszej daty, więc korekta z późniejszą datą stała przed fakturą — jej 422
  // kończył przebieg i faktura VAT z tego dnia czekała do jutra. Automat wysyła najpierw faktury, potem korekty.
  it('422 przy korekcie z datą późniejszą niż faktura — faktura VAT i tak wysłana w tym przebiegu', async () => {
    const z = zestaw({ odmowa: 'KZ', dataKZ: '2026-11-04' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('blad');
      expect(z.wyslane).toEqual(['V']);
      expect(w.wyslane.map((d) => d.uuid)).toEqual(['V']);
      expect(wczytajAutomatKsef(z.db).wstrzymane.map((x) => x.uuid)).toEqual(['KZ']);
    } finally { z.db.close(); }
  });

  it('kolejność wysyłki: najpierw faktury VAT, potem korekty (także gdy korekta ma późniejszą datę)', async () => {
    const z = zestaw({ dataKZ: '2026-11-04' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('ok');
      expect(z.wyslane).toEqual(['V', 'KZ']);
    } finally { z.db.close(); }
  });

  // Ponowna recenzja C02: automat przechodzi poprzedni i bieżący miesiąc — kolejność „faktury przed korektami”
  // obowiązuje w całym przebiegu, nie tylko w obrębie miesiąca (korekta z października nie zatrzyma listopadowej V).
  it('422 przy korekcie z poprzedniego miesiąca — faktura VAT z bieżącego i tak wysłana', async () => {
    const z = zestaw({ odmowa: 'KZ', dataKZ: '2026-10-31' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('blad');
      expect(z.wyslane).toEqual(['V']);
      expect(w.wyslane.map((d) => d.uuid)).toEqual(['V']);
      expect(wczytajAutomatKsef(z.db).wstrzymane.map((x) => x.uuid)).toEqual(['KZ']);
    } finally { z.db.close(); }
  });

  // Odbiór 50ed0def: pewna odmowa faktury VAT w pierwszej rundzie kończy przebieg — runda korekt się nie zaczyna.
  // KZ z poprzedniego miesiąca: jest już odłożona do drugiej rundy, gdy listopadowa V dostaje odmowę.
  it('422 przy fakturze VAT — korekty z drugiej rundy nie idą i nie są wstrzymane', async () => {
    const z = zestaw({ odmowa: 'V', dataKZ: '2026-10-31' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('blad');
      expect(z.wyslane).toEqual([]);
      expect(w.wyslane).toEqual([]);
      expect(wczytajAutomatKsef(z.db).wstrzymane.map((x) => x.uuid)).toEqual(['V']);
      expect(z.db.prepare('SELECT 1 FROM wysylki_ksef WHERE uuid = ?').get('KZ')).toBeUndefined();
    } finally { z.db.close(); }
  });

  it('kolejność przez oba miesiące: faktura z bieżącego przed korektą z poprzedniego', async () => {
    const z = zestaw({ dataKZ: '2026-10-31' });
    try {
      wlacz(z.db);
      const w = await z.automat(PRZEBIEG).przebieg();
      expect(w.stan).toBe('ok');
      expect(z.wyslane).toEqual(['V', 'KZ']);
    } finally { z.db.close(); }
  });
});
