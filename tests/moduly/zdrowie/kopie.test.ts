// PRZ-059: alarm starej kopii w /health (instalacja klienta). Nadzór włącza OMS_KOPIE_KATALOG
// (compose klienta); bez niego /health jest bajt w bajt taki jak dotąd — produkcja właściciela go nie ustawia.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/moduly/zdrowie/kopie.ts', async (oryginal) => {
  const m = await oryginal<typeof import('../../../src/moduly/zdrowie/kopie.ts')>();
  // Plik wydanie.json istnieje tylko w obrazie z paczki; w repo go nie ma. Atrapa odczytu = obraz z paczki.
  return { ...m, wersjaWydania: (plik: URL) => (process.env.TEST_WERSJA_WYDANIA ? process.env.TEST_WERSJA_WYDANIA : m.wersjaWydania(plik)) };
});
const { stanKopii, wersjaWydania, PROG_KOPII_H, ZNACZNIK_NOSNIKA } = await import('../../../src/moduly/zdrowie/kopie.ts');
const { zbudujOms } = await import('../../../src/oms/bootstrap.ts');

const katalogi: string[] = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); delete process.env.TEST_WERSJA_WYDANIA; vi.unstubAllGlobals(); });
const TERAZ = new Date('2026-10-10T12:00:00Z');
function katalog() { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-zdrowie-kopie-')); katalogi.push(k); return k; }
// Katalogi testu są na jednym dysku; nośnik (katalog „usb”) udaje osobne urządzenie.
const osobny = (usb: string) => (p: string) => (p.startsWith(usb) ? 2 : 1);
function kopia(k: string, nazwa: string, wiekH: number) {
  const p = path.join(k, nazwa); fs.writeFileSync(p, 'x');
  const t = new Date(TERAZ.getTime() - wiekH * 3600_000); fs.utimesSync(p, t, t);
}

describe('stanKopii', () => {
  it('świeża kopia lokalna i na nośniku: bez alarmów i uwag', () => {
    const lok = katalog(); const usb = katalog();
    kopia(lok, 'oms-2026-10-10.sqlite', 9); kopia(usb, 'oms-2026-10-10.sqlite', 9);
    fs.writeFileSync(path.join(usb, ZNACZNIK_NOSNIKA), '');
    expect(stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ, urzadzenie: osobny(usb) })).toEqual({ alarmy: [], uwagi: [] });
    // Znacznik jest, ale katalog na tym samym dysku co kopie lokalne: montowanie się nie udało.
    expect(stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ }).alarmy)
      .toEqual([`kopia poza dyskiem: ${usb} jest na tym samym dysku co ${lok} — nośnik niezamontowany`]);
  });

  it('kopia starsza niż 48 h alarmuje (lokalna i na nośniku osobno); o pliku decyduje data modyfikacji, nie nazwa', () => {
    expect(PROG_KOPII_H).toBe(48);
    const lok = katalog(); const usb = katalog();
    fs.writeFileSync(path.join(usb, ZNACZNIK_NOSNIKA), '');
    kopia(lok, 'oms-2026-10-10.sqlite', 49); kopia(usb, 'oms-2026-10-10.sqlite', 47);
    const s = stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ, urzadzenie: osobny(usb) });
    expect(s.alarmy).toEqual(['kopia bazy: najnowsza oms-2026-10-10.sqlite ma 49 h (próg 48 h)']);
    kopia(usb, 'oms-2026-10-10.sqlite', 50);
    expect(stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ, urzadzenie: osobny(usb) }).alarmy).toHaveLength(2);
  });

  it('brak kopii, brak nośnika i nieustawiony cel: każde jawnie', () => {
    const lok = katalog(); const usb = katalog();
    const bez = stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ });
    expect(bez.alarmy).toEqual([`kopia bazy: brak kopii w ${lok}`]);
    expect(bez.uwagi).toEqual(['kopia poza dyskiem: nieustawiona — awaria dysku serwera zabierze bazę razem z kopiami (OMS_KOPIA_ZEWNETRZNA)']);
    kopia(lok, 'oms-2026-10-10.sqlite', 1);
    // Pendrive niepodłączony: katalog istnieje (pusty, na dysku serwera), ale nie ma znacznika nośnika.
    expect(stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ }).alarmy)
      .toEqual([`kopia poza dyskiem: brak nośnika w ${usb} (brak pliku ${ZNACZNIK_NOSNIKA})`]);
    fs.writeFileSync(path.join(usb, ZNACZNIK_NOSNIKA), '');
    expect(stanKopii({ katalog: lok, zewnetrzna: usb, teraz: TERAZ, urzadzenie: osobny(usb) }).alarmy).toEqual([`kopia poza dyskiem: brak kopii w ${usb}`]);
    expect(stanKopii({ katalog: path.join(lok, 'nie-ma'), zewnetrzna: '', teraz: TERAZ }).alarmy[0]).toContain('niedostępny');
  });

  it('cudze pliki w katalogu kopii nie udają kopii', () => {
    const lok = katalog();
    kopia(lok, 'panel-2026-10-10.sqlite', 1); kopia(lok, 'oms-2026-10-10.sqlite.tmp', 1); kopia(lok, 'pliki-2026-10-10.tgz', 1);
    expect(stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ }).alarmy).toEqual([`kopia bazy: brak kopii w ${lok}`]);
  });

  it('wersjaWydania: pełny commit z wydanie.json albo null', () => {
    const k = katalog();
    const plik = path.join(k, 'wydanie.json');
    expect(wersjaWydania(new URL(`file://${plik.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`))).toBeNull();
    fs.writeFileSync(plik, JSON.stringify({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }));
    expect(wersjaWydania(new URL(`file://${plik.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`))).toBe('a'.repeat(40));
    fs.writeFileSync(plik, JSON.stringify({ commit: 'nie-sha' }));
    expect(wersjaWydania(new URL(`file://${plik.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`))).toBeNull();
  });
});

