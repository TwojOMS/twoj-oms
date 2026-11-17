import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  sejfZEnv, utworzSejf, bajtyKlucza, idKlucza, nowyKlucz, klasyfikuj, idKluczaZapisu, BladSekretow,
  przypnijSejf, sejfBazy, ustawSejfDomyslny, doZapisu, zOdczytu, FORMAT_SEKRETOW,
} from '../../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { BladKonfiguracji } from '../../../src/core/blad-konfiguracji.ts';
import { komunikatDlaOperatora } from '../../../src/domena/bledy.js';
import { przywrocSejfDomyslny } from '../../pomoc/sejf-testowy.ts';

const K1 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const K2 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const M = { tabela: 'tokeny_kanalu', kolumna: 'access_token', id: 'allegro-a' };

afterEach(() => przywrocSejfDomyslny());

describe('klucz', () => {
  it('przyjmuje tylko kanoniczny base64url 32 bajtów', () => {
    expect(bajtyKlucza(K1)).toHaveLength(32);
    expect(bajtyKlucza(nowyKlucz())).toHaveLength(32);
    // Ten sam początek, ostatni znak z ustawionymi wolnymi bitami — dekoduje się do tych samych bajtów, ale nie jest kanoniczny.
    expect(bajtyKlucza(K1.slice(0, -1) + '9')).toBeNull();
    expect(bajtyKlucza(K1 + '=')).toBeNull();
    expect(bajtyKlucza(K1.slice(0, -2))).toBeNull();
    expect(bajtyKlucza('')).toBeNull();
    expect(bajtyKlucza(K1.replace('A', '+'))).toBeNull();
  });
  it('id ma 8 znaków hex i zależy od klucza', () => {
    expect(idKlucza(bajtyKlucza(K1))).toMatch(/^[0-9a-f]{8}$/);
    expect(idKlucza(bajtyKlucza(K1))).not.toBe(idKlucza(bajtyKlucza(K2)));
  });
  it('sejfZEnv: brak klucza i zła postać = BladKonfiguracji bez wartości w komunikacie', () => {
    expect(() => sejfZEnv({})).toThrow(BladKonfiguracji);
    expect(() => sejfZEnv({ OMS_KLUCZ_SEKRETOW: '  ' })).toThrow(BladKonfiguracji);
    const zly = K1.slice(0, -1) + '9';
    try { sejfZEnv({ OMS_KLUCZ_SEKRETOW: zly }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(BladKonfiguracji); expect(String(e.message) + e.wskazowka).not.toContain(zly); }
    expect(() => sejfZEnv({ OMS_KLUCZ_SEKRETOW: K1, OMS_KLUCZ_SEKRETOW_POPRZEDNI: 'x' })).toThrow(BladKonfiguracji);
    const s = sejfZEnv({ OMS_KLUCZ_SEKRETOW: K1, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K2 });
    expect(s.idKlucza).toBe(idKlucza(bajtyKlucza(K1)));
    expect(s.idPoprzedniego).toBe(idKlucza(bajtyKlucza(K2)));
  });
  it('format danych z pliku format-sekretow.json', () => {
    expect(FORMAT_SEKRETOW).toBe(1);
  });
});

describe('klasyfikacja', () => {
  const s = sejfZEnv({ OMS_KLUCZ_SEKRETOW: K1 });
  const z = s.szyfruj('tajne', M);
  it.each([
    [null, 'pusty'], ['', 'pusty'], ['{}', 'jawny'], ['abc', 'jawny'], ['oms2.x', 'nieznana-wersja'], ['oms12.a.b.c', 'nieznana-wersja'],
    ['oms1.', 'uszkodzony'], ['oms1.abcd.x.y', 'uszkodzony'],
  ])('%s → %s', (w, k) => expect(klasyfikuj(w)).toBe(k));
  it('{} pusty tylko dla JSON-a', () => expect(klasyfikuj('{}', { json: true })).toBe('pusty'));
  it('poprawny zapis to szyfrogram, każda zła część to uszkodzony', () => {
    expect(klasyfikuj(z)).toBe('szyfrogram');
    const [w, id, n, d] = z.split('.');
    expect(klasyfikuj([w, id, n, d, 'x'].join('.'))).toBe('uszkodzony');
    expect(klasyfikuj([w, 'ABCDEF12', n, d].join('.'))).toBe('uszkodzony');
    expect(klasyfikuj([w, id, n.slice(1), d].join('.'))).toBe('uszkodzony');
    expect(klasyfikuj([w, id, n, 'AAAA'].join('.'))).toBe('uszkodzony');
    expect(idKluczaZapisu(z)).toBe(s.idKlucza);
    expect(idKluczaZapisu('jawny')).toBeNull();
  });
});

describe('szyfrowanie', () => {
  const s1 = sejfZEnv({ OMS_KLUCZ_SEKRETOW: K1 });
  const s2 = sejfZEnv({ OMS_KLUCZ_SEKRETOW: K2 });
  it('każdy zapis ma nowy nonce, odczyt oddaje tekst', () => {
    const a = s1.szyfruj('tajne ąę', M), b = s1.szyfruj('tajne ąę', M);
    expect(a).not.toBe(b);
    expect(a).not.toContain('tajne');
    expect(s1.odszyfruj(a, M)).toBe('tajne ąę');
  });
  it('przypięcie do miejsca: inny wiersz, kolumna albo tabela nie odszyfruje', () => {
    const z = s1.szyfruj('tajne', M);
    for (const inne of [{ ...M, id: 'allegro-b' }, { ...M, kolumna: 'refresh_token' }, { ...M, tabela: 'tokeny_ksef' }]) {
      expect(() => s1.odszyfruj(z, inne)).toThrow(expect.objectContaining({ kod: 'USZKODZONY' }));
    }
  });
  it('inny klucz = INNY_KLUCZ z obu id w komunikacie, bez wartości', () => {
    const z = s1.szyfruj('tajne', M);
    try { s2.odszyfruj(z, M); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(BladSekretow); expect(e.kod).toBe('INNY_KLUCZ');
      expect(e.message).toContain(s1.idKlucza); expect(e.message).toContain(s2.idKlucza); expect(e.message).not.toContain('tajne');
      expect(komunikatDlaOperatora(e)).toBe(e.message); // ekran pokazuje przyczynę, nie „błąd techniczny”
    }
  });
  it('klucz poprzedni odszyfrowuje i jest rozpoznany', () => {
    const z = s1.szyfruj('tajne', M);
    const po = sejfZEnv({ OMS_KLUCZ_SEKRETOW: K2, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K1 });
    expect(po.odszyfrujSzczegolowo(z, M)).toEqual({ tekst: 'tajne', poprzedni: true });
    expect(po.odszyfrujSzczegolowo(po.szyfruj('x', M), M)).toEqual({ tekst: 'x', poprzedni: false });
  });
  it('zmieniony bajt danych = USZKODZONY', () => {
    const z = s1.szyfruj('tajne', M);
    const [w, id, n, d] = z.split('.');
    const b = Buffer.from(d, 'base64url'); b[0] ^= 1;
    expect(() => s1.odszyfruj([w, id, n, b.toString('base64url')].join('.'), M)).toThrow(expect.objectContaining({ kod: 'USZKODZONY' }));
  });
  it('jawny, uszkodzony, nieznana wersja — odmowa z kodem', () => {
    expect(() => s1.odszyfruj('abc', M)).toThrow(expect.objectContaining({ kod: 'JAWNY_WIERSZ' }));
    expect(() => s1.odszyfruj('oms1.zle', M)).toThrow(expect.objectContaining({ kod: 'USZKODZONY' }));
    expect(() => s1.odszyfruj('oms2.a.b.c', M)).toThrow(expect.objectContaining({ kod: 'NIEZNANA_WERSJA' }));
  });
});

describe('przypięcie do uchwytu bazy', () => {
  it('bez przypięcia i bez sejfu domyślnego — odmowa BRAK_KLUCZA, bez sięgania do process.env', () => {
    ustawSejfDomyslny(null);
    const stary = process.env.OMS_KLUCZ_SEKRETOW;
    process.env.OMS_KLUCZ_SEKRETOW = K1;
    try {
      const db = new DatabaseSync(':memory:');
      expect(() => sejfBazy(db)).toThrow(expect.objectContaining({ kod: 'BRAK_KLUCZA' }));
      expect(() => doZapisu(db, M, 'x')).toThrow(BladSekretow);
    } finally { if (stary === undefined) delete process.env.OMS_KLUCZ_SEKRETOW; else process.env.OMS_KLUCZ_SEKRETOW = stary; }
  });
  it('dwie bazy z dwoma kluczami w jednym procesie — każda używa swojego', () => {
    ustawSejfDomyslny(null);
    const a = przypnijSejf(new DatabaseSync(':memory:'), utworzSejf(bajtyKlucza(K1)));
    const b = przypnijSejf(new DatabaseSync(':memory:'), utworzSejf(bajtyKlucza(K2)));
    const za = doZapisu(a, M, 'A'), zb = doZapisu(b, M, 'B');
    expect(idKluczaZapisu(za)).not.toBe(idKluczaZapisu(zb));
    expect(zOdczytu(a, M, za)).toBe('A');
    expect(zOdczytu(b, M, zb)).toBe('B');
    expect(() => zOdczytu(a, M, zb)).toThrow(expect.objectContaining({ kod: 'INNY_KLUCZ' }));
  });
  it('NULL zostaje NULL, {} JSON-a zostaje {}', () => {
    const db = new DatabaseSync(':memory:');
    expect(doZapisu(db, M, null)).toBeNull();
    // Pusty tekst zostaje pusty — zaszyfrowany miałby 16 bajtów i parser uznałby go za uszkodzony.
    expect(doZapisu(db, M, '')).toBe('');
    expect(zOdczytu(db, M, '')).toBe('');
    expect(zOdczytu(db, M, null)).toBeNull();
    expect(zOdczytu(db, M, '{}', { json: true })).toBe('{}');
    expect(() => zOdczytu(db, M, '{}')).toThrow(expect.objectContaining({ kod: 'JAWNY_WIERSZ' }));
  });
});
