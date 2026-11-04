// PRZ-147.02b — odczyt stanu zlecenia korekty w `doczytaj` (usługa i baza). Plan: docs/plany/PRZ-147-korekta-zwrotu.md,
// rozdz. 4 (decyzje 5–7) i 5 → 147-02b. Pewna odmowa programu (422) zwalnia rezerwację TYLKO dla referencji z tego
// wiersza; w toku / nieznany / błąd sieci niczego nie zwalniają; „wystawiona” tylko zawęża kandydatów z listy.
// Dane zmyślone: Pracownia Półcień, referencje REF-POLCIEN-….
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  dodajZwrot, zwrot, zarezerwujKorekte, zapiszKorekte, odrzucZlecenieKorekty,
} from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';

const NUMER_FV = 'FV 3/11/2026';
const OPIS_ODMOWY = 'inFakt nie wystawił korekty: klient — Proszę wybrać klienta.; '
  + 'powód korekty — Proszę podać powód korekty. Popraw i wystaw ponownie.';
const ODRZUCONA = {
  stan: 'odrzucona', uuid: null, bledy: [
    { pole: 'klient', komunikaty: ['Proszę wybrać klienta.'] },
    { pole: 'powód korekty', komunikaty: ['Proszę podać powód korekty.'] },
  ],
};
const KOREKTA = (uuid, numer) => ({ uuid, number: numer, corrected_invoice_number: NUMER_FV, invoice_date: '2026-11-04' });

const FAKTURA = {
  number: NUMER_FV, invoice_date: '2026-11-02', uuid: 'polcien-fv-3', client_id: 14702,
  services: [{ name: 'Lampa Półcień', quantity: 2, gross_price: 25800, tax_symbol: '23' }],
};

let db; let id;
const zwrotNa = (data = '2026-11-04') => dodajZwrot(db, id, { data, kwota: '129.00',
  pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '129.00' }] }).id;
// Wiersz „jak zostawił go stary kod”: rezerwacja i referencja wstawione wprost, bez numeru i bez błędu.
const zlecona = (zwrotId, referencja, kiedy = '2026-11-04T10:00:00Z') => db.prepare(
  'UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ? WHERE id = ?',
).run(kiedy, referencja, zwrotId);
const wpisyOdczytu = () => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'zwrot.korekta.odczyt'").all(id);

beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'reczne', {
    zrodlo_id: 14701, numer: '14701', klient: { company: 'Pracownia Półcień', email: 'biuro@polcien.example.test' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '258.00',
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-01T10:00:00',
    pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa Półcień', sku: 'LAMPA-P1', ilosc: 2, cena_brutto: '129.00',
      brutto_linii: '258.00', vat: null }],
  }, {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'polcien-fv-3', NUMER_FV, '2026-11-02T10:00:00Z');
});

