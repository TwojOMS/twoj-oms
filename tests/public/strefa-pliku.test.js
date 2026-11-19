import { describe, it, expect, vi } from 'vitest';
import { podlaczStrefePliku, opcjeZAtrybutow, sprawdzPliki } from '../../src/public/strefa-pliku.js';
import { podlaczStrefe as podlaczStrefeLogo, adresStrefy } from '../../src/public/logo-przeciaganie.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Wspólna strefa przeciągania plików. Karta produktu → Zdjęcia: wiele plików naraz,
// limit 10 MB na plik i limit wolnego miejsca (20 − zdjęcia na karcie). Repo nie ma biblioteki DOM, więc jak w teście
// logo: atrapy elementów. Upuszczone pliki trafiają do TEGO SAMEGO pola `multiple` (przez DataTransfer).

const MB = 1024 * 1024;
const plik = (nazwa = 'stol.jpg', rozmiar = 2 * MB, typ = 'image/jpeg') => ({ name: nazwa, size: rozmiar, type: typ });

function klasy() {
  const zbior = new Set();
  return { add: (k) => zbior.add(k), remove: (k) => zbior.delete(k), contains: (k) => zbior.has(k) };
}
function element(tag) {
  const el = {
    tag,
    textContent: '',
    className: '',
    hidden: false,
    attrs: {},
    children: [],
    dataset: {},
    classList: klasy(),
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    append(...d) {
      this.children.push(...d);
    },
    // Atrapa parsera: wstawienie HTML-a tworzy elementy z jego znaczników (jak przeglądarka) i zostawia ślad.
    set innerHTML(html) {
      this.htmlWstawiony = html;
      this.children = [...String(html).matchAll(/<(\w+)/g)].map((m) => element(m[1]));
    },
    replaceChildren(...d) {
      this.children = [...d];
    },
    addEventListener(t, f) {
      (this.sl ??= {})[t] = f;
    },
    querySelector(tag) {
      return this.children.find((dziecko) => dziecko.tag === tag);
    },
    focus: vi.fn(),
  };
  return el;
}
const dokument = { createElement: (t) => element(t) };

function strefa({ maksPlikow = 20, multiple = true } = {}) {
  const sluchacze = {};
  const pole = {
    files: [],
    value: '',
    multiple,
    disabled: false,
    getAttribute: (k) => (k === 'accept' ? 'image/jpeg,image/png,image/webp' : null),
    addEventListener(t, f) {
      (this.sl ??= {})[t] = f;
    },
  };
  const stan = element('p');
  const lista = element('ul');
  lista.hidden = true;
  const przycisk = element('button');
  przycisk.textContent = 'Wgraj zdjęcia';
  const el = {
    dataset: { maksPlikow: String(maksPlikow), maksBajtow: String(10 * MB), opisTypow: 'JPEG, PNG lub WebP' },
    classList: klasy(),
    ownerDocument: dokument,
    addEventListener(t, f) {
      sluchacze[t] = f;
    },
    contains: (cel) => cel?.wewnatrz === true,
    closest: (s) => (s === 'form' ? { querySelector: (q) => (q.includes('przycisk') ? przycisk : null) } : null),
    querySelector: (s) => (s.includes('input') ? pole : s.includes('stan') ? stan : s.includes('lista') ? lista : null),
  };
  return {
    el,
    pole,
    stan,
    lista,
    przycisk,
    wyslij: (typ, zd = {}) => sluchacze[typ]?.({ preventDefault: vi.fn(), ...zd }),
  };
}
function srodowisko() {
  const dt = {
    items: {
      dodane: [],
      add(f) {
        this.dodane.push(f);
      },
    },
    get files() {
      return [...this.items.dodane];
    },
  };
  let n = 0;
  return {
    DataTransfer: function DataTransfer() {
      dt.items.dodane = [];
      return dt;
    },
    URL: { createObjectURL: vi.fn(() => `blob:miniatura-${++n}`), revokeObjectURL: vi.fn() },
    dt,
  };
}
const upuszczenie = (pliki, typy = ['Files']) => ({ dataTransfer: { files: pliki, types: typy, dropEffect: '' } });
const podlacz = (s, env) => podlaczStrefePliku(s.el, opcjeZAtrybutow(s.el), env);

