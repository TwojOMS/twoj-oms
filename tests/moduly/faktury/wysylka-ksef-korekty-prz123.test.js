// PRZ-123 C08 — usługa wysyłki KSeF i automat dzienny podają regule flagę `korekty` z `program.opis.wbudowany`.
// Prawdziwe `createFakturyWidok`, `createWysylkaKsef`, `createAutomatKsef` na prawdziwej bazie (:memory:) i programie
// fakturowym w procesie (bez sieci). Dwa programy o tym samym koncie dokumentów:
//   • `test` (bez `opis.wbudowany`) — korekty jak dziś: POWOD_KOREKTA znak w znak, automat ich nie rusza;
//   • wbudowany (`opis.wbudowany: true`, jak TwojeFaktury) — korekta faktury już w KSeF jest kandydatem (podgląd,
//     zatwierdzenie, automat), korekta faktury jeszcze nie w KSeF czeka (C09: POWOD_KOREKTA_CZEKA — nie „w inFakcie”).
// Dane zmyślone (NIP-y testowe, numery KSeF wg wzoru TNumerKSeF).
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createAutomatKsef } from '../../../src/moduly/faktury/services/ksef-automat.js';
import { zapiszUstawieniaAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { POWOD_KOREKTA } from '../../../src/domena/wysylka-ksef.js';

const NIP = '1234500011';
const KSEF_PIERWOTNEJ = '1234563218-20261003-0A1B2C3D4E5F-01';
const ZDANIE_KOREKTY = 'Korekty wysyła się w inFakcie — panel ich nie wysyła.';
const ZDANIE_CZEKA = 'Korekta czeka na fakturę pierwotną — wyślesz ją do KSeF, gdy pierwotna dostanie numer KSeF.';
const NAZWA = Object.freeze({ mianownik: 'Program', dopelniacz: 'Programu', miejscownik: 'Programie', narzednik: 'Programem' });

const dok = (uuid, invoice_date, nadpisz = {}) => ({
  uuid, number: `${uuid}/10/2026`, rodzaj: 'vat', invoice_date, sale_date: invoice_date, ksef_number: null,
  client_company_name: 'Pracownia Półcień', client_tax_code: NIP, gross_price: 15899, left_to_pay: 0, ...nadpisz,
});

// V — faktura VAT; K1 — korekta faktury, która jest już w KSeF; K0 — korekta faktury jeszcze nie w KSeF.
const DOKUMENTY = () => [
  dok('V', '2026-10-19'),
  dok('K1', '2026-10-19', { rodzaj: 'korekta', gross_price: -2700, ksef_korygowanej: KSEF_PIERWOTNEJ }),
  dok('K0', '2026-10-19', { rodzaj: 'korekta', gross_price: -800, ksef_korygowanej: null }),
];

function programFakturowy({ wbudowany }) {
  const dokumenty = DOKUMENTY();
  const wyslane = [];
  const zakres = (rodzaj) => async ({ od, do: koniec, pole = 'invoice_date' }) => dokumenty
    .filter((d) => d.rodzaj === rodzaj && String(d[pole]) >= od && String(d[pole]) <= koniec).map((d) => ({ ...d }));
  const nieUzywana = async () => { throw new Error('nie w tym teście'); };
  return {
    wyslane,
    opis: {
      id: wbudowany ? 'wbudowany-testowy' : 'test', nazwa: NAZWA, regulaVat: 'wierszami', zdolnosci: ['wyslijDoKsef'],
      wystawienieWysylaDoKsef: false, ...(wbudowany ? { wbudowany: true } : {}),
      limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4 },
      adres: 'https://program.invalid', ekran: '/ustawienia/integracje/program',
    },
    sprawdzPolaczenie: nieUzywana, przygotujNabywce: nieUzywana, wystaw: nieUzywana, wystawKorekte: nieUzywana,
    pobierzPdf: nieUzywana, pobierzPdfKorekty: nieUzywana, pobierzFakture: nieUzywana,
    listaFaktur: zakres('vat'),
    listaKorekt: zakres('korekta'),
    wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return { odpowiedzInfaktu: { ok: true, uuid } }; },
  };
}

