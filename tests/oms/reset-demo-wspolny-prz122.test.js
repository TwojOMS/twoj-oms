// PRZ-122.TFe: przypadki wspólne przeniesione z tests/oms/reset-demo-prz122.test.js; asercje bez zmian.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../src/core/baza.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { resetDemoDostepny, KLUCZ_ZLECENIA_RESETU } from '../../src/domena/reset-demo.js';
import { zlecResetDemo, odczytajZlecenieResetu, przywrocPoResecie, wykonajZlecenieResetu, kopiaResetu } from '../../src/oms/db/reset-demo.js';

const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });
function baza(plik = ':memory:') {
  const db = openOmsDb(plik);
  wykonajMigracje(db, [modulRdzen]);
  return db;
}
function dane(db) {
  const wpis = db.prepare('INSERT INTO konfiguracja_integracji VALUES (?, ?, ?, ?, ?, ?)');
  wpis.run('program_fakturowy', '{"program":"twojefaktury"}', '{"tajne":"x"}', 42, 'operator', '2026-10-28');
  wpis.run('nip_firmy', '{"nip":"4534240685","nazwa":"Pracownia Półcień"}', '{}', 42, 'operator', '2026-10-28');
  wpis.run('ksef', '{}', '{"token":"sekret"}', null, null, '2026-10-28');
  db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('test', 1, '1', '10', '2026-10-28')").run();
}
function katalog() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-reset-demo-')); katalogi.push(k); return k;
}

describe('reset demo', () => {
  it.each([[true, 'tak', true], [false, 'tak', false], [true, 'atrapa', false], [false, 'atrapa', false]])
  ('dostępność proba=%s restart=%s', (proba, restart, wynik) => expect(resetDemoDostepny({ proba, restart })).toBe(wynik));

  it('odczyt zlecenia i przywrócenie bez sekretów i innych danych', () => {
    const stara = baza(); const nowa = baza();
    try {
      dane(stara);
      expect(odczytajZlecenieResetu(stara)).toBeNull();
      zlecResetDemo(stara, { login: 'operator', teraz: new Date('2026-10-28T12:00:00Z') });
      const wynik = odczytajZlecenieResetu(stara);
      expect(wynik.zlecenie).toEqual({ login: 'operator', zlecono: '2026-10-28T12:00:00.000Z' });
      expect(wynik.zachowane.map(w => w.integracja).sort()).toEqual(['nip_firmy', 'program_fakturowy']);
      expect(wynik.zachowane.every(w => !('sekrety_json' in w))).toBe(true);
      przywrocPoResecie(nowa, wynik);
      const w = nowa.prepare('SELECT * FROM konfiguracja_integracji ORDER BY integracja').all();
      expect(w.map(x => x.integracja)).toEqual(['nip_firmy', 'program_fakturowy']);
      expect(w.every(x => x.sekrety_json === '{}' && x.konto_id === null && x.konto_login === 'operator')).toBe(true);
      expect(w[0].ustawienia_json).toContain('4534240685');
      expect(nowa.prepare('SELECT COUNT(*) AS n FROM zamowienia').get().n).toBe(0);
    } finally { stara.close(); nowa.close(); }
  });

  it('bez zlecenia nie dotyka plików ani nie tworzy bazy', async () => {
    const k = katalog(); const plik = path.join(k, 'baza.sqlite'); baza(plik).close();
    const przed = fs.readFileSync(plik); const utworzBaze = vi.fn();
    expect(await wykonajZlecenieResetu({ baza: plik, utworzBaze })).toBeNull();
    expect(utworzBaze).not.toHaveBeenCalled(); expect(fs.readFileSync(plik)).toEqual(przed);
    expect(await wykonajZlecenieResetu({ baza: path.join(k, 'nie-ma'), utworzBaze })).toBeNull();
    expect(utworzBaze).not.toHaveBeenCalled();
  });

  it('pusty plik bazy (0 bajtów) = brak zlecenia, plik nietknięty', async () => {
    const k = katalog(); const plik = path.join(k, 'baza.sqlite'); fs.writeFileSync(plik, '');
    const utworzBaze = vi.fn();
    expect(await wykonajZlecenieResetu({ baza: plik, utworzBaze })).toBeNull();
    expect(utworzBaze).not.toHaveBeenCalled(); expect(fs.statSync(plik).size).toBe(0);
  });

  it('błąd przy tworzeniu bazy zachowuje przyczynę w cause', async () => {
    const k = katalog(); const plik = path.join(k, 'baza.sqlite');
    const db = baza(plik); zlecResetDemo(db, { login: 'anna' }); db.close();
    const przyczyna = new Error('migracja padła');
    const blad = await wykonajZlecenieResetu({ baza: plik, utworzBaze: async () => { throw przyczyna; } }).catch(e => e);
    expect(blad.message).toBe('Nie udało się wykonać resetu demo'); expect(blad.cause).toBe(przyczyna);
  });

  it('ucięta kopia bez bazy: jasny błąd z nazwą pliku kopii, nic nie tworzy', async () => {
    const k = katalog(); const plik = path.join(k, 'baza.sqlite');
    fs.writeFileSync(kopiaResetu(plik), ''); const utworzBaze = vi.fn();
    const blad = await wykonajZlecenieResetu({ baza: plik, utworzBaze }).catch(e => e);
    expect(blad.message).toContain(kopiaResetu(plik)); expect(utworzBaze).not.toHaveBeenCalled();
  });
});
