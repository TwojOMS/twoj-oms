// PRZ-108.10 — NIP sprzedawcy idący do inFaktu (adnotacja WDT w `notes`), do VIES (`requesterNumber`) i do KSeF
// kosztów (kontekst tokenu z panelu) czytany PRZY UŻYCIU: zapis w Ustawienia → Firma działa bez restartu. Faktura WDT
// bez NIP-u sprzedawcy odmawia PRZED rezerwacją (dziś wyszłaby adnotacja „NIP sprzedawcy: PL.”), faktura krajowa NIP-u
// sprzedawcy nie potrzebuje i wystawia się jak dotąd. Atrapy inFaktu i VIES — nic nie wychodzi; dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { createVies } from '../../../src/oms/services/vies.js';
import { zrodloKsefKosztow } from '../../../src/moduly/koszty/ksef-ustawien.ts';

const VIES_WAZNY = { wynik: 'wazny', nazwa: 'KUNDE GMBH', adres: null, dataZapytania: '2026-10-21T10:00:00.000Z',
  numerKonsultacji: 'WAPIAAAAY000001' };
const ODMOWA = 'Wpisz NIP firmy w Ustawienia → Firma';

const zamowienieWdt = (nad = {}) => ({
  zrodlo_id: 108, numer: 'WDT-108', klient: { company: 'Kunde GmbH', email: 'kunde@fikcja.invalid',
    address_1: 'Erfundene Str. 1', postcode: '10115', city: 'Berlin' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: 'DE123456789', kwota_brutto: '100.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T10:00:00',
  pozycje: [{ nazwa: 'Lampa', sku: null, ilosc: 1, cena_brutto: '100.00', vat: null }],
  ...nad,
});

function zestaw(nipSprzedawcy, nad = {}) {
  const db = openOmsDb(':memory:');
  const infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77), zalozKlienta: vi.fn().mockResolvedValue(78),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'WDT/1/10/2026', ksefStatus: null }),
    oznaczZaplacona: vi.fn(), iluMaNumer: vi.fn().mockResolvedValue(0),
  };
  const vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
  const id = zapiszZamowienie(db, 'reczne', zamowienieWdt(nad), {});
  const faktura = createFaktura({ db, infakt, vies, nipSprzedawcy, teraz: () => '2026-10-21T10:00:00.000Z' });
  return { db, infakt, vies, id, faktura };
}

describe('PRZ-108.10 faktura WDT — NIP sprzedawcy przy użyciu', () => {
  it('bez NIP-u sprzedawcy: odmowa przed rezerwacją — inFakt i VIES nietknięte, brak wiersza faktury', async () => {
    const { db, infakt, vies, id, faktura } = zestaw(() => null);
    await expect(faktura.wystaw(id)).rejects.toThrow(ODMOWA);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM faktury').get().n).toBe(0);
  });

  it('NIP z funkcji czytany przy każdym wystawieniu (zmiana w panelu bez restartu)', async () => {
    let nip = '2222222222';
    const { infakt, faktura, db } = zestaw(() => nip);
    const drugie = zapiszZamowienie(db, 'reczne', zamowienieWdt({ zrodlo_id: 109, numer: 'WDT-109' }), {});
    await faktura.wystaw(db.prepare("SELECT id FROM zamowienia WHERE numer = 'WDT-108'").get().id);
    expect(infakt.wystaw.mock.calls[0][0].notes).toContain('NIP sprzedawcy: PL2222222222.');
    nip = '1111111111';
    infakt.wystaw.mockResolvedValueOnce({ uuid: 'u2', numer: 'WDT/2/10/2026', ksefStatus: null });
    await faktura.wystaw(drugie);
    expect(infakt.wystaw.mock.calls[1][0].notes).toContain('NIP sprzedawcy: PL1111111111.');
  });

  it('faktura KRAJOWA bez NIP-u sprzedawcy wystawia się jak dotąd (inFakt zna sprzedawcę z konta)', async () => {
    const { infakt, id, faktura } = zestaw(() => null, { nip: '7777777777', klient: { company: 'Krajowy Nabywca' } });
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(infakt.wystaw.mock.calls[0][0], 'notes')).toBe(false);
  });

  it('stary kształt (NIP jako tekst) działa bez zmian', async () => {
    const { infakt, id, faktura } = zestaw('1234563218');
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].notes).toContain('PL1234563218.');
  });
});

