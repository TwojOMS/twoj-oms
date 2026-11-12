import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createFabrykaErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';

/** Panel z kanałem ERLI na atrapie i zamówieniami o podanych typeId; `test` dostaje wszystko, sprzątanie tutaj. */
async function zKanalemErli(typy, test) {
  const p = nowyPanel({ nadpisania: { 'wysylka.nadanie': { gotowe: () => true } } });
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'erli-07c-'));
  try {
    zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
    const admin = jako(p.db, 'operator');
    p.db.prepare(`INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('nietypowy','erli','Test','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
    zapiszKonfiguracjeIntegracji(p.db, 'erli:nietypowy', { ustawienia: { adresApi: 'https://sklep.polcien.example' }, sekrety: { kluczApi: 'atrapa' } });
    const atrapa = createAtrapaErli({ db: p.db, kanal: 'nietypowy', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T12:00:00Z') });
    const http = vi.fn(atrapa.fetchImpl);
    const uslugi = createFabrykaErli({ db: p.db })({ polaczenie: { klucz: 'nietypowy', odUtc: null }, http, sprawdzZapis() {} });
    const dane = await uslugi.klient.szukajZamowien({ pagination: { limit: 200 } });
    const zapisz = sur => zapiszZamowienie(p.db, 'nietypowy', mapujZamowienieErli(sur), sur);
    const ids = Object.fromEntries(typy.map(typeId => [typeId, zapisz(dane.find(z => z.delivery.typeId === typeId))]));
    const klient = () => ({ nadaj: vi.fn().mockResolvedValue({ numerListu: 'PC-ERLI-0001', etykietaPdf: Buffer.from('%PDF-test'), surowa: '{}' }) });
    const kurierzy = { dpd: klient(), erli_przesylki: klient(), inpost_paczkomat: klient() };
    const nadanie = createNadanie({ db: p.db, kurierzy, katalogEtykiet });
    const karta = id => get(p.app, `/zamowienia/${id}`, admin);
    const ekran = (id, query = '') => get(p.app, `/zamowienia/${id}/nadaj${query}`, admin);
    const przesylki = () => p.db.prepare('SELECT count(*) n FROM przesylki').get().n;
    await test({ p, dane, zapisz, ids, http, uslugi, kurierzy, nadanie, karta, ekran, przesylki });
  } finally { await p.app.close(); p.db.close(); rmSync(katalogEtykiet, { recursive: true, force: true }); }
}

it('karta, GET i usługa honorują drogę ERLI, blokady i ręczne nadpisanie bez HTTP słowników', () =>
  zKanalemErli(['erliPaczkomat', 'dpd', 'nieznanaMetoda'], async ({ p, ids, http, uslugi, kurierzy, nadanie, karta, ekran }) => {
    await expect(nadanie.nadaj(ids.erliPaczkomat)).rejects.toThrow(/słownik|ustal/);
    expect(p.db.prepare('SELECT count(*) n FROM przesylki').get().n).toBe(0);
    expect((await karta(ids.erliPaczkomat)).body).toContain('tego zamówienia nie nadasz');
    await uslugi.poller.przebieg();
    http.mockClear();
    const k = await karta(ids.erliPaczkomat);
    expect(k.body).toContain('Nadaj paczkę');
    expect(k.body).not.toContain('tego zamówienia nie nadasz');
    const e = await ekran(ids.erliPaczkomat);
    expect(e.statusCode).toBe(200);
    expect(e.body).toContain('Przesyłki Erli');
    const wybor = await ekran(ids.erliPaczkomat, '?wybor=1');
    expect(wybor.body).toContain('kurier=dpd');
    expect(wybor.body).toContain('Przesyłki Erli');
    const blokada = await karta(ids.nieznanaMetoda);
    expect(blokada.body).toContain('tego zamówienia nie nadasz');
    expect(blokada.body).not.toContain('>Nadaj paczkę');
    expect((await ekran(ids.nieznanaMetoda)).statusCode).toBe(400);
    await expect(nadanie.nadaj(ids.nieznanaMetoda)).rejects.toThrow(/nie wiem, jak nadać/);
    expect(p.db.prepare('SELECT count(*) n FROM przesylki').get().n).toBe(0);
    await nadanie.nadaj(ids.erliPaczkomat);
    expect(kurierzy.erli_przesylki.nadaj).toHaveBeenCalledTimes(1);
    expect(kurierzy.dpd.nadaj).not.toHaveBeenCalled();
    await nadanie.nadaj(ids.dpd);
    expect(kurierzy.dpd.nadaj).toHaveBeenCalledTimes(1);
    p.db.prepare('UPDATE zamowienia SET wysylka_reczna_json=? WHERE id=?').run(JSON.stringify({ metoda: 'dpd', pobranie: false }), ids.nieznanaMetoda);
    const reczna = (await karta(ids.nieznanaMetoda)).body;
    expect(reczna).toContain('plakietka--dpd');
    // Ręczna zmiana wygrywa z drogą ERLI także w pasku „Do załatwienia” i przy przycisku nadania.
    expect(reczna).not.toContain('nie wiem, jak nadać');
    expect(reczna).toContain('>Nadaj paczkę');
    await nadanie.nadaj(ids.nieznanaMetoda);
    expect(kurierzy.dpd.nadaj).toHaveBeenCalledTimes(2);
    await nadanie.nadaj(ids.erliPaczkomat, undefined, { kolejnosc: 2, kurierWybrany: 'dpd' });
    expect(kurierzy.dpd.nadaj).toHaveBeenCalledTimes(3);
    expect(http).not.toHaveBeenCalled();
    p.db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz='nietypowy'").run();
    expect((await karta(ids.erliPaczkomat)).body).toContain('Kanał ERLI wyłączony — włącz pobieranie');
  }));

// PRZ-157.07f (recenzja 07): plan rozdz. 3 pkt 3 — kurier z umowy firmy, dla którego OMS nie ma modułu,
// blokuje nadanie. Karta i usługa nadania mówią to samo, z jednego miejsca (drogaErliDlaZamowienia).
it('Kurier InPost z umowy firmy: karta ma sprawę nadania kanału, nadanie odmawia, nic nie wychodzi', () =>
  zKanalemErli(['paczkomat'], async ({ dane, zapisz, uslugi, kurierzy, nadanie, karta, przesylki }) => {
    const kurier = structuredClone(dane.find(z => z.delivery.typeId === 'paczkomat'));
    kurier.id = `${kurier.id}-kurier`;
    delete kurier.delivery.pickupPlace;
    kurier.delivery.name = 'Kurier InPost — umowa firmy';
    const id = zapisz(kurier);
    await uslugi.poller.przebieg();
    const b = (await karta(id)).body.replace(/\s+/g, ' ');
    // Sprawa `nadanie-kanalu` (kontekst.js) w pasku „Do załatwienia”: blokada z komunikatem rozdz. 3 pkt 3.
    const pasek = b.slice(b.indexOf('<div class="sprawy">'), b.indexOf('</ul>', b.indexOf('<div class="sprawy">')));
    expect(pasek).toMatch(/waga--blokada">blokada<\/span> <span>ERLI: „[^”]+” jedzie kurierem z Twojej umowy, a OMS nie ma modułu tego kuriera/);
    expect(b).not.toContain('Twoja umowa — Kurier InPost');
    expect(b).not.toContain('>Nadaj paczkę');
    // Komunikat nie obiecuje, że konfiguracja to naprawi — modułu kuriera InPost w OMS nie ma.
    expect(b).not.toMatch(/sprawdź mapowanie|InPost nie jest skonfigurowany/);
    await expect(nadanie.nadaj(id)).rejects.toThrow(/OMS nie ma modułu tego kuriera/);
    expect(Object.values(kurierzy).map(k => k.nadaj.mock.calls.length)).toEqual([0, 0, 0]);
    expect(przesylki()).toBe(0);
  }));

it('ręczny wybór kuriera spoza listy dla paczki z umową DPD: odmowa, zero wywołań klienta i zero przesyłek', () =>
  zKanalemErli(['dpd'], async ({ ids, uslugi, kurierzy, nadanie, przesylki }) => {
    await uslugi.poller.przebieg();
    await expect(nadanie.nadaj(ids.dpd, undefined, { kolejnosc: 1, kurierWybrany: 'erli_przesylki' }))
      .rejects.toThrow('ERLI: wskazany kurier nie jest dostępny dla tej paczki.');
    expect(Object.values(kurierzy).map(k => k.nadaj.mock.calls.length)).toEqual([0, 0, 0]);
    expect(przesylki()).toBe(0);
  }));
