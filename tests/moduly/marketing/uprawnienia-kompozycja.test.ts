import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zalozKonto, ustawUprawnienia, uprawnieniaKonta } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';
import type { ModulOms } from '../../../src/core/kontrakty.ts';

// PRZ-028C RED: frozen db.js (linie 118, 1434, 1808–1826) dosypuje ptaszek `cele`
// kontom sprzed zakładki, raz, ze znacznikiem w `migracje_jednorazowe`. Produkcyjny
// openOmsDb tego nie robi, więc historyczny cele-uprawnienia.test.js nie ładuje się.
// Ten test idzie przez PRAWDZIWY src/oms/db/db.ts i prawdziwą bazę plikową.
//
// Nazwa znacznika jest kontraktem z bazami produkcyjnymi: inna nazwa uruchomiłaby migrację
// ponownie i przywróciła ptaszki, które operator już świadomie odebrał.
const ZNACZNIK = 'ptaszek-cele-2026-09-13';
// D5: generyczny rejestr rozdanych kluczy (src/core/uprawnienia.ts). Oba znaczniki opisują to
// samo zdarzenie; stan „sprzed migracji” to brak OBU, a jeden bez drugiego trzeba uzgodnić
// bez ponownego dosypania ptaszka.
const KLUCZ_D5 = 'cele';

const zaladujDb = () => import('../../../src/oms/db/db.ts') as Promise<Record<string, any>>;

async function zBaza(test: (sciezka: string, openOmsDb: (p: string) => any) => void) {
  const { openOmsDb } = await zaladujDb();
  const katalog = mkdtempSync(join(tmpdir(), 'prz028c-uprawnienia-'));
  try { test(join(katalog, 'oms.sqlite'), openOmsDb); }
  finally { rmSync(katalog, { recursive: true, force: true }); }
}

const znaczniki = (db: any) => db.prepare('SELECT COUNT(*) AS c FROM migracje_jednorazowe WHERE nazwa = ?').get(ZNACZNIK).c;
const znacznikiD5 = (db: any) => db.prepare('SELECT COUNT(*) AS c FROM uprawnienia_rozdane WHERE klucz = ?').get(KLUCZ_D5).c;
const teraz = () => new Date('2026-10-01T08:00:00.000Z');

