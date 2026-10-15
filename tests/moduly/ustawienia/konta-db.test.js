import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zalozKonto, kontoPoLoginie, ustawUprawnienia, ustawCzynne, ustawAdmina, zmienHaslo,
  czyIstniejeCzynnyAdmin, listaKont, dopiszLogowanie, ostatnieLogowania, uprawnieniaKonta,
  MAKS_DLUGOSC_LOGINU_W_DZIENNIKU,
} from '../../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../../src/domena/hasla.js';

const swiezaBaza = () => openOmsDb(':memory:');

describe('konta', () => {
  it('SWIEZA BAZA NIE MA ZADNEGO KONTA — na tym stoi degradacja konta z .env', () => {
    const db = swiezaBaza();
    expect(listaKont(db)).toEqual([]);
    expect(czyIstniejeCzynnyAdmin(db)).toBe(false);
  });

  it('zalozone konto ma uprawnienia swojej roli i da sie je znalezc po loginie', () => {
    const db = swiezaBaza();
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h1', rola: 'sprzedaz', admin: false });
    const konto = kontoPoLoginie(db, 'ewa');
    expect(konto.imie).toBe('Barbara');
    expect(konto.rola).toBe('sprzedaz');
    expect(konto.czynne).toBe(true);
    expect(konto.admin).toBe(false);
    expect(konto.uprawnienia.has('raporty')).toBe(true);
    expect(konto.uprawnienia.has('koszty')).toBe(true);
    expect(konto.uprawnienia.has('finanse')).toBe(false);
    expect(konto.uprawnienia.has('ustawienia')).toBe(false);
  });

  it('hasla nie leza w bazie otwartym tekstem', () => {
    const db = swiezaBaza();
    zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'jawne', rola: 'sprzedaz', admin: false });
    const wiersz = db.prepare('SELECT hash_hasla FROM konta WHERE login = ?').get('ewa');
    expect(wiersz.hash_hasla).not.toContain('jawne');
    expect(zgodneHaslo('jawne', wiersz.hash_hasla)).toBe(true);
  });

  it('login jest unikalny', () => {
    const db = swiezaBaza();
    zalozKonto(db, { login: 'ewa', imie: 'A', haslo: 'h', rola: 'sprzedaz', admin: false });
    expect(() => zalozKonto(db, { login: 'ewa', imie: 'B', haslo: 'h', rola: 'produkcja', admin: false }))
      .toThrow();
  });

  it('ustawUprawnienia PODMIENIA komplet, a nie doklada', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'p', imie: 'P', haslo: 'h', rola: 'produkcja', admin: false });
    ustawUprawnienia(db, id, ['magazyn']);
    const konto = kontoPoLoginie(db, 'p');
    expect([...konto.uprawnienia]).toEqual(['magazyn']);
  });

  it('czynnego admina widac dopiero, gdy jest CZYNNY i ma flage admin', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    expect(czyIstniejeCzynnyAdmin(db)).toBe(true);
    ustawCzynne(db, id, false);
    expect(czyIstniejeCzynnyAdmin(db)).toBe(false);
  });

  it('konto wylaczone NIE ZNIKA z listy — historia ma dalej miec kogo wskazac', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawCzynne(db, id, false);
    expect(listaKont(db)).toHaveLength(1);
    expect(listaKont(db)[0].czynne).toBe(false);
  });

  it('zmiana hasla dziala, a stare przestaje pasowac', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'ewa', imie: 'A', haslo: 'stare', rola: 'sprzedaz', admin: false });
    zmienHaslo(db, id, 'nowe');
    const wiersz = db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(id);
    expect(zgodneHaslo('nowe', wiersz.hash_hasla)).toBe(true);
    expect(zgodneHaslo('stare', wiersz.hash_hasla)).toBe(false);
  });

  it('ustawAdmina nadaje i odbiera flage, a od niej zalezy degradacja konta z .env', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'ewa', imie: 'A', haslo: 'h', rola: 'sprzedaz', admin: false });
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(false);
    expect(czyIstniejeCzynnyAdmin(db)).toBe(false);

    ustawAdmina(db, id, true);
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(true);
    expect(czyIstniejeCzynnyAdmin(db)).toBe(true);

    ustawAdmina(db, id, false);
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(false);
    expect(czyIstniejeCzynnyAdmin(db)).toBe(false);
  });

  it('uprawnieniaKonta oddaje dokladnie to, co ustawiono przez ustawUprawnienia', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'p', imie: 'P', haslo: 'h', rola: 'produkcja', admin: false });
    ustawUprawnienia(db, id, ['magazyn', 'raporty']);
    const uprawnienia = uprawnieniaKonta(db, id);
    expect(uprawnienia).toBeInstanceOf(Set);
    expect([...uprawnienia].sort()).toEqual(['magazyn', 'raporty']);
  });

  it('uprawnieniaKonta dla konta bez uprawnien oddaje pusty Set', () => {
    const db = swiezaBaza();
    const id = zalozKonto(db, { login: 'p', imie: 'P', haslo: 'h', rola: 'produkcja', admin: false, ekrany: [] });
    expect(uprawnieniaKonta(db, id)).toEqual(new Set());
  });
});

