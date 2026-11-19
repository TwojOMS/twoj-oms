import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-testowy-oms.ts';
import {
  przesun,
  ustawGlowne,
  przeniesPrzed,
  celUpuszczenia,
  zapiszKolejnosc,
  zapiszAi,
  utworzKolejnosc,
  licznik,
  kolejnyIndeks,
  podlaczGalerie,
} from '../../src/public/karta-galeria.js';

// Galeria na karcie produktu: logika przestawiania i zapisu jest w czystych funkcjach (repo nie ma biblioteki DOM),
// a widok sprawdzamy na HTML-u z serwera — w tym to, co musi działać bez skryptu.

describe('przestawianie kolejności', () => {
  it('przesuwa w lewo i w prawo, na brzegu nic nie zmienia', () => {
    expect(przesun([1, 2, 3], 2, 'lewo')).toEqual([2, 1, 3]);
    expect(przesun([1, 2, 3], 2, 'prawo')).toEqual([1, 3, 2]);
    expect(przesun([1, 2, 3], 1, 'lewo')).toEqual([1, 2, 3]);
    expect(przesun([1, 2, 3], 3, 'prawo')).toEqual([1, 2, 3]);
  });
  it('ustawia jako główne = na pierwsze miejsce, reszta w tej samej kolejności', () => {
    expect(ustawGlowne([1, 2, 3, 4], 3)).toEqual([3, 1, 2, 4]);
    expect(ustawGlowne([1, 2], 1)).toEqual([1, 2]);
  });
  it('przenosi przed albo za wskazane zdjęcie (przeciąganie)', () => {
    expect(przeniesPrzed([1, 2, 3, 4], 4, 2, false)).toEqual([1, 4, 2, 3]);
    expect(przeniesPrzed([1, 2, 3, 4], 1, 3, true)).toEqual([2, 3, 1, 4]);
    expect(przeniesPrzed([1, 2, 3], 2, 2, false)).toEqual([1, 2, 3]);
  });
  it('cel upuszczenia liczy z najbliższego środka miniatury, stronę z położenia w poziomie', () => {
    const prostokaty = [
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 110, top: 0, width: 100, height: 100 },
      { left: 0, top: 110, width: 100, height: 100 },
    ];
    expect(celUpuszczenia(prostokaty, 120, 40)).toEqual({ indeks: 1, po: false });
    expect(celUpuszczenia(prostokaty, 205, 60)).toEqual({ indeks: 1, po: true });
    expect(celUpuszczenia(prostokaty, 70, 190)).toEqual({ indeks: 2, po: true });
    expect(celUpuszczenia([], 0, 0)).toBeNull();
  });
});

