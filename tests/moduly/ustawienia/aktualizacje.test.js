// PRZ-099: Ustawienia → Aktualizacje na prawdziwym serwerze — usługa `ustawienia.aktualizacje` podmieniona atrapą
// (bez pliku wydania i bez sieci).
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const COMMIT = 'abc123def4560000000000000000000000000000';
const WYDANIE = { commit: COMMIT, wersja: 'v0.2.0', utworzono: '2026-10-18T12:02:00Z' };
const jest = (wersja, opis = 'Nowy ekran.') => ({
  stan: 'jest', wersja, opublikowano: '2026-10-25T09:00:00Z', opis, adres: `https://github.com/TwojOMS/twoj-oms/releases/tag/${wersja}`,
});

function panel({ wydanie = null, wynik = { stan: 'brak-wydan' } } = {}) {
  const atrapa = { sprawdzen: 0, wydanie: () => wydanie, sprawdz: async () => { atrapa.sprawdzen += 1; return wynik; } };
  const p = nowyPanel({ nadpisania: { 'ustawienia.aktualizacje': atrapa } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'ustawienia']);
  return { ...p, atrapa, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

const sekcja = (html, id) => {
  const m = new RegExp(`<section class="ust-sekcja" id="${id}">[\\s\\S]*?<\\/section>`, 'u').exec(html);
  expect(m, `brak sekcji #${id}`).not.toBeNull();
  return m[0];
};
const AKTYWNA = /<li class="aktywna">\s*<a href="\/ustawienia\/aktualizacje">/u;
const INSTRUKCJA = 'href="https://github.com/TwojOMS/twoj-oms/blob/main/docs/aktualizacja-klienta-v0.md"';

describe('PRZ-099 Ustawienia → Aktualizacje', () => {
  it('bez pliku wydania: „Wersja: nieznana”, przycisk „Sprawdź teraz”, zapowiedź przycisku instalacji; GET nie pyta GitHuba', async () => {
    const { app, admin, atrapa } = panel();
    const r = await get(app, '/ustawienia/aktualizacje', admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toMatch(AKTYWNA);
    expect(sekcja(r.body, 'akt-instalacja')).toContain('Wersja: nieznana. Ten OMS nie został zainstalowany z paczki wydania, więc panel nie zna jego numeru.');
    const najnowsze = sekcja(r.body, 'akt-najnowsze');
    expect(najnowsze).toContain('action="/ustawienia/aktualizacje/sprawdz"');
    expect(najnowsze).toContain('Sprawdź teraz');
    expect(najnowsze).toContain('Panel łączy się z GitHubem tylko po kliknięciu.');
    const instalacja = sekcja(r.body, 'akt-jak');
    expect(instalacja).toContain('Instalacja jednym przyciskiem — funkcja wkrótce dostępna.');
    expect(instalacja).toContain(INSTRUKCJA);
    expect(atrapa.sprawdzen).toBe(0);
  });

  it('wydanie z numerem: wersja, skrócony commit i data paczki; wydanie bez numeru: commit', async () => {
    const p1 = panel({ wydanie: WYDANIE });
    const s1 = sekcja((await get(p1.app, '/ustawienia/aktualizacje', p1.admin)).body, 'akt-instalacja');
    expect(s1).toContain('Wersja: v0.2.0');
    expect(s1).toContain('commit abc123def456');
    expect(s1).toContain('paczka z 2026-10-18 14:02');
    const p2 = panel({ wydanie: { ...WYDANIE, wersja: null } });
    expect(sekcja((await get(p2.app, '/ustawienia/aktualizacje', p2.admin)).body, 'akt-instalacja'))
      .toContain('Wersja: bez numeru (commit abc123def456)');
  });

  it('„Sprawdź teraz”: nowsze wydanie z opisem i linkiem; ta sama wersja → „Masz najnowszą”', async () => {
    const p = panel({ wydanie: WYDANIE, wynik: jest('v0.3.0') });
    const r = await post(p.app, '/ustawienia/aktualizacje/sprawdz', p.admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toMatch(AKTYWNA);
    const s = sekcja(r.body, 'akt-najnowsze');
    expect(s).toContain('Dostępna jest nowsza wersja: v0.3.0 z 2026-10-25.');
    expect(s).toContain('<pre class="opis-wydania">Nowy ekran.</pre>');
    expect(s).toContain('href="https://github.com/TwojOMS/twoj-oms/releases/tag/v0.3.0"');
    expect(p.atrapa.sprawdzen).toBe(1);

    const q = panel({ wydanie: WYDANIE, wynik: jest('v0.2.0') });
    const s2 = sekcja((await post(q.app, '/ustawienia/aktualizacje/sprawdz', q.admin)).body, 'akt-najnowsze');
    expect(s2).toContain('Masz najnowszą wersję (v0.2.0).');
    expect(s2).not.toContain('Dostępna jest nowsza');
  });

  it('instalacja bez numeru: najnowsze wydanie bez porównania', async () => {
    const p = panel({ wynik: jest('v0.3.0') });
    const s = sekcja((await post(p.app, '/ustawienia/aktualizacje/sprawdz', p.admin)).body, 'akt-najnowsze');
    expect(s).toContain('Najnowsze wydanie: v0.3.0 z 2026-10-25. Nie da się porównać z tą instalacją, bo nie ma ona numeru wersji.');
    expect(s).not.toContain('Masz najnowszą');
  });

  it('opis wydania z GitHuba jest tekstem, nie HTML-em', async () => {
    const p = panel({ wydanie: WYDANIE, wynik: jest('v0.3.0', '<script>alert(1)</script>') });
    const r = await post(p.app, '/ustawienia/aktualizacje/sprawdz', p.admin);
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.body).not.toContain('<script>alert(1)');
  });

  it.each([
    [{ stan: 'brak-wydan' }, 'W repozytorium nie ma jeszcze opublikowanych wydań.'],
    [{ stan: 'limit' }, 'GitHub chwilowo ogranicza liczbę zapytań. Spróbuj ponownie za godzinę.'],
    [{ stan: 'blad' }, 'Nie udało się połączyć z GitHubem. Sprawdź połączenie serwera z internetem i spróbuj później.'],
  ])('wynik %o → zdanie dla człowieka', async (wynik, zdanie) => {
    const p = panel({ wydanie: WYDANIE, wynik });
    const r = await post(p.app, '/ustawienia/aktualizacje/sprawdz', p.admin);
    expect(r.statusCode).toBe(200);
    expect(sekcja(r.body, 'akt-najnowsze')).toContain(zdanie);
    expect(sekcja(r.body, 'akt-jak')).toContain('funkcja wkrótce dostępna');
  });

  it('konto z ptaszkiem Ustawień, ale bez admina → 403 na GET i POST, GitHub niepytany', async () => {
    const p = panel({ wynik: jest('v0.3.0') });
    expect((await get(p.app, '/ustawienia/aktualizacje', p.ewa)).statusCode).toBe(403);
    expect((await post(p.app, '/ustawienia/aktualizacje/sprawdz', p.ewa)).statusCode).toBe(403);
    expect(p.atrapa.sprawdzen).toBe(0);
    // Pozycji nie ma też w podmenu nie-admina.
    const r = await get(p.app, '/ustawienia/magazyn', p.ewa);
    expect(r.body).not.toContain('href="/ustawienia/aktualizacje"');
  });
});
