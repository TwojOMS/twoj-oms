// PRZ-051 — indeks listy: liczniki zakładek COUNT-em, strona LIMIT-em, świeżość po każdym
// zapisie (także z innego połączenia) i po samym upływie czasu.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { listaZamowien, zapiszFaktyStatusu } from '../../src/oms/db/zamowienia.js';
import { indeksListy } from '../../src/oms/db/indeks-listy.js';
import { wyliczStatus, doZrobienia, ETYKIETY } from '../../src/domena/status.js';
import { wiekZamowienia } from '../../src/domena/wiek-zamowienia.js';
import { pasujeDoFiltrow } from '../../src/domena/filtry-listy.js';
import { pasujeDoSzukania } from '../../src/domena/szukanie.js';
import { wstawGole, wstawMieszane, otworzBazeListy } from './pomoc.js';

// Vite 5 nie rozpoznaje jeszcze node:sqlite jako modułu wbudowanego Node 24.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

let db;
const T = Date.parse('2026-10-01T09:30:00Z');
beforeEach(() => { db = otworzBazeListy(); });
afterEach(() => { try { db.close(); } catch { /* już zamknięta */ } });

// Wyrocznia: dokładnie to, co liczyła lista przed PRZ-051 — cała tabela w JS.
function wyrocznia(t) {
  const wszystkie = listaZamowien(db).map((z) => ({ ...z, status: wyliczStatus(z), robocze: doZrobienia(z, t),
    poTerminie: wiekZamowienia(z, new Date(t))?.poTerminie === true }));
  const statusy = Object.fromEntries(Object.keys(ETYKIETY).map((k) => [k, wszystkie.filter((z) => z.status === k).length]));
  return { wszystkie, liczniki: { wszystkie: wszystkie.length, do_zrobienia: wszystkie.filter((z) => z.robocze).length,
    po_terminie: wszystkie.filter((z) => z.poTerminie).length, statusy } };
}

async function liczniki(t) { const i = indeksListy(db); await i.odswiez(t); return i.liczniki(t); }

