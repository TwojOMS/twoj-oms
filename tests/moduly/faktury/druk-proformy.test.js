import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProforme, uniewaznijPoprzednie } from '../../../src/moduly/faktury/db/proformy.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { dodajFaktureDoKolejki } from '../../../src/moduly/faktury/db/kolejka-druku-faktur.js';
import {
  dodajProformeDoKolejki, proformyDoWziecia, ostatniaPozycjaDlaProformy, ostatniePozycjeDlaProform,
} from '../../../src/moduly/faktury/db/kolejka-druku-proform.js';
import { odroczenieMs } from '../../../src/domena/kolejka-druku-stan.js';
import { ekranDlaAdresu } from '../../../src/domena/ekrany.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKolejkiDrukuProform } from '../../../src/moduly/rdzen/migracje/0009-kolejka-druku-proform.ts';

// PRZ-152.G10a — druk proformy: osobna tabela `kolejka_druku_proform` (migracja rdzen/0009), czuwacz
// bez zmian — `/kolejka-druku-faktur` oddaje pozycje faktur i proform razem, proforma ma id „p<n>”.
// Decyzja właściciela 05.11: drukujemy KAŻDĄ proformę, która nie jest unieważniona (bez „aktualna/rozliczona”).

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const PDF_FAKTURY = Buffer.from('%PDF-1.4 udawana faktura');
const PDF_PROFORMY = Buffer.from('%PDF-1.4 udawana proforma Pracownia Półcień');

const katalogi = [];
let db, app, faktura, id, katalog;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  katalog = mkdtempSync(join(tmpdir(), 'oms-druk-proformy-'));
  katalogi.push(katalog);
  faktura = { pdf: vi.fn().mockResolvedValue({ numer: 'FV/3/11/2026', bajty: PDF_FAKTURY }) };
  const proforma = createProforma({ db, config: { proforma: { katalog } } });
  app = buildOmsServer({ db, config, poller, faktura, proforma });
  await app.ready();
  id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 101, numer: 'PC-101', klient: { first_name: 'Anna', company: 'Pracownia Półcień' }, dostawa: { city: 'Warszawa' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '249.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-03T09:00:00',
    pozycje: [{ nazwa: 'Lampa Półcień', sku: 'PC-1', ilosc: 1, cena_brutto: '249.00', brutto_linii: '249.00', vat: null }],
  }, {});
});

afterEach(async () => {
  await app?.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

/** Proforma z zapisanym plikiem — numery PF/1/11/2026, PF/2/11/2026… */
function zProforma(utworzonaAt = '2026-11-03T10:00:00.000Z') {
  const p = zapiszProforme(db, id, { kwotaBrutto: '249.00', rok: 2026, miesiac: 11, utworzonaAt });
  const plik = join(katalog, `PC-101-${p.numer.replaceAll('/', '_')}.pdf`);
  writeFileSync(plik, PDF_PROFORMY);
  db.prepare('UPDATE proformy SET plik_sciezka = ? WHERE id = ?').run(plik, p.id);
  return p;
}
const zFaktura = () => {
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)')
    .run(id, 'u-1', 'FV/3/11/2026', '2026-11-03T10:00:00');
  return db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
};
const wyslij = (url, payload, headers = naglowek) => app.inject({ method: 'POST', url, headers, payload });
const pobierz = (url, headers = naglowek) => app.inject({ method: 'GET', url, headers });
const wierszeKolejki = () => db.prepare('SELECT * FROM kolejka_druku_proform ORDER BY id').all();
const ostatniLog = () => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).at(-1);

