import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaDokumentuProgramu } from '../../../src/moduly/rdzen/migracje/0008-dokument-programu.ts';
import {
  rozpocznijFakture, zakonczFakture, fakturaSkasowanaWInfakcie,
} from '../../../src/moduly/faktury/db/faktury.js';
import { zapewnijOkres, rozpocznijFaktureOkresu, zakonczFaktureOkresu } from '../../../src/oms/db/okresy.js';

// PRZ-118.03 — migracja rdzen/0008 (`program`, `dokument_id` w `faktury` i `okresy_rozliczeniowe`)
// i podwójny zapis: dla inFaktu identyfikator idzie też do `infakt_uuid` (okno wycofania do obrazu,
// który zna tylko tę kolumnę), dla innego programu `infakt_uuid` zostaje pusty.

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const TABELE = ['faktury', 'okresy_rozliczeniowe'];
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz118-03-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}

// Rdzeń w stanie sprzed tej zmiany: te same migracje, bez numeru 8.
const rdzenBez8 = { ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 8) };

const kolumny = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();

function zamowienie(db, numer) {
  return Number(db.prepare(
    "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)"
    + " VALUES ('pracownia_polcien', ?, ?, '249.00', '2026-10-01')",
  ).run(numer, `LAMPA-${numer}`).lastInsertRowid);
}

// Baza na PLIKU w kształcie produkcji tuż przed wydaniem: migracje 1–7, bez kolumn programu.
function staraBaza() {
  const plik = nowyPlik();
  const db = openOmsDb(plik, { moduly: [rdzenBez8] });
  for (const t of TABELE) {
    expect(kolumny(db, t).map((k) => k.name)).not.toContain('dokument_id');
  }
  const ins = db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run(zamowienie(db, 1), 'U-STARA-1', 'FV 1/10/2026', null, '2026-10-01T10:00:00Z');
  ins.run(zamowienie(db, 2), 'U-STARA-2', 'FV 2/10/2026', 'wyslana', '2026-10-02T10:00:00Z');
  ins.run(zamowienie(db, 3), null, null, 'w_toku', '2026-10-03T10:00:00Z'); // rezerwacja w toku
  db.prepare(
    "INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, infakt_uuid, numer, utworzony_at)"
    + " VALUES ('nip:5250000000', 2026, 9, 'zafakturowany', 'U-OKRES-9', 'FV 9/09/2026', '2026-09-01')",
  ).run();
  db.prepare(
    "INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, utworzony_at)"
    + " VALUES ('nip:5250000000', 2026, 10, 'otwarty', '2026-10-01')",
  ).run();
  db.close();
  return plik;
}

const wiersze = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();

