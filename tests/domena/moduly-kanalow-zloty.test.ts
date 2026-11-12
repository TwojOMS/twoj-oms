import { afterEach, beforeEach, expect, it } from 'vitest';
import { czyKanalAllegro, ustawKanalyAllegro, kanalyAllegro } from '../../src/domena/wysylka.js';

const tabela = [
  [{ sklep: 'allegro_polcien' }, true, 'allegro'],
  [{ sklep: 'rynek_polcien' }, true, 'allegro'],
  [{ sklep: 'sklep_polcien' }, false, 'woo'],
  [{ sklep: 'reczne' }, false, 'woo'],
  [{ sklep: 'ALLEGRO_x' }, false, 'woo'],
  [{ sklep: 'allegrowy' }, false, 'woo'],
  [{ sklep: '' }, false, 'woo'],
  [{ sklep: undefined }, false, 'woo'],
  [null, false, 'woo'],
] as const;

beforeEach(() => ustawKanalyAllegro(['rynek_polcien']));
afterEach(() => ustawKanalyAllegro([]));

it.each(tabela)('złoty predykat przez wysylka.js: %j → %s', (z, allegro) => {
  expect(czyKanalAllegro(z)).toBe(allegro);
});

it.each(tabela)('złoty moduł zamówienia: %j → %s / %s', async (z, _allegro, typ) => {
  const { modulZamowienia, umiejetnosciZamowienia } = await import('../../src/domena/moduly-kanalow.ts');
  expect(modulZamowienia(z).typ).toBe(typ);
  expect(umiejetnosciZamowienia(z)).toBe(modulZamowienia(z).umiejetnosci);
});

it('jawny zbiór zastępuje konfigurację, a prefiks nadal wygrywa', () => {
  const klucze = new Set(['sklep_polcien']);
  expect(czyKanalAllegro({ sklep: 'rynek_polcien' }, klucze)).toBe(false);
  expect(czyKanalAllegro({ sklep: 'sklep_polcien' }, klucze)).toBe(true);
  expect(czyKanalAllegro({ sklep: 'allegro_polcien' }, klucze)).toBe(true);
  const kopia = kanalyAllegro();
  kopia.push('sklep_polcien');
  expect(kanalyAllegro()).toEqual(['rynek_polcien']);
  ustawKanalyAllegro(undefined);
  expect(kanalyAllegro()).toEqual([]);
});

// PRZ-157.00 (D9): moduł zamówienia z typu połączenia w rejestrze kanałów, nie z prefiksu klucza.
// Rejestr typów (klucz → kanaly_sprzedazy.typ / OMS_KANALY) wstrzykuje kompozycja kanałów; tu — atrapa.
const REJESTR_PRZ157: Record<string, string> = {
  rynek_polcien: 'allegro', // Allegro z env (klucz bez prefiksu)
  allegro_a1b2c3: 'allegro', // Allegro z panelu
  sklep_polcien: 'woo', // Woo z env
  woo_d4e5f6: 'woo', // Woo z panelu
  polcien_g7h8: 'polcien', // nowy typ zarejestrowany tylko w teście
};
const tabelaRejestru = [
  [{ sklep: 'rynek_polcien' }, 'allegro'],
  [{ sklep: 'allegro_a1b2c3' }, 'allegro'],
  [{ sklep: 'sklep_polcien' }, 'woo'],
  [{ sklep: 'woo_d4e5f6' }, 'woo'],
  [{ sklep: 'reczne' }, 'woo'],
  [{ sklep: 'indywidualne' }, 'woo'],
  [{ sklep: '' }, 'woo'],
  [null, 'woo'],
  [{ sklep: 'polcien_g7h8' }, 'polcien'],
] as const;

