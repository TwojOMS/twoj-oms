// PRZ-118.10 (poprawka z recenzji 09): stary adres zapisu automatu KSeF (`POST /ustawienia/integracje/infakt/ksef-automat`,
// trasy/ustawienia-infakt.js) przy błędzie formularza odpowiada 400 z ekranem Automatyzacji. Ten ekran bierze nazwę
// programu z usługi `infakt` modułu faktur; trasa rejestrowana w faktury/modul.ts jej nie dostawała, więc przy programie
// innym niż inFakt 400 mówiło „inFakt”, a nowy adres (`/ustawienia/automatyzacje/ksef`) — nazwę programu.
// Program testowy („Testownik”) przez szew `fabryki.programFakturowy` (tylko OMS_TRYB=proba); nic nie wychodzi z procesu.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';
import { wczytajAutomatKsef, wstrzymajFakture } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const STARY_ZAPIS = '/ustawienia/integracje/infakt/ksef-automat';
const NOWY_ZAPIS = '/ustawienia/automatyzacje/ksef';
const sekcjaAutomatu = (html) => /<section class="ust-sekcja[^"]*" id="ksef-automat">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

describe('PRZ-118.10 — 400 starego adresu zapisu automatu KSeF mówi nazwą programu', () => {
  let katalog;
  let a;
  beforeAll(async () => {
    katalog = mkdtempSync(join(tmpdir(), 'prz118-10-'));
    const env = {
      OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      OMS_TRYB: 'proba',
    };
    const fabryki = { programFakturowy: () => programTestowy(), createVies: () => createAtrapaVies({ env }) };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
    a = await zbudujOms({ env, moduly, teraz: () => new Date('2026-10-15T10:00:00.000Z'), log: () => {} });
    // Nazwa programu stoi w sekcji automatu przy wstrzymanych fakturach („Testownik je odrzucił … Popraw w Testowniku”).
    wstrzymajFakture(a.db, { uuid: 'dok-wstrzymany-8', numer: 'FV 8/10/2026', dzien: '2026-10-14', powod: 'nabywca bez adresu' });
  });
  afterAll(async () => {
    await a?.app.close(); a?.db.close();
    rmSync(katalog, { recursive: true, force: true });
  });

  const zapisz = (url, pola) => a.app.inject({ method: 'POST', url, headers: POST, payload: new URLSearchParams(pola).toString() });

  it.each([[STARY_ZAPIS], [NOWY_ZAPIS]])('%s: zła godzina → 400, sekcja automatu mówi „Testownik”, ani jednego „inFak…”', async (url) => {
    const przed = wczytajAutomatKsef(a.db);
    const r = await zapisz(url, { wlaczony: '1', godzina: '25:00' });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(400);
    const sekcja = sekcjaAutomatu(r.body);
    expect(sekcja).not.toBe('');
    expect(sekcja).toContain('Wstrzymane faktury (Testownik je odrzucił');
    expect(sekcja).toContain('Popraw w Testowniku');
    expect([...r.body.matchAll(/.{0,80}inFak.{0,40}/g)].map((m) => m[0].trim())).toEqual([]);
    expect(wczytajAutomatKsef(a.db)).toEqual(przed);
  });
});
