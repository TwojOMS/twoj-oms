import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// UKLAD ZAKLADKI /przesylki — trzy zgloszenia właściciela z 18.09.2026:
//  1. zmiana filtra WYRZUCALA ze statusu, na ktorym operator stal (formularz szedl GET-em
//     bez `pokaz`, wiec trasa spadala na domyslne `w_drodze`);
//  2. brak gotowych przedzialow „Ten miesiac" i „Ostatnie 7 dni";
//  3. ostatnia kolumna bez naglowka, a slowo „nadana" powtorzone w KAZDYM wierszu.
//
// ⚠️ Osobny plik od przesylki-filtry.test.js: tamten pilnuje ZAWEZANIA zbioru, ten UKLADU
// i nawigacji. Mieszanie ich konczy sie testem, ktory czerwienieje od zmiany po drugiej
// stronie ekranu.

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = (nr) => ({
  zrodlo_id: nr,
  numer: `Z-${nr}`,
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' },
  dostawa: {},
  metoda_wysylki: 'dpd',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: null,
  kwota_brutto: '50.00',
  status_woo: 'processing',
  oplacone_at: null,
  anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z',
  pozycje: [],
});

function nadana(db, zamowienieId, kurier, numer, { status = null, statusAt = null, utworzona } = {}) {
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run(utworzona, p.id);
  if (status) zapiszStatusDpd(db, p.id, { opis: status, at: statusAt });
  return p.id;
}

let db; let app;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Czwartek 27.08.2026, 12:00 czasu warszawskiego.
  vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
  db = openOmsDb(':memory:');

  const id1 = zapiszZamowienie(db, 'pro', zmapowane(1), {});
  nadana(db, id1, 'dpd', 'DPD-21', { utworzona: '2026-08-21T10:00:00.000Z' });

  const id2 = zapiszZamowienie(db, 'pro', zmapowane(2), {});
  nadana(db, id2, 'dpd', 'DORECZONA', {
    status: 'Przesyłka doręczona', statusAt: '2026-08-22T12:00:00.000', utworzona: '2026-08-22T08:00:00.000Z',
  });

  const id3 = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(3), {});
  nadana(db, id3, 'allegro_wza', 'WZA-25', { utworzona: '2026-08-24T23:30:00.000Z' });

  app = buildOmsServer({ db, config: CONFIG });
});

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });

// ⚠️⚠️ WYCINAMY SAM FORMULARZ FILTROW — i to nie jest ozdoba testu. Pierwsza wersja
// asertowala `<input type="hidden" name="pokaz" …>` na CALYM body i przechodzila na zielono
// PRZED zmiana w kodzie, bo dokladnie takie pole stoi juz w formularzach „Ukryj"
// i „Przywroc" przy kazdym wierszu. Test mierzylby wiec cudzy element i nie zauwazylby,
// ze formularz filtrow dalej gubi status.
function formularzFiltrow(body) {
  const start = body.indexOf('<form class="filtry"');
  if (start === -1) return '';
  const koniec = body.indexOf('</form>', start);
  return body.slice(start, koniec === -1 ? undefined : koniec);
}

describe('zmiana filtra nie wyrzuca ze statusu', () => {
  // ⚠️ To jest CALE zgloszenie nr 1: operator stoi na „Doręczone", zmienia przewoznika
  // i ma zostac na „Doręczone". Formularz idzie GET-em, wiec stan chipu musi jechac
  // ukrytym polem — inaczej trasa nie ma skad go wziac i podstawia domyslny.
  it('formularz filtrow niesie wybrany status ukrytym polem', async () => {
    const r = await pobierz('/przesylki?pokaz=doreczone');
    expect(formularzFiltrow(r.body)).toContain('name="pokaz" value="doreczone"');
  });

  it('niesie status takze wtedy, gdy zaden filtr nie jest ustawiony', async () => {
    const r = await pobierz('/przesylki?pokaz=ukryte');
    expect(formularzFiltrow(r.body)).toContain('name="pokaz" value="ukryte"');
  });

  it('domyslny widok niesie utworzone, a nie pusta wartosc', async () => {
    const r = await pobierz('/przesylki');
    expect(formularzFiltrow(r.body)).toContain('name="pokaz" value="utworzone"');
  });
});

describe('gotowe przedzialy dat', () => {
  // ⚠️ Daty liczone po WARSZAWSKU, tak jak caly filtr (niezmiennik 4.104). Zegar testu
  // stoi na 27.08.2026 12:00 CEST.
  it('„Ten miesiac" ustawia zakres od pierwszego dnia miesiaca do dzis', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(r.body).toContain('od=2026-08-01&amp;do=2026-08-27');
  });

  it('„Ostatnie 7 dni" obejmuje dzis i szesc dni wstecz', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(r.body).toContain('od=2026-08-21&amp;do=2026-08-27');
  });

  it('skroty zachowuja wybrany status', async () => {
    const r = await pobierz('/przesylki?pokaz=doreczone');
    expect(r.body).toContain('pokaz=doreczone&amp;od=2026-08-01');
  });

  it('skroty zachowuja pozostale filtry, a nie kasuja ich', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd');
    expect(r.body).toContain('od=2026-08-01&amp;do=2026-08-27&amp;kurier=dpd');
  });

  it('skrot faktycznie zaweza liste po przejsciu', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-21&do=2026-08-27');
    expect(r.body).toContain('DPD-21');
    expect(r.body).toContain('WZA-25');
  });
});

describe('kolumna daty nadania', () => {
  it('ma wlasny naglowek', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(r.body).toContain('<th>Nadana</th>');
  });

  it('nie powtarza slowa „nadana" w kazdym wierszu', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    // Sama data, bez prefiksu. Klasa `pastylka--etap-nadana` zostaje i to nie kolizja.
    expect(r.body).not.toContain('nadana 2026-08');
  });

  it('data nadania nadal jest w wierszu', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie');
    expect(r.body).toContain('2026-08-21 12:00');
  });
});
