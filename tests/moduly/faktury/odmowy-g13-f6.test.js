// PRZ-152.G13f6: tylko opakowanie odmów 62 i 80–84; bez sieci.
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeXML } from 'ejs';
import { nowyPanel, BASIC, post } from '../../pomoc/konta-prz068.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { wstrzymajFakture, zapiszTrybAutomatu, wczytajAutomatKsef } from '../../../src/moduly/faktury/db/ksef-automat.js';

const katalog = mkdtempSync(join(tmpdir(), 'oms-g13f6-'));
const PODGLAD = 'Nie przygotowano wysyłki do KSeF';
const WYSYLKA = 'Nie wysłano do KSeF';
const ZWOLNIENIE = 'Nie zwolniono faktury';
const BRAK = 'Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF. Klucz API inFaktu wpiszesz w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt).';
const OPIS = 'Faktura <Półcień> & "próba" jest niedostępna.';
let p;
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Sieć zabroniona'); }); });
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; vi.restoreAllMocks(); });
afterAll(() => rmSync(katalog, { recursive: true, force: true }));
function panel(opcje = {}) {
  p = nowyPanel({ env: { OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog }, ...opcje });
}
function sprawdz(r, status, tekst, tytul) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${escapeXML(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain('<a class="btn" href="/faktury">Wróć do faktur</a>');
  expect(globalThis.fetch).not.toHaveBeenCalled();
}
const zadanie = (trasa, payload = {}) => post(p.app, '/faktury/ksef/' + trasa, BASIC, payload);

for (const [nr, trasa, tytul] of [[82, 'podglad', PODGLAD], [84, 'wyslij', WYSYLKA]]) {
  it(`${nr}: brak usługi`, async () => { panel(); sprawdz(await zadanie(trasa), 503, BRAK, tytul); });
  it(`62: niedostępna wysyłka — ${trasa}`, async () => {
    const podglad = vi.fn(); const wyslij = vi.fn();
    panel({ wysylkaKsef: { niedostepna: OPIS, podglad, wyslij } });
    sprawdz(await zadanie(trasa, { uuid: 'polcien' }), 409, OPIS, WYSYLKA);
    expect(podglad).not.toHaveBeenCalled(); expect(wyslij).not.toHaveBeenCalled();
  });
}
it('80: brak identyfikatora zwolnienia', async () => {
  panel(); sprawdz(await zadanie('automat/zwolnij'), 400, 'Brak identyfikatora faktury do zwolnienia.', ZWOLNIENIE);
});
for (const [tryb, kod, koniec] of [
  ['reczna', 'odrzucona', 'bo KSeF odrzucił tę wersję. Popraw fakturę w zakładce FAKTURY i wyślij poprawioną wersję ręcznie.'],
  ['po_wystawieniu', 'odrzucona', 'bo KSeF odrzucił tę wersję. Popraw fakturę; nową wersję automat wyśle sam.'],
  ['reczna', 'nie-wyslano', 'bo nie ponawia tej samej wysyłki. Wyślij ją ręcznie bez zmian z zakładki FAKTURY.'],
]) it(`81: ${tryb}, ${kod} — wpis pozostaje`, async () => {
  panel();
  zapiszTrybAutomatu(p.db, { tryb, odstepEdycji: 15, login: 'operator' });
  wstrzymajFakture(p.db, { uuid: 'polcien', numer: '1/11/2026', dzien: '2026-11-05', powod: OPIS, kod });
  const przed = wczytajAutomatKsef(p.db);
  sprawdz(await zadanie('automat/zwolnij', { uuid: 'polcien' }), 409,
    'Tej faktury nie da się zwolnić — automat i tak jej nie wyśle, ' + koniec, ZWOLNIENIE);
  expect(wczytajAutomatKsef(p.db)).toEqual(przed);
});
for (const [blad, tekst] of [[bladOperatora(OPIS), OPIS], [new Error('Szczegóły techniczne'), 'błąd techniczny panelu — szczegóły w logu zamówienia.']]) {
  it(`83: odmowa podglądu — ${tekst}`, async () => {
    const podglad = vi.fn(async () => { throw blad; }); const wyslij = vi.fn();
    panel({ wysylkaKsef: { podglad, wyslij } });
    sprawdz(await zadanie('podglad', { uuid: 'polcien' }), 400, `Nie udało się przygotować wysyłki: ${tekst}`, PODGLAD);
    expect(podglad).toHaveBeenCalledTimes(1); expect(wyslij).not.toHaveBeenCalled();
  });
}