describe('zapis bez przeładowania', () => {
  it('zachowuje wysłaną kolejność, gdy odpowiedź 200 nie zawiera pola kolejnosc', async () => {
    const wyslij = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(zapiszKolejnosc('/k', [2, 1], wyslij)).resolves.toEqual([2, 1]);
  });
  it('wysyła PEŁNĄ permutację polami `kolejnosc` i bierze kolejność z odpowiedzi serwera', async () => {
    const wyslij = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kolejnosc: [3, 1, 2] }) });
    await expect(zapiszKolejnosc('/magazyn/7/zdjecia/kolejnosc', [3, 1, 2], wyslij)).resolves.toEqual([3, 1, 2]);
    const [adres, opcje] = wyslij.mock.calls[0];
    expect(adres).toBe('/magazyn/7/zdjecia/kolejnosc');
    expect(opcje.method).toBe('POST');
    expect(opcje.headers.accept).toBe('application/json');
    expect(String(opcje.body)).toBe('kolejnosc=3&kolejnosc=1&kolejnosc=2');
  });
  it('odmowa serwera (409) daje jego komunikat, awaria sieci — ogólny', async () => {
    const odmowa = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ blad: 'Galeria zmieniła się — odśwież stronę.' }),
    });
    await expect(zapiszKolejnosc('/k', [1], odmowa)).rejects.toThrow('Galeria zmieniła się — odśwież stronę.');
    const awaria = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(zapiszKolejnosc('/k', [1], awaria)).rejects.toThrow(/Nie udało się zapisać kolejności/);
  });
  it('znacznik AI: zaznaczenie wysyła ai=1, odznaczenie — puste pole; 409 po wysyłce do kanału', async () => {
    const wyslij = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 5, ai: 1 }) });
    await expect(zapiszAi('/magazyn/7/zdjecia/5/ai', true, wyslij)).resolves.toBe(1);
    expect(String(wyslij.mock.calls[0][1].body)).toBe('ai=1');
    wyslij.mockResolvedValue({ ok: true, json: async () => ({ id: 5, ai: 0 }) });
    await expect(zapiszAi('/magazyn/7/zdjecia/5/ai', false, wyslij)).resolves.toBe(0);
    expect(String(wyslij.mock.calls[1][1].body)).toBe('');
    const odmowa = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ blad: 'Wysłane.' }) });
    await expect(zapiszAi('/k', true, odmowa)).rejects.toThrow('Wysłane.');
  });
  it('przestawia od razu, po zapisie ogłasza miejsce; przy błędzie wraca do starej kolejności i mówi dlaczego', async () => {
    const pokazane = [];
    const komunikaty = [];
    const zapisz = vi.fn().mockResolvedValue([2, 1, 3]);
    const k = utworzKolejnosc({
      ids: [1, 2, 3],
      zapisz,
      pokaz: (ids) => pokazane.push(ids),
      oglos: (tekst, blad) => komunikaty.push([tekst, Boolean(blad)]),
    });
    await k.zmien([2, 1, 3], 2);
    expect(zapisz).toHaveBeenCalledWith([2, 1, 3]);
    expect(pokazane).toEqual([
      [2, 1, 3],
      [2, 1, 3],
    ]);
    expect(k.ids()).toEqual([2, 1, 3]);
    expect(komunikaty.at(-1)).toEqual(['Zdjęcie jest teraz na miejscu 1 z 3 (główne). Zapisano.', false]);

    zapisz.mockRejectedValueOnce(new Error('Galeria zmieniła się — odśwież stronę.'));
    await k.zmien([2, 3, 1], 1);
    expect(pokazane.at(-1)).toEqual([2, 1, 3]);
    expect(k.ids()).toEqual([2, 1, 3]);
    expect(komunikaty.at(-1)).toEqual([
      'Nie zapisano kolejności: Galeria zmieniła się — odśwież stronę. Przywrócono poprzednią.',
      true,
    ]);
  });
  it('nie zaczyna drugiego zapisu, zanim skończy się pierwszy; brak zmiany nic nie wysyła', async () => {
    let skoncz;
    const zapisz = vi.fn(() => new Promise((r) => (skoncz = r)));
    const k = utworzKolejnosc({ ids: [1, 2], zapisz, pokaz: () => {}, oglos: () => {} });
    const pierwszy = k.zmien([2, 1], 2);
    expect(await k.zmien([1, 2], 1)).toBe(false);
    skoncz([2, 1]);
    await pierwszy;
    expect(zapisz).toHaveBeenCalledTimes(1);
    expect(await k.zmien([2, 1], 2)).toBe(false);
    expect(zapisz).toHaveBeenCalledTimes(1);
  });
});

describe('powiększenie', () => {
  it('licznik „3 / 7” i przechodzenie strzałkami w kółko', () => {
    expect(licznik(2, 7)).toBe('3 / 7');
    expect(kolejnyIndeks(6, 7, 1)).toBe(0);
    expect(kolejnyIndeks(0, 7, -1)).toBe(6);
    expect(kolejnyIndeks(3, 7, 1)).toBe(4);
  });
});

function element(selektory = {}) {
  const klasy = new Set();
  const sluchacze = {};
  return {
    children: [],
    dataset: {},
    classList: {
      add: (klasa) => klasy.add(klasa),
      remove: (...nazwy) => nazwy.forEach((klasa) => klasy.delete(klasa)),
      contains: (klasa) => klasy.has(klasa),
    },
    querySelector: (selektor) => selektory[selektor] ?? null,
    querySelectorAll: () => [],
    addEventListener: (typ, fn) => (sluchacze[typ] ??= []).push(fn),
    focus: vi.fn(),
    append(dziecko) {
      const rodzic = dziecko.parentElement;
      if (rodzic) rodzic.children.splice(rodzic.children.indexOf(dziecko), 1);
      this.children.push(dziecko);
      dziecko.parentElement = this;
    },
    wyslij(typ, pola = {}) {
      const zdarzenie = { target: this, preventDefault: vi.fn(), ...pola };
      sluchacze[typ]?.forEach((fn) => fn(zdarzenie));
      return zdarzenie;
    },
  };
}