describe('migracja rdzen/0008 — program i dokument_id', () => {
  it('(1) stara baza: wiersze z infakt_uuid dostają program=infakt i dokument_id, rezerwacja i pusty okres zostają NULL', () => {
    const plik = staraBaza();
    const db = openOmsDb(plik);
    try {
      expect(db.prepare("SELECT nazwa FROM migracje WHERE modul = 'rdzen' AND numer = 8").get())
        .toEqual({ nazwa: migracjaDokumentuProgramu.nazwa });
      expect(db.prepare('SELECT infakt_uuid, program, dokument_id, numer FROM faktury ORDER BY id').all()).toEqual([
        { infakt_uuid: 'U-STARA-1', program: 'infakt', dokument_id: 'U-STARA-1', numer: 'FV 1/10/2026' },
        { infakt_uuid: 'U-STARA-2', program: 'infakt', dokument_id: 'U-STARA-2', numer: 'FV 2/10/2026' },
        { infakt_uuid: null, program: null, dokument_id: null, numer: null },
      ]);
      expect(db.prepare('SELECT miesiac, infakt_uuid, program, dokument_id FROM okresy_rozliczeniowe ORDER BY id').all())
        .toEqual([
          { miesiac: 9, infakt_uuid: 'U-OKRES-9', program: 'infakt', dokument_id: 'U-OKRES-9' },
          { miesiac: 10, infakt_uuid: null, program: null, dokument_id: null },
        ]);
    } finally { db.close(); }
  });

  it('(2) ponowne wykonanie migracji niczego nie zmienia — także wiersza z dokument_id innym niż infakt_uuid', () => {
    const plik = staraBaza();
    const db = openOmsDb(plik);
    try {
      // Wiersz, którego ponowny przebieg NIE MOŻE nadpisać z infakt_uuid.
      db.prepare("UPDATE faktury SET program = 'inny', dokument_id = 'D-INNY' WHERE infakt_uuid = 'U-STARA-2'").run();
      db.prepare("UPDATE okresy_rozliczeniowe SET program = 'inny', dokument_id = 'D-OKRES' WHERE miesiac = 9").run();
      const przed = TABELE.map((t) => [kolumny(db, t), wiersze(db, t)]);
      migracjaDokumentuProgramu.wykonaj(db);
      migracjaDokumentuProgramu.wykonaj(db);
      expect(TABELE.map((t) => [kolumny(db, t), wiersze(db, t)])).toEqual(przed);
      expect(db.prepare("SELECT program, dokument_id FROM faktury WHERE infakt_uuid = 'U-STARA-2'").get())
        .toEqual({ program: 'inny', dokument_id: 'D-INNY' });
    } finally { db.close(); }
    // Trzecie otwarcie: migracja oznaczona, schemat i dane bez zmian.
    const jeszcze = openOmsDb(plik);
    try {
      expect(jeszcze.prepare("SELECT count(*) AS n FROM migracje WHERE modul = 'rdzen' AND numer = 8").get()).toEqual({ n: 1 });
    } finally { jeszcze.close(); }
  });

  it('(3) strażnik migracji przepuszcza repozytorium (kod 0)', () => {
    const wyjscie = execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' });
    expect(wyjscie).toBe('');
  });

  it('(5) obie kolumny w obu tabelach: TEXT, bez NOT NULL, bez wartości domyślnej, bez indeksu', () => {
    const db = openOmsDb(':memory:');
    try {
      for (const t of TABELE) {
        for (const nazwa of ['program', 'dokument_id']) {
          const k = kolumny(db, t).find((x) => x.name === nazwa);
          expect(k, `${t}.${nazwa}`).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
        }
        const indeksowane = db.prepare(`PRAGMA index_list(${t})`).all()
          .flatMap((i) => db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name));
        expect(indeksowane).not.toContain('dokument_id');
        expect(indeksowane).not.toContain('program');
      }
    } finally { db.close(); }
  });
});