describe('opcjeZAtrybutow', () => {
  it('typy z atrybutu accept pola, limity z data-*, wiele z multiple', () => {
    const s = strefa({ maksPlikow: 7 });
    const o = opcjeZAtrybutow(s.el);
    expect(o.typy).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(o.maksBajtow).toBe(10 * MB);
    expect(o.maksPlikow).toBe(7);
    expect(o.wiele).toBe(true);
  });
});

it('nowa karta dopisuje zdjęcia, zachowuje ich znaczniki AI i aktualizuje indeks po usunięciu', () => {
  const s = strefa();
  s.el.dataset.aiNaPlik = '';
  podlacz(s, srodowisko());
  const a = plik('pierwsze.jpg');
  const b = plik('drugie.jpg');
  const c = plik('trzecie.jpg');
  s.wyslij('drop', upuszczenie([a, b]));
  const znacznik = (i) => s.lista.children[i].querySelector('label').querySelector('input');
  expect(znacznik(0).checked).toBe(false);
  znacznik(1).checked = true;
  znacznik(1).sl.change();

  s.pole.files = [c];
  s.pole.sl.change();
  expect(s.pole.files).toEqual([a, b, c]);
  const usun = s.lista.children[0].querySelector('button');
  expect(usun.type).toBe('button');
  // Kosz zamiast napisu: nazwę dla czytnika i podpowiedź po najechaniu niesie atrybut, ikona jest ukryta.
  expect(usun.textContent).toBe('');
  expect(usun.attrs['aria-label']).toBe('Usuń z wyboru: pierwsze.jpg');
  expect(usun.attrs.title).toBe('Usuń z wyboru');
  expect(usun.htmlWstawiony).toMatch(/^<svg[^>]*aria-hidden="true"/);
  usun.sl.click();

  expect(s.pole.files).toEqual([b, c]);
  expect(znacznik(0)).toMatchObject({ name: 'zdjecie_ai_0', value: '1', checked: true });
  expect(znacznik(1)).toMatchObject({ name: 'zdjecie_ai_1', checked: false });
});

