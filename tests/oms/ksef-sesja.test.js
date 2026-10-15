import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createSesjaKsef } from '../../src/oms/ksef/sesja.js';

const klientAtrapa = (slad) => ({
  zaloguj: async () => { slad.push('zaloguj'); return { accessToken: 'A1', accessDo: '2026-08-12T21:00:00Z', refreshToken: 'R1', refreshDo: '2026-09-12T21:00:00Z' }; },
  odswiez: async () => { slad.push('odswiez'); return { accessToken: 'A2', accessDo: '2026-08-12T23:00:00Z' }; },
});

describe('sesja KSeF', () => {
  it('bez zapisanej pary loguje sie od nowa i zapisuje OBA tokeny', async () => {
    const db = openOmsDb(); const slad = [];
    const sesja = createSesjaKsef({ db, klient: klientAtrapa(slad), teraz: () => new Date('2026-08-12T18:00:00Z') });
    expect(await sesja.accessToken()).toBe('A1');
    expect(slad).toEqual(['zaloguj']);
    const w = db.prepare('SELECT * FROM tokeny_ksef WHERE id = 1').get();
    expect(w.refresh_token).toBe('R1');
  });

  it('wazny access token uzywa sie ponownie, bez ani jednego wywolania sieci', async () => {
    const db = openOmsDb(); const slad = [];
    const sesja = createSesjaKsef({ db, klient: klientAtrapa(slad), teraz: () => new Date('2026-08-12T18:00:00Z') });
    await sesja.accessToken();
    slad.length = 0;
    expect(await sesja.accessToken()).toBe('A1');
    expect(slad).toEqual([]);
  });

  it('access token blisko wygasniecia ODSWIEZA sie, nie loguje od nowa', async () => {
    const db = openOmsDb(); const slad = [];
    let chwila = new Date('2026-08-12T18:00:00Z');
    const sesja = createSesjaKsef({ db, klient: klientAtrapa(slad), teraz: () => chwila });
    await sesja.accessToken();
    slad.length = 0;
    // 21:00 minus zapas 5 min — 20:56 juz kwalifikuje do odswiezenia
    chwila = new Date('2026-08-12T20:56:00Z');
    expect(await sesja.accessToken()).toBe('A2');
    expect(slad).toEqual(['odswiez']);
  });

  it('wygasly REFRESH oznacza pelne logowanie, nie proba odswiezenia', async () => {
    const db = openOmsDb(); const slad = [];
    let chwila = new Date('2026-08-12T18:00:00Z');
    const sesja = createSesjaKsef({ db, klient: klientAtrapa(slad), teraz: () => chwila });
    await sesja.accessToken();
    slad.length = 0;
    chwila = new Date('2026-10-01T10:00:00Z');
    await sesja.accessToken();
    expect(slad).toEqual(['zaloguj']);
  });

  it('W1: nieudane odswiezenie prowadzi do JEDNEJ proby pelnego logowania, nie do martwej sesji', async () => {
    const db = openOmsDb(); const slad = [];
    let chwila = new Date('2026-08-12T18:00:00Z');
    const klient = {
      zaloguj: async () => { slad.push('zaloguj'); return { accessToken: 'A1', accessDo: '2026-08-12T21:00:00Z', refreshToken: 'R1', refreshDo: '2026-09-12T21:00:00Z' }; },
      odswiez: async () => { slad.push('odswiez'); throw new Error('KSeF odmawia odswiezenia'); },
    };
    const sesja = createSesjaKsef({ db, klient, teraz: () => chwila });
    await sesja.accessToken();
    slad.length = 0;
    // refresh_do jeszcze daleki, ale access_do juz blisko wygasniecia -> proba odswiezenia
    chwila = new Date('2026-08-12T20:56:00Z');
    expect(await sesja.accessToken()).toBe('A1');
    expect(slad).toEqual(['odswiez', 'zaloguj']);
  });

  it('W1: gdy padnie i odswiezenie, i pelne logowanie, blad wychodzi na zewnatrz bez trzeciej proby', async () => {
    const db = openOmsDb(); const slad = [];
    let chwila = new Date('2026-08-12T18:00:00Z');
    const klientDobry = {
      zaloguj: async () => { slad.push('zaloguj'); return { accessToken: 'A1', accessDo: '2026-08-12T21:00:00Z', refreshToken: 'R1', refreshDo: '2026-09-12T21:00:00Z' }; },
      odswiez: async () => { slad.push('odswiez'); throw new Error('KSeF odmawia odswiezenia'); },
    };
    const sesja = createSesjaKsef({ db, klient: klientDobry, teraz: () => chwila });
    await sesja.accessToken();
    slad.length = 0;

    const sesjaZObomaBledami = createSesjaKsef({
      db,
      klient: {
        zaloguj: async () => { slad.push('zaloguj'); throw new Error('redeem juz zuzyty'); },
        odswiez: async () => { slad.push('odswiez'); throw new Error('KSeF odmawia odswiezenia'); },
      },
      teraz: () => chwila,
    });
    chwila = new Date('2026-08-12T20:56:00Z');
    await expect(sesjaZObomaBledami.accessToken()).rejects.toThrow('redeem juz zuzyty');
    expect(slad).toEqual(['odswiez', 'zaloguj']);
  });

  it('W2: dwa rownolegle accessToken() na pustej bazie daja JEDNO zaloguj() i ten sam token', async () => {
    const db = openOmsDb(); const slad = [];
    const sesja = createSesjaKsef({ db, klient: klientAtrapa(slad), teraz: () => new Date('2026-08-12T18:00:00Z') });
    const [a, b] = await Promise.all([sesja.accessToken(), sesja.accessToken()]);
    expect(a).toBe('A1');
    expect(b).toBe('A1');
    expect(slad).toEqual(['zaloguj']);
  });

  it('nieudane logowanie zapisuje tresc bledu w ostatni_blad', async () => {
    const db = openOmsDb(); const slad = [];
    let chwila = new Date('2026-08-12T18:00:00Z');
    const klientDobry = klientAtrapa(slad);
    const sesja = createSesjaKsef({ db, klient: klientDobry, teraz: () => chwila });
    await sesja.accessToken();
    slad.length = 0;

    const sesjaZBledem = createSesjaKsef({
      db,
      klient: {
        zaloguj: async () => { throw new Error('redeem juz zuzyty'); },
        odswiez: async () => { throw new Error('KSeF odmawia odswiezenia'); },
      },
      teraz: () => chwila,
    });
    chwila = new Date('2026-08-12T20:56:00Z');
    await expect(sesjaZBledem.accessToken()).rejects.toThrow();

    const w = db.prepare('SELECT * FROM tokeny_ksef WHERE id = 1').get();
    expect(w.ostatni_blad).toContain('redeem juz zuzyty');
    // niezmiennik 4.10: blad nie niesie tokenow
    expect(w.ostatni_blad).not.toContain('A1');
    expect(w.ostatni_blad).not.toContain('R1');
  });
});