describe('PRZ-028C uprawnienia — migracja ptaszka cele w produkcyjnym openOmsDb', () => {
  it('db.ts eksportuje dosypPtaszekCeli i niezmienioną nazwę znacznika', async () => {
    const modul = await zaladujDb();
    expect(typeof modul.dosypPtaszekCeli).toBe('function');
    expect(modul.MIGRACJA_PTASZEK_CELE).toBe(ZNACZNIK);
  });

  it('konto Sprzedaż sprzed migracji dostaje przy restarcie wyłącznie ptaszek cele', async () => {
    await zBaza((sciezka, openOmsDb) => {
      const db1 = openOmsDb(sciezka);
      let ewa: number, pakowacz: number;
      try {
        ewa = zalozKonto(db1, { login: 'ewa', imie: 'ewa', haslo: 'x', rola: 'sprzedaz', admin: false });
        pakowacz = zalozKonto(db1, { login: 'pak', imie: 'pak', haslo: 'x', rola: 'produkcja', admin: false });
        // Stan „sprzed": brak cele i świadomie odebrana kampania, bez OBU znaczników.
        ustawUprawnienia(db1, ewa, ekranyRoli('sprzedaz').filter(k => k !== 'cele' && k !== 'kampania'));
        db1.prepare('DELETE FROM migracje_jednorazowe WHERE nazwa = ?').run(ZNACZNIK);
        db1.prepare('DELETE FROM uprawnienia_rozdane WHERE klucz = ?').run(KLUCZ_D5);
      } finally { db1.close(); }

      const db2 = openOmsDb(sciezka);
      try {
        const po = uprawnieniaKonta(db2, ewa!);
        expect(po).toContain('cele');
        expect(po).not.toContain('kampania');
        expect(po.size).toBe(ekranyRoli('sprzedaz').length - 1);
        expect(uprawnieniaKonta(db2, pakowacz!)).not.toContain('cele');
        expect(znaczniki(db2)).toBe(1);
        expect(znacznikiD5(db2)).toBe(1);
      } finally { db2.close(); }
    });
  });

  it('po wykonaniu migracji kolejne restarty nie cofają decyzji operatora', async () => {
    await zBaza((sciezka, openOmsDb) => {
      const db1 = openOmsDb(sciezka);
      let ewa: number;
      try {
        // Świeża baza: migracja przechodzi na pustej tabeli kont i zostawia znacznik.
        expect(znaczniki(db1)).toBe(1);
        expect(znacznikiD5(db1)).toBe(1);
        ewa = zalozKonto(db1, { login: 'ewa', imie: 'ewa', haslo: 'x', rola: 'sprzedaz', admin: false });
        expect(uprawnieniaKonta(db1, ewa)).toContain('cele');
        ustawUprawnienia(db1, ewa, ekranyRoli('sprzedaz').filter(k => k !== 'cele'));
      } finally { db1.close(); }

      for (let restart = 0; restart < 2; restart++) {
        const db = openOmsDb(sciezka);
        try {
          expect(uprawnieniaKonta(db, ewa!)).not.toContain('cele');
          expect(znaczniki(db)).toBe(1);
        } finally { db.close(); }
      }
    });
  });

  it('D5 obecny, stary znacznik brak → reopen uzgadnia stary i nie przywraca cele (dwa restarty)', async () => {
    await zBaza((sciezka, openOmsDb) => {
      const db1 = openOmsDb(sciezka);
      let ewa: number;
      try {
        ewa = zalozKonto(db1, { login: 'ewa', imie: 'ewa', haslo: 'x', rola: 'sprzedaz', admin: false });
        // Operator świadomie odebrał cele; rozdanie D5 już odnotowane, starego znacznika brak.
        ustawUprawnienia(db1, ewa, ekranyRoli('sprzedaz').filter(k => k !== 'cele'));
        db1.prepare('INSERT OR IGNORE INTO uprawnienia_rozdane (klucz, rozdane_at) VALUES (?, ?)').run(KLUCZ_D5, teraz().toISOString());
        db1.prepare('DELETE FROM migracje_jednorazowe WHERE nazwa = ?').run(ZNACZNIK);
      } finally { db1.close(); }

      for (let restart = 0; restart < 2; restart++) {
        const db = openOmsDb(sciezka);
        try {
          expect({ restart, cele: uprawnieniaKonta(db, ewa!).has('cele'), stary: znaczniki(db), d5: znacznikiD5(db) })
            .toEqual({ restart, cele: false, stary: 1, d5: 1 });
        } finally { db.close(); }
      }
    });
  });

  it('stary znacznik obecny, D5 brak → reopen uzgadnia D5 i nie przywraca cele', async () => {
    const { rozdajNoweUprawnienia } = await import('../../../src/core/uprawnienia.ts');
    const { modulMarketing } = await import('../../../src/moduly/marketing/modul.ts');
    await zBaza((sciezka, openOmsDb) => {
      const db1 = openOmsDb(sciezka);
      let ewa: number;
      try {
        ewa = zalozKonto(db1, { login: 'ewa', imie: 'ewa', haslo: 'x', rola: 'sprzedaz', admin: false });
        ustawUprawnienia(db1, ewa, ekranyRoli('sprzedaz').filter(k => k !== 'cele'));
        db1.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?, ?)').run(ZNACZNIK, teraz().toISOString());
        db1.prepare('DELETE FROM uprawnienia_rozdane WHERE klucz = ?').run(KLUCZ_D5);
      } finally { db1.close(); }

      for (let restart = 0; restart < 2; restart++) {
        const db = openOmsDb(sciezka);
        try {
          // D5 czytany PRZED rozdaniem: uzgadnia go sam reopen, nie rozdajNoweUprawnienia.
          const d5PoReopen = znacznikiD5(db);
          // Po uzgodnieniu D5 również generyczne rozdanie modułu marketingu nie dosypuje ptaszka.
          const rozdane = rozdajNoweUprawnienia(db, [modulMarketing] as ModulOms[], teraz);
          expect({ restart, d5PoReopen, rozdaneCeli: rozdane.includes(KLUCZ_D5),
            cele: uprawnieniaKonta(db, ewa!).has('cele'), stary: znaczniki(db) })
            .toEqual({ restart, d5PoReopen: 1, rozdaneCeli: false, cele: false, stary: 1 });
        } finally { db.close(); }
      }
    });
  });
});
