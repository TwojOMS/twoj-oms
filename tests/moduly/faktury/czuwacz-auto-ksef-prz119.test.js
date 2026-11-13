// PRZ-119.05 — warstwa 3 ochrony przed automatyczną wysyłką Fakturowni do KSeF: czuwacz KSeF czyta dokument, którego
// wysyłki OMS NIE zlecał (brak wiersza w `wysylki_ksef`), a Fakturownia mówi, że dokument poszedł do KSeF
// (`gov_status` poza null / not_connected / not_applicable) → ten sam trwały alarm co przy wystawieniu (warstwa 2)
// i wpis w historii zamówienia. Dokument zlecony z panelu — bez alarmu. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, ostatniWpisLogu } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { utworzAlarmAutoKsef } from '../../../src/moduly/faktury/db/alarm-auto-ksef.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { programFakturownia } from '../../../src/integracje/programy/fakturownia.ts';

let licznik = 0;

function zamowienieZFaktura(db, { wyslanaZPanelu }) {
  licznik += 1;
  const sklep = 'allegro_polcien';
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${licznik}`, numer: String(5000 + licznik), klient: { first_name: 'Ala' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: new Date().toISOString(), pozycje: [],
  }, {});
  const dokument = String(900 + licznik);
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid: dokument, numer: `FV ${licznik}/11/2026`, ksefStatus: null }, { program: 'fakturownia' });
  if (wyslanaZPanelu) zajmijWysylkeKsef(db, dokument, { numer: `FV ${licznik}/11/2026` });
  return { zamowienieId: id, dokument };
}

function czuwaczFakturowni(db, odpowiedz, { alarm = true } = {}) {
  const alarmAutoKsef = utworzAlarmAutoKsef(db);
  const klient = {
    pobierzFakture: async (id) => ({ id: Number(id), number: `FV ${id}`, kind: 'vat', price_gross: '123.00', price_net: '100.00', price_tax: '23.00', paid: '0',
      positions: [], ...odpowiedz }),
  };
  const program = programFakturownia(klient, { alarmAutoKsef });
  return { alarmAutoKsef, czuwacz: createCzuwaczKsef({ db, program, ...(alarm ? { alarmAutoKsef } : {}), log: () => {} }) };
}

describe('PRZ-119.05 czuwacz KSeF — warstwa 3 (Fakturownia wysłała sama)', () => {
  it('dokument z gov_status „ok”, którego OMS nie zlecał → alarm i wpis w historii zamówienia', async () => {
    const db = openOmsDb(':memory:');
    const { zamowienieId, dokument } = zamowienieZFaktura(db, { wyslanaZPanelu: false });
    const { alarmAutoKsef, czuwacz } = czuwaczFakturowni(db, { gov_status: 'ok', gov_id: 'KSEF-ZMYSLONY-1' });

    await czuwacz.przebieg();

    expect(alarmAutoKsef.wczytaj()).toEqual([expect.objectContaining({ dokument, gov_status: 'ok', oid: null })]);
    const wpisy = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ksef'").all(zamowienieId)
      .map((w) => w.wynik);
    expect(wpisy.some((w) => w.includes('OMS tego nie zlecał'))).toBe(true);
    db.close();
  });

  it('„processing” w kolejnych przebiegach: jeden wpis w historii, alarm po „Sprawdziłem” nie wraca bez zmiany stanu', async () => {
    const db = openOmsDb(':memory:');
    const { zamowienieId } = zamowienieZFaktura(db, { wyslanaZPanelu: false });
    const { alarmAutoKsef, czuwacz } = czuwaczFakturowni(db, { gov_status: 'processing' });

    await czuwacz.przebieg();
    alarmAutoKsef.zgas();
    await czuwacz.przebieg();

    expect(alarmAutoKsef.wczytaj()).toEqual([]);
    const ile = db.prepare("SELECT COUNT(*) AS n FROM log WHERE zamowienie_id = ? AND akcja = 'ksef' AND wynik LIKE '%nie zlecał%'")
      .get(zamowienieId).n;
    expect(ile).toBe(1);
    db.close();
  });

  it('ten sam dokument zlecony z panelu (wiersz w wysylki_ksef) → bez alarmu', async () => {
    const db = openOmsDb(':memory:');
    const { zamowienieId } = zamowienieZFaktura(db, { wyslanaZPanelu: true });
    const { alarmAutoKsef, czuwacz } = czuwaczFakturowni(db, { gov_status: 'ok', gov_id: 'KSEF-ZMYSLONY-2' });

    await czuwacz.przebieg();

    expect(alarmAutoKsef.wczytaj()).toEqual([]);
    expect(ostatniWpisLogu(db, zamowienieId, 'ksef')?.wynik).toContain('dokument jest w KSeF');
    db.close();
  });

  it.each([null, 'not_connected', 'not_applicable'])('gov_status %s (nie poszło do KSeF) → bez alarmu', async (gov) => {
    const db = openOmsDb(':memory:');
    zamowienieZFaktura(db, { wyslanaZPanelu: false });
    const { alarmAutoKsef, czuwacz } = czuwaczFakturowni(db, { gov_status: gov });

    await czuwacz.przebieg();

    expect(alarmAutoKsef.wczytaj()).toEqual([]);
    db.close();
  });

  it('panel zleca wysyłkę drugiego dokumentu W TRAKCIE przebiegu (po odczycie listy) → bez fałszywego alarmu', async () => {
    const db = openOmsDb(':memory:');
    const pierwszy = zamowienieZFaktura(db, { wyslanaZPanelu: false }).dokument;
    const drugi = zamowienieZFaktura(db, { wyslanaZPanelu: false }).dokument;
    const alarmAutoKsef = utworzAlarmAutoKsef(db);
    const zlecone = new Set();
    const klient = {
      pobierzFakture: async (id) => {
        // Operator zatwierdza wysyłkę drugiego dokumentu, gdy czuwacz czyta pierwszy (rezerwacja przed wysyłką).
        if (String(id) === pierwszy) { zajmijWysylkeKsef(db, drugi, { numer: 'FV 2/11/2026' }); zlecone.add(drugi); }
        return { id: Number(id), number: `FV ${id}`, kind: 'vat', price_gross: '123.00', price_net: '100.00', price_tax: '23.00', paid: '0',
          positions: [], gov_status: zlecone.has(String(id)) ? 'processing' : null };
      },
    };
    const program = programFakturownia(klient, { alarmAutoKsef });

    await createCzuwaczKsef({ db, program, alarmAutoKsef, log: () => {} }).przebieg();

    expect(zlecone.has(drugi)).toBe(true);
    expect(alarmAutoKsef.wczytaj()).toEqual([]);
  });

  it('bez magazynu alarmu (inFakt, TwojeFaktury) czuwacz działa jak dotąd — numer zapisany, bez wpisu warstwy 3', async () => {
    const db = openOmsDb(':memory:');
    const { zamowienieId } = zamowienieZFaktura(db, { wyslanaZPanelu: false });
    const { czuwacz } = czuwaczFakturowni(db, { gov_status: 'ok', gov_id: 'KSEF-ZMYSLONY-3' }, { alarm: false });

    await czuwacz.przebieg();

    expect(ostatniWpisLogu(db, zamowienieId, 'ksef')?.wynik).toBe('dokument jest w KSeF (KSEF-ZMYSLONY-3)');
    db.close();
  });
});
