// PRZ-108.06 (zmiana A planu automatyzacji, właściciel 21.10): ekran Ustawienia → Automatyzacje (tylko admin) i przeniesiony
// na niego formularz automatu wysyłki do KSeF. Logika automatu bez zmian — przenosi się ekran i adres zapisu; stary
// adres zapisu (`/ustawienia/integracje/infakt/ksef-automat`) dalej zapisuje, ale wraca na nowy ekran.
// Prawdziwy serwer i moduły, inFakt niepodłączony — żadne żądanie nie wychodzi z procesu.
// Wzór: tests/moduly/faktury/ksef-automat-trasy.test.js (stamtąd przeniesione testy formularza).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';
import { nowyPanel, jako, get, post, POLLER, CONFIG } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wczytajAutomatKsef } from '../../../src/moduly/faktury/db/ksef-automat.js';

const EKRAN = '/ustawienia/automatyzacje';
const ZAPIS = `${EKRAN}/ksef`;
const STARY_ZAPIS = '/ustawienia/integracje/infakt/ksef-automat';
const INFAKT = '/ustawienia/integracje/infakt';
const PO_ZAPISIE = `${EKRAN}?zapisano=ksef-automat#ksef-automat`;

const otwarte = [];
function panel({ demo = null } = {}) {
  const p = demo
    ? (() => { const db = openOmsDb(':memory:'); return { db, app: buildOmsServer({ poller: POLLER, db, config: { auth: { ...CONFIG.auth }, demo } }) }; })()
    : nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  // Konto z Ustawieniami, ale bez admina — od PRZ-108.06 nie zapisze automatu KSeF (dawniej mogło).
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'faktury', 'ustawienia']);
  zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ola').id, ['zamowienia', 'faktury']);
  const wynik = { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa'), ola: jako(p.db, 'ola') };
  otwarte.push(wynik);
  return wynik;
}
const sekcja = (html, id) => new RegExp(`<section class="ust-sekcja[^"]*" id="${id}">[\\s\\S]*?<\\/section>`, 'u').exec(html)?.[0] ?? '';
const akcjaFormularza = (html) => /<form id="ksef-automat-formularz"[^>]*action="([^"]+)"/u.exec(html)?.[1];

afterEach(async () => {
  vi.useRealTimers();
  for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); }
});

