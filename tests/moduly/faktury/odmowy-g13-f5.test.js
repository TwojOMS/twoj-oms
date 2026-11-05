// PRZ-152.G13f5: status i tekst bez zmian, odmowy ustawień faktur w układzie OMS.
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeXML } from 'ejs';
import { nowyPanel, jako, post } from '../../pomoc/konta-prz068.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';

const FIRMA = '/ustawienia/firma';
const INFAKT = '/ustawienia/integracje/infakt';
const PROGRAM = '/ustawienia/integracje/program-fakturowy';
const katalog = mkdtempSync(join(tmpdir(), 'oms-g13f5-'));
const TOKEN = 'zmyslony-klucz-g13f5';
const HASLO = 'zmyslone-haslo-g13f5';
const VAT = { tytul: 'Nie zapisano ustawień VAT', wroc: '/ustawienia/faktury/vat', napis: 'Wróć do ustawień VAT' };
const REJESTROWE = { tytul: 'Nie zapisano danych rejestrowych', wroc: '/ustawienia/firma/rejestrowe', napis: 'Wróć do danych rejestrowych' };
const RACHUNEK = { tytul: 'Nie zapisano rachunku firmy', wroc: '/ustawienia/firma/rachunek', napis: 'Wróć do rachunku bankowego' };
const EKRAN = { '/rachunek': RACHUNEK, '/rachunek/usun': RACHUNEK, '/stawka-vat': VAT, '/zwolnienie-vat': VAT, '/nip': REJESTROWE, '/bdo': REJESTROWE };
let p;
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Sieć zabroniona'); }); });
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; vi.restoreAllMocks(); });
afterAll(() => rmSync(katalog, { recursive: true, force: true }));

async function odmowa({ env = {}, url, status, tekst, wroc = FIRMA, tytul = 'Nie zapisano danych firmy', napis = 'Wróć do ustawień firmy', admin = true }) {
  p = nowyPanel({ env: { OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, INFAKT_API_KEY: TOKEN, ...env } });
  zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: HASLO, rola: admin ? 'administrator' : 'sprzedaz', admin });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'operator').id, ['ustawienia']);
  const r = await post(p.app, url, jako(p.db, 'operator'));
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${escapeXML(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napis}</a>`);
  expect(r.body).not.toContain(TOKEN);
  expect(r.body).not.toContain(HASLO);
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

for (const [sciezka, tekst] of [
  ['/rachunek', 'Rachunek firmy zmienia tylko administrator. Formularz niczego nie zapisał.'],
  ['/rachunek/usun', 'Rachunek firmy zmienia tylko administrator. Formularz niczego nie zapisał.'],
  ['/stawka-vat', 'Domyślną stawkę VAT zmienia tylko administrator. Formularz niczego nie zapisał.'],
  ['/zwolnienie-vat', 'Zwolnienie z VAT zmienia tylko administrator. Formularz niczego nie zapisał.'],
  ['/nip', 'NIP i BDO firmy zmienia tylko administrator. Formularz niczego nie zapisał.'],
  ['/bdo', 'NIP i BDO firmy zmienia tylko administrator. Formularz niczego nie zapisał.'],
]) {
  it(`101 tekst(): 403 ${sciezka}`, () => odmowa({ url: `${FIRMA}${sciezka}`, admin: false, status: 403, tekst, ...EKRAN[sciezka] }));
}

for (const [sciezka, env, tekst] of [
  ['/rachunek', { OMS_BANK: 'Bank Przykładowy' }, 'Rachunek firmy jest ustawiony w pliku konfiguracji (OMS_RACHUNEK / OMS_BANK w oms.env) — tam go zmień. Formularz niczego nie zapisał.'],
  ['/nip', { OMS_SPRZEDAWCA_NIP: '1234563218' }, 'NIP firmy jest ustawiony w pliku konfiguracji (OMS_SPRZEDAWCA_NIP w oms.env) — tam go zmień. Formularz niczego nie zapisał.'],
  ['/bdo', { OMS_SPRZEDAWCA_BDO: '000123456' }, 'Numer BDO jest ustawiony w pliku konfiguracji (OMS_SPRZEDAWCA_BDO w oms.env) — tam go zmień. Formularz niczego nie zapisał.'],
  ['/zwolnienie-vat', { OMS_PROGRAM_FAKTUROWY: 'infakt' }, 'Zwolnienie z VAT ustawiasz tylko przy programie TwojeFaktury — w innym programie fakturowym ustaw je u niego. Formularz niczego nie zapisał.'],
]) {
  it(`101 tekst(): 409 ${sciezka}`, () => odmowa({ url: `${FIRMA}${sciezka}`, env, status: 409, tekst, ...EKRAN[sciezka] }));
}

it('102 adres firmy z pliku: 409', () => odmowa({ url: FIRMA, env: { DPD_NADAWCA_NAZWA: 'Przykładowa Pracownia' }, status: 409,
  tekst: 'Adres firmy jest ustawiony w pliku konfiguracji (DPD_NADAWCA_… w oms.env) — tam go zmień. Formularz niczego nie zapisał.' }));
it('103 inFakt z pliku: 409', () => odmowa({ url: INFAKT, status: 409,
  tekst: 'inFakt jest ustawiony w pliku konfiguracji (oms.env, INFAKT_API_KEY) — tam go zmień. Formularz niczego nie zapisał.',
  tytul: 'Nie zapisano ustawień inFaktu', wroc: INFAKT, napis: 'Wróć do ustawień inFaktu' }));
it('104 program z pliku: 409', () => odmowa({ url: PROGRAM, env: { OMS_PROGRAM_FAKTUROWY: 'infakt' }, status: 409,
  tekst: 'Moduł faktur jest ustawiony w pliku konfiguracji (OMS_PROGRAM_FAKTUROWY) — tam go zmień. Formularz niczego nie zapisał.',
  tytul: 'Nie zmieniono programu faktur', wroc: PROGRAM, napis: 'Wróć do ustawień programu faktur' }));
it('105 restart wyłączony: 404', () => odmowa({ url: `${PROGRAM}/restart`, env: { OMS_RESTART_Z_PANELU: '' }, status: 404,
  tekst: 'Ponowne uruchomienie z panelu jest wyłączone (OMS_RESTART_Z_PANELU) — uruchom ponownie OMS na serwerze.',
  tytul: 'Nie uruchomiono OMS ponownie', wroc: PROGRAM, napis: 'Wróć do ustawień programu faktur' }));
it('106 serie: 403', () => odmowa({ url: `${PROGRAM}/serie`, env: { OMS_TWOJEFAKTURY: 'tak', OMS_PROGRAM_FAKTUROWY: 'twojefaktury' }, admin: false, status: 403,
  tekst: 'Serie numeracji zmienia administrator.', tytul: 'Nie zapisano serii numeracji', wroc: `${PROGRAM}/serie`, napis: 'Wróć do ustawień serii numeracji' }));
