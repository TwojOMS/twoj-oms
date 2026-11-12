import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../../src/domena/szablony-paczek.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createFabrykaErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-157.12r: nadanie HURTEM zamówień ERLI ma iść tą samą drogą co pojedyncze
// (`metodaNadaniaErli` → `drogaErliDlaZamowienia`): Przesyłki Erli z wymiarami z kroku 4,
// kurier z umowy według mapy, blokada = pominięte z powodem, ręczna metoda wygrywa.
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const headers = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const WYMIARY_KROK4 = { waga: 2, dlugosc: 40, szerokosc: 30, wysokosc: 15 };

async function zHurtemErli(test) {
  const db = openOmsDb(':memory:');
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'erli-12r-'));
  let app;
  try {
    let szablony = odczytajSzablony({});
    szablony = zmienSzablon(szablony, { nazwa: 'Mała', waga: '0,5', dlugosc: '30', szerokosc: '20', wysokosc: '10' }, 'mala').stan;
    szablony = ustawDomyslnySzablon(szablony, 'mala').stan;
    zapiszUstawienia(db, zapiszSzablony(szablony));
    const klient = () => ({ nadaj: vi.fn().mockResolvedValue({ numerListu: 'PC-HURT-0001', etykietaPdf: Buffer.from('%PDF-test'), surowa: '{}' }) });
    const kurierzy = { dpd: klient(), erli_przesylki: klient(), inpost_paczkomat: klient() };
    const nadanie = createNadanie({ db, kurierzy, katalogEtykiet });
    // Serwer zakłada tabele modułów (m.in. `kanaly_sprzedazy`), więc powstaje przed kanałem ERLI.
    app = buildOmsServer({ db, config, nadanie, kurierzy: {} });
    await app.ready();
    db.prepare(`INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('polcien','erli','Pracownia Półcień','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
    zapiszKonfiguracjeIntegracji(db, 'erli:polcien', {
      ustawienia: { adresApi: 'https://sklep.polcien.example', punktNadania: 77, wymiaryDomyslne: WYMIARY_KROK4 },
      sekrety: { kluczApi: 'atrapa' },
    });
    const atrapa = createAtrapaErli({ db, kanal: 'polcien', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T12:00:00Z') });
    const http = vi.fn(atrapa.fetchImpl);
    const uslugi = createFabrykaErli({ db })({ polaczenie: { klucz: 'polcien', odUtc: null }, http, sprawdzZapis() {} });
    const dane = await uslugi.klient.szukajZamowien({ pagination: { limit: 200 } });
    const zapisz = (sur) => zapiszZamowienie(db, 'polcien', mapujZamowienieErli(sur), sur);
    const pierwsze = (typeId) => dane.find((z) => z.delivery.typeId === typeId);
    const ids = {
      erli: zapisz(pierwsze('erliPaczkomat')),
      dpd: zapisz(pierwsze('dpd')),
      blokada: zapisz(pierwsze('nieznanaMetoda')),
    };
    // Drugie zamówienie z nieznaną dostawą, ale z ręcznie ustawioną metodą DPD na karcie.
    const reczne = structuredClone(pierwsze('nieznanaMetoda'));
    reczne.id = `${reczne.id}-reczne`;
    ids.reczne = zapisz(reczne);
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json=? WHERE id=?').run(JSON.stringify({ metoda: 'dpd', pobranie: false }), ids.reczne);
    await uslugi.poller.przebieg();
    const wszystkie = Object.values(ids).map(String);
    const podglad = (id = wszystkie) => app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj-podglad', headers, payload: { id } });
    const zatwierdz = (payload) => app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj', headers, payload: { id: wszystkie, ...payload } });
    const przesylki = () => db.prepare('SELECT zamowienie_id, kurier FROM przesylki ORDER BY zamowienie_id').all();
    await test({ db, ids, http, kurierzy, podglad, zatwierdz, przesylki });
  } finally {
    await app?.close();
    db.close();
    rmSync(katalogEtykiet, { recursive: true, force: true });
  }
}

const wiersz = (html, id) => {
  const i = html.indexOf(`name="id" value="${id}"`);
  return i < 0 ? '' : html.slice(i, html.indexOf('</tr>', i));
};
const pominiete = (html) => html.replace(/\s+/g, ' ');

it('podgląd: Przesyłki Erli z wymiarami kroku 4, kurier z umowy, blokada pominięta, ręczna metoda wygrywa', () =>
  zHurtemErli(async ({ ids, http, podglad }) => {
    http.mockClear();
    const r = await podglad();
    expect(r.statusCode).toBe(200);
    const b = r.body;
    const erli = wiersz(b, ids.erli);
    expect(erli).toContain('Przesyłki Erli');
    // Wybór wstępny rozmiaru = wymiary z kroku 4 kreatora ERLI.
    expect(erli).toMatch(/<option value="erli:40x30x15x2" selected>[^<]*40 × 30 × 15 cm, 2 kg/);
    expect(wiersz(b, ids.dpd)).not.toBe('');
    expect(wiersz(b, ids.dpd)).not.toContain('value="erli');
    expect(wiersz(b, ids.reczne)).not.toBe('');
    expect(wiersz(b, ids.blokada)).toBe('');
    expect(pominiete(b)).toContain('nie wiem, jak nadać');
    // Podgląd czyta drogę z pamięci kanału — bez ani jednego zapytania do ERLI.
    expect(http).not.toHaveBeenCalled();
  }));

it('zatwierdzenie: ERLI z wymiarami kroku 4, DPD z mapy i z ręcznej metody, blokada niczego nie nadaje', () =>
  zHurtemErli(async ({ ids, kurierzy, zatwierdz, przesylki }) => {
    const r = await zatwierdz({ zatwierdzenie: 'nadaj' });
    expect(r.statusCode).toBe(200);
    expect(kurierzy.erli_przesylki.nadaj).toHaveBeenCalledTimes(1);
    const wywErli = kurierzy.erli_przesylki.nadaj.mock.calls[0][0];
    expect(wywErli.zamowienie.id).toBe(ids.erli);
    expect(wywErli.paczka).toMatchObject(WYMIARY_KROK4);
    const dpdDla = kurierzy.dpd.nadaj.mock.calls.map((c) => c[0].zamowienie.id).sort((a, b) => a - b);
    expect(dpdDla).toEqual([ids.dpd, ids.reczne].sort((a, b) => a - b));
    expect(kurierzy.inpost_paczkomat.nadaj).not.toHaveBeenCalled();
    expect(przesylki().map((p) => p.zamowienie_id)).not.toContain(ids.blokada);
    expect(pominiete(r.body)).toContain('nie wiem, jak nadać');
  }));

it('zatwierdzenie: szablon wybrany przez człowieka wygrywa z wymiarami kroku 4', () =>
  zHurtemErli(async ({ ids, kurierzy, zatwierdz }) => {
    const r = await zatwierdz({ zatwierdzenie: 'nadaj', [`szablon_${ids.erli}`]: 'mala' });
    expect(r.statusCode).toBe(200);
    expect(kurierzy.erli_przesylki.nadaj).toHaveBeenCalledTimes(1);
    expect(kurierzy.erli_przesylki.nadaj.mock.calls[0][0].paczka).toMatchObject({ waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10 });
  }));

it.each([
  ['zmienione', { ...WYMIARY_KROK4, dlugosc: 100, waga: 25 }],
  ['usunięte', undefined],
])('zatwierdzenie: wymiary kroku 4 %s po podglądzie — wiersz odrzucony, nic nie nadane', (_opis, nowe) =>
  zHurtemErli(async ({ db, ids, kurierzy, podglad, zatwierdz }) => {
    const p = await podglad([String(ids.erli)]);
    const wartosc = wiersz(p.body, ids.erli).match(/<option value="(erli:[^"]+)" selected>/)[1];
    zapiszKonfiguracjeIntegracji(db, 'erli:polcien', {
      ustawienia: { adresApi: 'https://sklep.polcien.example', punktNadania: 77, ...(nowe ? { wymiaryDomyslne: nowe } : {}) },
      sekrety: { kluczApi: 'atrapa' },
    });
    const r = await zatwierdz({ zatwierdzenie: 'nadaj', id: [String(ids.erli)], [`szablon_${ids.erli}`]: wartosc });
    expect(r.statusCode).toBe(200);
    expect(kurierzy.erli_przesylki.nadaj).not.toHaveBeenCalled();
    expect(pominiete(r.body)).toContain('odśwież podgląd nadania');
  }));

it('kanał ERLI wyłączony: hurt pomija zamówienia z drogą ERLI i niczego nie nadaje', () =>
  zHurtemErli(async ({ db, ids, kurierzy, podglad, zatwierdz }) => {
    db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz='polcien'").run();
    const p = await podglad([String(ids.erli), String(ids.dpd)]);
    expect(pominiete(p.body)).toContain('Kanał ERLI wyłączony — włącz pobieranie');
    expect(wiersz(p.body, ids.erli)).toBe('');
    await zatwierdz({ zatwierdzenie: 'nadaj', id: [String(ids.erli), String(ids.dpd)] });
    expect(kurierzy.erli_przesylki.nadaj).not.toHaveBeenCalled();
    expect(kurierzy.dpd.nadaj).not.toHaveBeenCalled();
  }));