describe('POST /proformy/:id/drukuj', () => {
  it('ważna proforma → 302 na kartę z kotwicą #faktura, wiersz w kolejce, log proforma.druk', async () => {
    const p = zProforma();
    const r = await wyslij(`/proformy/${p.id}/drukuj`);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}#faktura`);
    expect(wierszeKolejki()).toMatchObject([{ proforma_id: p.id, status: 'oczekuje', proby: 0 }]);
    expect(ostatniLog()).toMatchObject({
      akcja: 'proforma.druk', wynik: 'Ręcznie (adam): proforma PF/1/11/2026 dodana do kolejki druku.',
    });
  });

  it('starsza ważna proforma (nie aktualna) → 302 i wiersz w kolejce', async () => {
    const starsza = zProforma('2026-11-03T10:00:00.000Z');
    zProforma('2026-11-04T10:00:00.000Z');
    const r = await wyslij(`/proformy/${starsza.id}/drukuj`);
    expect(r.statusCode).toBe(302);
    expect(wierszeKolejki()).toMatchObject([{ proforma_id: starsza.id, status: 'oczekuje' }]);
  });

  it('unieważniona → 400 z tekstem odmowy, bez wiersza w kolejce', async () => {
    const p = zProforma();
    uniewaznijPoprzednie(db, id);
    const r = await wyslij(`/proformy/${p.id}/drukuj`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<p class="pasek-uwaga" role="alert">Proforma PF/1/11/2026 jest unieważniona — nie drukujemy dokumentu, który nie obowiązuje.</p>'); // G13f2: strona OMS
    expect(wierszeKolejki()).toEqual([]);
  });

  it('proforma bez zapisanego pliku → 400 od razu, bez wiersza w kolejce', async () => {
    const p = zapiszProforme(db, id, { kwotaBrutto: '249.00', rok: 2026, miesiac: 11, utworzonaAt: '2026-11-03T10:00:00.000Z' });
    const r = await wyslij(`/proformy/${p.id}/drukuj`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('<p class="pasek-uwaga" role="alert">Proforma PF/1/11/2026 nie ma zapisanego pliku PDF — nie ma czego drukować.</p>'); // G13f2: strona OMS
    expect(wierszeKolejki()).toEqual([]);
  });

  it('nieznana proforma → 404', async () => {
    expect((await wyslij('/proformy/999/drukuj')).statusCode).toBe(404);
  });

  it('drugie kliknięcie tworzy drugie zadanie (powtórny wydruk dozwolony, jak przy fakturze)', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await wyslij(`/proformy/${p.id}/drukuj`);
    expect(wierszeKolejki()).toHaveLength(2);
  });

  it('adres operatora mieści się w uprawnieniu dokumentów zamówienia', () => {
    expect(ekranDlaAdresu('/proformy/1/drukuj')).toBe('pozostale-dokumenty-zamowienia');
    expect(ekranDlaAdresu('/proformy/1/druk-porzuc')).toBe('pozostale-dokumenty-zamowienia');
  });
});

describe('POST /proformy/:id/druk-porzuc', () => {
  it('porzuca ostatnią pozycję i zapisuje decyzję człowieka', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    const r = await wyslij(`/proformy/${p.id}/druk-porzuc`);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}#faktura`);
    expect(ostatniaPozycjaDlaProformy(db, p.id).status).toBe('porzucone');
    expect(ostatniLog()).toMatchObject({ akcja: 'proforma.druk' });
    expect(ostatniLog().wynik).toMatch(/^Ręcznie \(adam\): porzucony wydruk proformy PF\/1\/11\/2026/);
  });

  it('proforma bez pozycji w kolejce → 404', async () => {
    const p = zProforma();
    expect((await wyslij(`/proformy/${p.id}/druk-porzuc`)).statusCode).toBe(404);
  });
});