function galeriaNaDom({ pusta = false } = {}) {
  const anuluj = element();
  const pytanie = element();
  const potwierdz = Object.assign(
    element({ '[data-anuluj]': anuluj, '[data-tak]': element(), '[data-pytanie]': pytanie, '[data-uwaga]': element() }),
    { hidden: true },
  );
  const obraz = { src: '/1.png', getAttribute: () => obraz.src, removeAttribute: vi.fn() };
  const podglad = Object.assign(element({ img: obraz }), { hidden: false });
  const zastepnik = { hidden: true };
  const lista = element();
  const li = [1, 2].map((id, i) => {
    const plakietka = { hidden: i !== 0 };
    const miniatura = element({ '[data-glowne]': plakietka });
    miniatura.dataset = { zdjecieId: String(id), adres: i ? '' : '/1.png' };
    miniatura.getBoundingClientRect = () => ({ left: i * 100, top: 0, width: 100, height: 100 });
    lista.append(miniatura);
    return miniatura;
  });
  const kosz = element();
  const formularz = (klasa) => {
    const form = element({ button: kosz });
    form.classList.add(klasa);
    form.closest = () => li[1];
    return form;
  };
  const uchwyt = { closest: () => li[0], setPointerCapture: vi.fn() };
  const dokument = element();
  const strefa = { contains: (cel) => cel === strefa, dispatchEvent: vi.fn() };
  const dodaj = Object.assign(element({ '.strefa-pliku': strefa }), { open: false });
  const sekcja = element();
  const pomocAi = { hidden: true };
  const korzen = element({
    'ol.karta-galeria': pusta ? null : lista,
    '[data-galeria-potwierdz]': potwierdz,
    'a[data-galeria-glowne]': podglad,
    '[data-galeria-brak-podgladu]': zastepnik,
    '.karta-galeria-dodaj': dodaj,
    '[data-galeria-ai-pomoc]': pomocAi,
  });
  korzen.closest = () => sekcja;
  korzen.ownerDocument = dokument;
  korzen.append(potwierdz);
  podlaczGalerie(korzen);
  const wskaznik = (pola = {}) => ({
    pointerId: 1,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    clientX: 5,
    clientY: 5,
    target: { closest: () => uchwyt },
    ...pola,
  });
  return {
    korzen,
    sekcja,
    lista,
    dokument,
    li,
    dodaj,
    strefa,
    pomocAi,
    podglad,
    zastepnik,
    formularz,
    potwierdz,
    anuluj,
    pytanie,
    kosz,
    wskaznik,
  };
}

