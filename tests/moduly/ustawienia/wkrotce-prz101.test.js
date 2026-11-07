// PRZ-101.01: strony „wkrótce” w Ustawieniach — jedna trasa, treść z jednej tablicy (domena/ustawienia-wkrotce.js).
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { STRONY_WKROTCE } from '../../../src/domena/ustawienia-wkrotce.js';
import { podmenuUstawien, modelNawigacjiUstawien } from '../../../src/domena/podmenu-ustawien.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

function panel(kopie, drukFaktur) {
  const nadpisania = {};
  if (kopie) nadpisania['zdrowie.kopie'] = kopie;
  if (drukFaktur !== undefined) nadpisania['faktury.stanDrukuFaktur'] = drukFaktur;
  const p = nowyPanel({ nadpisania });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const tresc = (html) => /<main class="kolumna-glowna[^"]*">([\s\S]*)<\/main>/u.exec(html)?.[1] ?? '';
const strona = (html) => /<section class="ust-sekcja ust-wkrotce">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

it('C05b: instrukcja faktur i brak usługi lub błąd nie psują strony', async () => {
  // null = modułu faktur bez usługi (wprost, bo po C05a prawdziwa usługa istnieje zawsze)
  for (const usluga of [null, () => { throw new Error('brak'); }]) {
    const { app, db, admin } = panel(undefined, usluga);
    try {
      const r = await get(app, '/ustawienia/druk', admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('id="faktury"');
      const lista = /<ol>([\s\S]*?)<\/ol>/u.exec(r.body)?.[1] ?? '';
      expect((lista.match(/<li>/gu) ?? []).length).toBeGreaterThanOrEqual(5);
      expect(r.body).not.toContain('deploy/drukarka/README.md');
      expect(r.body).toContain('Panel nie ma jeszcze danych o komputerach z drukarką');
    } finally { await app.close(); db.close(); }
  }
});

it('C05b: stan stanowisk jest odczytywany przy każdym żądaniu', async () => {
  let stan = { podlaczone: false, stanowiska: [] };
  const { app, db, admin } = panel(undefined, () => stan);
  try {
    expect((await get(app, '/ustawienia/druk', admin)).body).toContain('Żaden komputer z drukarką się nie zgłosił');
    stan = { podlaczone: true, stanowiska: [
      { nazwa: 'BIURO-1', at: '2026-10-29T10:00:00.000Z', minutTemu: 2, aktywne: true },
      { nazwa: '<inne>', at: '2026-10-29T09:00:00.000Z', minutTemu: 63, aktywne: false },
      { nazwa: 'BIURO-2', at: '2026-10-29T10:02:00.000Z', minutTemu: 0, aktywne: true },
    ] };
    const r = await get(app, '/ustawienia/druk', admin);
    expect(r.body).toMatch(/BIURO-1 — zgłosił się 2 min temu — aktywny<\/li>/u);
    expect(r.body).toMatch(/&lt;inne&gt; — zgłosił się 63 min temu — nieaktywny<\/li>/u);
    expect(r.body).toMatch(/BIURO-2 — zgłosił się przed chwilą — aktywny<\/li>/u);
  } finally { await app.close(); db.close(); }
});

it('PRZ-127: brak rzeczywistego katalogu nie staje się zielonym statusem z podmienionej usługi zdrowia', async () => {
  const { app, db, admin } = panel(() => ({katalogDostepny:true,zewnetrzna:true,zewnetrznaStan:'ok',ostatnia:{plik:'oms-2026-10-28.sqlite',wiekH:5}}));
  try {
    const r=await get(app,'/ustawienia/kopie',admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Nie skonfigurowano');
    expect(r.body).not.toContain('oms-2026-10-28.sqlite');
    expect(r.body).not.toContain('Pełna ochrona');
  } finally {await app.close();db.close();}
});

describe('PRZ-101.01 Ustawienia — strony „wkrótce”', () => {
  it('każda pozycja „wkrótce” w menu ma stronę i każda strona ma pozycję w menu', () => {
    const wMenu = podmenuUstawien('/ustawienia', { admin: true }).filter((p) => p.wkrotce).map((p) => p.href).sort();
    expect(STRONY_WKROTCE.filter((s) => !s.dziala).map((s) => s.href).sort()).toEqual(wMenu);
  });

  it.each(STRONY_WKROTCE.map((s) => [s.href, s]))('%s: 200, tytuł, opis, punkty, podświetlona pozycja menu', async (href, s) => {
    const { app, admin } = panel();
    const r = await get(app, href, admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain(`<title>${s.tytul}</title>`);
    const t = tresc(r.body);
    // PRZ-154 E2.1: w działach h1 należy do powłoki; strony bez działu mają własny h1.
    const dzial = modelNawigacjiUstawien(href, {admin: true}).dzialy?.find(d => d.aktywna);
    const zakladka = modelNawigacjiUstawien(href, {admin: true}).zakladki.find(z => z.aktywna);
    if (dzial && s.tytul === zakladka?.etykieta) expect(t).not.toContain(`<h2 class="naglowek-formularza">${s.tytul}</h2>`);
    else expect(t).toContain(dzial ? `<h2 class="naglowek-formularza">${s.tytul}</h2>` : `<h1>${s.tytul}</h1>`);
    const sekcja = strona(r.body);
    expect(sekcja).toContain(s.opis);
    for (const punkt of s.punkty) expect(sekcja).toContain(`<li>${punkt}</li>`);
    if (s.dzis) expect(sekcja).toContain(s.dzis);
    if (s.dziala) {
      // PRZ-126: Druk działa (drukowanie faktur) — bez ramki „nie działa” i bez plakietki „wkrótce” przy pozycji.
      expect(sekcja).not.toContain('Ten ekran jeszcze nie działa');
      expect(r.body).toContain(`href="${href}" aria-current="page"`);
      return;
    }
    expect(sekcja).toContain('Ten ekran jeszcze nie działa');
    expect(r.body).toContain('System'); // zapowiedzi poza kolumną działów
    expect(sekcja).toContain('Ten ekran jeszcze nie działa');
  });

  it('treść jest konkretna: 2–4 punkty, bez dat i obietnic', () => {
    // PRZ-102.01: Powiadomienia zastąpione działającym formularzem osobistym.
    expect(STRONY_WKROTCE).toHaveLength(3);
    for (const s of STRONY_WKROTCE) {
      expect(s.punkty.length).toBeGreaterThanOrEqual(2);
      expect(s.punkty.length).toBeLessThanOrEqual(4);
      const calosc = [s.opis, ...s.punkty, s.dzis ?? ''].join(' ');
      expect(calosc).not.toMatch(/\b20\d\d\b|wkrótce|niedługo|już niebawem|obiecujemy/iu);
    }
  });

  it('nieznany adres pod /ustawienia daje 404, nie stronę „wkrótce”', async () => {
    const { app, admin } = panel();
    expect((await get(app, '/ustawienia/nieznane', admin)).statusCode).toBe(404);
    expect((await get(app, '/ustawienia/druk/cos', admin)).statusCode).toBe(404);
  });

  it('strona jest tylko do oglądania — POST nie ma trasy', async () => {
    const { app, admin } = panel();
    expect((await post(app, '/ustawienia/kopie', admin)).statusCode).toBe(404);
  });

  it('konto bez uprawnienia „ustawienia” nie wchodzi', async () => {
    const { app, ewa } = panel();
    expect((await get(app, '/ustawienia/kopie', ewa)).statusCode).toBe(403);
  });
});
