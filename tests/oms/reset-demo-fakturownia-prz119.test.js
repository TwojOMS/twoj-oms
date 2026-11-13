// PRZ-119.11a — reset piaskownicy w profilu próby Fakturowni: wiersz `fakturownia` (domena konta próbnego i token
// z ekranu) przechodzi przez reset W CAŁOŚCI — tą samą drogą co Allegro Sandbox — ale tylko, gdy start podaje
// `zachowajFakturownie` (plik profilu istnieje). Bez profilu wiersz znika jak dotąd. Znacznik bazy próby (część `oid`)
// jest nowy po każdym resecie. Wszystkie wartości zmyślone („Pracownia Półcień”).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../src/core/baza.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { modulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { wykonajZlecenieResetu, znacznikResetuProby } from '../../src/oms/db/reset-demo.js';
import { ZACHOWANE_PRZY_RESECIE, ZACHOWANE_PROBA_FAKTUROWNIA } from '../../src/domena/reset-demo.js';
import { znacznikBazyProby } from '../../deploy/proba/atrapy/fakturownia-proba.ts';

const TOKEN = 'zmyslony-token-polcien-proba-0001';
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });
const katalog = () => { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-reset-fakturowni-')); katalogi.push(k); return k; };

function baza(plik) {
  const db = openOmsDb(plik);
  wykonajMigracje(db, [modulRdzen, modulKanaly]);
  return db;
}
function staraBaza(plik) {
  const db = baza(plik);
  try {
    const wpis = db.prepare('INSERT INTO konfiguracja_integracji VALUES (?, ?, ?, ?, ?, ?)');
    wpis.run('fakturownia', '{"domena":"pracownia-polcien"}', JSON.stringify({ token: TOKEN }), 7, 'adam', '2026-11-12');
    wpis.run('program_fakturowy', '{"program":"fakturownia"}', '{}', 7, 'adam', '2026-11-12');
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('test', 1, 'STARE-1', '10', '2026-11-10')").run();
  } finally { db.close(); }
}
const swiezeDemo = (plik) => async () => {
  const db = baza(plik);
  try { db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('test', 1, 'DEMO-1', '20', '2026-11-12')").run(); }
  finally { db.close(); }
};
const wiersz = (plik, nazwa) => {
  const db = baza(plik);
  try { return db.prepare('SELECT integracja, ustawienia_json, sekrety_json, konto_id FROM konfiguracja_integracji WHERE integracja = ?').get(nazwa); }
  finally { db.close(); }
};

describe('PRZ-119.11a reset piaskownicy a wiersz Fakturowni', () => {
  it('lista zachowanych: Fakturownia osobno, nie w zwykłej liście (ta gubi sekrety)', () => {
    expect(ZACHOWANE_PROBA_FAKTUROWNIA).toEqual(['fakturownia']);
    expect(ZACHOWANE_PRZY_RESECIE).not.toContain('fakturownia');
  });

  it('z profilem: wiersz `fakturownia` po resecie jest w całości, z tokenem; wynik (log) podaje tylko nazwę', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    staraBaza(plik);
    fs.writeFileSync(znacznikResetuProby(plik), '2026-11-12T10:00:00Z\n');
    const wynik = await wykonajZlecenieResetu({ baza: plik, utworzBaze: swiezeDemo(plik), zachowajSandbox: true, zachowajFakturownie: true });
    expect(wynik.fakturownia).toEqual(['fakturownia']);
    expect(JSON.stringify(wynik)).not.toContain(TOKEN);
    const w = wiersz(plik, 'fakturownia');
    expect(JSON.parse(w.ustawienia_json)).toEqual({ domena: 'pracownia-polcien' });
    expect(JSON.parse(w.sekrety_json)).toEqual({ token: TOKEN });
    expect(w.konto_id).toBeNull();
    // Wybór programu przechodzi jak dotąd (zwykła lista, bez sekretów).
    expect(JSON.parse(wiersz(plik, 'program_fakturowy').ustawienia_json)).toEqual({ program: 'fakturownia' });
  });

  it('bez profilu: wiersz `fakturownia` znika jak przed zmianą', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    staraBaza(plik);
    fs.writeFileSync(znacznikResetuProby(plik), 'x');
    const wynik = await wykonajZlecenieResetu({ baza: plik, utworzBaze: swiezeDemo(plik), zachowajSandbox: true });
    expect(wynik.fakturownia).toEqual([]);
    expect(wiersz(plik, 'fakturownia')).toBeUndefined();
  });

  it('znacznik bazy próby: stały w jednej bazie, inny po każdym z dwóch resetów', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    staraBaza(plik);
    const znaczniki = [];
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(znacznikResetuProby(plik), 'x');
      await wykonajZlecenieResetu({ baza: plik, utworzBaze: swiezeDemo(plik), zachowajSandbox: true, zachowajFakturownie: true });
      const db = baza(plik);
      try {
        const z = znacznikBazyProby(db);
        expect(z).toMatch(/^[a-z0-9]{8}$/);
        expect(znacznikBazyProby(db)).toBe(z);
        znaczniki.push(z);
      } finally { db.close(); }
    }
    expect(znaczniki[0]).not.toBe(znaczniki[1]);
  });
});
