// Haszowanie hasel kont panelu — scrypt z node:crypto (spec 2026-09-12).
//
// ⚠️ DLACZEGO SCRYPT, A NIE bcrypt ANI argon2. Obraz panelu budowany jest NA NAS-IE,
// a bcrypt i argon2 to paczki natywne — kompilowane przy `npm ci`, na Celeronie, bez
// kompilatora w obrazie. Kazda z nich to dodatkowy sposob, na jaki instalacja moze nie
// wstac; u kupujacego „Twoj OMS" bylby to pierwszy ekran, jaki zobaczy. scrypt jest
// w standardowej bibliotece Node i nie ma czego instalowac.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Parametry zapisujemy W SAMYM ZAPISIE, a nie tylko tutaj — inaczej podniesienie kosztu
// w przyszlosci uniewaznialoby WSZYSTKIE istniejace hasla naraz, bez ani jednego ostrzezenia.
const N = 16384;   // 128 * N * r = 16 MB, miesci sie w domyslnym `maxmem` Node (32 MB)
const R = 8;
const P = 1;
const DLUGOSC = 32;
const BAJTY_SOLI = 16;

export function zahaszuj(haslo) {
  const sol = randomBytes(BAJTY_SOLI);
  const klucz = scryptSync(String(haslo), sol, DLUGOSC, { N, r: R, p: P });
  return ['scrypt', N, R, P, sol.toString('base64'), klucz.toString('base64')].join('$');
}

/**
 * ⚠️ KAZDA droga odmowy konczy sie tym samym `false`, takze przy zapisie, ktorego nie da sie
 * rozebrac. Wolajacy nie ma jak (ani po co) odroznic „zle haslo" od „zepsuty wiersz".
 */
export function zgodneHaslo(haslo, zapis) {
  const czesci = String(zapis ?? '').split('$');
  if (czesci.length !== 6 || czesci[0] !== 'scrypt') return false;
  const [, n, r, p, sol64, klucz64] = czesci;
  try {
    const oczekiwany = Buffer.from(klucz64, 'base64');
    // ⚠️⚠️ Warunek na DLUGOSC (stala modulu), NIE na „wieksze od zera". Zmierzone: wiersz
    // z PUSTYM ogonem (`...$<sol>$`) daje `oczekiwany.length === 0`, a `scryptSync(cokolwiek,
    // sol, 0, ...)` NIE rzuca — oddaje bufor zerowej dlugosci — i `timingSafeEqual(pusty,
    // pusty)` oddaje `true`. Bez tego warunku KAZDE haslo pasowaloby do takiego zapisu.
    // Odrzucamy PRZED wywolaniem `scryptSync`, zeby zepsuty/skrocony klucz nigdy nie mial
    // szansy dac dlugosci zgodnej z samym soba. Gdy `DLUGOSC` kiedys urosnie, stare zapisy
    // PRZESTANA pasowac — i ma to byc GLOSNE (migracja hasel), nie ciche przepuszczenie.
    if (oczekiwany.length !== DLUGOSC) return false;
    const policzony = scryptSync(
      String(haslo), Buffer.from(sol64, 'base64'), oczekiwany.length,
      { N: Number(n), r: Number(r), p: Number(p) },
    );
    return timingSafeEqual(policzony, oczekiwany);
  } catch {
    return false;
  }
}