describe('PRZ-108.06 ekran Ustawienia → Automatyzacje', () => {
  it('admin: 200, tytuł z menu, automaty systemowe — KSeF (domyślnie wyłączony) i autoodpowiedź Allegro', async () => {
    const p = panel();
    const r = await get(p.app, EKRAN, p.admin);
    expect(r.statusCode).toBe(200);
    // PRZ-108.11 (decyzja właściciela 22.10): przy tytule plakietka BETA.
    expect(r.body).toContain('<div class="tytul-z-plakietka"><h1>Automatyzacje</h1><span class="menu-ustawien-beta">BETA</span></div>');
    expect(r.body).toContain('<title>Automatyzacje</title>');
    expect(r.body).toContain('Automaty systemowe');
    const ksef = sekcja(r.body, 'ksef-automat');
    expect(ksef).toContain('Automatyczna wysyłka do KSeF');
    // PRZ-108.11 (decyzja właściciela 22.10): akapit o „zaznacz wszystkie” usunięty z kafla.
    expect(ksef).not.toContain('zaznacz wszystkie');
    expect(ksef).toContain('nie da się cofnąć');
    expect(ksef).toContain('inFakt nie jest podłączony');
    expect(ksef).toContain('name="godzina"');
    expect(ksef).toContain('value="20:00"');
    expect(ksef).not.toMatch(/name="wlaczony" value="1"[^>]*checked/u);
    expect(akcjaFormularza(r.body)).toBe(ZAPIS);
    const auto = sekcja(r.body, 'autoodpowiedz');
    expect(auto).toContain('Autoodpowiedź Allegro');
    expect(auto).toContain('Wyłączona');
    expect(auto).toContain('href="/ustawienia/wiadomosci-i-automatyzacje"');
    // PRZ-108.08 (C1): rejestr zdarzeń nie jest już pusty — sekcja reguł z przyciskiem dodawania (zmiana zachowania).
    expect(r.body).toContain('Dodaj automatyzację');
    expect(r.body).toContain(`${EKRAN}/nowa`);
  });

  it('autoodpowiedź włączona w Ustawieniach → wiersz mówi „Włączona”', async () => {
    const p = panel();
    p.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('formulka.wlaczona', '1', '2026-10-21')").run();
    const r = await get(p.app, EKRAN, p.admin);
    expect(sekcja(r.body, 'autoodpowiedz')).toContain('Włączona');
  });

  it('konto z „ustawienia” bez admina → 403 na ekran i na zapis; konto bez „ustawienia” → 403', async () => {
    const p = panel();
    expect((await get(p.app, EKRAN, p.ewa)).statusCode).toBe(403);
    expect((await post(p.app, ZAPIS, p.ewa, { wlaczony: ['0', '1'], godzina: '20:00' })).statusCode).toBe(403);
    expect((await get(p.app, EKRAN, p.ola)).statusCode).toBe(403);
    expect((await post(p.app, ZAPIS, p.ola, { wlaczony: ['0', '1'], godzina: '20:00' })).statusCode).toBe(403);
    expect(wczytajAutomatKsef(p.db)).toMatchObject({ wlaczony: false, zmienil: null });
  });

  it('gość demo ogląda ekran (200), zapisu nie zrobi (403)', async () => {
    const p = panel({ demo: { login: 'demo', haslo: 'demo', reset: 'co 60 minut', resetPlanowy: null, resetGodzina: null } });
    zalozKonto(p.db, { login: 'demo', imie: 'Gość', haslo: 'demo', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'demo').id, [...ekranyRoli('sprzedaz'), 'ustawienia']);
    const gosc = jako(p.db, 'demo');
    const r = await get(p.app, EKRAN, gosc);
    expect(r.statusCode).toBe(200);
    expect(sekcja(r.body, 'ksef-automat')).toContain('Automatyczna wysyłka do KSeF');
    expect((await post(p.app, ZAPIS, gosc, { wlaczony: ['0', '1'], godzina: '20:00' })).statusCode).toBe(403);
    expect(wczytajAutomatKsef(p.db).wlaczony).toBe(false);
  });

  it('admin zapisuje z formularza ekranu: 303 na nowy ekran, wartości w tabeli ustawień, wyłączenie samym polem ukrytym', async () => {
    const p = panel();
    const akcja = akcjaFormularza((await get(p.app, EKRAN, p.admin)).body);
    const r = await post(p.app, akcja, p.admin, { wlaczony: ['0', '1'], godzina: '20:00' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(PO_ZAPISIE);
    expect(wczytajAutomatKsef(p.db)).toMatchObject({ wlaczony: true, godzina: '20:00', zmienil: { login: 'adam' } });
    const ekran = await get(p.app, r.headers.location, p.admin);
    expect(ekran.body).toContain('Zapisano ustawienia automatycznej wysyłki do KSeF.');
    expect(sekcja(ekran.body, 'ksef-automat')).toMatch(/name="wlaczony" value="1"[^>]*checked/u);
    const w = await post(p.app, ZAPIS, p.admin, { wlaczony: '0', godzina: '20:00' });
    expect(w.statusCode).toBe(303);
    expect(wczytajAutomatKsef(p.db).wlaczony).toBe(false);
  });

  it.each([['25:00', '1'], ['8:00', '1'], ['', '1'], ['20:00', 'tak'], ['23:59', '1'], ['23:46', '1']])('zła godzina %j / przełącznik %j → 400 z ekranem, nic nie zapisane', async (godzina, wlaczony) => {
    const p = panel();
    const r = await post(p.app, ZAPIS, p.admin, { wlaczony, godzina });
    expect(r.statusCode).toBe(400);
    // PRZ-108.11 (decyzja właściciela 22.10): przy tytule plakietka BETA.
    expect(r.body).toContain('<div class="tytul-z-plakietka"><h1>Automatyzacje</h1><span class="menu-ustawien-beta">BETA</span></div>');
    expect(sekcja(r.body, 'ksef-automat')).toContain('Nie zapisano');
    expect(wczytajAutomatKsef(p.db)).toMatchObject({ wlaczony: false, godzina: '20:00', zmienil: null });
  });

  it('włączenie o 21:30 z godziną 20:00 nie wysyła dziś — ekran mówi „jutro o 20:00”', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T19:30:00Z'));
    const p = panel();
    const r = await post(p.app, ZAPIS, p.admin, { wlaczony: ['0', '1'], godzina: '20:00' });
    expect(r.statusCode).toBe(303);
    expect(wczytajAutomatKsef(p.db).ostatniPrzebieg).toBe('2026-10-20');
    expect((await get(p.app, EKRAN, p.admin)).body).toContain('jutro o 20:00');
  });
});

describe('PRZ-108.06 stary adres zapisu automatu KSeF', () => {
  it('admin: zapis działa, 303 na ekran Automatyzacji', async () => {
    const p = panel();
    const r = await post(p.app, STARY_ZAPIS, p.admin, { wlaczony: ['0', '1'], godzina: '21:15' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(PO_ZAPISIE);
    expect(wczytajAutomatKsef(p.db)).toMatchObject({ wlaczony: true, godzina: '21:15', zmienil: { login: 'adam' } });
  });

  it('konto z „ustawienia” bez admina → 403, w bazie nic', async () => {
    const p = panel();
    const r = await post(p.app, STARY_ZAPIS, p.ewa, { wlaczony: ['0', '1'], godzina: '20:00' });
    expect(r.statusCode).toBe(403);
    expect(wczytajAutomatKsef(p.db)).toMatchObject({ wlaczony: false, zmienil: null });
  });

  it('błąd formularza → 400 z ekranem Automatyzacji (menu podświetla Automatyzacje)', async () => {
    const p = panel();
    const r = await post(p.app, STARY_ZAPIS, p.admin, { wlaczony: '1', godzina: '25:00' });
    expect(r.statusCode).toBe(400);
    // PRZ-108.11 (decyzja właściciela 22.10): przy tytule plakietka BETA.
    expect(r.body).toContain('<div class="tytul-z-plakietka"><h1>Automatyzacje</h1><span class="menu-ustawien-beta">BETA</span></div>');
    expect(sekcja(r.body, 'ksef-automat')).toContain('Nie zapisano');
    expect(r.body).toMatch(/<li class="aktywna">\s*<a href="\/ustawienia\/automatyzacje"/u);
    expect(wczytajAutomatKsef(p.db).zmienil).toBeNull();
  });
});

describe('PRZ-108.06 ekran inFaktu po przeniesieniu automatu', () => {
  it('admin: bez formularza automatu, ze stanem i odnośnikiem do Automatyzacji; faktury konsumenckie zostają', async () => {
    const p = panel();
    const r = await get(p.app, INFAKT, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('id="ksef-automat-formularz"');
    expect(r.body).not.toContain(STARY_ZAPIS);
    expect(r.body).toContain('id="ksef-konsumenckie"');
    const kafel = sekcja(r.body, 'ksef-automat');
    expect(kafel).toContain('Automatyczna wysyłka do KSeF');
    expect(kafel).toContain('Wyłączona');
    expect(kafel).toContain(`href="${EKRAN}#ksef-automat"`);
    expect(kafel).toContain('Ustawienia → Automatyzacje');
  });

  it('po włączeniu kafel inFaktu mówi „Włączona” i kiedy najbliższy przebieg', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const p = panel();
    await post(p.app, ZAPIS, p.admin, { wlaczony: ['0', '1'], godzina: '20:00' });
    const kafel = sekcja((await get(p.app, INFAKT, p.admin)).body, 'ksef-automat');
    expect(kafel).toContain('Włączona');
    expect(kafel).toContain('dziś o 20:00');
  });

  it('konto z „ustawienia” bez admina: stan widzi, odnośnika nie — „ustawia administrator”', async () => {
    const p = panel();
    const r = await get(p.app, INFAKT, p.ewa);
    expect(r.statusCode).toBe(200);
    const kafel = sekcja(r.body, 'ksef-automat');
    expect(kafel).toContain('Wyłączona');
    expect(kafel).not.toContain(`href="${EKRAN}`);
    expect(kafel).toContain('ustawia administrator');
  });
});
