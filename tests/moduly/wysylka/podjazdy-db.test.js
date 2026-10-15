import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  pobierzPodjazd,
  powiazanePrzesylkiPodjazdu,
  zapiszPodgladPodjazdu,
  zapiszPrzejecie,
  zarezerwujPodjazd,
  importujPotwierdzonyPodjazd,
  zajmijSprawdzeniePodjazdu, zapiszWynikPodjazdu,
} from '../../../src/moduly/wysylka/db/podjazdy.js';

const otwarte = [];
afterEach(() => { while (otwarte.length) otwarte.pop().close(); });

function db() {
  const wynik = openOmsDb(':memory:');
  otwarte.push(wynik);
  return wynik;
}

function przesylka(baza, numer = 'A') {
  const zamowienie = baza.prepare(
    "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('allegro_szkicownia', ?, ?, '10.00', '2026-09-22T08:00:00.000Z')",
  ).run(Number(numer.charCodeAt(0)), `A-${numer}`);
  return Number(baza.prepare(
    "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at) VALUES (?, 'allegro_wza', 'nadana', ?, '2026-09-22T08:00:00.000Z')",
  ).run(Number(zamowienie.lastInsertRowid), `LIST-${numer}`).lastInsertRowid);
}

const rezerwacja = (ids, overrides = {}) => ({
  podgladId: 'podglad-1', grupaId: 'allegro_szkicownia|method-dpd', commandId: 'command-1',
  kanal: 'allegro_szkicownia', przewoznik: 'DPD', adres: { city: 'Pęki', postCode: '00-650' },
  termin: { date: '2026-09-23', minTime: '08:00', maxTime: '12:00' }, kto: 'adam',
  utworzonaAt: '2026-09-22T09:00:00.000Z', przesylki: ids.map((id) => ({
    przesylkaId: id, shipmentId: `shipment-${id}`, numerListu: `LIST-${id}`,
  })), ...overrides,
});

function podglad(baza, id = 'podglad-1') {
  return zapiszPodgladPodjazdu(baza, {
    id, kto: 'adam', snapshot: { grupy: [] }, wygasaAt: '2026-09-22T09:30:00.000Z',
    utworzonyAt: '2026-09-22T09:00:00.000Z',
  });
}

describe('podjazdy: trwała rezerwacja', () => {
  it('migruje starą paczkę bez zmiany jej statusu ani zapisanych etykiet', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema([
      'ALTER TABLE przesylki DROP COLUMN przejeta_at',
      'ALTER TABLE przesylki DROP COLUMN przejecie_zdarzenie_at',
      'ALTER TABLE przesylki DROP COLUMN przejecie_zrodlo',
      'ALTER TABLE przesylki DROP COLUMN przejecie_kod',
      'ALTER TABLE podjazdy DROP COLUMN sprawdzenie_token',
    ], ['przejeta_at', 'przejecie_zdarzenie_at', 'przejecie_zrodlo', 'przejecie_kod', 'sprawdzenie_token']);
    const katalog = mkdtempSync(join(tmpdir(), 'oms-podjazdy-migracja-'));
    const plik = join(katalog, 'oms.sqlite');
    const stara = openOmsDb(plik); otwarte.push(stara);
    const id = przesylka(stara, 'M');
    stara.prepare(
      "UPDATE przesylki SET status = 'nadana', etykieta_sciezka = '/etykiety/M.pdf', etykieta_zpl_sciezka = '/etykiety/M.zpl' WHERE id = ?",
    ).run(id);
    stara.close(); otwarte.pop();

    const poMigracji = openOmsDb(plik); otwarte.push(poMigracji);
    expect(poMigracji.prepare(
      'SELECT status, etykieta_sciezka, etykieta_zpl_sciezka, przejeta_at, przejecie_kod FROM przesylki WHERE id = ?',
    ).get(id)).toEqual({
      status: 'nadana', etykieta_sciezka: '/etykiety/M.pdf', etykieta_zpl_sciezka: '/etykiety/M.zpl',
      przejeta_at: null, przejecie_kod: null,
    });
    expect(poMigracji.prepare('SELECT sprawdzenie_token FROM podjazdy').all()).toEqual([]);
    poMigracji.close(); otwarte.pop();
    const drugiStart = openOmsDb(plik); otwarte.push(drugiStart);
    expect(drugiStart.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name LIKE 'podjazdy%'").get().c).toBe(3);
  });

  it('zapisuje UUID i nie tworzy drugiego zlecenia przy restarcie', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-podjazdy-'));
    const plik = join(katalog, 'oms.sqlite');
    const pierwsza = openOmsDb(plik); otwarte.push(pierwsza);
    const a = przesylka(pierwsza, 'A');
    podglad(pierwsza);
    const zapisany = zarezerwujPodjazd(pierwsza, rezerwacja([a]));
    pierwsza.close(); otwarte.pop();

    const druga = openOmsDb(plik); otwarte.push(druga);
    const tenSam = zarezerwujPodjazd(druga, rezerwacja([a], { commandId: 'nie-wolno-nowego' }));
    expect(tenSam).toMatchObject({ id: zapisany.id, command_id: 'command-1' });
    expect(powiazanePrzesylkiPodjazdu(druga, zapisany.id)).toEqual([
      expect.objectContaining({ przesylka_id: a, shipment_id: `shipment-${a}`, aktywna_rezerwacja: 1 }),
    ]);
  });

  it('odrzuca nakładającą się rezerwację bez zajmowania pozostałej paczki', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-podjazdy-kolizja-'));
    const plik = join(katalog, 'oms.sqlite');
    const pierwsza = openOmsDb(plik); otwarte.push(pierwsza);
    const a = przesylka(pierwsza, 'A'); const b = przesylka(pierwsza, 'B'); const c = przesylka(pierwsza, 'C');
    podglad(pierwsza); podglad(pierwsza, 'podglad-2');
    const druga = openOmsDb(plik); otwarte.push(druga);
    zarezerwujPodjazd(pierwsza, rezerwacja([a, b]));
    expect(() => zarezerwujPodjazd(druga, rezerwacja([b, c], {
      podgladId: 'podglad-2', grupaId: 'allegro_szkicownia|method-one', commandId: 'command-2',
    }))).toThrow(/rezerw/i);
    expect(pierwsza.prepare('SELECT COUNT(*) AS c FROM podjazdy_przesylki WHERE przesylka_id = ?').get(c).c).toBe(0);
  });
});

