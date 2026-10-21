// PRZ-105 — domyślna stawka VAT w Ustawieniach → Firma. Prośba właściciela 21.10: „pole stawka VAT z domyślną wartością
// ustawianą w ustawieniach - u nas 23%”. Bez wpisu = 23 (Szkicownia bez zmian), zapisuje tylko administrator,
// stawki 23/8/5/0, przy 0 ostrzeżenie „0% krajowe — sprawdź podstawę” (decyzja właściciela: dozwolone z ostrzeżeniem).
// Prawdziwy skład (zbudujOms), sieć zabroniona. Dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
import { czytajStawkeDomyslna, zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';

const EKRAN = '/ustawienia/firma';
const ZAPIS = '/ustawienia/firma/stawka-vat';

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz105-'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

async function panel() {
  const env = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_USER: 'operator', OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
  const a = await zbudujOms({ env, moduly: modulyDla(env) });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(a.db, kontoPoLoginie(a.db, 'ewa').id, ['ustawienia', 'zamowienia']);
  return { ...a, admin: jako(a.db, 'adam'), ewa: jako(a.db, 'ewa'), zamknij: async () => { await a.app.close(); a.db.close(); } };
}
const sekcja = (html) => /<section class="ust-sekcja" id="stawka-vat">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

describe('czytajStawkeDomyslna / zapiszStawkeDomyslna', () => {
  it('bez wpisu → 23; po zapisie 8 → 8; wpis spoza listy w bazie → 23, nie śmieć', async () => {
    const p = await panel();
    try {
      expect(czytajStawkeDomyslna(p.db)).toBe('23');
      zapiszStawkeDomyslna(p.db, '8');
      expect(czytajStawkeDomyslna(p.db)).toBe('8');
      p.db.prepare("UPDATE ustawienia SET wartosc = '22' WHERE klucz = 'vat.stawka_domyslna'").run();
      expect(czytajStawkeDomyslna(p.db)).toBe('23');
    } finally { await p.zamknij(); }
  });

  it('zapis stawki spoza listy rzuca — nic nie trafia do bazy', async () => {
    const p = await panel();
    try {
      expect(() => zapiszStawkeDomyslna(p.db, 'zw')).toThrow();
      expect(p.db.prepare("SELECT 1 FROM ustawienia WHERE klucz = 'vat.stawka_domyslna'").get()).toBeUndefined();
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-105 Ustawienia → Firma → Domyślna stawka VAT', () => {
  it('ekran: lista 23/8/5/0 z zaznaczoną 23, bez ostrzeżenia o 0%', async () => {
    const p = await panel();
    try {
      const r = await get(p.app, EKRAN, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      const s = sekcja(r.body);
      expect(s).toContain('Domyślna stawka VAT');
      expect([...s.matchAll(/<option value="(\d+)"/gu)].map((m) => m[1])).toEqual(['23', '8', '5', '0']);
      expect(s).toMatch(/<option value="23" selected>/u);
      expect(s).not.toContain('0% krajowe');
    } finally { await p.zamknij(); }
  });

  it('administrator zapisuje 8 → 303, odczyt 8, ekran zaznacza 8', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.admin, { stawka: '8' });
      expect(r.statusCode, r.body).toBe(303);
      expect(czytajStawkeDomyslna(p.db)).toBe('8');
      const e = await get(p.app, r.headers.location, p.admin);
      expect(sekcja(e.body)).toMatch(/<option value="8" selected>/u);
    } finally { await p.zamknij(); }
  });

  it('0 zapisuje się, a ekran ostrzega „0% krajowe — sprawdź podstawę”', async () => {
    const p = await panel();
    try {
      expect((await post(p.app, ZAPIS, p.admin, { stawka: '0' })).statusCode).toBe(303);
      expect(czytajStawkeDomyslna(p.db)).toBe('0');
      expect(sekcja((await get(p.app, EKRAN, p.admin)).body)).toContain('0% krajowe — sprawdź podstawę');
    } finally { await p.zamknij(); }
  });

  it('stawka spoza listy (22, zw, pusta) → 400 z komunikatem, nic nie zapisane', async () => {
    const p = await panel();
    try {
      for (const stawka of ['22', 'zw', '']) {
        const r = await post(p.app, ZAPIS, p.admin, { stawka });
        expect(r.statusCode).toBe(400);
        expect(sekcja(r.body)).toContain('Nie zapisano stawki');
      }
      expect(czytajStawkeDomyslna(p.db)).toBe('23');
    } finally { await p.zamknij(); }
  });

  it('konto z dostępem do Ustawień, ale nie administrator → 403, stawka bez zmian; ekran bez formularza', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.ewa, { stawka: '8' });
      expect(r.statusCode).toBe(403);
      expect(czytajStawkeDomyslna(p.db)).toBe('23');
      expect(sekcja((await get(p.app, EKRAN, p.ewa)).body)).not.toContain(`action="${ZAPIS}"`);
    } finally { await p.zamknij(); }
  });
});