function zestaw({ wbudowany }) {
  const db = openOmsDb(':memory:');
  const program = programFakturowy({ wbudowany });
  const fakturyWidok = createFakturyWidok({ db, program });
  const wysylkaKsef = createWysylkaKsef({ db, program, fakturyWidok, log: () => {} });
  const automat = (teraz) => createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz: () => new Date(teraz), log: () => {} });
  return { db, program, wysylkaKsef, automat };
}
const ARGS = { uuids: ['V', 'K1', 'K0'], miesiac: '2026-10', pole: 'invoice_date' };
const wlacz = (db) => zapiszUstawieniaAutomatu(db, { wlaczony: true, godzina: '20:00', ostatniPrzebieg: null, login: 'adam' });

describe('C08 — program `test` (nie wbudowany): korekty jak dziś', () => {
  it('flaga usługi wyłączona', () => {
    const z = zestaw({ wbudowany: false });
    try { expect(z.wysylkaKsef.korekty).toBe(false); } finally { z.db.close(); }
  });

  it('podgląd i zatwierdzenie: obie korekty odrzucone zdaniem POWOD_KOREKTA znak w znak, leci tylko VAT', async () => {
    const z = zestaw({ wbudowany: false });
    try {
      expect(POWOD_KOREKTA).toBe(ZDANIE_KOREKTY);
      const p = await z.wysylkaKsef.podglad(ARGS);
      expect(p.doWyslania.map((d) => d.uuid)).toEqual(['V']);
      expect(p.pominiete).toEqual([
        { numer: 'K1/10/2026', powod: ZDANIE_KOREKTY },
        { numer: 'K0/10/2026', powod: ZDANIE_KOREKTY },
      ]);
      const w = await z.wysylkaKsef.wyslij(ARGS, 'adam');
      expect(z.program.wyslane).toEqual(['V']);
      expect(w.pominiete.map((x) => x.powod)).toEqual([ZDANIE_KOREKTY, ZDANIE_KOREKTY]);
    } finally { z.db.close(); }
  });

  it('automat dzienny: wysyła tylko VAT, korekty w „po zasadzie” z POWOD_KOREKTA', async () => {
    const z = zestaw({ wbudowany: false });
    try {
      wlacz(z.db);
      const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
      expect(z.program.wyslane).toEqual(['V']);
      expect(w.poZasadzie).toEqual(expect.arrayContaining([
        { numer: 'K1/10/2026', powod: ZDANIE_KOREKTY },
        { numer: 'K0/10/2026', powod: ZDANIE_KOREKTY },
      ]));
    } finally { z.db.close(); }
  });
});

describe('C08 — program wbudowany (TwojeFaktury): korekta faktury już w KSeF jest kandydatem', () => {
  it('flaga usługi włączona', () => {
    const z = zestaw({ wbudowany: true });
    try { expect(z.wysylkaKsef.korekty).toBe(true); } finally { z.db.close(); }
  });

  it('podgląd i zatwierdzenie: V i K1 lecą, K0 (pierwotna nie w KSeF) czeka z POWOD_KOREKTA_CZEKA (C09)', async () => {
    const z = zestaw({ wbudowany: true });
    try {
      const p = await z.wysylkaKsef.podglad(ARGS);
      expect(p.doWyslania.map((d) => d.uuid)).toEqual(['V', 'K1']);
      expect(p.pominiete).toEqual([{ numer: 'K0/10/2026', powod: ZDANIE_CZEKA }]);
      await z.wysylkaKsef.wyslij(ARGS, 'adam');
      expect(z.program.wyslane).toEqual(['V', 'K1']);
    } finally { z.db.close(); }
  });

  it('automat dzienny: wysyła V i K1, K0 nie jest kandydatem', async () => {
    const z = zestaw({ wbudowany: true });
    try {
      wlacz(z.db);
      const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
      expect([...z.program.wyslane].sort()).toEqual(['K1', 'V']);
      expect(w.poZasadzie).toEqual(expect.arrayContaining([{ numer: 'K0/10/2026', powod: ZDANIE_CZEKA }]));
      expect(w.poZasadzie.map((x) => x.numer)).not.toContain('K1/10/2026');
    } finally { z.db.close(); }
  });
});