describe('podjazdy: fakt przejęcia', () => {
  it('nie cofa raz zapisanego dowodu przez pustszy lub starszy odczyt', () => {
    const baza = db(); const id = przesylka(baza);
    const pierwszy = zapiszPrzejecie(baza, id, {
      zrodlo: 'allegro', kod: 'IN_TRANSIT', zdarzenieAt: '2026-09-22T08:00:00.000Z',
    });
    expect(pierwszy).toMatchObject({ przejecie_zrodlo: 'allegro', przejecie_kod: 'IN_TRANSIT' });
    expect(zapiszPrzejecie(baza, id, {
      zrodlo: 'allegro', kod: 'DELIVERED', zdarzenieAt: '2026-09-21T08:00:00.000Z',
    })).toBeNull();
    expect(pobierzPodjazd(baza, 999)).toBeNull();
    expect(baza.prepare('SELECT przejeta_at, przejecie_zdarzenie_at, przejecie_kod FROM przesylki WHERE id = ?').get(id))
      .toMatchObject({ przejecie_zdarzenie_at: '2026-09-22T08:00:00.000Z', przejecie_kod: 'IN_TRANSIT' });
  });
});

describe('podjazdy zamówione wcześniej poza OMS', () => {
  it('importuje potwierdzony odbiór raz i blokuje drugie zlecenie tej paczki', () => {
    const baza = db(); const id = przesylka(baza);
    baza.prepare("UPDATE przesylki SET id_przesylki_kuriera='shipment-A', etykieta_zpl_sciezka='/etykiety/A.zpl' WHERE id=?").run(id);
    const dane = { przesylkaId: id, shipmentId: 'shipment-A', numerListu: 'LIST-A',
      kanal: 'allegro_szkicownia', metoda: '03f26351-f683-4db2-8895-f2c599280e3c',
      commandId: 'command-external', pickupId: 'pickup-external', pickupCarrier: 'DPD',
      carrierPickupId: 'AD-123', adres: { city: 'Pęki' },
      termin: { date: '2026-09-23', minTime: '13:00', maxTime: '17:00' } };
    const pierwszy = importujPotwierdzonyPodjazd(baza, dane);
    expect(pierwszy).toMatchObject({ stan: 'potwierdzony', pickup_id: 'pickup-external', pickup_carrier: 'DPD' });
    expect(importujPotwierdzonyPodjazd(baza, dane).id).toBe(pierwszy.id);
    expect(baza.prepare('SELECT COUNT(*) c FROM podjazdy').get().c).toBe(1);
    expect(powiazanePrzesylkiPodjazdu(baza, pierwszy.id)).toEqual([
      expect.objectContaining({ przesylka_id: id, shipment_id: 'shipment-A', aktywna_rezerwacja: 1 }),
    ]);
    expect(() => importujPotwierdzonyPodjazd(baza, { ...dane, commandId: 'other', pickupId: 'other' }))
      .toThrow(/aktyw/i);
    expect(() => importujPotwierdzonyPodjazd(baza, { ...dane, shipmentId: 'wrong' }))
      .toThrow(/nie zgadza/i);
  });
});

describe('podjazdy: wyłączność sprawdzania statusu', () => {
  it('tylko jeden proces przejmuje GET; spóźniony odczyt nie nadpisuje wyniku', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-podjazdy-claim-'));
    const plik = join(katalog, 'oms.sqlite');
    const pierwsza = openOmsDb(plik); otwarte.push(pierwsza);
    const idPaczki = przesylka(pierwsza, 'A'); podglad(pierwsza);
    const z = zarezerwujPodjazd(pierwsza, rezerwacja([idPaczki]));
    const druga = openOmsDb(plik); otwarte.push(druga);
    const czas = '2026-09-22T09:01:00.000Z';
    expect(zajmijSprawdzeniePodjazdu(pierwsza, z.id, { token: 'a', teraz: czas, do: '2026-09-22T09:02:00.000Z' })).toBe(true);
    expect(zajmijSprawdzeniePodjazdu(druga, z.id, { token: 'b', teraz: czas, do: '2026-09-22T09:02:00.000Z' })).toBe(false);
    expect(zapiszWynikPodjazdu(pierwsza, z.id, { stan: 'potwierdzony', pickupId: 'pickup-1', sprawdzenieToken: 'a' }).stan).toBe('potwierdzony');
    expect(zapiszWynikPodjazdu(druga, z.id, { stan: 'odrzucony', sprawdzenieToken: 'b' }).stan).toBe('potwierdzony');
    expect(zapiszWynikPodjazdu(druga, z.id, { stan: 'odrzucony' }).stan).toBe('potwierdzony');
    expect(powiazanePrzesylkiPodjazdu(druga, z.id)[0].aktywna_rezerwacja).toBe(1);
  });
});