describe('strefa zdjęć karty (wiele plików)', () => {
  it('upuszczenie 2 plików ustawia pole.files (2), listę 2 pozycji z miniaturą i rozmiarem, przycisk „Wgraj zdjęcia (2)”', () => {
    const s = strefa();
    const env = srodowisko();
    podlacz(s, env);
    const a = plik('stol.jpg', 2 * MB);
    const b = plik('krzeslo.webp', 300 * 1024, 'image/webp');
    s.wyslij('drop', upuszczenie([a, b]));
    expect(s.pole.files.length).toBe(2);
    expect(s.pole.files).toEqual([a, b]);
    expect(s.lista.hidden).toBe(false);
    expect(s.lista.children).toHaveLength(2);
    const tekst = (li) => JSON.stringify(li);
    expect(tekst(s.lista.children[0])).toContain('stol.jpg');
    expect(tekst(s.lista.children[0])).toContain('2 MB');
    expect(tekst(s.lista.children[1])).toContain('krzeslo.webp');
    expect(tekst(s.lista.children[1])).toContain('300 KB');
    expect(tekst(s.lista.children[0])).toContain('blob:miniatura-1');
    expect(s.przycisk.textContent).toBe('Wgraj zdjęcia (2)');
    expect(s.el.dataset.stan).toBe('wybrany');
  });
  it('plik większy niż 10 MB: komunikat po polsku, pole i lista bez zmian', () => {
    const s = strefa();
    const env = srodowisko();
    podlacz(s, env);
    const dobry = plik('dobry.jpg');
    s.wyslij('drop', upuszczenie([dobry]));
    s.wyslij('drop', upuszczenie([plik('ok.jpg'), plik('ogromne.jpg', 11 * MB)]));
    expect(s.stan.textContent).toMatch(/ogromne\.jpg/);
    expect(s.stan.textContent).toMatch(/10 MB/);
    expect(s.el.dataset.stan).toBe('blad');
    expect(s.pole.files).toEqual([dobry]);
    expect(s.lista.children).toHaveLength(1);
    expect(s.przycisk.textContent).toBe('Wgraj zdjęcia (1)');
  });
  it('dokładnie 10 MB przechodzi', () => {
    const s = strefa();
    podlacz(s, srodowisko());
    s.wyslij('drop', upuszczenie([plik('rowno.jpg', 10 * MB)]));
    expect(s.pole.files).toHaveLength(1);
  });
  it('zły typ (GIF): komunikat z nazwą pliku, nic nie trafia do pola', () => {
    const s = strefa();
    const env = srodowisko();
    podlacz(s, env);
    s.wyslij('drop', upuszczenie([plik('a.jpg'), plik('ruch.gif', 1000, 'image/gif')]));
    expect(s.stan.textContent).toMatch(/ruch\.gif/);
    expect(s.stan.textContent).toMatch(/JPEG, PNG lub WebP/);
    expect(s.el.dataset.stan).toBe('blad');
    expect(env.dt.items.dodane).toEqual([]);
    expect(s.pole.files).toEqual([]);
  });
  it('system bez typu MIME: decyduje rozszerzenie z listy accept', () => {
    expect(sprawdzPliki([plik('A.JPEG', 10, '')], opcjeZAtrybutow(strefa().el))).toBeNull();
    expect(sprawdzPliki([plik('a.bmp', 10, '')], opcjeZAtrybutow(strefa().el))).toMatch(/a\.bmp/);
  });
  it('nadmiar ponad wolne miejsce: komunikat z liczbą, nic nie trafia do pola', () => {
    const s = strefa({ maksPlikow: 2 });
    const env = srodowisko();
    podlacz(s, env);
    s.wyslij('drop', upuszczenie([plik('1.jpg'), plik('2.jpg'), plik('3.jpg')]));
    expect(s.stan.textContent).toMatch(/3/);
    expect(s.stan.textContent).toMatch(/miejsca na 2/);
    expect(s.el.dataset.stan).toBe('blad');
    expect(s.pole.files).toEqual([]);
    s.wyslij('drop', upuszczenie([plik('1.jpg'), plik('2.jpg')]));
    expect(s.pole.files).toHaveLength(2);
  });
  it('wybór z dysku (change) przechodzi tę samą kontrolę; zły wybór czyści pole, żeby nie poszedł formularzem', () => {
    const s = strefa({ maksPlikow: 1 });
    const env = srodowisko();
    podlacz(s, env);
    s.pole.files = [plik('a.jpg'), plik('b.jpg')];
    s.pole.value = 'C:\\fakepath\\a.jpg';
    s.pole.sl.change();
    expect(s.el.dataset.stan).toBe('blad');
    expect(s.pole.value).toBe('');
    expect(s.lista.children).toHaveLength(0);
    expect(s.przycisk.textContent).toBe('Wgraj zdjęcia');
    s.pole.files = [plik('a.jpg')];
    s.pole.sl.change();
    expect(s.lista.children).toHaveLength(1);
    expect(s.przycisk.textContent).toBe('Wgraj zdjęcia (1)');
  });
  it('kolejny wybór zwalnia adresy poprzednich miniatur', () => {
    const s = strefa();
    const env = srodowisko();
    podlacz(s, env);
    s.wyslij('drop', upuszczenie([plik('a.jpg'), plik('b.jpg')]));
    s.wyslij('drop', upuszczenie([plik('c.jpg')]));
    expect(env.URL.revokeObjectURL).toHaveBeenCalledWith('blob:miniatura-1');
    expect(env.URL.revokeObjectURL).toHaveBeenCalledWith('blob:miniatura-2');
  });
  it('podświetlenie strefy przy przeciąganiu plików, upuszczenie blokuje otwarcie pliku w karcie', () => {
    const s = strefa();
    podlacz(s, srodowisko());
    s.wyslij('dragenter', upuszczenie([], ['Files']));
    expect(s.el.classList.contains('strefa-pliku--nad')).toBe(true);
    s.wyslij('dragleave', { relatedTarget: null });
    expect(s.el.classList.contains('strefa-pliku--nad')).toBe(false);
    const preventDefault = vi.fn();
    s.wyslij('drop', { ...upuszczenie([plik()]), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
  it('brak wolnego miejsca: upuszczenie nic nie dodaje i mówi dlaczego', () => {
    const s = strefa({ maksPlikow: 0 });
    podlacz(s, srodowisko());
    s.wyslij('drop', upuszczenie([plik()]));
    expect(s.pole.files).toEqual([]);
    expect(s.stan.textContent).toMatch(/miejsca/);
    expect(s.el.dataset.stan).toBe('blad');
  });
  it('pole wyłączone (karta pełna) przy niezerowym limicie: komunikat „pełna”, nic nie trafia do pola', () => {
    const s = strefa({ maksPlikow: 5 });
    s.pole.disabled = true;
    const env = srodowisko();
    podlacz(s, env);
    s.wyslij('drop', upuszczenie([plik()]));
    expect(s.stan.textContent).toBe(opcjeZAtrybutow(s.el).komunikaty.pelna);
    expect(env.dt.items.dodane).toEqual([]);
    expect(s.pole.files).toEqual([]);
  });
  it('limit 0: komunikat „pełna”, a nie „wybrano N, zostało 0”', () => {
    const s = strefa({ maksPlikow: 0 });
    podlacz(s, srodowisko());
    s.wyslij('drop', upuszczenie([plik()]));
    expect(s.stan.textContent).toBe(opcjeZAtrybutow(s.el).komunikaty.pelna);
  });
  it('nazwa pliku z HTML-em trafia na listę jako tekst, bez wstawiania znaczników', () => {
    const s = strefa();
    podlacz(s, srodowisko());
    const zla = '<img src=x onerror=alert(1)>.png';
    s.wyslij('drop', upuszczenie([plik(zla, 1000, 'image/png')]));
    const [li] = s.lista.children;
    const nazwa = li.children.find((d) => d.className === 'strefa-pliku-nazwa');
    expect(nazwa.textContent).toBe(zla);
    expect(nazwa.htmlWstawiony).toBeUndefined();
    expect(li.children.filter((d) => d.tag === 'img')).toHaveLength(1);
    expect(nazwa.children).toEqual([]);
  });
});

describe('logo bierze wspólny moduł z tą samą wersją zasobów', () => {
  it('adres strefa-pliku.js dostaje `?v=` ze skryptu logo', () => {
    expect(adresStrefy('https://oms.example/public/logo-przeciaganie.js?v=abc1234567')).toBe(
      'https://oms.example/public/strefa-pliku.js?v=abc1234567',
    );
    expect(adresStrefy('file:///x/src/public/logo-przeciaganie.js')).toBe('file:///x/src/public/strefa-pliku.js');
  });
  it('żaden skrypt w src/public nie importuje modułu względnym adresem bez wersji', () => {
    const katalog = fileURLToPath(new URL('../../src/public/', import.meta.url));
    const zle = readdirSync(katalog)
      .filter((n) => n.endsWith('.js'))
      .filter((n) => /(?:\bfrom\s*|\bimport\s*\(\s*)['"`]\.\.?\//.test(readFileSync(join(katalog, n), 'utf8')));
    expect(zle).toEqual([]);
  });
});

describe('logo na wspólnej strefie — bez zmiany zachowania', () => {
  it('nadal odrzuca 2 pliki naraz', () => {
    const wejscie = { files: [], value: 'x', addEventListener() {} };
    const stan = { textContent: '' };
    const podglad = { hidden: true, addEventListener() {} };
    const sl = {};
    const el = {
      dataset: {},
      classList: klasy(),
      addEventListener: (t, f) => {
        sl[t] = f;
      },
      contains: () => false,
      querySelector: (s) =>
        s.includes('input') ? wejscie : s.includes('stan') ? stan : s.includes('podglad') ? podglad : null,
    };
    const env = srodowisko();
    podlaczStrefeLogo(el, env);
    sl.drop({ preventDefault() {}, ...upuszczenie([plik('a.png', 10, 'image/png'), plik('b.png', 10, 'image/png')]) });
    expect(stan.textContent).toMatch(/jeden plik/i);
    expect(env.dt.items.dodane).toEqual([]);
    expect(el.dataset.stan).toBe('blad');
  });
});
