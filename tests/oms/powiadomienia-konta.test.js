import { it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { MODULY } from '../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../src/core/sprawdz-moduly.ts';
import {
  powiadomieniaKonta,
  oznaczPrzeczytane,
  oznaczWszystkiePrzeczytane,
  ukryteTypyKonta,
  zapiszUkryteTypy,
} from '../../src/oms/db/powiadomienia.js';
import { odrzuc } from '../../src/oms/db/ostrzezenia.js';

// Jeden odczyt dla dzwonka, strony i pasa: migawka firmy zawężona do tego, co widzi konto, z przeczytaniami
// tego konta i wspólnym dla firmy „Ignoruj”.

const T0 = '2026-11-18T10:00:00.000Z';
const teraz = new Date('2026-11-18T12:00:00.000Z');
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});

function baza() {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  bazy.push(db);
  const wstaw = db.prepare(
    `INSERT INTO powiadomienia (klucz, typ, tekst, href, etykieta_przycisku, etykieta_odrzucenia, pilne,
      pierwszy_raz_at, ostatnio_at, rozwiazane_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const wiersz = (klucz, typ, href, { pilne = 0, rozwiazane = null, ostatnio = T0, odrzucenie = 'Ignoruj' } = {}) =>
    wstaw.run(klucz, typ, `Sprawa ${klucz}`, href, href ? 'Pokaż' : null, odrzucenie, pilne, T0, ostatnio, rozwiazane);
  wiersz('kanal:allegro_polcien:pilne', 'kanal', '/ustawienia/integracje', { pilne: 1, odrzucenie: null });
  wiersz('integracja:poller:sklep', 'integracja', '/ustawienia/lacznosc', { pilne: 1, odrzucenie: 'Wycisz na 24 h' });
  wiersz('automatyzacja:wstrzymana:1:x', 'automatyzacja', '/ustawienia/automatyzacje/1');
  wiersz('faktura-ksef:FV-1', 'faktura-ksef', '/faktury');
  wiersz('przesylka:p1:x', 'przesylka', '/zamowienia/1', { ostatnio: '2026-11-18T11:00:00.000Z' });
  wiersz('niski-stan:7:0', 'niski-stan', '/magazyn?stan=niski');
  wiersz('pobranie:z1', 'pobranie-korekta', '/zamowienia/2', { rozwiazane: '2026-11-18T09:00:00.000Z' });
  return db;
}
const konto = (id, ekrany, admin = false) => ({ id, admin, uprawnienia: new Set(ekrany) });
const sprzedawca = konto(2, ['zamowienia']);
const magazynier = konto(3, ['zamowienia', 'magazyn']);
const admin = konto(1, [], true);
const klucze = (lista) => lista.map((w) => w.klucz);

it('konto bez magazynu nie widzi niskiego stanu, a nie-admin nie widzi automatyzacji', () => {
  const db = baza();
  const s = powiadomieniaKonta(db, sprzedawca, { teraz });
  expect(klucze(s.aktualne)).not.toContain('niski-stan:7:0');
  expect(klucze(s.aktualne)).not.toContain('automatyzacja:wstrzymana:1:x');
  // Prawo do ekranu przycisku: KSeF prowadzi do /faktury, których sprzedawca nie ma.
  expect(klucze(s.aktualne)).not.toContain('faktura-ksef:FV-1');
  expect(klucze(powiadomieniaKonta(db, magazynier, { teraz }).aktualne)).toContain('niski-stan:7:0');
  // Prawo do Ustawień nie wystarcza — automatyzacje widzi tylko administrator.
  const zUstawieniami = konto(4, ['zamowienia', 'ustawienia']);
  expect(klucze(powiadomieniaKonta(db, zUstawieniami, { teraz }).aktualne)).toContain('integracja:poller:sklep');
  expect(klucze(powiadomieniaKonta(db, zUstawieniami, { teraz }).aktualne)).not.toContain(
    'automatyzacja:wstrzymana:1:x',
  );
  const a = powiadomieniaKonta(db, admin, { teraz });
  expect(klucze(a.aktualne)).toContain('automatyzacja:wstrzymana:1:x');
  expect(klucze(a.aktualne)).toContain('niski-stan:7:0');
  expect(klucze(a.archiwum)).toEqual(['pobranie:z1']);
  expect(a.archiwum[0]).toMatchObject({ status: 'rozwiazane', statusAt: '2026-11-18T09:00:00.000Z' });
});

it('awarię kanału widzi każde konto; bez prawa do Ustawień zostaje bez przycisku', () => {
  const db = baza();
  const [kanal] = powiadomieniaKonta(db, sprzedawca, { teraz }).aktualne;
  expect(kanal).toMatchObject({ klucz: 'kanal:allegro_polcien:pilne', pilne: true, przycisk: null });
  expect(kanal.etykietaOdrzucenia).toBeNull();
  const [uAdmina] = powiadomieniaKonta(db, admin, { teraz }).aktualne;
  expect(uAdmina.przycisk).toEqual({ href: '/ustawienia/integracje', etykieta: 'Pokaż' });
});

it('przeczytane jednego konta nie gasi licznika drugiego; nieprzeczytane idą pierwsze', () => {
  const db = baza();
  const przed = powiadomieniaKonta(db, magazynier, { teraz });
  expect(przed.nieprzeczytane).toBe(przed.aktualne.length);
  expect(przed.pilne).toBe(1);
  expect(oznaczPrzeczytane(db, magazynier.id, 'kanal:allegro_polcien:pilne', { teraz })).toBe(true);
  const po = powiadomieniaKonta(db, magazynier, { teraz });
  expect(po.nieprzeczytane).toBe(przed.nieprzeczytane - 1);
  // Pilne zostaje pilne bez względu na przeczytanie — czerwony dzwonek mówi o sprawie, nie o kliknięciu.
  expect(po.pilne).toBe(1);
  expect(po.aktualne.at(-1)).toMatchObject({ klucz: 'kanal:allegro_polcien:pilne', przeczytane: true });
  expect(powiadomieniaKonta(db, admin, { teraz }).nieprzeczytane).toBe(
    powiadomieniaKonta(db, admin, { teraz }).aktualne.length,
  );
  // Nieznany klucz nie zostawia śladu.
  expect(oznaczPrzeczytane(db, magazynier.id, 'przesylka:nie-ma', { teraz })).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM powiadomienia_przeczytane').get().n).toBe(1);
});

it('„wszystkie przeczytane” oznacza tylko aktualne widoczne dla konta', () => {
  const db = baza();
  expect(oznaczWszystkiePrzeczytane(db, sprzedawca, { teraz })).toBe(2);
  expect(powiadomieniaKonta(db, sprzedawca, { teraz }).nieprzeczytane).toBe(0);
  const zapisane = db
    .prepare('SELECT klucz FROM powiadomienia_przeczytane WHERE konto_id = ? ORDER BY klucz')
    .all(sprzedawca.id)
    .map((w) => w.klucz);
  // Awaria integracji prowadzi do Ustawień, których sprzedawca nie ma — nie widzi jej, więc jej nie oznacza.
  expect(zapisane).toEqual(['kanal:allegro_polcien:pilne', 'przesylka:p1:x']);
  const a = powiadomieniaKonta(db, admin, { teraz });
  expect(a.nieprzeczytane).toBe(a.aktualne.length);
});

it('„Ignoruj” chowa u obu kont i przenosi do archiwum z nazwą tego, kto kliknął', () => {
  const db = baza();
  odrzuc(db, 'przesylka:p1:x', { kto: 'magazyn-test', kiedy: '2026-11-18T11:30:00.000Z' });
  for (const k of [sprzedawca, magazynier]) {
    const s = powiadomieniaKonta(db, k, { teraz });
    expect(klucze(s.aktualne)).not.toContain('przesylka:p1:x');
    expect(s.archiwum.find((w) => w.klucz === 'przesylka:p1:x')).toMatchObject({
      status: 'zignorowane',
      statusAt: '2026-11-18T11:30:00.000Z',
      statusKto: 'magazyn-test',
    });
  }
});

it('wyciszenie awarii integracji wraca po dobie', () => {
  const db = baza();
  odrzuc(db, 'integracja:poller:sklep', { kto: 'admin-test', kiedy: '2026-11-18T11:00:00.000Z' });
  const wyciszone = powiadomieniaKonta(db, admin, { teraz });
  expect(klucze(wyciszone.aktualne)).not.toContain('integracja:poller:sklep');
  expect(wyciszone.archiwum.find((w) => w.klucz === 'integracja:poller:sklep')).toMatchObject({
    status: 'wyciszone',
    statusAt: '2026-11-19T11:00:00.000Z',
  });
  const poDobie = powiadomieniaKonta(db, admin, { teraz: new Date('2026-11-19T11:00:01.000Z') });
  expect(klucze(poDobie.aktualne)).toContain('integracja:poller:sklep');
});

it('ukryty rodzaj znika z odczytu konta, ale awarii kanału ukryć się nie da', () => {
  const db = baza();
  zapiszUkryteTypy(db, magazynier.id, ['przesylka']);
  expect(() => zapiszUkryteTypy(db, magazynier.id, ['kanal'])).toThrow();
  db.prepare('UPDATE ustawienia SET wartosc = ? WHERE klucz = ?').run(
    '["kanal","przesylka"]',
    `powiadomienia.ukryte.${magazynier.id}`,
  );
  const s = powiadomieniaKonta(db, magazynier, { teraz });
  expect(klucze(s.aktualne)).toContain('kanal:allegro_polcien:pilne');
  expect(klucze(s.aktualne)).not.toContain('przesylka:p1:x');
});

it('zapis z rodzajem, którego już nie ma, zachowuje pozostałe ukrycia konta', () => {
  const db = baza();
  db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run(
    `powiadomienia.ukryte.${magazynier.id}`,
    '["wiadomosc-allegro","przesylka"]',
    T0,
  );
  expect(ukryteTypyKonta(db, magazynier.id)).toEqual(['przesylka']);
  expect(klucze(powiadomieniaKonta(db, magazynier, { teraz }).aktualne)).not.toContain('przesylka:p1:x');
});

it('kolejność aktualnych: nieprzeczytane, w grupie pilne, potem rodzaj', () => {
  const db = baza();
  oznaczPrzeczytane(db, admin.id, 'integracja:poller:sklep', { teraz });
  expect(klucze(powiadomieniaKonta(db, admin, { teraz }).aktualne)).toEqual([
    'kanal:allegro_polcien:pilne',
    'automatyzacja:wstrzymana:1:x',
    'faktura-ksef:FV-1',
    'przesylka:p1:x',
    'niski-stan:7:0',
    'integracja:poller:sklep',
  ]);
});

it('konto bez id (serwisowe) czyta wszystko jako nieprzeczytane i nic nie zapisuje', () => {
  const db = baza();
  const serwis = { id: 0, admin: true, serwisowe: true, uprawnienia: new Set() };
  expect(oznaczPrzeczytane(db, serwis.id, 'kanal:allegro_polcien:pilne', { teraz })).toBe(false);
  expect(oznaczWszystkiePrzeczytane(db, serwis, { teraz })).toBe(0);
  const s = powiadomieniaKonta(db, serwis, { teraz });
  expect(s.nieprzeczytane).toBe(s.aktualne.length);
});