async function zRejestrem() {
  const m = await import('../../src/domena/moduly-kanalow.ts');
  const MODUL_POLCIEN = { ...m.MODULY_KANALOW.woo, typ: 'polcien', nazwa: 'Pracownia Półcień', litera: 'P', idKatalogu: 'polcien',
    umiejetnosci: { ...m.MODULY_KANALOW.woo.umiejetnosci, statusZwrotny: 'mapa', scalanie: false } } as const;
  m.ustawRejestrKanalow((k) => REJESTR_PRZ157[k] ?? null, { ...m.MODULY_KANALOW, polcien: MODUL_POLCIEN });
  return { ...m, MODUL_POLCIEN };
}
afterEach(async () => (await import('../../src/domena/moduly-kanalow.ts')).ustawRejestrKanalow(null));

it.each(tabelaRejestru)('PRZ-157.00: moduł z rejestru kanałów: %j → %s', async (z, typ) => {
  const { modulZamowienia, umiejetnosciZamowienia, nieznaneKanalyZamowien } = await zRejestrem();
  expect(modulZamowienia(z).typ).toBe(typ);
  expect(umiejetnosciZamowienia(z)).toBe(modulZamowienia(z).umiejetnosci);
  expect(nieznaneKanalyZamowien()).toEqual([]);
});

it('PRZ-157.00: kanały OMS-u bez ostrzeżenia to te same, co wbudowane w widoku kanałów', async () => {
  const { KANALY_OMS } = await import('../../src/domena/moduly-kanalow.ts');
  const { kanalyWidoku } = await import('../../src/domena/kanaly.js');
  expect([...KANALY_OMS]).toEqual(kanalyWidoku([]).map((k: { klucz: string }) => k.klucz));
});

it('PRZ-157.00: kanał typu polcien dostaje opis i umiejętności swojego modułu, nie sklepu', async () => {
  const { modulZamowienia, umiejetnosciZamowienia, MODUL_POLCIEN } = await zRejestrem();
  expect(modulZamowienia({ sklep: 'polcien_g7h8' })).toBe(MODUL_POLCIEN);
  expect(umiejetnosciZamowienia({ sklep: 'polcien_g7h8' }).statusZwrotny).toBe('mapa');
});

it('PRZ-157.00: typ allegro/woo z rejestru nie zmienia dawnego wyboru (zgodność z SQL KSeF)', async () => {
  const m = await import('../../src/domena/moduly-kanalow.ts');
  m.ustawRejestrKanalow((k) => ({ allegro_jak_sklep: 'woo', sklep_jak_allegro: 'allegro' } as Record<string, string>)[k] ?? null);
  expect(m.modulZamowienia({ sklep: 'allegro_jak_sklep' }).typ).toBe('allegro');
  expect(m.modulZamowienia({ sklep: 'sklep_jak_allegro' }).typ).toBe('woo');
  expect(m.nieznaneKanalyZamowien()).toEqual([]);
});

it('PRZ-157.00: nieznany klucz → jak dotąd (moduł sklepu) i ostrzeżenie w diagnostyce', async () => {
  const { modulZamowienia, nieznaneKanalyZamowien } = await zRejestrem();
  expect(modulZamowienia({ sklep: 'zniknal_polcien' }).typ).toBe('woo');
  expect(modulZamowienia({ sklep: 'zniknal_polcien' }).typ).toBe('woo');
  // Typ zapisany w bazie, ale bez modułu w tej wersji — też nieznany, też po staremu.
  const m = await import('../../src/domena/moduly-kanalow.ts');
  m.ustawRejestrKanalow((k) => (k === 'przyszly_polcien' ? 'przyszly' : null));
  expect(nieznaneKanalyZamowien()).toEqual([]);
  expect(modulZamowienia({ sklep: 'przyszly_polcien' }).typ).toBe('woo');
  expect(nieznaneKanalyZamowien()).toEqual(['przyszly_polcien']);
});

it('PRZ-157.00: nieznany klucz z prefiksem allegro_ zostaje przy Allegro jak dotąd (z ostrzeżeniem)', async () => {
  const { modulZamowienia, nieznaneKanalyZamowien } = await zRejestrem();
  expect(modulZamowienia({ sklep: 'allegro_usuniety' }).typ).toBe('allegro');
  expect(nieznaneKanalyZamowien()).toEqual(['allegro_usuniety']);
});