describe('obsługa galerii w DOM', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['pointerup', 'pointercancel'])('%s poza listą kończy gest przed progiem, a kolejny gest działa', (typ) => {
    const g = galeriaNaDom();
    const wyslij = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kolejnosc: [2, 1] }) });
    vi.stubGlobal('fetch', wyslij);
    g.lista.wyslij('pointerdown', g.wskaznik());
    g.dokument.wyslij(typ, g.wskaznik({ buttons: 0 }));
    // Ponowne wejście z wciśniętym przyciskiem nie może wznowić zakończonego gestu.
    const ruch = g.wskaznik({ clientX: 175 });
    g.lista.wyslij('pointermove', ruch);
    g.dokument.wyslij('pointermove', ruch);
    expect(g.lista.classList.contains('karta-galeria--przeciaganie')).toBe(false);
    const najechanie = g.wskaznik({ buttons: 0, clientX: 175 });
    g.lista.wyslij('pointermove', najechanie);
    g.dokument.wyslij('pointermove', najechanie);
    expect(g.lista.classList.contains('karta-galeria--przeciaganie')).toBe(false);
    expect(wyslij).not.toHaveBeenCalled();

    g.lista.wyslij('pointerdown', g.wskaznik());
    g.dokument.wyslij('pointermove', ruch);
    expect(g.lista.classList.contains('karta-galeria--przeciaganie')).toBe(true);
    g.dokument.wyslij('pointerup', ruch);
    expect(wyslij).toHaveBeenCalledOnce();
  });

  it.each(['brak przycisku', 'utrata przechwycenia'])('%s anuluje aktywne przeciąganie bez zapisu', (przyczyna) => {
    const g = galeriaNaDom();
    const wyslij = vi.fn();
    vi.stubGlobal('fetch', wyslij);
    g.lista.wyslij('pointerdown', g.wskaznik());
    const ruch = g.wskaznik({ clientX: 175 });
    g.lista.wyslij('pointermove', ruch);
    g.dokument.wyslij('pointermove', ruch);
    expect(g.lista.classList.contains('karta-galeria--przeciaganie')).toBe(true);
    if (przyczyna === 'brak przycisku') {
      const bezPrzycisku = { ...ruch, buttons: 0 };
      g.lista.wyslij('pointermove', bezPrzycisku);
      g.dokument.wyslij('pointermove', bezPrzycisku);
    } else {
      g.lista.wyslij('lostpointercapture', ruch);
      g.dokument.wyslij('lostpointercapture', ruch);
    }
    expect(g.lista.classList.contains('karta-galeria--przeciaganie')).toBe(false);
    g.dokument.wyslij('pointerup', { ...ruch, buttons: 0 });
    expect(wyslij).not.toHaveBeenCalled();
  });

  it.each([false, true])('nad sekcją otwiera dodawanie plików i przekazuje drop do strefy (pusta: %s)', (pusta) => {
    const g = galeriaNaDom({ pusta });
    vi.stubGlobal(
      'DragEvent',
      class {
        constructor(type, { dataTransfer }) {
          Object.assign(this, { type, dataTransfer });
        }
      },
    );
    const dataTransfer = { types: ['Files'], files: [{ name: 'lampa.png' }] };
    expect(
      g.sekcja.wyslij('dragenter', { dataTransfer: { types: ['text/plain'] } }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(g.dodaj.open).toBe(false);
    for (const typ of ['dragenter', 'dragover']) {
      g.dodaj.open = false;
      expect(g.sekcja.wyslij(typ, { dataTransfer }).preventDefault).toHaveBeenCalledOnce();
      expect(g.dodaj.open).toBe(true);
    }
    expect(g.sekcja.wyslij('drop', { dataTransfer }).preventDefault).toHaveBeenCalledOnce();
    expect(g.strefa.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'drop', dataTransfer }));
    g.sekcja.wyslij('drop', { target: g.strefa, dataTransfer });
    expect(g.strefa.dispatchEvent).toHaveBeenCalledOnce();
    expect(g.pomocAi.hidden).toBe(false);
  });

  it('potwierdza usunięcie przy miniaturze i po anulowaniu oddaje fokus koszowi', () => {
    const g = galeriaNaDom();
    const form = g.formularz('karta-galeria-kosz');
    expect(g.lista.wyslij('submit', { target: form }).preventDefault).toHaveBeenCalledOnce();
    expect(g.potwierdz.parentElement).toBe(g.li[1]);
    expect(g.pytanie.textContent).toBe('Usunąć zdjęcie 2?');
    expect(g.potwierdz.hidden).toBe(false);
    expect(g.anuluj.focus).toHaveBeenCalledOnce();
    g.anuluj.wyslij('click');
    expect(g.potwierdz.hidden).toBe(true);
    expect(g.potwierdz.parentElement).toBe(g.korzen);
    expect(g.kosz.focus).toHaveBeenCalledOnce();
  });

  it('po przestawieniu pokazuje plakietkę tylko przy nowym zdjęciu głównym', () => {
    const g = galeriaNaDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kolejnosc: [2, 1] }) }));
    g.lista.wyslij('submit', { target: g.formularz('karta-galeria-na-glowne') });
    expect(g.lista.children).toEqual([g.li[1], g.li[0]]);
    expect(g.li.map((li) => li.querySelector('[data-glowne]').hidden)).toEqual([true, false]);
  });

  it('po przestawieniu zastępuje podgląd, jeśli nowe główne nie ma adresu', () => {
    const g = galeriaNaDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kolejnosc: [2, 1] }) }));
    g.lista.wyslij('submit', { target: g.formularz('karta-galeria-na-glowne') });
    expect(g.podglad.hidden).toBe(true);
    expect(g.zastepnik.hidden).toBe(false);
  });
});

