// PRZ-102.12 — ekran automatu wysyłki do KSeF (Ustawienia → Integracje → inFakt), wynik ostatniego przebiegu
// i wiersz na stronie głównej. Prawdziwy serwer i prawdziwe moduły, konta z rolami; inFakt niepodłączony
// (ekran ma wtedy powiedzieć, że automat nic nie wyśle) — żadne żądanie nie wychodzi z procesu.
import ejs from 'ejs';
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
import { wczytajAutomatKsef, zapiszWynikAutomatu, zapiszTrybAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';

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

  // PRZ-123 C09ca: przy wpisie „odrzucona” / „nie-wyslano” (TwojeFaktury) zdjęcie wpisu niczego nie wysyła — ta wersja
  // nie wraca do kolejki automatu — więc „Zwolnij” nie ma, a trasa odmawia.
  const wstrzymaj = (p, wpisy) => p.db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)')
    .run('ksef.automat.wstrzymane', JSON.stringify(wpisy), '2026-10-27T10:15:00.000Z');
  const ODRZUCONA = { uuid: 'R', numer: 'R/10/2026', dzien: '2026-10-27', powod: 'kod 450: błąd semantyki', kod: 'odrzucona', wersja: 1 };
  const NIE_DOSZLA = { uuid: 'N', numer: 'N/10/2026', dzien: '2026-10-27', powod: 'kod 401', kod: 'nie-wyslano', wersja: 1 };
  const formularzZwolnij = (body, uuid) => new RegExp(`action="/faktury/ksef/automat/zwolnij"[^>]*>\\s*<input type="hidden" name="uuid" value="${uuid}"`, 'u').test(body);

  it('C09ca: wpis „odrzucona” i „nie-wyslano” — bez formularza „Zwolnij”, ze zdaniem, co zrobić; wpis bez kodu — z formularzem', async () => {
    const p = panel();
    wstrzymaj(p, [ODRZUCONA, NIE_DOSZLA, { uuid: 'B', numer: 'B/10/2026', dzien: '2026-10-20', powod: 'inFakt odrzucił (422)' }]);
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.statusCode).toBe(200);
    expect(formularzZwolnij(r.body, 'R')).toBe(false);
    expect(formularzZwolnij(r.body, 'N')).toBe(false);
    expect(formularzZwolnij(r.body, 'B')).toBe(true);
    // Krok jest już w zdaniu wpisu (zdanieWstrzymanej); w miejscu przycisku — krótka notka, bez powtórzenia zdania.
    expect(r.body).toContain('Nie do zwolnienia — popraw fakturę.');
    expect(r.body).toContain('Nie do zwolnienia — wyślij ręcznie.');
  });

  it('K440c2: wpis „duplikat-niesprawdzony” — przycisk „Sprawdź ponownie” i prawdziwe wyjaśnienie; inne wpisy nadal „Zwolnij”', async () => {
    const p = panel();
    const DUPLIKAT = { uuid: 'D', numer: 'D/10/2026', dzien: '2026-10-27', powod: 'nie udało się pobrać faktury z KSeF', kod: 'duplikat-niesprawdzony', wersja: 1 };
    wstrzymaj(p, [DUPLIKAT, { uuid: 'B', numer: 'B/10/2026', dzien: '2026-10-20', powod: 'inFakt odrzucił (422)' }]);
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.statusCode).toBe(200);
    const wiersz = (uuid) => (r.body.split('<li>').find((l) => l.includes(`value="${uuid}"`)) ?? '').split('</li>')[0];
    expect(formularzZwolnij(r.body, 'D')).toBe(true);
    expect(wiersz('D')).toContain('Sprawdź ponownie');
    expect(wiersz('D')).not.toContain('Zwolnij</button>');
    expect(wiersz('B')).toContain('Zwolnij</button>');
    expect(wiersz('B')).not.toContain('Sprawdź ponownie');
    expect(r.body).toContain('„Sprawdź ponownie” niczego nie wysyła — panel jeszcze raz pobierze z KSeF fakturę o tym numerze i porówna ją z wysłaną.');
    // Tylko wpisy zwykłe: stare wyjaśnienie „Zwolnij” zostaje, bez zdania o duplikacie.
    const q = panel();
    wstrzymaj(q, [{ uuid: 'B', numer: 'B/10/2026', dzien: '2026-10-20', powod: 'inFakt odrzucił (422)' }]);
    const r2 = await get(q.app, '/faktury/ksef/automat', q.ewa);
    expect(r2.body).toContain('„Zwolnij” niczego nie wysyła');
    expect(r2.body).not.toContain('Sprawdź ponownie');
    // POST jak „Zwolnij”: zdejmuje wpis, 303.
    const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid: 'D' });
    expect(z.statusCode).toBe(303);
    expect(wczytajAutomatKsef(p.db).wstrzymane.map((w) => w.uuid)).toEqual(['B']);
  });

  it('K440c2: pasek wstrzymanych (TwojeFaktury) — zdanie z następnym krokiem zamiast „wymagają człowieka”', async () => {
    const wstrzymane = [{ uuid: 'D', numer: 'D/10/2026' }, { uuid: 'E', numer: 'E/10/2026' }];
    const automat = { wyborTrybu: true, tryb: 'o_godzinie', stoiPrzezBrak: false, najblizszy: 'jutro', odstepEdycji: 5, coIleMin: 5, odstepMaks: 60,
      bledy: [], wstrzymane, zwolnienieMozliwe: true, nazwaProgramu: { mianownik: 'TwojeFaktury', miejscownik: 'w TwojeFaktury' },
      formularz: { wlaczony: true, godzina: '18:00', tryb: 'o_godzinie', odstepEdycji: 5 }, wynik: null, zmienil: null };
    const html = await ejs.renderFile('src/moduly/faktury/widoki/_automat-ksef.ejs', { automat, konsumenckie: false, fmtDataCzas: (x) => String(x) });
    expect(html).toContain('Wstrzymane faktury (automat ich nie wyśle): D/10/2026, E/10/2026.');
    expect(html).toContain('Co się stało i jaki jest następny krok');
    expect(html).not.toMatch(/wymaga(ją)? człowieka/u);
  });

  it('C09ca: POST „Zwolnij” przy wpisie „nie-wyslano” / „odrzucona” → 409 po polsku, wpis zostaje; bez kodu — jak dotąd', async () => {
    const p = panel();
    wstrzymaj(p, [ODRZUCONA, NIE_DOSZLA, { uuid: 'B', numer: 'B/10/2026', dzien: '2026-10-20', powod: 'inFakt odrzucił (422)' }]);
    for (const uuid of ['N', 'R']) {
      const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid });
      expect(z.statusCode).toBe(409);
      expect(z.body).toMatch(/automat i tak jej nie wyśle/u);
    }
    expect(wczytajAutomatKsef(p.db).wstrzymane.map((w) => w.uuid)).toEqual(['R', 'N', 'B']);
    const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid: 'B' });
    expect(z.statusCode).toBe(303);
    expect(wczytajAutomatKsef(p.db).wstrzymane.map((w) => w.uuid)).toEqual(['R', 'N']);
  });

  // PRZ-123 ZDROWIE-RECZNIE (poprawka po recenzji): w trybie „ręcznie” automat niczego nie wysyła, więc ekran automatu
  // i odmowa „Zwolnij” przy wpisie „odrzucona” nie mogą obiecywać, że poprawioną wersję „automat wyśle sam”.
  it('ZDROWIE-RECZNIE: tryb „ręcznie” + wpis „odrzucona” — ekran i 409 każą wysłać poprawioną wersję ręcznie', async () => {
    const p = panel();
    zapiszTrybAutomatu(p.db, { tryb: 'reczna', odstepEdycji: 15, login: 'adam' });
    wstrzymaj(p, [ODRZUCONA]);
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('wyślij poprawioną wersję ręcznie');
    expect(r.body).not.toContain('automat wyśle sam');
    const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid: 'R' });
    expect(z.statusCode).toBe(409);
    expect(z.body).toContain('wyślij poprawioną wersję ręcznie');
    expect(z.body).not.toContain('automat wyśle sam');
  });

  it('ZDROWIE-RECZNIE: tryb „po wystawieniu” + wpis „odrzucona” — ekran i 409 jak dotąd: poprawioną wersję automat wyśle sam', async () => {
    const p = panel();
    zapiszTrybAutomatu(p.db, { tryb: 'po_wystawieniu', odstepEdycji: 15, login: 'adam' });
    wstrzymaj(p, [ODRZUCONA]);
    const r = await get(p.app, '/faktury/ksef/automat', p.ewa);
    expect(r.body).toContain('poprawioną wersję automat wyśle sam');
    expect(r.body).not.toContain('wyślij poprawioną wersję ręcznie');
    const z = await post(p.app, '/faktury/ksef/automat/zwolnij', p.ewa, { uuid: 'R' });
    expect(z.statusCode).toBe(409);
    expect(z.body).toContain('automat wyśle sam');
    expect(z.body).not.toContain('ręcznie');
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
