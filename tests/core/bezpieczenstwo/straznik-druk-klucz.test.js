// PRZ-153.E4.1 — kolejki druku przyjmują klucz API z zakresem `druk` obok hasła serwisowego
// (plan docs/plany/PRZ-153-api-v1.md, „E4 — Druk na kluczu `druk`”). Dane zmyślone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { dodajDoKolejki } from '../../../src/moduly/wysylka/db/kolejka-druku.js';
import { zapiszProforme } from '../../../src/moduly/faktury/db/proformy.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { dodajProformeDoKolejki } from '../../../src/moduly/faktury/db/kolejka-druku-proform.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { zalozKluczApi, odwolajKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';

const BASIC = `Basic ${Buffer.from('serwis:haslo-env').toString('base64')}`;
const ORIGIN = 'http://localhost:80';
const ZPL = '^XA^FDPracownia Polcien^FS^XZ';
const PDF_PROFORMY = Buffer.from('%PDF-1.4 udawana proforma Pracownia Półcień');

let db;
let app;
let katalog;
let adminId;
let pozycjaEtykiety;
let pozycjaProformy;
const teraz = () => new Date().toISOString();
const klucz = (zakresy = ['druk']) => zalozKluczApi(db, {
  nazwa: 'czuwacz testowy', zakresy, kontoId: adminId, teraz: teraz(),
});
const bearer = (k) => ({ authorization: `Bearer ${k}` });
const pobierz = (url, headers = {}) => app.inject({ method: 'GET', url, headers });
const wyslij = (url, headers = {}) => app.inject({
  method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: '{}',
});

beforeEach(async () => {
  db = openOmsDb(':memory:');
  katalog = mkdtempSync(join(tmpdir(), 'oms-druk-klucz-'));
  const proforma = createProforma({ db, config: { proforma: { katalog } } });
  const config = { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [], proforma: { katalog } };
  app = buildOmsServer({ db, config, proforma });
  await app.ready();
  // Czynny admin w tabeli = konto serwisowe zdegradowane (stan produkcji, w którym czuwacze chodzą dziś na Basic).
  adminId = zalozKonto(db, { login: 'ala', imie: 'Ala Testowa', haslo: 'h', rola: 'admin', admin: true });

  const zamowienieId = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 7001, numer: 'PC-7001', klient: { first_name: 'Anna', company: 'Pracownia Półcień' },
    dostawa: { city: 'Warszawa' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '249.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null,
    anulowane: 0, utworzone_at: '2026-11-03T09:00:00', pozycje: [],
  }, {});
  const przesylka = rozpocznijPrzesylke(db, zamowienieId, 'dpd');
  const sciezkaZpl = join(katalog, 'PC-7001-0000000000001U.zpl');
  writeFileSync(sciezkaZpl, ZPL);
  zakonczPrzesylke(db, przesylka.id, {
    numerListu: '0000000000001U', etykietaSciezka: join(katalog, 'PC-7001.pdf'), etykietaZplSciezka: sciezkaZpl, surowa: '<xml/>',
  });
  pozycjaEtykiety = dodajDoKolejki(db, przesylka.id).id;

  const p = zapiszProforme(db, zamowienieId, { kwotaBrutto: '249.00', rok: 2026, miesiac: 11, utworzonaAt: '2026-11-03T10:00:00.000Z' });
  const plik = join(katalog, 'PC-7001-proforma.pdf');
  writeFileSync(plik, PDF_PROFORMY);
  db.prepare('UPDATE proformy SET plik_sciezka = ? WHERE id = ?').run(plik, p.id);
  pozycjaProformy = `p${dodajProformeDoKolejki(db, p.id).id}`;
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(katalog, { recursive: true, force: true });
});