describe('PRZ-108.10 faktura okresu WDT — NIP sprzedawcy przy użyciu', () => {
  function okres(nipSprzedawcy) {
    const db = openOmsDb(':memory:');
    const o = zapewnijOkres(db, { klientKlucz: 'kunde', rok: 2026, miesiac: 9 });
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at) VALUES ('reczne', 1, 'R/2026/108', '50.00', ?, '2026-09-10T10:00:00.000Z')").run(o.id);
    const zid = db.prepare("SELECT id FROM zamowienia WHERE numer = 'R/2026/108'").get().id;
    db.prepare("INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (?, 'Lampa', 1, '50.00', '50.00', 'reczna')").run(zid);
    const infakt = { znajdzKlientaPoNip: vi.fn().mockResolvedValue(77), zalozKlienta: vi.fn(),
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'WDT/1/10/2026', ksefStatus: null }), iluMaNumer: vi.fn().mockResolvedValue(0) };
    const vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
    const usluga = createFakturaOkresu({ db, infakt, vies, nipSprzedawcy, teraz: () => '2026-10-21T10:00:00.000Z' });
    return { db, o, infakt, vies, usluga };
  }
  const KLIENT = { nip: 'DE123456789', nazwa: 'Kunde GmbH' };

  it('bez NIP-u sprzedawcy: odmowa przed rezerwacją i zamknięciem okresu, inFakt i VIES nietknięte', async () => {
    const { o, infakt, vies, usluga, db } = okres(() => null);
    await expect(usluga.wystaw(o.id, KLIENT)).rejects.toThrow(ODMOWA);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(db.prepare('SELECT stan FROM okresy_rozliczeniowe WHERE id = ?').get(o.id).stan).toBe(o.stan);
  });

  it('NIP z funkcji trafia do adnotacji WDT', async () => {
    const { o, infakt, usluga } = okres(() => '2222222222');
    await usluga.wystaw(o.id, KLIENT);
    expect(infakt.wystaw.mock.calls[0][0].notes).toContain('PL2222222222.');
  });
});

describe('PRZ-108.10 VIES — requesterNumber przy każdym zapytaniu', () => {
  it('funkcja NIP-u czytana przy każdym sprawdzeniu', async () => {
    let nip = '2222222222';
    const adresy = [];
    const fetchImpl = vi.fn(async (url) => { adresy.push(String(url)); return new Response(JSON.stringify({ isValid: true }), { status: 200 }); });
    const vies = createVies({ fetchImpl, nipSprzedawcy: () => nip });
    await vies.sprawdz('DE123456789');
    nip = '1111111111';
    await vies.sprawdz('DE123456789');
    expect(adresy[0]).toContain('requesterNumber=2222222222');
    expect(adresy[1]).toContain('requesterNumber=1111111111');
  });
});

describe('PRZ-108.10 KSeF kosztów — kontekst tokenu z panelu to bieżący NIP firmy', () => {
  it('zmiana NIP-u buduje nowy zestaw z nowym NIP-em; brak NIP-u = brak zestawu', () => {
    let nip = '2222222222';
    const fabryka = vi.fn((o) => ({ o }));
    const zrodlo = zrodloKsefKosztow({ wczytaj: () => ({ ustawienia: { nip: null }, sekrety: { token: 't'.repeat(40) } }),
      nipSprzedawcy: () => nip, fabryka, zestaw: (klient, t) => ({ klient, t }) });
    expect(zrodlo.biezacy().t.nip).toBe('2222222222');
    nip = '1111111111';
    expect(zrodlo.biezacy().t.nip).toBe('1111111111');
    expect(fabryka).toHaveBeenCalledTimes(2);
    nip = null;
    expect(zrodlo.biezacy()).toBeNull();
  });
});