describe('podwójny zapis identyfikatora dokumentu', () => {
  const fakturaW = (db, id) => db.prepare(
    'SELECT program, dokument_id, infakt_uuid, numer, ksef_status FROM faktury WHERE id = ?',
  ).get(id);
  const okresW = (db, id) => db.prepare(
    'SELECT program, dokument_id, infakt_uuid, numer, ksef_status, stan FROM okresy_rozliczeniowe WHERE id = ?',
  ).get(id);

  it('(4a) zakonczFakture: inFakt pisze trzy kolumny, Fakturownia zostawia infakt_uuid pusty, bez argumentu = inFakt', () => {
    const db = openOmsDb(':memory:');
    try {
      const a = rozpocznijFakture(db, zamowienie(db, 11));
      zakonczFakture(db, a.id, { uuid: 'U-1', numer: 'FV/1', ksefStatus: null }, { program: 'infakt' });
      expect(fakturaW(db, a.id)).toEqual({ program: 'infakt', dokument_id: 'U-1', infakt_uuid: 'U-1', numer: 'FV/1', ksef_status: null });

      const b = rozpocznijFakture(db, zamowienie(db, 12));
      zakonczFakture(db, b.id, { uuid: '771', numer: 'FV/2', ksefStatus: null }, { program: 'fakturownia' });
      expect(fakturaW(db, b.id)).toEqual({ program: 'fakturownia', dokument_id: '771', infakt_uuid: null, numer: 'FV/2', ksef_status: null });

      // Dzisiejsi wołający (services/faktura.js) nie podają programu.
      const c = rozpocznijFakture(db, zamowienie(db, 13));
      zakonczFakture(db, c.id, { uuid: 'U-3', numer: 'FV/3', ksefStatus: 'wyslana' });
      expect(fakturaW(db, c.id)).toEqual({ program: 'infakt', dokument_id: 'U-3', infakt_uuid: 'U-3', numer: 'FV/3', ksef_status: 'wyslana' });

      const d = rozpocznijFakture(db, zamowienie(db, 14));
      for (const program of [null, '', 7]) {
        expect(() => zakonczFakture(db, d.id, { uuid: 'U-4', numer: 'FV/4', ksefStatus: null }, { program }))
          .toThrow(/program/);
      }
      expect(fakturaW(db, d.id)).toMatchObject({ program: null, dokument_id: null, infakt_uuid: null, ksef_status: 'w_toku' });
    } finally { db.close(); }
  });

  it('(4b) zakonczFaktureOkresu: to samo dla faktury okresu', () => {
    const db = openOmsDb(':memory:');
    try {
      const wystaw = (miesiac, uuid, opcje) => {
        const o = zapewnijOkres(db, { klientKlucz: 'nip:5250000000', rok: 2026, miesiac });
        rozpocznijFaktureOkresu(db, o.id);
        return opcje === undefined
          ? zakonczFaktureOkresu(db, o.id, { uuid, numer: `FV/${miesiac}`, ksefStatus: null })
          : zakonczFaktureOkresu(db, o.id, { uuid, numer: `FV/${miesiac}`, ksefStatus: null }, opcje);
      };
      const a = wystaw(7, 'U-7', { program: 'infakt' });
      expect(okresW(db, a.id)).toEqual({ program: 'infakt', dokument_id: 'U-7', infakt_uuid: 'U-7', numer: 'FV/7', ksef_status: null, stan: 'zafakturowany' });
      const b = wystaw(8, '772', { program: 'fakturownia' });
      expect(okresW(db, b.id)).toEqual({ program: 'fakturownia', dokument_id: '772', infakt_uuid: null, numer: 'FV/8', ksef_status: null, stan: 'zafakturowany' });
      const c = wystaw(9, 'U-9');
      expect(okresW(db, c.id)).toEqual({ program: 'infakt', dokument_id: 'U-9', infakt_uuid: 'U-9', numer: 'FV/9', ksef_status: null, stan: 'zafakturowany' });

      const o = zapewnijOkres(db, { klientKlucz: 'nip:5250000000', rok: 2026, miesiac: 10 });
      rozpocznijFaktureOkresu(db, o.id);
      expect(() => zakonczFaktureOkresu(db, o.id, { uuid: 'U-10', numer: 'FV/10', ksefStatus: null }, { program: '' }))
        .toThrow(/program/);
      expect(okresW(db, o.id)).toMatchObject({ program: null, dokument_id: null, infakt_uuid: null, ksef_status: 'w_toku' });
    } finally { db.close(); }
  });

  it('odnotowanie „skasowana w inFakcie” usuwa wiersz razem z dokument_id — nie zostaje identyfikator skasowanego dokumentu', () => {
    const db = openOmsDb(':memory:');
    try {
      const zid = zamowienie(db, 21);
      const f = rozpocznijFakture(db, zid);
      zakonczFakture(db, f.id, { uuid: 'U-21', numer: 'FV/21', ksefStatus: null });
      fakturaSkasowanaWInfakcie(db, zid);
      expect(db.prepare('SELECT count(*) AS n FROM faktury WHERE zamowienie_id = ?').get(zid)).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM faktury WHERE dokument_id = 'U-21' OR infakt_uuid = 'U-21'").get())
        .toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