describe('strażnik: klucz `druk` na kolejkach druku', () => {
  it('klucz `druk` → 200 na obu kolejkach i ich plikach', async () => {
    const { klucz: k } = klucz();
    const lista = await pobierz('/kolejka-druku', bearer(k));
    expect(lista.statusCode).toBe(200);
    expect(lista.json().map((p) => p.id)).toEqual([pozycjaEtykiety]);

    const zpl = await pobierz(`/kolejka-druku/${pozycjaEtykiety}/zpl`, bearer(k));
    expect(zpl.statusCode).toBe(200);
    expect(zpl.body).toBe(ZPL);

    const faktury = await pobierz('/kolejka-druku-faktur?stanowisko=BIURO-1', bearer(k));
    expect(faktury.statusCode).toBe(200);
    expect(faktury.json().map((p) => p.id)).toEqual([pozycjaProformy]);

    const pdf = await pobierz(`/kolejka-druku-faktur/${pozycjaProformy}/pdf`, bearer(k));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.equals(PDF_PROFORMY)).toBe(true);
  });

  it('POST …/wydrukowano kluczem `druk`: z Origin → 2xx, bez Origin → 403 CSRF (bez wyjątku dla druku)', async () => {
    const { klucz: k } = klucz();
    const bezOrigin = await wyslij(`/kolejka-druku/${pozycjaEtykiety}/wydrukowano`, bearer(k));
    expect(bezOrigin.statusCode).toBe(403);
    const bezOriginF = await wyslij(`/kolejka-druku-faktur/${pozycjaProformy}/wydrukowano`, bearer(k));
    expect(bezOriginF.statusCode).toBe(403);

    const r = await wyslij(`/kolejka-druku/${pozycjaEtykiety}/wydrukowano`, { ...bearer(k), origin: ORIGIN });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const f = await wyslij(`/kolejka-druku-faktur/${pozycjaProformy}/wydrukowano`, { ...bearer(k), origin: ORIGIN });
    expect(f.statusCode).toBe(200);
    expect(f.json()).toEqual({ ok: true });
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(pozycjaEtykiety).status).toBe('wydrukowano');
  });

  it('klucz bez zakresu `druk` → 403 kod brak_zakresu na każdej kolejce', async () => {
    const { klucz: k } = klucz(['zamowienia:odczyt', 'zamowienia:zapis', 'produkty:odczyt']);
    for (const url of ['/kolejka-druku', `/kolejka-druku/${pozycjaEtykiety}/zpl`, '/kolejka-druku-faktur',
      `/kolejka-druku-faktur/${pozycjaProformy}/pdf`]) {
      const r = await pobierz(url, bearer(k));
      expect(r.statusCode, url).toBe(403);
      expect(r.json(), url).toEqual({ kod: 'brak_zakresu', powod: 'Klucz nie ma zakresu druk.' });
    }
    const post = await wyslij(`/kolejka-druku/${pozycjaEtykiety}/wydrukowano`, { ...bearer(k), origin: ORIGIN });
    expect(post.statusCode).toBe(403);
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(pozycjaEtykiety).status).toBe('oczekuje');
  });

  // Jak dziś dla Bearer na panelu: ścieżka Basic → 401, a po kilku próbach hamulec logowania → 429 (zmierzone 06.11).
  it('klucz `druk` nie otwiera innych adresów panelu → 401 (albo 429 hamulca, jak dziś)', async () => {
    const { klucz: k } = klucz();
    expect((await pobierz('/zamowienia', bearer(k))).statusCode).toBe(401);
    for (const url of ['/zamowienia', '/ustawienia', '/ustawienia/klucze-api', '/przesylki', '/api/sprzedaz',
      '/kolejka-drukux', '/kolejka-druku-fakturx', '/']) {
      for (const accept of ['application/json', 'text/html']) {
        const r = await pobierz(url, { ...bearer(k), accept });
        expect([401, 429], `${url} ${accept}`).toContain(r.statusCode);
      }
    }
  });

  it('surowe HTTP: /kolejka-druku/../zamowienia z kluczem nie dochodzi do ekranu zamówień', async () => {
    const { klucz: k } = klucz();
    const adres = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
    const surowo = (path) => new Promise((ok, zle) => {
      const r = http.request({ host: adres.hostname, port: adres.port, path, headers: bearer(k) }, (res) => {
        let tresc = ''; res.on('data', (c) => { tresc += c; }); res.on('end', () => ok({ status: res.statusCode, tresc }));
      });
      r.on('error', zle);
      r.end();
    });
    for (const path of ['/kolejka-druku/../zamowienia', '/kolejka-druku/%2e%2e/zamowienia', '/kolejka-druku%2f..%2fzamowienia']) {
      const r = await surowo(path);
      expect(r.status, path).not.toBe(200);
      expect(r.tresc, path).not.toContain('PC-7001');
    }
    expect((await surowo('/kolejka-druku')).status).toBe(200);
  });

  it('klucz `druk` na /api/v1/ja → 200 (ja nie wymaga zakresu)', async () => {
    const { klucz: k, prefiks } = klucz();
    const r = await pobierz('/api/v1/ja', bearer(k));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ nazwa: 'czuwacz testowy', prefiks, zakresy: ['druk'] });
  });

  it('zakodowana ścieżka /kolejka%2Ddruku z kluczem → ten sam wynik co /kolejka-druku', async () => {
    const { klucz: k } = klucz();
    const zwykla = await pobierz('/kolejka-druku', bearer(k));
    const zakodowana = await pobierz('/kolejka%2Ddruku', bearer(k));
    expect(zakodowana.statusCode).toBe(200);
    expect(zakodowana.body).toBe(zwykla.body);
    const pdf = await pobierz(`/kolejka%2Ddruku-faktur/${pozycjaProformy}/pdf`, bearer(k));
    expect(pdf.statusCode).toBe(200);

    const { klucz: bezDruku } = klucz(['zamowienia:odczyt']);
    const odmowa = await pobierz('/kolejka%2Ddruku', bearer(bezDruku));
    expect(odmowa.statusCode).toBe(403);
    expect(odmowa.json().kod).toBe('brak_zakresu');
  });

  it('zdekodowany ? (%3F) nie skraca ścieżki do prefiksu kolejki', async () => {
    const { klucz: k } = klucz();
    // Zdekodowane `/kolejka-druku/?` nie jest kolejka: dawna sciezka Basic, 401 — klucz tego nie otwiera.
    for (const adres of ['/kolejka-druku%3F/../zamowienia', '/kolejka-druku/%3F', '/kolejka-druku/%23']) {
      const r = await pobierz(adres, bearer(k));
      expect(r.statusCode, adres).toBe(401);
    }
  });

  it('zakodowana ścieżka z ciasteczkiem admina (bez klucza) → jak dziś, nie odmowa klucza', async () => {
    const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('ala', odczytajSekret(db))}`;
    const zwykla = await pobierz('/kolejka-druku', { cookie });
    expect(zwykla.statusCode).toBe(200);
    // Dziś: ekranDlaAdresu nie zna zakodowanej ścieżki → „Brak uprawnień” (403), także dla admina. Bez zmian.
    const zakodowana = await pobierz('/kolejka%2Ddruku', { cookie });
    expect(zakodowana.statusCode).toBe(403);
    expect(zakodowana.body).toBe('Brak uprawnień do tego ekranu');
  });

  it('odwołany klucz `druk` → 401 kod klucz', async () => {
    const { klucz: k, id } = klucz();
    expect((await pobierz('/kolejka-druku', bearer(k))).statusCode).toBe(200);
    odwolajKluczApi(db, id, teraz());
    const r = await pobierz('/kolejka-druku', bearer(k));
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' });
    const zly = await pobierz('/kolejka-druku', { authorization: 'Bearer toms_zly' });
    expect(zly.statusCode).toBe(401);
  });

  it('Basic konta serwisowego na kolejkach działa jak dziś (po degradacji)', async () => {
    expect((await pobierz('/kolejka-druku', { authorization: BASIC })).statusCode).toBe(200);
    expect((await pobierz('/kolejka-druku-faktur', { authorization: BASIC })).statusCode).toBe(200);
    const r = await wyslij(`/kolejka-druku/${pozycjaEtykiety}/wydrukowano`, { authorization: BASIC, origin: ORIGIN });
    expect(r.statusCode).toBe(200);
  });
});
