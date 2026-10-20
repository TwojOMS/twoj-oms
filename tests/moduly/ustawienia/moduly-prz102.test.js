import { afterEach, describe, expect, it } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const panele = [];
function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'pracownik', imie: 'Pracownik', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'pracownik').id, ['ustawienia', 'klienci', 'okresy']);
  return { ...p, admin: jako(p.db, 'admin'), pracownik: jako(p.db, 'pracownik') };
}
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });
const przelacz = (p, modul, wlacz = '0', kto = p.admin) => post(p.app, '/ustawienia/moduly', kto, { modul, wlacz });
function zapis(db, wartosc) {
  db.prepare("INSERT OR REPLACE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('moduly.wylaczone', ?, '2026-10-20')").run(wartosc);
}
function klient(db, zbiorczo = 1) {
  db.prepare("INSERT INTO klienci (klucz,nazwa,nip,rozliczenie_zbiorcze,rabat_procent,utworzone_at,zmienione_at) VALUES ('przyklad','Pracownia Przykładowa','1234567890',?,10,'2026-10-01','2026-10-01')").run(zbiorczo);
}

describe('PRZ-102.02 wyłączanie modułów', () => {
  it('admin widzi dwa włączone moduły, wyłącza klientow bez restartu i włącza ponownie', async () => {
    const p = panel();
    const ekran = await get(p.app, '/ustawienia/moduly', p.admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('Wyłącz Stali klienci');
    expect(ekran.body).toContain('Wyłącz Rozliczenia');
    expect((await przelacz(p, 'klienci')).statusCode).toBe(303);
    expect(JSON.parse(p.db.prepare("SELECT wartosc FROM ustawienia WHERE klucz='moduly.wylaczone'").get().wartosc)).toEqual(['klienci']);
    const menu = await get(p.app, '/', p.admin);
    expect(menu.body).not.toContain('href="/klienci"');
    const odmowa = await get(p.app, '/klienci?nowy', p.admin);
    expect(odmowa.statusCode).toBe(404);
    expect(odmowa.body).toContain('Moduł wyłączony');
    expect(odmowa.body).toContain('href="/ustawienia/moduly"');
    const inny = await get(p.app, '/klienci/1/edytuj', p.pracownik);
    expect(inny.statusCode).toBe(404);
    expect(inny.body).not.toContain('href="/ustawienia/moduly"');
    expect((await przelacz(p, 'klienci', '1')).statusCode).toBe(303);
    expect((await get(p.app, '/klienci', p.admin)).statusCode).toBe(200);
    expect((await get(p.app, '/', p.admin)).body).toContain('href="/klienci"');
  });
  it('nie-admin nawet z prawem ustawień nie czyta i nie zapisuje; nieznany klucz odrzucony', async () => {
    const p = panel();
    expect((await get(p.app, '/ustawienia/moduly', p.pracownik)).statusCode).toBe(403);
    expect((await przelacz(p, 'klienci', '0', p.pracownik)).statusCode).toBe(403);
    for (const klucz of ['zamowienia', 'ustawienia', 'obcy']) expect((await przelacz(p, klucz)).statusCode).toBe(400);
    expect((await przelacz(p, 'klienci', 'tak')).statusCode).toBe(400);
    expect(p.db.prepare("SELECT * FROM ustawienia WHERE klucz='moduly.wylaczone'").get()).toBeUndefined();
  });
  it('odmawia wyłączenia obu ekranów przy kliencie rozliczanym zbiorczo', async () => {
    const p = panel(); klient(p.db);
    for (const modul of ['klienci', 'okresy']) {
      const r = await przelacz(p, modul);
      expect(r.statusCode).toBe(409);
      expect(r.body).toContain('1 stałych klientów z rozliczeniem zbiorczym');
    }
    expect(p.db.prepare("SELECT * FROM ustawienia WHERE klucz='moduly.wylaczone'").get()).toBeUndefined();
  });
  it('odmawia wyłączenia rozliczeń przy okresie z zamówieniami bez faktury, także zamkniętym', async () => {
    const p = panel();
    const id = p.db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz,rok,miesiac,stan,utworzony_at) VALUES ('dawny',2026,10,'zamkniety','2026-10-01')").run().lastInsertRowid;
    p.db.prepare("INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,okres_rozliczeniowy_id) VALUES ('reczne',1,'DEMO/1','10.00','2026-10-01',?)").run(id);
    const r = await przelacz(p, 'okresy');
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('1 okresów z zamówieniami bez zakończonej faktury');
    // Karta klienta jest jedyną drogą do uzupełnienia nabywcy/umowy starego okresu.
    expect((await przelacz(p, 'klienci')).statusCode).toBe(409);
    for (const status of ['w_toku', 'do_wyjasnienia']) {
      p.db.prepare('UPDATE okresy_rozliczeniowe SET ksef_status=?').run(status);
      expect((await przelacz(p, 'okresy')).statusCode).toBe(409);
    }
    expect(p.db.prepare("SELECT * FROM ustawienia WHERE klucz='moduly.wylaczone'").get()).toBeUndefined();
    p.db.prepare("UPDATE okresy_rozliczeniowe SET stan='zafakturowany', numer='DEMO/1', infakt_uuid='demo-uuid', ksef_status=NULL").run();
    expect((await przelacz(p, 'okresy')).statusCode).toBe(409);
  });
  it.each([
    ['niedopłata', '0.00', true, 409],
    ['pokryte', '1230.00', true, 303],
    ['nadpłata', '1230.01', true, 409],
    ['zaliczka bez zamówień', '100.00', false, 409],
    ['uszkodzona wpłata', 'nieznana', true, 409],
    ['uszkodzona zaliczka bez zamówień', 'nieznana', false, 409],
  ])('saldo okresu: %s — sprawdza oba przełączniki', async (_opis, kwota, maZamowienia, kod) => {
    const p = panel();
    const id = p.db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz,rok,miesiac,stan,utworzony_at,numer,infakt_uuid) VALUES ('dawny',2026,10,'zafakturowany','2026-10-01','DEMO/1','demo-uuid')").run().lastInsertRowid;
    if (!maZamowienia) p.db.prepare("UPDATE okresy_rozliczeniowe SET stan='otwarty', numer=NULL, infakt_uuid=NULL WHERE id=?").run(id);
    if (maZamowienia) {
      p.db.prepare("INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,okres_rozliczeniowy_id) VALUES ('reczne',1,'DEMO/1','1230.00','2026-10-01',?)").run(id);
      // Jak na ekranie okresu: ręcznie anulowane zamówienie nie zwiększa należności.
      p.db.prepare("INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,okres_rozliczeniowy_id,anulowane_recznie) VALUES ('reczne',2,'DEMO/2','500.00','2026-10-01',?,1)").run(id);
    }
    p.db.prepare("INSERT INTO platnosci_okresu (okres_rozliczeniowy_id,kwota,metoda,zrodlo,utworzona_at) VALUES (?,?,'przelew','reczna','2026-10-02')").run(id, kwota);
    for (const modul of ['klienci', 'okresy']) {
      const r = await przelacz(p, modul);
      expect(r.statusCode, r.body).toBe(kod);
      if (kod === 409) {
        expect(r.body).toContain('1 okresów z nierozliczonymi wpłatami albo niedopłatą — rozlicz je w Rozliczeniach');
        if (kwota === 'nieznana') expect(r.body).toContain('nie można odczytać kwoty');
      }
    }
    if (kod === 409) expect(p.db.prepare("SELECT * FROM ustawienia WHERE klucz='moduly.wylaczone'").get()).toBeUndefined();
    // Włączenie pozostaje możliwe także wtedy, gdy wpłata jest uszkodzona.
    expect((await przelacz(p, 'okresy', '1')).statusCode).toBe(303);
  });
  it('pusty okres nie blokuje; wyłączone Rozliczenia blokują GET i POST przed trasą', async () => {
    const p = panel();
    p.db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz,rok,miesiac,stan,utworzony_at) VALUES ('dawny',2026,10,'otwarty','2026-10-01')").run();
    expect((await przelacz(p, 'okresy')).statusCode).toBe(303);
    for (const r of [await get(p.app, '/okresy', p.admin), await post(p.app, '/okresy/1/zamknij', p.admin)]) {
      expect(r.statusCode).toBe(404); expect(r.body).toContain('Moduł wyłączony');
    }
    expect(p.db.prepare('SELECT stan FROM okresy_rozliczeniowe').get().stan).toBe('otwarty');
    await przelacz(p, 'okresy', '1');
    expect((await get(p.app, '/okresy', p.admin)).statusCode).toBe(200);
  });
  it('rabaty zostają, a ekran ról objaśnia wyłączony moduł', async () => {
    const p = panel(); klient(p.db, 0);
    expect((await przelacz(p, 'klienci')).statusCode).toBe(303);
    expect((await get(p.app, '/ustawienia/moduly', p.admin)).body).toContain('1 stałych klientów z rabatem — rabaty nadal działają, edycja po włączeniu modułu');
    expect(p.db.prepare('SELECT rabat_procent FROM klienci').get().rabat_procent).toBe(10);
    expect((await get(p.app, '/ustawienia/role', p.admin)).body).toContain('Stali klienci (moduł wyłączony)');
  });
  it('po wyłączeniu Rozliczeń nowa umowa zbiorcza wymaga ponownego włączenia modułu', async () => {
    const p = panel();
    await przelacz(p, 'okresy');
    const r = await post(p.app, '/klienci', p.admin, {
      nazwa: 'Pracownia Przykładowa', nip: '1234567890', rozliczenie_zbiorcze: 'on',
      prog_darmowej_dostawy: '100', oplata_obslugi: '10', oplata_kurierska: '20',
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Włącz Rozliczenia w Ustawieniach → Moduły');
    expect(p.db.prepare('SELECT COUNT(*) AS n FROM klienci').get().n).toBe(0);
  });
  it.each([null, '', '{zepsute', '{}', '["zamowienia"]', '["klienci",5]'])('pusty/uszkodzony zapis %s niczego nie wyłącza', async wartosc => {
    const p = panel(); if (wartosc !== null) zapis(p.db, wartosc);
    expect((await get(p.app, '/klienci', p.admin)).statusCode).toBe(200);
    expect((await get(p.app, '/okresy', p.admin)).statusCode).toBe(200);
  });
});