describe('PRZ-051 indeks listy', () => {
  it('liczniki zakładek = wyrocznia JS, policzone COUNT-em', async () => {
    wstawMieszane(db, { powtorzen: 3 });
    expect(await liczniki(T)).toEqual(wyrocznia(T).liczniki);
  });

  it('strona: zakładki, filtry i fraza dają to samo, co filtr JS, w porządku listy i z liczbą łączną', async () => {
    wstawMieszane(db, { powtorzen: 3 });
    const i = indeksListy(db);
    await i.odswiez(T);
    const { wszystkie } = wyrocznia(T);
    const przypadki = [
      [{ rodzaj: 'robocze' }, {}, '', (z) => z.robocze],
      [{ rodzaj: 'wszystkie' }, {}, '', () => true],
      [{ rodzaj: 'po_terminie' }, {}, '', (z) => z.poTerminie],
      [{ rodzaj: 'status', status: 'wyslane' }, { kanal: 'kanal_b' }, '', (z) => z.status === 'wyslane' && pasujeDoFiltrow(z, { kanal: 'kanal_b' })],
      [{ rodzaj: 'wszystkie' }, { od: '2026-09-14', do: '2026-09-20', wysylka: 'dpd' }, '', (z) => pasujeDoFiltrow(z, { od: '2026-09-14', do: '2026-09-20', wysylka: 'dpd' })],
      [null, {}, 'kowalski miasto', (z) => pasujeDoSzukania(z, 'kowalski miasto')],
      [null, { platnosc: 'BLIK' }, 'kowalski', (z) => pasujeDoSzukania(z, 'kowalski') && pasujeDoFiltrow(z, { platnosc: 'BLIK' })],
    ];
    for (const [zakladka, filtry, szukaj, pred] of przypadki) {
      const oczekiwane = wszystkie.filter(pred).map((z) => z.id);
      expect(oczekiwane.length, JSON.stringify([zakladka, filtry, szukaj])).toBeGreaterThan(0);
      const s = i.strona({ zakladka, filtry, szukaj, offset: 0, limit: 7, teraz: T });
      expect(s.lacznie).toBe(oczekiwane.length);
      expect(s.ids).toEqual(oczekiwane.slice(0, 7));
      const reszta = i.strona({ zakladka, filtry, szukaj, offset: 7, limit: 1000, teraz: T });
      expect([...s.ids, ...reszta.ids]).toEqual(oczekiwane);
    }
  });

  it('filtr widzi metodę wysyłki PO ręcznej zmianie, fraza cyfrowa znajduje telefon zapisany ze spacjami', async () => {
    // Oczekiwania z DANYCH zestawu, nie z reguły — porównanie reguły z nią samą niczego nie dowodzi.
    const w = wstawMieszane(db, { powtorzen: 2 });
    const i = indeksListy(db);
    await i.odswiez(T);
    const reczne = w.filter((x) => x.rodzaj === 'odbior-reczny').map((x) => x.id);
    expect(reczne).toHaveLength(2);
    const strona = (filtry, szukaj = '') => i.strona({ zakladka: szukaj ? null : { rodzaj: 'wszystkie' }, filtry, szukaj, offset: 0, limit: 1000, teraz: T });
    const odbior = strona({ wysylka: 'odbior_osobisty' });
    expect([...odbior.ids].sort()).toEqual([...reczne].sort());
    expect(strona({ wysylka: 'dpd' }).ids.filter((id) => reczne.includes(id))).toEqual([]);
    const [, a, b, c] = w.telefon.cyfry.match(/^(\d{3})(\d{3})(\d{3})$/);
    expect(strona({}, `${a}-${b}-${c}`).ids).toEqual([w.telefon.id]);
    expect(strona({}, `(${a}) ${b} ${c}`).ids).toEqual([w.telefon.id]);
    // Następna, INNA fraza w tym samym połączeniu ma dać swój wynik (funkcja SQL pamięta frazę).
    const peki = wyrocznia(T).wszystkie.filter((z) => pasujeDoSzukania(z, 'peki')).map((z) => z.id);
    expect(peki.length).toBeGreaterThan(5);
    expect([...strona({}, 'peki').ids].sort()).toEqual([...peki].sort());
  });

  it('równe daty: strony się nie nakładają i niczego nie gubią', async () => {
    const ids = wstawGole(db, 25);
    const i = indeksListy(db);
    await i.odswiez(T);
    const strony = [0, 10, 20].flatMap((offset) => i.strona({ zakladka: { rodzaj: 'wszystkie' }, filtry: {}, szukaj: '', offset, limit: 10, teraz: T }).ids);
    expect(strony).toEqual([...ids].reverse());
  });

  it('32 767 + 1 zamówień: indeks buduje się porcjami, liczniki i strona bez błędu SQL', async () => {
    wstawGole(db, 32768);
    const l = await liczniki(T);
    expect(l.wszystkie).toBe(32768);
    expect(l.statusy.nowe).toBe(32768);
    const s = indeksListy(db).strona({ zakladka: { rodzaj: 'robocze' }, filtry: {}, szukaj: '', offset: 0, limit: 100, teraz: T });
    expect(s.ids).toHaveLength(100);
    expect(s.lacznie).toBe(32768);
  }, 60000);

  it('każdy zapis w tabelach źródłowych odświeża wiersz przy następnym odczycie', async () => {
    const [a, b, c] = wstawMieszane(db, { powtorzen: 1 }).filter((w) => w.rodzaj === 'nowe' || w.rodzaj === 'w-realizacji' || w.rodzaj === 'wyslane-czyste').map((w) => w.id);
    const i = indeksListy(db);
    await i.odswiez(T);
    const sprawdz = async (opis) => { await i.odswiez(T); expect(i.liczniki(T), opis).toEqual(wyrocznia(T).liczniki); };
    zapiszFaktyStatusu(db, a, { wyslane_at: '2026-09-30T10:00:00Z' }); await sprawdz('zamowienia');
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at, kolejnosc) VALUES (?, 'dpd', 'nadana', 'X1', '2026-09-30T10:00:00Z', 2)").run(c); await sprawdz('przesylki');
    db.prepare("INSERT INTO faktury (zamowienie_id, infakt_uuid, ksef_status, utworzona_at) VALUES (?, 'u-x', 'do_wyjasnienia', '2026-09-30T10:00:00Z')").run(b); await sprawdz('faktury');
    db.prepare("INSERT INTO zwroty (zamowienie_id, data, kwota, utworzony_at) VALUES (?, '2026-09-30', '1.00', '2026-09-30T10:00:00Z')").run(c); await sprawdz('zwroty');
    db.prepare("INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, zrodlo, utworzona_at) VALUES (?, '10.00', '2026-09-20T10:00:00Z', 'x', 'reczna', '2026-09-20T10:00:00Z')").run(a);
    db.prepare("UPDATE zamowienia SET wyslane_at = NULL WHERE id = ?").run(a); await sprawdz('platnosci');
    db.prepare("UPDATE pozycje SET nazwa = 'Realizacja ekspresowa' WHERE zamowienie_id = ?").run(b); await sprawdz('pozycje');
    db.prepare('DELETE FROM zamowienia WHERE id = ?').run(b); await sprawdz('usunięcie');
  });

  describe('na pliku bazy (kilka połączeń = kilka procesów)', () => {
    let kat; let plik;
    beforeEach(() => { db.close(); kat = mkdtempSync(join(tmpdir(), 'prz051-')); plik = join(kat, 'oms.sqlite'); db = otworzBazeListy(plik); });
    afterEach(() => { try { db.close(); } catch { /* */ } rmSync(kat, { recursive: true, force: true }); });

    it('zapis innego procesu przez openOmsDb (skrypt importu) trafia do indeksu przy następnym odczycie', async () => {
      const [id] = wstawGole(db, 3);
      const i = indeksListy(db);
      await i.odswiez(T);
      expect(i.liczniki(T).statusy.wyslane).toBe(0);
      const skrypt = otworzBazeListy(plik);
      zapiszFaktyStatusu(skrypt, id, { wyslane_at: '2026-09-30T10:00:00Z' });
      skrypt.close();
      await i.odswiez(T);
      expect(i.liczniki(T).statusy.wyslane).toBe(1);
    });

    it('indeks przeżywa restart: nowy proces odpowiada od razu, bez budowy od zera', async () => {
      wstawMieszane(db, { powtorzen: 2 });
      await indeksListy(db).odswiez(T);
      const oczekiwane = wyrocznia(T).liczniki;
      db.close();
      db = otworzBazeListy(plik);
      const policzone = [];
      const oryginal = db.prepare;
      db.prepare = function (sql) { if (/FROM zamowienia WHERE id IN/.test(sql)) policzone.push(sql); return oryginal.call(this, sql); };
      // Liczniki z tabeli, zanim cokolwiek się przeliczy.
      expect(indeksListy(db).liczniki(T)).toEqual(oczekiwane);
      db.prepare = oryginal;
      expect(policzone).toEqual([]);
    });

    it('zapis gołym połączeniem (bez wyzwalaczy) wyłapuje sprawdzenie po starcie następnego procesu', async () => {
      const [id] = wstawGole(db, 3);
      await indeksListy(db).odswiez(T);
      const gole = new DatabaseSync(plik);
      gole.prepare("UPDATE zamowienia SET wyslane_at = '2026-09-30T10:00:00Z' WHERE id = ?").run(id);
      gole.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('kanal_a', 999, 'GOLE', '1.00', '2026-09-30T10:00:00')").run();
      gole.close();
      // Ten sam proces nie wie o zmianie (to jest znana granica, opisana w indeks-listy.js)…
      await indeksListy(db).odswiez(T);
      expect(indeksListy(db).liczniki(T).statusy.wyslane).toBe(0);
      // …następny start sprawdza całość.
      db.close();
      db = otworzBazeListy(plik);
      await indeksListy(db).odswiez(T);
      expect(indeksListy(db).liczniki(T)).toEqual(wyrocznia(T).liczniki);
      expect(indeksListy(db).liczniki(T).statusy.wyslane).toBe(1);
    });

    it('odświeżenie bez pracy do zrobienia nie czeka na blokadę zapisu innego procesu', async () => {
      wstawGole(db, 3);
      const i = indeksListy(db);
      await i.odswiez(T);
      const inny = new DatabaseSync(plik);
      inny.exec('BEGIN IMMEDIATE'); // np. import sklepu w trakcie transakcji
      try {
        const t = performance.now();
        await i.odswiez(T);
        expect(i.liczniki(T).wszystkie).toBe(3);
        expect(performance.now() - t).toBeLessThan(2000); // busy_timeout panelu to 20 s
      } finally { inny.exec('ROLLBACK'); inny.close(); }
    }, 30000);

    it('duża baza: sprawdzenie po starcie idzie w tle, z widocznym postępem, i kończy się zgodnie z wyrocznią', async () => {
      wstawGole(db, 1200);
      await indeksListy(db).odswiez(T);
      db.prepare("UPDATE zamowienia SET wyslane_at = '2026-09-30T10:00:00Z' WHERE id <= 5").run();
      db.prepare('DELETE FROM lista_brudne').run(); // udajemy zapis, którego wyzwalacz nie widział
      db.close();
      db = otworzBazeListy(plik);
      const i = indeksListy(db);
      await i.odswiez(T);
      expect(i.sprawdzanie()).toEqual({ sprawdzone: 0, wszystkie: 1200 });
      for (let n = 0; n < 200 && i.sprawdzanie(); n++) await new Promise((r) => setTimeout(r, 20));
      expect(i.sprawdzanie()).toBe(null);
      expect(i.liczniki(T)).toEqual(wyrocznia(T).liczniki);
    });
  });

  it('uszkodzone zamówienie (zły JSON) nie zamraża indeksu: reszta się liczy, ono ląduje w „Do zrobienia” z przyczyną', async () => {
    const ids = wstawGole(db, 5);
    const i = indeksListy(db);
    await i.odswiez(T);
    db.prepare("UPDATE zamowienia SET klient_json = '{zepsute' WHERE id = ?").run(ids[1]);
    zapiszFaktyStatusu(db, ids[2], { wyslane_at: '2026-09-30T10:00:00Z' });
    const [nowe] = wstawGole(db, 1, { od: 100 });
    await i.odswiez(T);
    const l = i.liczniki(T);
    expect(l.wszystkie).toBe(6);
    expect(l.statusy.wyslane).toBe(1);
    expect(l.do_zrobienia).toBe(5); // 4 nowe (w tym dopisane) + uszkodzone
    expect(i.strona({ zakladka: { rodzaj: 'wszystkie' }, filtry: {}, szukaj: '', offset: 0, limit: 10, teraz: T }).ids).toContain(nowe);
    expect(i.uszkodzone()).toEqual([{ id: ids[1], numer: 'T-2', blad: expect.stringMatching(/JSON/) }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lista_brudne').get().n).toBe(0);
    // Naprawa danych zdejmuje zamówienie z listy uszkodzonych przy następnym odczycie.
    db.prepare("UPDATE zamowienia SET klient_json = NULL WHERE id = ?").run(ids[1]);
    await i.odswiez(T);
    expect(i.uszkodzone()).toEqual([]);
    expect(i.liczniki(T).statusy.nowe).toBe(5);
  });

  it('uszkodzone zamówienie przy PIERWSZEJ budowie: budowa się kończy i nie powtarza przy każdym żądaniu', async () => {
    const ids = wstawGole(db, 4);
    db.prepare("UPDATE zamowienia SET dostawa_json = '[' WHERE id = ?").run(ids[0]);
    const i = indeksListy(db);
    await i.odswiez(T);
    expect(db.prepare("SELECT 1 AS j FROM lista_meta WHERE klucz = 'zbudowany_at'").get()).toEqual({ j: 1 });
    const sql = [];
    const oryginal = db.prepare;
    db.prepare = function (t) { sql.push(t); return oryginal.call(this, t); };
    try { await i.odswiez(T); } finally { db.prepare = oryginal; }
    expect(sql.filter((t) => /FROM zamowienia WHERE id IN/.test(t))).toEqual([]);
    expect(i.liczniki(T).wszystkie).toBe(4);
  });

  it('każdy wyzwalacz oznacza dokładnie zmienione zamówienie (zanim cokolwiek się przeliczy)', async () => {
    const [a, b] = wstawGole(db, 2);
    const i = indeksListy(db);
    await i.odswiez(T);
    const brudne = () => db.prepare('SELECT zamowienie_id AS id FROM lista_brudne ORDER BY 1').all().map((w) => w.id);
    const zapisy = [
      ['zamowienia', () => db.prepare("UPDATE zamowienia SET uwagi = 'x' WHERE id = ?").run(a)],
      ['pozycje', () => db.prepare("INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto) VALUES (?, 'P', 1, '1.00')").run(a)],
      ['platnosci', () => db.prepare("INSERT INTO platnosci (zamowienie_id, kwota, zrodlo, utworzona_at) VALUES (?, '1.00', 'reczna', '2026-09-30')").run(a)],
      ['przesylki', () => db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, utworzona_at) VALUES (?, 'dpd', 'nadana', '2026-09-30')").run(a)],
      ['faktury', () => db.prepare("INSERT INTO faktury (zamowienie_id, utworzona_at) VALUES (?, '2026-09-30')").run(a)],
      ['zwroty', () => db.prepare("INSERT INTO zwroty (zamowienie_id, data, kwota, utworzony_at) VALUES (?, '2026-09-30', '1', '2026-09-30')").run(a)],
    ];
    for (const [tabela, zapis] of zapisy) {
      zapis();
      expect(brudne(), tabela).toEqual([a]);
      await i.odswiez(T);
      expect(brudne(), tabela).toEqual([]);
    }
    for (const t of ['pozycje', 'platnosci', 'przesylki', 'faktury', 'zwroty']) {
      db.prepare(`UPDATE ${t} SET zamowienie_id = ? WHERE zamowienie_id = ?`).run(b, a);
      expect(brudne(), `${t} przeniesione`).toEqual([a, b]);
      db.prepare(`DELETE FROM ${t} WHERE zamowienie_id = ?`).run(b);
      await i.odswiez(T);
    }
    db.prepare('DELETE FROM zamowienia WHERE id = ?').run(b);
    expect(brudne()).toEqual([b]);
  });

  it('baza ze schematem indeksu sprzed poprawek (bez kolumny blad): czytelna odmowa, nie surowy błąd SQL', () => {
    db.exec('ALTER TABLE lista_stan DROP COLUMN blad');
    expect(() => indeksListy(db)).toThrow(/bez kolumny blad/);
  });

  it('wygasanie po horyzoncie jest rozrzucone (nie cała tabela jednego dnia)', async () => {
    wstawGole(db, 90);
    await indeksListy(db).odswiez(T);
    const dni = db.prepare('SELECT COUNT(DISTINCT wazne_do) AS n, MIN(wazne_do) AS od, MAX(wazne_do) AS do_ FROM lista_stan').get();
    expect(dni.n).toBe(30);
    expect(dni.od).toBeGreaterThan(T + 59 * 86400000);
  });

  it('wiersz po horyzoncie liczy się od nowa przy odczycie', async () => {
    wstawGole(db, 2);
    const i = indeksListy(db);
    await i.odswiez(T);
    const przed = db.prepare('SELECT MIN(wazne_do) AS w FROM lista_stan').get().w;
    await i.odswiez(przed + 1);
    expect(db.prepare('SELECT MIN(wazne_do) AS w FROM lista_stan').get().w).toBeGreaterThan(przed);
  });

  it('sam upływ czasu (bez zapisu) przenosi zamówienie do „po terminie" i „do zrobienia"', async () => {
    wstawMieszane(db, { powtorzen: 1 });
    const i = indeksListy(db);
    await i.odswiez(T);
    for (const dt of [0, 3 * 60000, 3 * 86400000, 10 * 86400000]) {
      await i.odswiez(T + dt);
      expect(i.liczniki(T + dt), `+${dt}`).toEqual(wyrocznia(T + dt).liczniki);
    }
    expect(wyrocznia(T + 10 * 86400000).liczniki.po_terminie).toBeGreaterThan(wyrocznia(T).liczniki.po_terminie);
  });
});