describe('widok galerii na karcie', () => {
  const auth = {
    authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
    origin: 'http://localhost',
  };
  let db, app, katalog;
  const dodaj = (kolejnosc, wyslane = null) =>
    Number(
      db
        .prepare(
          `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at, wyslane_at)
          VALUES (1000, ?, 'reczne', ?, '2026-11-13', ?)`,
        )
        .run(kolejnosc, `https://obrazy.example/${kolejnosc}.png`, wyslane).lastInsertRowid,
    );
  const strona = async (url = '/magazyn/1000') => {
    const r = await app.inject({ url, headers: auth });
    expect(r.statusCode).toBe(200);
    return r.body;
  };
  const sekcja = (html) => html.match(/<section class="panel" id="zdjecia-karty">[\s\S]*?<\/section>/)?.[0] ?? '';
  const miniatury = (html) =>
    [...sekcja(html).matchAll(/<li class="karta-galeria-miniatura"[\s\S]*?<\/li>/g)].map((m) => m[0]);

  beforeEach(async () => {
    katalog = await mkdtemp(join(tmpdir(), 'karta-galeria-'));
    db = openOmsDb(':memory:');
    app = buildOmsServer({
      db,
      config: { auth: { user: 'operator', pass: 'atrapa' } },
      magazyn: {},
      env: { OMS_KATALOG_ZDJEC: katalog },
    });
    db.prepare(
      `INSERT INTO karty_produktow (id,nazwa,utworzony_at,zmieniony_at) VALUES (1000, 'Lampa Półcień', '2026-11-13', '2026-11-13')`,
    ).run();
  });
  afterEach(async () => {
    await app?.close();
    db?.close();
    await rm(katalog, { recursive: true, force: true });
  });

  it('kosz w rogu każdej miniatury: nazwa „Usuń zdjęcie N”, podpowiedź i ostrzeżenie o kanale do paska potwierdzenia', async () => {
    const [a, b] = [dodaj(0), dodaj(1, '2026-11-14')];
    const li = miniatury(await strona());
    expect(li).toHaveLength(2);
    li.forEach((html, i) => {
      const kosz = html.match(/<form[^>]*class="karta-galeria-kosz"[\s\S]*?<\/form>/)?.[0] ?? '';
      expect(kosz).toContain(`action="/magazyn/1000/zdjecia/${[a, b][i]}/usun"`);
      expect(kosz).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*aria-label="Usuń zdjęcie ${i + 1}"`));
      expect(kosz).toMatch(/title="Usuń zdjęcie"/);
      expect(kosz).toMatch(/<svg[^>]*aria-hidden="true"/);
    });
    expect(li[0]).not.toContain('data-uwaga=');
    expect(li[1]).toMatch(/data-uwaga="Zdjęcie jest w ofercie kanału — zniknie z karty\. /);
  });

  it('menu „⋯” działa bez skryptu: w lewo / w prawo, ustaw jako główne (pełna kolejność), znacznik AI', async () => {
    const ids = [dodaj(0), dodaj(1), dodaj(2, '2026-11-14')];
    const li = miniatury(await strona());
    const menu = li.map((html) => html.match(/<details class="karta-galeria-menu">[\s\S]*?<\/details>/)?.[0] ?? '');
    expect(menu[1]).toMatch(/<summary[^>]*aria-label="Więcej akcji — zdjęcie 2"/);
    expect(menu[1]).toContain(`<input type="hidden" name="zdjecieId" value="${ids[1]}">`);
    expect(menu[1]).toMatch(/name="kierunek" value="lewo"[^>]*>Przesuń w lewo</);
    expect(menu[1]).toMatch(/name="kierunek" value="prawo"[^>]*>Przesuń w prawo</);
    expect(menu[0]).toMatch(/value="lewo"[^>]*disabled/);
    expect(menu[2]).toMatch(/value="prawo"[^>]*disabled/);
    const glowne = menu[2].match(/<form[^>]*class="karta-galeria-na-glowne"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect([...glowne.matchAll(/name="kolejnosc" value="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ]);
    expect(glowne).toContain('Ustaw jako główne');
    expect(menu[0]).toMatch(/class="karta-galeria-na-glowne"[\s\S]*?<button[^>]*disabled/);
    expect(menu[1]).toContain(`action="/magazyn/1000/zdjecia/${ids[1]}/ai"`);
    expect(menu[2]).toContain('Zdjęcie poszło już do kanału');

    // Ten sam formularz „Ustaw jako główne” bez skryptu: pełna permutacja i powrót na kartę.
    const body = new URLSearchParams(ids.map((id, i) => ['kolejnosc', String(ids[(i + 2) % 3])])).toString();
    const r = await app.inject({
      method: 'POST',
      url: '/magazyn/1000/zdjecia/kolejnosc',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: body,
    });
    expect(r.statusCode).toBe(303);
    expect(miniatury(await strona())[0]).toContain(`data-zdjecie-id="${ids[2]}"`);
  });

  it('pierwsze zdjęcie jest główne: duży podgląd z nazwą karty, plakietka „główne” tylko na pierwszej miniaturze', async () => {
    dodaj(0);
    dodaj(1);
    const html = await strona();
    const s = sekcja(html);
    expect(s).toMatch(
      /<a class="karta-galeria-glowne" href="https:\/\/obrazy\.example\/0\.png"[^>]*>\s*<img src="https:\/\/obrazy\.example\/0\.png" alt="Lampa Półcień"/,
    );
    const li = miniatury(html);
    expect(li[0]).toMatch(/<span class="plakietka karta-galeria-plakietka" data-glowne>główne<\/span>/);
    expect(li[1]).toMatch(/<span class="plakietka karta-galeria-plakietka" data-glowne hidden>główne<\/span>/);
    expect(s).toMatch(/<ol class="karta-galeria"[^>]*aria-describedby="karta-galeria-pomoc"/);
    expect(s).toMatch(/id="karta-galeria-komunikat"[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('powiększenie w natywnym <dialog> z licznikiem i strzałkami; skrypt z wersją', async () => {
    dodaj(0);
    const html = await strona();
    const dialog = sekcja(html).match(/<dialog[\s\S]*?<\/dialog>/)?.[0] ?? '';
    expect(dialog).toMatch(/<dialog class="karta-galeria-dialog" aria-label="Powiększenie zdjęcia" closedby="any"/);
    expect(dialog).toMatch(/<form method="dialog">/);
    expect(dialog).toMatch(/aria-label="Poprzednie zdjęcie"/);
    expect(dialog).toMatch(/aria-label="Następne zdjęcie"/);
    expect(dialog).toContain('data-galeria-licznik');
    const src = html.match(/<script type="module" src="(\/public\/karta-galeria\.js\?v=[a-f0-9]{10})"><\/script>/)?.[1];
    expect(src).toBeTruthy();
    expect((await app.inject(src)).statusCode).toBe(200);
  });

  it('galeria stoi obok danych karty (przed nimi w kodzie, więc na wąskim ekranie nad nimi) — także w edycji', async () => {
    dodaj(0);
    for (const url of ['/magazyn/1000', '/magazyn/1000?edytuj=dane']) {
      const html = await strona(url);
      const uklad = html.indexOf('<div class="karta-dane-uklad">');
      expect(uklad).toBeGreaterThan(-1);
      expect(uklad).toBeLessThan(html.indexOf('id="zdjecia-karty"'));
      expect(html.indexOf('id="zdjecia-karty"')).toBeLessThan(html.indexOf('id="dane-karty"'));
      expect(html.split('id="zdjecia-karty"')).toHaveLength(2);
    }
    expect(await strona('/magazyn/1000?edytuj=dane')).toContain('panel--edycja');
  });
});
