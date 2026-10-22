// PRZ-102.12 — ekran automatu wysyłki do KSeF (Ustawienia → Integracje → inFakt), wynik ostatniego przebiegu
// i wiersz na stronie głównej. Prawdziwy serwer i prawdziwe moduły, konta z rolami; inFakt niepodłączony
// (ekran ma wtedy powiedzieć, że automat nic nie wyśle) — żadne żądanie nie wychodzi z procesu.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';
import { wczytajAutomatKsef, zapiszWynikAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';

const ADRES = '/ustawienia/integracje/infakt';

function panel() {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  const p = nowyPanel({ moduly });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'faktury']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

afterEach(() => { vi.useRealTimers(); });

it('PRZ-102.26: ustawienie B2C domyślnie wyłączone, zapis firmowy i 403 bez prawa do Ustawień', async () => {
  const p = panel();
  const url = `${ADRES}/ksef-konsumenckie`;
  try {
    const r = await get(p.app, ADRES, p.admin);
    expect(r.body).toContain('Wysyłaj do KSeF także faktury konsumenckie (nabywca bez NIP-u)');
    expect(r.body).toContain('Klient bez dostępu do KSeF dostaje wydruk z kodem QR.');
    expect(r.body).not.toMatch(/id="ksef-konsumenckie-wlaczone"[^>]*checked/);
    expect((await post(p.app, url, p.ewa, { wlaczony: '1' })).statusCode).toBe(403);
    expect(p.db.prepare("SELECT * FROM ustawienia WHERE klucz = 'ksef.konsumenckie'").get()).toBeUndefined();
    expect((await post(p.app, url, p.admin, { wlaczony: ['0', '1'] })).statusCode).toBe(303);
    expect(p.db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'ksef.konsumenckie'").get().wartosc).toBe('1');
    expect((await post(p.app, url, p.admin, { wlaczony: 'true' })).statusCode).toBe(400);
    expect(p.db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'ksef.konsumenckie'").get().wartosc).toBe('1');
    expect((await get(p.app, ADRES, p.admin)).body).toMatch(/id="ksef-konsumenckie-wlaczone"[^>]*checked/);
    expect((await post(p.app, url, p.admin, { wlaczony: '0' })).statusCode).toBe(303);
    expect(p.db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'ksef.konsumenckie'").get().wartosc).toBe('0');
  } finally { await p.app.close(); p.db.close(); }
});

// PRZ-108.06: formularz automatu (przełącznik, godzina, złe wejścia, „jutro o 20:00”) przeniesiony na ekran
// Ustawienia → Automatyzacje — jego testy są w tests/moduly/automatyzacje/ekran-ksef.test.js (tam też stary adres
// zapisu i kafel stanu na ekranie inFaktu). Zmiana zachowania: zapis tylko dla admina (dawniej każde konto z „ustawienia”).

describe('PRZ-102.12 wynik ostatniego przebiegu', () => {
  const wynik = {
    dzien: '2026-10-20', startAt: '2026-10-20T18:01:00.000Z', koniecAt: '2026-10-20T18:01:05.000Z', stan: 'blad',
    wyslane: [{ uuid: 'A', numer: 'A/10/2026' }], niepewne: [{ uuid: 'B', numer: 'B/10/2026' }], pominiete: [],
    poZasadzie: [{ numer: 'D/10/2026', powod: 'Korekty wysyła się w inFakcie — panel ich nie wysyła.' }],
    blad: 'inFakt nie odpowiedział w 30 s',
  };

  it('/faktury/ksef/automat pokazuje, co poszło, co niepewne i co z zasady nie leci (konto z „faktury”)', async () => {
    const p = panel();
    zapiszWynikAutomatu(p.db, wynik);
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('A/10/2026');
    expect(r.body).toContain('B/10/2026');
    expect(r.body).toContain('NIE WIADOMO');
    expect(r.body).toContain('D/10/2026');
    expect(r.body).toContain('inFakt nie odpowiedział w 30 s');
    expect(r.body).toContain('automat KSeF');
  });

  // Poprawka po drugiej recenzji: przerwany/trwający przebieg z pustymi listami nie jest „nic do wysłania”.
  it.each([
    ['przerwany', { uuid: 'A', numer: 'A/10/2026' }, 'sprawdź w inFakcie'],
    ['trwa', { uuid: 'A', numer: 'A/10/2026' }, 'Przebieg trwa — odśwież za chwilę'],
    ['trwa', null, 'Przebieg trwa — odśwież za chwilę'],
  ])('wynik „%s” (w trakcie: %j) z pustymi listami — bez zdania „nie znalazł nic do wysłania”', async (stan, wTrakcie, oczekiwane) => {
    const p = panel();
    zapiszWynikAutomatu(p.db, { dzien: '2026-10-20', startAt: '2026-10-20T18:01:00.000Z', koniecAt: null, stan, wTrakcie,
      wyslane: [], niepewne: [], pominiete: [], poZasadzie: [], wstrzymane: [], blad: null });
    const r = await get(p.app, '/faktury/ksef/automat', p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('nie znalazł nic do wysłania');
    expect(r.body.toLowerCase()).toContain(oczekiwane.toLowerCase());
  });

  it('bez żadnego przebiegu — ekran mówi, że automat jeszcze nie działał', async () => {
    const p = panel();
    const r = await get(p.app, '/faktury/ksef/automat', p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Automat jeszcze ani razu nie wysyłał');
  });

  it('wstrzymana faktura: ekran wyniku mówi, co zrobić, a „Zwolnij” (konto z „faktury”) zdejmuje wstrzymanie', async () => {
    const p = panel();
    p.db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run('ksef.automat.wstrzymane',
      JSON.stringify([{ uuid: 'B', numer: 'B/10/2026', dzien: '2026-10-20', powod: 'inFakt odrzucił (422): brak adresu' }]), '2026-10-20T18:01:00.000Z');
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.body).toContain('Faktura B/10/2026 wstrzymana — automat jej nie wyśle');
    expect(r.body).toContain('action="/faktury/ksef/automat/zwolnij"');
    const g = await get(p.app, '/', p.admin);
    expect(g.body).toContain('Faktura B/10/2026 wstrzymana');
    const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid: 'B' });
    expect(z.statusCode).toBe(303);
    expect(wczytajAutomatKsef(p.db).wstrzymane).toEqual([]);
  });

  it('strona główna: wiersz ostrzeżenia przy błędzie automatu, z przyciskiem do wyniku', async () => {
    const p = panel();
    zapiszWynikAutomatu(p.db, wynik);
    const r = await get(p.app, '/', p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Automat KSeF');
    expect(r.body).toContain('href="/faktury/ksef/automat"');
  });
});
