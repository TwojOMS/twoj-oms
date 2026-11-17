import { it, expect, vi } from 'vitest';

const modul = () => import('../../../src/public/statusy-kolejnosc.js');

it('przenosi element na dokładny indeks w obie strony, bez zmiany wejścia', async () => {
  const { przeniesElement } = await modul();
  const lista = ['a', 'b', 'c', 'd'];
  expect(przeniesElement(lista, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  expect(przeniesElement(lista, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  expect(przeniesElement(lista, 1, 1)).toEqual(lista);
  expect(lista).toEqual(['a', 'b', 'c', 'd']);
});

function ekran() {
  const zdarzenia = {};
  const dokumentZdarzenia = {};
  const lista = {
    children: [], ownerDocument: {
      addEventListener: (n, fn) => { dokumentZdarzenia[n] = fn; },
      defaultView: { addEventListener() {}, requestAnimationFrame: vi.fn(), cancelAnimationFrame() {}, innerHeight: 900 },
    },
    addEventListener: (nazwa, fn) => { zdarzenia[nazwa] = fn; },
    querySelectorAll: () => lista.children,
    append: (...elementy) => { lista.children = elementy; },
    setAttribute() {}, removeAttribute() {},
    insertBefore: (w, przed) => {
      lista.children = lista.children.filter(e => e !== w);
      const i = przed ? lista.children.indexOf(przed) : lista.children.length;
      lista.children.splice(i, 0, w);
    },
  };
  for (const klucz of ['a', 'b', 'c']) {
    const wiersz = { dataset: { klucz }, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ top: 100 + lista.children.indexOf(wiersz) * 100, height: 100 }) };
    const uchwyt = { dataset: { nazwa: klucz }, focus: vi.fn(), closest: () => wiersz, setAttribute() {}, setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture() {} };
    wiersz.querySelector = () => uchwyt;
    lista.children.push(wiersz);
  }
  return { lista, zdarzenia, dokumentZdarzenia, komunikat: { textContent: '' } };
}

it('przesunięcie wskaźnikiem odzyskuje fokus i przechwycenie po zmianie DOM; Escape cofa bez POST', async () => {
  const { inicjalizujKolejnosc } = await modul();
  const { lista, zdarzenia, dokumentZdarzenia, komunikat } = ekran();
  const wyslij = vi.fn();
  inicjalizujKolejnosc(lista, komunikat, wyslij);
  const uchwyt = lista.children[0].querySelector();
  zdarzenia.pointerdown({ target: { closest: () => uchwyt }, button: 0, isPrimary: true, pointerId: 7, clientY: 150, preventDefault() {} });
  uchwyt.focus.mockClear(); uchwyt.setPointerCapture.mockClear();
  dokumentZdarzenia.pointermove({ pointerId: 7, clientY: 380, preventDefault() {} });
  expect(lista.children.map(w => w.dataset.klucz)).toEqual(['b', 'c', 'a']);
  expect(uchwyt.focus).toHaveBeenCalled();
  expect(uchwyt.setPointerCapture).toHaveBeenCalledWith(7);
  await zdarzenia.keydown({ key: 'Escape', preventDefault() {} });
  expect(lista.children.map(w => w.dataset.klucz)).toEqual(['a', 'b', 'c']);
  expect(wyslij).not.toHaveBeenCalled();
});

it('ArrowDown/ArrowUp na uchwycie zapisują raz, ogłaszają pozycję i zachowują fokus; granica nie zapisuje', async () => {
  const { inicjalizujKolejnosc } = await modul();
  const { lista, zdarzenia, komunikat } = ekran();
  const wyslij = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ komunikat: 'Zapisano kolejność' }) });
  inicjalizujKolejnosc(lista, komunikat, wyslij);
  const uchwyt = lista.children[0].querySelector();
  const klawisz = key => zdarzenia.keydown({ target: { closest: () => uchwyt }, key, preventDefault: vi.fn() });
  await klawisz('ArrowDown');
  expect(lista.children.map(w => w.dataset.klucz)).toEqual(['b', 'a', 'c']);
  expect(JSON.parse(wyslij.mock.calls[0][1].body)).toEqual({ akcja: 'kolejnosc', kolejnosc: ['b', 'a', 'c'] });
  expect(komunikat.textContent).toContain('Zapisano kolejność');
  expect(komunikat.textContent).toContain('2 z 3');
  expect(uchwyt.focus).toHaveBeenCalled();
  await klawisz('ArrowUp');
  await klawisz('ArrowUp');
  await klawisz('x');
  expect(wyslij).toHaveBeenCalledTimes(2);
  expect(lista.children.map(w => w.dataset.klucz)).toEqual(['a', 'b', 'c']);
});

it.each(['http', 'siec'])('przy błędzie %s przywraca kolejność i ogłasza błąd', async blad => {
  const { inicjalizujKolejnosc } = await modul();
  const { lista, zdarzenia, komunikat } = ekran();
  const wyslij = blad === 'http' ? vi.fn().mockResolvedValue({ ok: false }) : vi.fn().mockRejectedValue(new Error('offline'));
  inicjalizujKolejnosc(lista, komunikat, wyslij);
  await zdarzenia.keydown({ target: { closest: () => lista.children[0].querySelector() }, key: 'ArrowDown', preventDefault() {} });
  expect(lista.children.map(w => w.dataset.klucz)).toEqual(['a', 'b', 'c']);
  expect(komunikat.textContent).toContain('Przywrócono poprzednią kolejność');
});

it('nie wysyła drugiego zapisu, dopóki pierwszy trwa', async () => {
  const { inicjalizujKolejnosc } = await modul();
  const { lista, zdarzenia, komunikat } = ekran();
  let zakoncz;
  const wyslij = vi.fn().mockImplementation(() => new Promise(resolve => { zakoncz = resolve; }));
  inicjalizujKolejnosc(lista, komunikat, wyslij);
  const e = { target: { closest: () => lista.children[0].querySelector() }, key: 'ArrowDown', preventDefault() {} };
  const pierwszy = zdarzenia.keydown(e);
  await zdarzenia.keydown(e);
  expect(wyslij).toHaveBeenCalledTimes(1);
  zakoncz({ ok: true, json: async () => ({}) });
  await pierwszy;
});