describe('/health z nadzorem kopii (kompozycja jak u klienta)', () => {
  const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: os.tmpdir(), OMS_ETYKIETY_KATALOG: os.tmpdir() };

  it('stara kopia → alarm i ok=false; brak celu zewnętrznego → uwaga; wersja wydania na końcu odpowiedzi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
    process.env.TEST_WERSJA_WYDANIA = 'c'.repeat(40);
    const lok = katalog();
    kopia(lok, 'oms-2026-10-07.sqlite', 72);
    const a = await zbudujOms({ env: { ...env, OMS_KOPIE_KATALOG: lok }, teraz: () => TERAZ });
    try {
      const r = await a.app.inject('/health');
      expect(r.statusCode).toBe(200);
      const j = r.json();
      expect(j.ok).toBe(false);
      expect(j.alarmy).toContain('kopia bazy: najnowsza oms-2026-10-07.sqlite ma 72 h (próg 48 h)');
      expect(j.uwagi).toContain('kopia poza dyskiem: nieustawiona — awaria dysku serwera zabierze bazę razem z kopiami (OMS_KOPIA_ZEWNETRZNA)');
      expect(j.wersja).toBe('c'.repeat(40));
      // Umowa z czujką monitoring: nowe pola po `poller`, nigdy między `uwagi` a `poller`.
      const klucze = Object.keys(j);
      expect(klucze.indexOf('wersja')).toBeGreaterThan(klucze.indexOf('poller'));
      expect(klucze.indexOf('poller')).toBe(klucze.indexOf('uwagi') + 1);
      kopia(lok, 'oms-2026-10-10.sqlite', 2);
      const usb = katalog(); fs.writeFileSync(path.join(usb, ZNACZNIK_NOSNIKA), ''); kopia(usb, 'oms-2026-10-10.sqlite', 2);
      // Świeża kopia lokalna; cel zewnętrzny nieustawiony (tylko uwaga) — bez alarmów kopii.
      expect((await a.app.inject('/health')).json().alarmy.filter((x: string) => x.startsWith('kopia'))).toEqual([]);
    } finally { await a.app.close(); a.db.close(); }
  });

  it('cel zewnętrzny ustawiony, nośnik bez znacznika → alarm w /health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
    const lok = katalog(); const usb = katalog();
    kopia(lok, 'oms-2026-10-10.sqlite', 2);
    const a = await zbudujOms({ env: { ...env, OMS_KOPIE_KATALOG: lok, OMS_KOPIA_ZEWNETRZNA: usb }, teraz: () => TERAZ });
    try {
      const j = (await a.app.inject('/health')).json();
      expect(j.ok).toBe(false);
      expect(j.alarmy).toContain(`kopia poza dyskiem: brak nośnika w ${usb} (brak pliku ${ZNACZNIK_NOSNIKA})`);
      expect(j).not.toHaveProperty('wersja');
    } finally { await a.app.close(); a.db.close(); }
  });

  it('bez OMS_KOPIE_KATALOG nadzoru nie ma (produkcja bez zmian), także gdy cel zewnętrzny wpisano', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
    const a = await zbudujOms({ env: { ...env, OMS_KOPIA_ZEWNETRZNA: katalog() }, teraz: () => TERAZ });
    try {
      const j = (await a.app.inject('/health')).json();
      expect([...j.alarmy, ...j.uwagi].filter((x: string) => x.startsWith('kopia'))).toEqual([]);
    } finally { await a.app.close(); a.db.close(); }
  });
});