describe('PRZ-147.02b odczyt stanu zlecenia w doczytaj', () => {
  it('422: rezerwacja zwolniona, błąd po polsku, referencja zostaje, lista niepytana, jeden wpis w logu', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const infakt = { statusKorekty: vi.fn().mockResolvedValue(ODRZUCONA), listaKorekt: vi.fn().mockResolvedValue([]) };
    const korekta = createKorekta({ db, infakt });
    await korekta.doczytaj(id, a);
    const w = zwrot(db, id, a);
    expect(infakt.statusKorekty).toHaveBeenCalledWith('REF-POLCIEN-A');
    expect(w.korekta_zlecona_at).toBeNull();
    expect(w.korekta_blad).toBe(OPIS_ODMOWY);
    expect(w.korekta_referencja).toBe('REF-POLCIEN-A');
    expect(w.korekta_numer).toBeNull();
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
    expect(wpisyOdczytu()).toHaveLength(1);
    expect(wpisyOdczytu()[0].wynik).toContain('klient — Proszę wybrać klienta.');

    // Drugie wejście: zlecenia już nie ma — bez pytania programu i bez drugiego wpisu.
    await korekta.doczytaj(id, a);
    expect(infakt.statusKorekty).toHaveBeenCalledTimes(1);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
    expect(wpisyOdczytu()).toHaveLength(1);
  });

  it('odrzucona spoza kontraktu (bez `bledy`, `bledy` nie tablicą): doczytaj NIE RZUCA', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const bezBledow = { statusKorekty: vi.fn().mockResolvedValue({ stan: 'odrzucona' }), listaKorekt: vi.fn() };
    await expect(createKorekta({ db, infakt: bezBledow }).doczytaj(id, a)).resolves.toBeUndefined();
    expect(zwrot(db, id, a).korekta_zlecona_at).toBeNull();
    const b = zwrotNa('2026-11-03');
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = NULL WHERE id = ?').run(a);
    zlecona(b, 'REF-POLCIEN-B');
    const zlyKsztalt = { statusKorekty: vi.fn().mockResolvedValue({ stan: 'odrzucona', bledy: 'zły' }), listaKorekt: vi.fn() };
    await expect(createKorekta({ db, infakt: zlyKsztalt }).doczytaj(id, b)).resolves.toBeUndefined();
    // Błąd przy składaniu opisu = cisza: rezerwacja zostaje jak była.
    expect(zwrot(db, id, b).korekta_zlecona_at).not.toBeNull();
  });

  it('422 przy dwóch otwartych sprawach: zwrot A zwolniony, zwrot B nietknięty (status przed W3)', async () => {
    const a = zwrotNa('2026-11-03');
    const b = zwrotNa('2026-11-04');
    zlecona(a, 'REF-POLCIEN-A');
    const infakt = { statusKorekty: vi.fn().mockResolvedValue(ODRZUCONA), listaKorekt: vi.fn().mockResolvedValue([]) };
    await createKorekta({ db, infakt }).doczytaj(id, a);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBeNull();
    expect(zwrot(db, id, a).korekta_blad).toBe(OPIS_ODMOWY);
    const wb = zwrot(db, id, b);
    expect([wb.korekta_zlecona_at, wb.korekta_blad, wb.korekta_referencja, wb.korekta_numer]).toEqual([null, null, null, null]);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
  });

  it('w toku: nic się nie zmienia, listaKorekt niewołane', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const przed = zwrot(db, id, a);
    const infakt = { statusKorekty: vi.fn().mockResolvedValue({ stan: 'w_toku', uuid: null, bledy: [] }),
      listaKorekt: vi.fn().mockResolvedValue([KOREKTA('kor-x', '1/KOR/11/2026')]) };
    await createKorekta({ db, infakt }).doczytaj(id, a);
    expect(zwrot(db, id, a)).toEqual(przed);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
    expect(wpisyOdczytu()).toHaveLength(0);
  });

  it.each([
    ['nieznany', () => vi.fn().mockResolvedValue({ stan: 'nieznany', uuid: null, bledy: [] })],
    ['błąd sieci', () => vi.fn().mockRejectedValue(new Error('inFakt nieosiągalny: ECONNRESET'))],
  ])('%s: rezerwacja zostaje, dalej droga listy jak dziś', async (_nazwa, status) => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const pusta = { statusKorekty: status(), listaKorekt: vi.fn().mockResolvedValue([]) };
    await expect(createKorekta({ db, infakt: pusta }).doczytaj(id, a)).resolves.toBeUndefined();
    const w = zwrot(db, id, a);
    expect(w.korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');
    expect(w.korekta_blad).toBeNull();
    expect(pusta.listaKorekt).toHaveBeenCalledTimes(1);

    const zLista = { statusKorekty: status(), listaKorekt: vi.fn().mockResolvedValue([KOREKTA('kor-x', '1/KOR/11/2026')]) };
    await createKorekta({ db, infakt: zLista }).doczytaj(id, a);
    expect(zwrot(db, id, a).korekta_numer).toBe('1/KOR/11/2026');
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');
  });

  it('wystawiona z uuid X: lista z jedyną pasującą korektą o uuid Y nic nie zapisuje; lista z X zapisuje numer', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const wystawiona = vi.fn().mockResolvedValue({ stan: 'wystawiona', uuid: 'kor-x', bledy: [] });
    const zY = { statusKorekty: wystawiona, listaKorekt: vi.fn().mockResolvedValue([KOREKTA('kor-y', '2/KOR/11/2026')]) };
    await createKorekta({ db, infakt: zY }).doczytaj(id, a);
    expect(zY.listaKorekt).toHaveBeenCalledTimes(1);
    expect(zwrot(db, id, a).korekta_numer).toBeNull();
    expect(zwrot(db, id, a).korekta_uuid).toBeNull();
    expect(wpisyOdczytu()).toHaveLength(0);

    const zX = { statusKorekty: wystawiona,
      listaKorekt: vi.fn().mockResolvedValue([KOREKTA('kor-y', '2/KOR/11/2026'), KOREKTA('kor-x', '1/KOR/11/2026')]) };
    await createKorekta({ db, infakt: zX }).doczytaj(id, a);
    expect(zwrot(db, id, a).korekta_numer).toBe('1/KOR/11/2026');
    expect(zwrot(db, id, a).korekta_uuid).toBe('kor-x');
    expect(wpisyOdczytu()).toHaveLength(1);
  });

  it('stara referencja: po 422 ponowne zlecenie zerwane przed odpowiedzią — odczyt starego 422 NIE zwalnia nowej rezerwacji', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-STARA');
    const status = vi.fn().mockResolvedValue(ODRZUCONA);
    const infakt = {
      statusKorekty: status,
      listaKorekt: vi.fn().mockResolvedValue([]),
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockRejectedValue(Object.assign(new Error('inFakt nieosiągalny: ECONNRESET'), {})),
    };
    const korekta = createKorekta({ db, infakt });
    await korekta.doczytaj(id, a);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBeNull();

    await expect(korekta.wystaw(id, a)).rejects.toThrow('ECONNRESET');
    const poZerwaniu = zwrot(db, id, a);
    expect(poZerwaniu.korekta_zlecona_at).not.toBeNull();
    expect(poZerwaniu.korekta_referencja).toBeNull();
    expect(poZerwaniu.korekta_blad).toBeNull();

    await korekta.doczytaj(id, a);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe(poZerwaniu.korekta_zlecona_at);
    expect(zwrot(db, id, a).korekta_blad).toBeNull();
    expect(wpisyOdczytu()).toHaveLength(1);
  });

  it('program bez statusKorekty (np. TwojeFaktury): zachowanie jak dziś — lista pytana, rezerwacja zostaje', async () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([]) };
    await createKorekta({ db, infakt }).doczytaj(id, a);
    expect(infakt.listaKorekt).toHaveBeenCalledTimes(1);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');
    expect(zwrot(db, id, a).korekta_blad).toBeNull();
  });

  it('zlecenie bez referencji: programu o status nie pyta', async () => {
    const a = zwrotNa();
    zlecona(a, null);
    const infakt = { statusKorekty: vi.fn().mockResolvedValue(ODRZUCONA), listaKorekt: vi.fn().mockResolvedValue([]) };
    await createKorekta({ db, infakt }).doczytaj(id, a);
    expect(infakt.statusKorekty).not.toHaveBeenCalled();
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');
  });
});

