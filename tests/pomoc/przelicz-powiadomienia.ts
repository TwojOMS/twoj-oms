import { expect } from 'vitest';
import type { createMigawkaPowiadomien } from '../../src/moduly/zamowienia/services/migawka-powiadomien.js';

type OdczytUslugi = <T>(modul: string, nazwa: string) => T | Promise<T>;
type PrzeliczMigawke = ReturnType<typeof createMigawkaPowiadomien>['przeliczTeraz'];

export async function przeliczPowiadomienia({ usluga }: { usluga: OdczytUslugi }) {
  const przelicz = await usluga<PrzeliczMigawke>('zamowienia', 'przeliczPowiadomienia');
  expect(await przelicz()).not.toHaveProperty('blad');
}