describe('dziennik logowan', () => {
  // ⚠️⚠️ DOWOD MUTACYJNY (Zadanie 5, scripts/mutacje-konta-role.mjs, mutacja 17): `login`
  // w dzienniku pochodzi WPROST z `req.body.uzytkownik`, bez zadnego ograniczenia dlugosci
  // ze strony wolajacego — zmierzone na zywym serwerze: 291 zadan w 2 s po 100 kB kazdy to
  // 29,1 MB w samej tej kolumnie. Ten sam scenariusz stoi juz w tests/oms/logowanie.test.js
  // (`login w dzienniku jest przyciety...`), ale TAMTEN test chodzi przez cala trase /login
  // (hamulec + scrypt), wiec nie zlapie regresji, gdyby `dopiszLogowanie` bylo kiedys wolane
  // z INNEGO miejsca niz logowanie.js — przycinanie ma pilnowac warstwa `konta.js`
  // SAMODZIELNIE, dla WSZYSTKICH wywolan, nie tylko tego jednego.
  it('login w dzienniku jest PRZYCIETY do MAKS_DLUGOSC_LOGINU_W_DZIENNIKU', () => {
    const db = swiezaBaza();
    const dlugiLogin = 'x'.repeat(1000);
    dopiszLogowanie(db, { login: dlugiLogin, usluga: 'oms', ip: '::1', wynik: 'zle-haslo' });
    const [wpis] = ostatnieLogowania(db, 1);
    expect(wpis.login).toHaveLength(MAKS_DLUGOSC_LOGINU_W_DZIENNIKU);
    expect(wpis.login).toBe('x'.repeat(MAKS_DLUGOSC_LOGINU_W_DZIENNIKU));
  });

  it('ZAPISUJE TAKZE PROBY NIEUDANE — bez nich dziennik pokazuje tylko to, co sie udalo', () => {
    const db = swiezaBaza();
    dopiszLogowanie(db, { login: 'ewa', usluga: 'oms', ip: '192.168.0.7', wynik: 'zle-haslo' });
    dopiszLogowanie(db, { login: 'ewa', usluga: 'oms', ip: '192.168.0.7', wynik: 'udane' });
    const wpisy = ostatnieLogowania(db, 10);
    expect(wpisy).toHaveLength(2);
    expect(wpisy.map((w) => w.wynik)).toContain('zle-haslo');
  });

  it('oddaje NAJNOWSZE najpierw i szanuje limit', () => {
    const db = swiezaBaza();
    for (let i = 0; i < 5; i += 1) {
      dopiszLogowanie(db, { login: `k${i}`, usluga: 'oms', ip: '::1', wynik: 'udane' });
    }
    const wpisy = ostatnieLogowania(db, 2);
    expect(wpisy).toHaveLength(2);
    expect(wpisy[0].login).toBe('k4');
  });

  it('listaKont pokazuje date ostatniego UDANEGO logowania', () => {
    const db = swiezaBaza();
    zalozKonto(db, { login: 'ewa', imie: 'A', haslo: 'h', rola: 'sprzedaz', admin: false });
    expect(listaKont(db)[0].ostatnie_logowanie).toBeNull();
    dopiszLogowanie(db, { login: 'ewa', usluga: 'oms', ip: '::1', wynik: 'zle-haslo' });
    expect(listaKont(db)[0].ostatnie_logowanie).toBeNull();
    dopiszLogowanie(db, { login: 'ewa', usluga: 'oms', ip: '::1', wynik: 'udane' });
    expect(listaKont(db)[0].ostatnie_logowanie).not.toBeNull();
  });
});
