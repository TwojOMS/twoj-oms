import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { zalozKonto, kontoPoLoginie, czyIstniejeCzynnyAdmin, listaKont } from '../../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../../src/domena/hasla.js';
import { synchronizujRole } from '../../../src/moduly/ustawienia/role.js';
import { wydajLink, aktywnyLink, uzyjLinku, uniewaznijLinkiKonta, WAZNOSC_LINKU_MS } from '../../../src/moduly/ustawienia/linki-hasla.js';
import { zalozKontoZaproszone, ustawEmail, emailKonta, czyZaproszone } from '../../../src/moduly/ustawienia/konta-dostep.js';

const T0 = new Date('2026-10-14T02:00:00Z');
const o = (ms) => () => new Date(T0.getTime() + ms);
const kodBledu = (fn) => { try { fn(); } catch (e) { return e.kod ?? e.message; } return null; };
function baza() {
  const db = openOmsDb(':memory:');
  wykonajMigracje(db, [modulRdzen, modulUstawienia]);
  synchronizujRole(db, { teraz: o(0) });
  return db;
}

describe('PRZ-069 linki do hasła', () => {
  it('w bazie wyłącznie SHA-256 tokenu, token 43 znaki base64url, ważność 48 h', () => {
    const db = baza();
    const id = zalozKontoZaproszone(db, { login: 'nowa', imie: 'Nowa', rola: 'produkcja', teraz: o(0) });
    const { token, wygasaAt } = wydajLink(db, { kontoId: id, cel: 'zaproszenie', utworzylKontoId: null, teraz: o(0) });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const w = db.prepare('SELECT * FROM linki_hasla').get();
    expect(w.hash_tokenu).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db.prepare('SELECT * FROM linki_hasla').all())).not.toContain(token);
    expect(wygasaAt).toBe(new Date(T0.getTime() + WAZNOSC_LINKU_MS).toISOString());
    expect(aktywnyLink(db, token, o(WAZNOSC_LINKU_MS - 1))).toMatchObject({ kontoId: id, cel: 'zaproszenie', login: 'nowa' });
    expect(aktywnyLink(db, token, o(WAZNOSC_LINKU_MS))).toBeNull();
  });

  it('konto zaproszone: wartownik zamiast scrypt, puste hasło nie pasuje, nie liczy się jako czynny admin', () => {
    const db = baza();
    const id = zalozKontoZaproszone(db, { login: 'szef', imie: 'Szef', rola: 'administrator', teraz: o(0) });
    const hash = db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(id).hash_hasla;
    expect(czyZaproszone(hash)).toBe(true);
    expect(zgodneHaslo('', hash)).toBe(false);
    expect(kontoPoLoginie(db, 'szef')).toMatchObject({ admin: true, czynne: true });
    expect(czyIstniejeCzynnyAdmin(db)).toBe(false);
    expect(listaKont(db).find((k) => k.login === 'szef').zaproszone).toBe(true);
  });

  it('użycie linku: hasło scrypt, wersja_hasla +1, link zużyty, pozostałe unieważnione; drugie użycie odmawia', () => {
    const db = baza();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
    const pierwszy = wydajLink(db, { kontoId: id, cel: 'reset', utworzylKontoId: null, teraz: o(0) });
    const drugi = wydajLink(db, { kontoId: id, cel: 'reset', utworzylKontoId: null, teraz: o(1000) });
    expect(aktywnyLink(db, pierwszy.token, o(2000))).toBeNull(); // nowy link unieważnia wcześniejszy
    expect(uzyjLinku(db, { token: drugi.token, haslo: 'nowe-haslo-12345', teraz: o(3000) })).toEqual({ login: 'ewa' });
    const konto = kontoPoLoginie(db, 'ewa');
    expect(konto.wersja_hasla).toBe(1);
    expect(zgodneHaslo('nowe-haslo-12345', db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(id).hash_hasla)).toBe(true);
    expect(uzyjLinku(db, { token: drugi.token, haslo: 'inne-haslo-12345', teraz: o(4000) })).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM linki_hasla WHERE uzyte_at IS NULL AND uniewaznione_at IS NULL').get().n).toBe(0);
  });

  it('wyłączenie konta unieważnia jego linki; link wyłączonego konta nie działa', () => {
    const db = baza();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
    const { token } = wydajLink(db, { kontoId: id, cel: 'reset', utworzylKontoId: null, teraz: o(0) });
    uniewaznijLinkiKonta(db, id, o(10));
    expect(aktywnyLink(db, token, o(20))).toBeNull();
  });

  it('e-mail: przycięty, unikalny bez względu na wielkość liter, zły format odrzucony', () => {
    const db = baza();
    const a = zalozKonto(db, { login: 'a', imie: 'A', haslo: 'h', rola: 'sprzedaz' });
    const b = zalozKonto(db, { login: 'b', imie: 'B', haslo: 'h', rola: 'sprzedaz' });
    ustawEmail(db, a, '  Ewa@Example.TEST ', o(0));
    expect(emailKonta(db, a)).toBe('Ewa@Example.TEST');
    expect(kodBledu(() => ustawEmail(db, b, 'ewa@example.test', o(0)))).toBe('email-zajety');
    for (const zly of ['', 'bez-malpy', 'a@b', 'a b@c.test', `${'x'.repeat(250)}@e.test`]) expect(kodBledu(() => ustawEmail(db, b, zly, o(0))), zly).toBe('email-format');
    ustawEmail(db, a, 'nowy@example.test', o(0));
    expect(db.prepare('SELECT count(*) AS n FROM konta_email').get().n).toBe(1);
  });
});