describe('czuwacz: lista, PDF, potwierdzenie — kontrakt bez zmian', () => {
  it('lista oddaje pozycję proformy obok pozycji faktury, posortowane po utworzone_at', async () => {
    const p = zProforma();
    const f = zFaktura();
    const pozF = dodajFaktureDoKolejki(db, f.id);
    const pozP = dodajProformeDoKolejki(db, p.id);
    // Proforma trafiła do kolejki WCZEŚNIEJ niż faktura — ma stać pierwsza.
    db.prepare('UPDATE kolejka_druku_faktur SET utworzone_at = ? WHERE id = ?').run('2026-11-03T12:00:00.000Z', pozF.id);
    db.prepare('UPDATE kolejka_druku_proform SET utworzone_at = ? WHERE id = ?').run('2026-11-03T11:00:00.000Z', pozP.id);
    const r = await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      { id: `p${pozP.id}`, numer: 'PF/1/11/2026', zamowienie: 'PC-101', zamowienieId: id },
      { id: pozF.id, numer: 'FV/3/11/2026', zamowienie: 'PC-101', zamowienieId: id },
    ]);
  });

  it('pozycja z przykładu planu: { id: "p1", numer: "PF/1/11/2026", zamowienie: "PC-101", zamowienieId: 1 }', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=biuro')).json())
      .toEqual([{ id: 'p1', numer: 'PF/1/11/2026', zamowienie: 'PC-101', zamowienieId: 1 }]);
  });

  it('PDF pozycji p1 to zapisany plik proformy — bajty równe /proformy/1/pdf, nazwa proforma-…', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    const r = await pobierz('/kolejka-druku-faktur/p1/pdf');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="proforma-PF_1_11_2026.pdf"');
    const zKarty = await pobierz(`/proformy/${p.id}/pdf`);
    expect(Buffer.from(r.rawPayload)).toEqual(Buffer.from(zKarty.rawPayload));
    expect(Buffer.from(r.rawPayload)).toEqual(PDF_PROFORMY);
    expect(faktura.pdf).not.toHaveBeenCalled();
  });

  it('id faktury bez przedrostka działa jak dziś, także gdy proforma ma ten sam numer pozycji', async () => {
    const p = zProforma();
    const f = zFaktura();
    const pozF = dodajFaktureDoKolejki(db, f.id);
    const pozP = dodajProformeDoKolejki(db, p.id);
    expect(pozF.id).toBe(pozP.id);
    const r = await pobierz(`/kolejka-druku-faktur/${pozF.id}/pdf`);
    expect(Buffer.from(r.rawPayload)).toEqual(PDF_FAKTURY);
    expect(r.headers['content-disposition']).toBe('attachment; filename="faktura-FV_3_11_2026.pdf"');
    await wyslij(`/kolejka-druku-faktur/${pozF.id}/wydrukowano`);
    expect(ostatniaPozycjaDlaProformy(db, p.id).status).toBe('oczekuje');
  });

  it('POST …/p1/wydrukowano → wydrukowane_at, pozycja znika z listy', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    const r = await wyslij('/kolejka-druku-faktur/p1/wydrukowano');
    expect(r.statusCode).toBe(200);
    const w = ostatniaPozycjaDlaProformy(db, p.id);
    expect(w.status).toBe('wydrukowano');
    expect(w.wydrukowane_at).toBeTruthy();
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=biuro')).json()).toEqual([]);
  });

  it('POST …/p1/blad → odroczenie jak przy fakturze, zajęcie zwolnione', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    const przed = Date.now();
    const r = await wyslij('/kolejka-druku-faktur/p1/blad', { powod: 'brak papieru' });
    expect(r.statusCode).toBe(200);
    const w = ostatniaPozycjaDlaProformy(db, p.id);
    expect(w).toMatchObject({ status: 'oczekuje', proby: 1, ostatni_blad: 'brak papieru', zajete_przez: null, zajete_at: null });
    const odroczenie = new Date(w.nastepna_proba_at).getTime() - przed;
    expect(odroczenie).toBeGreaterThanOrEqual(odroczenieMs(1) - 50);
    expect(odroczenie).toBeLessThanOrEqual(odroczenieMs(1) + 5000);
    expect(proformyDoWziecia(db, { stanowisko: 'biuro' })).toEqual([]);
    expect(proformyDoWziecia(db, { stanowisko: 'biuro', terazIso: '2999-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('unieważniona po dodaniu do kolejki → znika z listy czuwacza i dostaje stan porzucone', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    uniewaznijPoprzednie(db, id);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=biuro')).json()).toEqual([]);
    expect(ostatniaPozycjaDlaProformy(db, p.id)).toMatchObject({
      status: 'porzucone', ostatni_blad: 'proforma unieważniona przed wydrukiem',
    });
  });

  // Recenzja G10a: czuwacz drukuje pozycje po kolei (do 120 s każda) — proforma unieważniona PO zajęciu
  // pozycji, a PRZED pobraniem PDF, nie może wyjść z drukarki.
  it('unieważniona po zajęciu przez czuwacza → PDF 409 bez pliku, pozycja porzucona', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=biuro')).json()).toHaveLength(1);
    uniewaznijPoprzednie(db, id);
    const r = await pobierz('/kolejka-druku-faktur/p1/pdf?stanowisko=biuro');
    expect(r.statusCode).toBe(409);
    expect(r.headers['content-type']).not.toMatch(/pdf/);
    expect(r.body).toBe('Proforma PF/1/11/2026 jest unieważniona — nie drukujemy dokumentu, który nie obowiązuje.');
    expect(ostatniaPozycjaDlaProformy(db, p.id)).toMatchObject({
      status: 'porzucone', ostatni_blad: 'proforma unieważniona przed wydrukiem', zajete_przez: null, zajete_at: null,
    });
  });

  // Recenzja 2: PDF wyszedł, gdy proforma była ważna — kartka już jest w drukarce. Potwierdzenie zapisuje
  // prawdę (wydrukowano) z notatką, a nie odmawia.
  it('PDF oddany ważnej, unieważnienie w trakcie druku → …/wydrukowano 200, status wydrukowano z notatką', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    expect((await pobierz('/kolejka-druku-faktur/p1/pdf?stanowisko=biuro')).statusCode).toBe(200);
    uniewaznijPoprzednie(db, id);
    const r = await wyslij('/kolejka-druku-faktur/p1/wydrukowano');
    expect(r.statusCode).toBe(200);
    const w = ostatniaPozycjaDlaProformy(db, p.id);
    expect(w).toMatchObject({ status: 'wydrukowano', ostatni_blad: 'wydrukowano po unieważnieniu' });
    expect(w.wydrukowane_at).toBeTruthy();
  });

  it('S1: A dostaje PDF ważnej → unieważnienie → lista B porzuca pozycję A → A woła /wydrukowano → wydrukowano z notatką', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=BIURO-A')).json()).toHaveLength(1);
    expect((await pobierz('/kolejka-druku-faktur/p1/pdf?stanowisko=BIURO-A')).statusCode).toBe(200);
    uniewaznijPoprzednie(db, id);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=BIURO-B')).json()).toEqual([]);
    expect(ostatniaPozycjaDlaProformy(db, p.id).status).toBe('porzucone');
    const r = await wyslij('/kolejka-druku-faktur/p1/wydrukowano');
    expect(r.statusCode).toBe(200);
    const w = ostatniaPozycjaDlaProformy(db, p.id);
    expect(w).toMatchObject({ status: 'wydrukowano', ostatni_blad: 'wydrukowano po unieważnieniu' });
    expect(w.wydrukowane_at).toBeTruthy();
  });

  it('ważna proforma → …/wydrukowano bez notatki', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    await wyslij('/kolejka-druku-faktur/p1/wydrukowano');
    expect(ostatniaPozycjaDlaProformy(db, p.id)).toMatchObject({ status: 'wydrukowano', ostatni_blad: null });
  });

  // Recenzja 2: czuwacz-faktur.ps1 po 409 z PDF woła /blad z tekstem wyjątku — nie może nadpisać porzucenia.
  it('PDF 409 → czuwacz woła /blad → powód i status porzucenia bez zmian', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    uniewaznijPoprzednie(db, id);
    expect((await pobierz('/kolejka-druku-faktur/p1/pdf?stanowisko=biuro')).statusCode).toBe(409);
    const r = await wyslij('/kolejka-druku-faktur/p1/blad', { powod: 'The remote server returned an error: (409) Conflict.' });
    expect(r.statusCode).toBe(200);
    expect(ostatniaPozycjaDlaProformy(db, p.id)).toMatchObject({
      status: 'porzucone', ostatni_blad: 'proforma unieważniona przed wydrukiem', proby: 0, nastepna_proba_at: null,
    });
  });

  it('wydrukowana, potem unieważniona, potem ponowny GET PDF → 409, ale stan zostaje wydrukowano', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    await wyslij('/kolejka-druku-faktur/p1/wydrukowano');
    uniewaznijPoprzednie(db, id);
    expect((await pobierz('/kolejka-druku-faktur/p1/pdf?stanowisko=biuro')).statusCode).toBe(409);
    expect(ostatniaPozycjaDlaProformy(db, p.id)).toMatchObject({ status: 'wydrukowano', ostatni_blad: null });
  });

  it('dwa stanowiska: pozycji zajętej przez pierwsze drugie nie dostaje', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=BIURO-1')).json()).toHaveLength(1);
    expect((await pobierz('/kolejka-druku-faktur?stanowisko=BIURO-2')).json()).toEqual([]);
  });

  it('zniekształcone albo nieznane id → 404', async () => {
    for (const adres of ['px', 'p0', 'p99', '12abc']) {
      expect((await pobierz(`/kolejka-druku-faktur/${adres}/pdf`)).statusCode, adres).toBe(404);
      expect((await wyslij(`/kolejka-druku-faktur/${adres}/wydrukowano`)).statusCode, adres).toBe(404);
      expect((await wyslij(`/kolejka-druku-faktur/${adres}/blad`, { powod: 'x' })).statusCode, adres).toBe(404);
    }
  });

  it('trasa maszynowa nie przepuszcza bez basic auth', async () => {
    const p = zProforma();
    await wyslij(`/proformy/${p.id}/drukuj`);
    const r = await pobierz('/kolejka-druku-faktur/p1/pdf', {});
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('udawana proforma');
  });
});

