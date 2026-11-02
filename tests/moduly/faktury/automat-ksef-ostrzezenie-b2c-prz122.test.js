// PRZ-122.TFeb: wydzielone przypadki wspólne; ciała bez zmian.
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKonsumenckie } from '../../../src/moduly/faktury/db/ksef-konsumenckie.js';
import { modelAutomatuKsef } from '../../../src/moduly/faktury/trasy/automat-ksef-ekran.js';
const otwarte = [];
afterEach(() => { while (otwarte.length) otwarte.pop().close(); });

describe('PRZ-122 B2C-QR — (d) ostrzeżenie na ekranie automatu KSeF', () => {
  const PARTIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/moduly/faktury/widoki/_automat-ksef.ejs');
  const TF = { opis: { wbudowany: true }, nazwa: { mianownik: 'TwojeFaktury', dopelniacz: 'TwojeFaktury', miejscownik: 'TwojeFaktury', narzednik: 'TwojeFaktury' } };
  const INFAKT = { opis: { wbudowany: false }, nazwa: { mianownik: 'inFakt', dopelniacz: 'inFaktu', miejscownik: 'inFakcie', narzednik: 'inFaktem' } };
  const konfiguracja = { odlaczonyDoRestartu: () => false, wymagaRestartu: () => false };
  const ZDANIE = 'Faktury konsumenckie (nabywca bez NIP-u) nie idą teraz do KSeF — PDF dla nabywcy będzie gotowy po włączeniu';
  function ekran(program, wlaczone) {
    const db = openOmsDb(':memory:');
    otwarte.push(db);
    if (wlaczone) zapiszKonsumenckie(db, true);
    const automat = modelAutomatuKsef({ db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => new Date('2026-10-28T09:00:00.000Z'), infakt: program });
    return ejs.renderFile(PARTIAL, { automat, konsumenckie: wlaczone, fmtDataCzas: (s) => String(s) });
  }

  it('TwojeFaktury, przełącznik wyłączony → jedno zdanie ostrzeżenia z miejscem w Ustawieniach', async () => {
    const html = await ekran(TF, false);
    expect(html).toContain('id="ksef-automat-konsumenckie"');
    expect(html).toContain(ZDANIE);
    expect(html.split(ZDANIE)).toHaveLength(2);
    // PRZ-126.J01: przy TwojeFaktury przełącznik stoi na ekranie Wysyłka do KSeF, nie na ekranie inFaktu.
    expect(html).toContain('Ustawienia → Integracje → Moduł faktur → Wysyłka do KSeF, sekcja „Faktury konsumenckie w KSeF”');
    expect(html).not.toContain('Sklepy i usługi');
  });

  it('TwojeFaktury z włączonym przełącznikiem i inFakt → bez zdania', async () => {
    expect(await ekran(TF, true)).not.toContain('ksef-automat-konsumenckie');
    expect(await ekran(INFAKT, false)).not.toContain('ksef-automat-konsumenckie');
  });
});
