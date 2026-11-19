import { expect, it } from 'vitest';
import { polecenieZFormularza, zmianyHurtem } from '../../src/domena/magazyn-hurt.js';

const karta = { id: 1, nazwa: 'Lampa Półcień', prog_niskiego_stanu: 4 };

it('pusty próg hurtem zachowuje poprzedni próg przy zmianie innego pola', () => {
  const { polecenie, blad } = polecenieZFormularza({ prog_niskiego_stanu: '  ', glebokosc_cm: '20' });
  expect(blad).toBeNull();
  expect(zmianyHurtem([karta], polecenie)[0].zmiany).toEqual({ glebokosc_mm: 200 });
});

it.each([
  [{ prog_niskiego_stanu_bez: 'tak' }, null, 'bez progu'],
  [{ prog_niskiego_stanu: '0' }, 0, '0 szt.'],
  [{ prog_niskiego_stanu: '6' }, 6, '6 szt.'],
])('planuje zmianę progu dla %j', (body, wartosc, opis) => {
  const { polecenie, blad } = polecenieZFormularza(body);
  expect(blad).toBeNull();
  expect(zmianyHurtem([karta], polecenie)).toEqual([
    {
      id: 1,
      nazwa: karta.nazwa,
      zmiany: { prog_niskiego_stanu: wartosc },
      opisy: [{ pole: 'Próg niskiego stanu', z: '4 szt.', na: opis }],
    },
  ]);
  expect(zmianyHurtem([{ ...karta, prog_niskiego_stanu: wartosc }], polecenie)).toEqual([]);
});

it.each([
  { prog_niskiego_stanu: '-1' },
  { prog_niskiego_stanu: '1.5' },
  { prog_niskiego_stanu: '1e3' },
  { prog_niskiego_stanu: '9007199254740992' },
  { prog_niskiego_stanu: ['2', '3'] },
  { prog_niskiego_stanu_bez: ['tak', 'tak'] },
  { prog_niskiego_stanu: '0', prog_niskiego_stanu_bez: 'tak' },
])('nie planuje żadnej zmiany, gdy ustawienie progu jest błędne: %j', (body) => {
  const { polecenie, blad } = polecenieZFormularza({ ...body, glebokosc_cm: '20' });
  expect(blad).toMatch(/próg niskiego stanu/i);
  expect(polecenie).toBeNull();
});