describe('ostatniePozycjeDlaProform — stan druku dla listy proform karty', () => {
  it('oddaje najnowszą pozycję każdej proformy, pomija proformy bez pozycji', () => {
    const a = zProforma('2026-11-03T10:00:00.000Z');
    const b = zProforma('2026-11-04T10:00:00.000Z');
    const c = zProforma('2026-11-05T10:00:00.000Z');
    dodajProformeDoKolejki(db, a.id);
    const druga = dodajProformeDoKolejki(db, a.id);
    const dlaB = dodajProformeDoKolejki(db, b.id);
    const mapa = ostatniePozycjeDlaProform(db, [a.id, b.id, c.id]);
    expect(mapa).toBeInstanceOf(Map);
    expect([...mapa.keys()].sort()).toEqual([a.id, b.id]);
    expect(mapa.get(a.id).id).toBe(druga.id);
    expect(mapa.get(b.id).id).toBe(dlaB.id);
    expect(ostatniePozycjeDlaProform(db, []).size).toBe(0);
  });
});

describe('migracja rdzen/0009 — kolejka_druku_proform', () => {
  it('stara baza (1–8) dostaje tabelę bez zgłoszenia nieaddytywności; druga wykonaj nic nie psuje', () => {
    const kat = mkdtempSync(join(tmpdir(), 'oms-mig-0009-'));
    katalogi.push(kat);
    const plik = join(kat, 'oms.sqlite');
    const rdzenBez9 = { ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 9) };
    const stara = openOmsDb(plik, { moduly: [rdzenBez9] });
    expect(stara.prepare("SELECT name FROM sqlite_master WHERE name = 'kolejka_druku_proform'").get()).toBeUndefined();
    stara.close();

    const nowa = openOmsDb(plik);
    expect(nowa.prepare("SELECT numer FROM migracje WHERE modul = 'rdzen' AND numer = 9").get()).toEqual({ numer: 9 });
    const kolumny = nowa.prepare('PRAGMA table_info(kolejka_druku_proform)').all().map((k) => k.name);
    expect(kolumny).toEqual(['id', 'proforma_id', 'status', 'proby', 'ostatni_blad', 'nastepna_proba_at',
      'utworzone_at', 'wydrukowane_at', 'zajete_przez', 'zajete_at']);
    const fk = nowa.prepare('PRAGMA foreign_key_list(kolejka_druku_proform)').all();
    expect(fk).toMatchObject([{ table: 'proformy', from: 'proforma_id', to: 'id', on_delete: 'CASCADE' }]);
    const indeksy = nowa.prepare('PRAGMA index_list(kolejka_druku_proform)').all().map((i) => i.name);
    expect(indeksy).toContain('kolejka_druku_proform_status_proba');

    const z = zapiszZamowienie(nowa, 'pro', {
      zrodlo_id: 7, numer: 'PC-7', klient: {}, dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0,
      nip: null, kwota_brutto: '10.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null,
      anulowane: 0, utworzone_at: '2026-11-03T09:00:00', pozycje: [],
    }, {});
    const p = zapiszProforme(nowa, z, { kwotaBrutto: '10.00', rok: 2026, miesiac: 11 });
    dodajProformeDoKolejki(nowa, p.id);
    migracjaKolejkiDrukuProform.wykonaj(nowa);
    expect(nowa.prepare('SELECT COUNT(*) AS ile FROM kolejka_druku_proform').get().ile).toBe(1);
    nowa.close();
    // Ponowne otwarcie (migracja już zapisana) — bez błędu i bez zmian.
    const trzecia = openOmsDb(plik);
    expect(trzecia.prepare('SELECT COUNT(*) AS ile FROM kolejka_druku_proform').get().ile).toBe(1);
    trzecia.close();
  });
});

describe('karta zamówienia: przycisk „Drukuj” proformy (G16b)', () => {
  it('ważna proforma z plikiem ma formularz /proformy/:id/drukuj', async () => {
    const p = zProforma();
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro'); // czuwacz podłączony — inaczej karta mówi „brak drukarki”
    const r = await pobierz(`/zamowienia/${id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`action="/proformy/${p.id}/drukuj"`);
  });

  it('unieważniona proforma — bez przycisku', async () => {
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    const p = zProforma();
    uniewaznijPoprzednie(db, id);
    const r = await pobierz(`/zamowienia/${id}`);
    expect(r.body).not.toContain(`action="/proformy/${p.id}/drukuj"`);
  });

  it('proforma bez pliku — bez przycisku', async () => {
    await pobierz('/kolejka-druku-faktur?stanowisko=biuro');
    const p = zapiszProforme(db, id, { kwotaBrutto: '249.00', rok: 2026, miesiac: 11, utworzonaAt: '2026-11-03T10:00:00.000Z' });
    const r = await pobierz(`/zamowienia/${id}`);
    expect(r.body).not.toContain(`action="/proformy/${p.id}/drukuj"`);
  });
});