describe('PRZ-147.02b baza: odrzucZlecenieKorekty i zarezerwujKorekte', () => {
  it('cudza referencja → bez zmian (changes 0); własna → zwolnienie i błąd', () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    expect(odrzucZlecenieKorekty(db, id, a, 'REF-POLCIEN-INNA', 'opis')).toBe(false);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');
    expect(zwrot(db, id, a).korekta_blad).toBeNull();
    expect(odrzucZlecenieKorekty(db, id, a, 'REF-POLCIEN-A', 'opis odmowy')).toBe(true);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBeNull();
    expect(zwrot(db, id, a).korekta_blad).toBe('opis odmowy');
    // Drugi raz (równoległe wejście) — już nic do zwolnienia.
    expect(odrzucZlecenieKorekty(db, id, a, 'REF-POLCIEN-A', 'opis odmowy')).toBe(false);
  });

  it('nie zwalnia zwrotu z numerem ani innego zamówienia; ucina opis do 500 znaków', () => {
    const a = zwrotNa();
    zlecona(a, 'REF-POLCIEN-A');
    zapiszKorekte(db, id, a, { numer: '1/KOR/11/2026' });
    expect(odrzucZlecenieKorekty(db, id, a, 'REF-POLCIEN-A', 'opis')).toBe(false);
    expect(zwrot(db, id, a).korekta_zlecona_at).toBe('2026-11-04T10:00:00Z');

    const b = zwrotNa('2026-11-05');
    zlecona(b, 'REF-POLCIEN-B');
    expect(odrzucZlecenieKorekty(db, id + 1, b, 'REF-POLCIEN-B', 'opis')).toBe(false);
    expect(odrzucZlecenieKorekty(db, id, b, 'REF-POLCIEN-B', 'x'.repeat(600))).toBe(true);
    expect(zwrot(db, id, b).korekta_blad).toHaveLength(500);
  });

  it('zarezerwujKorekte czyści starą referencję i błąd', () => {
    const a = zwrotNa();
    db.prepare("UPDATE zwroty SET korekta_referencja = 'REF-POLCIEN-STARA', korekta_blad = 'stary błąd' WHERE id = ?").run(a);
    expect(zarezerwujKorekte(db, id, a, '2026-11-04T12:00:00Z')).toBe(true);
    const w = zwrot(db, id, a);
    expect([w.korekta_zlecona_at, w.korekta_referencja, w.korekta_blad]).toEqual(['2026-11-04T12:00:00Z', null, null]);
  });
});
