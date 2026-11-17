import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { ModulOms } from '../../src/core/kontrakty.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { podpisz } from '../../src/core/bezpieczenstwo/sesja.js';
import { zbudujStraznika } from '../../src/core/bezpieczenstwo/straznik.js';
import { zalozKonto, dopiszLogowanie, kontoPoLoginie } from '../../src/core/bezpieczenstwo/konta.js';

// Wyłącznie deklaracje granicy JS: te same funkcje, bez opakowania ani zastępowania
// zachowania. TS zawęża opcjonalne pola starego JS do ich domyślnego null/undefined.
// Rzutowanie ModulOms odpowiada temu w istniejących aplikacja.test.ts i uruchomienie.test.ts.
export const rdzen = modulRdzen as ModulOms;
export const podpiszWersje = podpisz as unknown as (login: string, sekret: string, teraz?: number, wersja?: number) => string;
export const zalozKontoZPtaszkami = zalozKonto as unknown as (db: DatabaseSync, dane: {
  login: string; imie: string; haslo: string; rola: string; admin?: boolean; ekrany?: string[] | null;
}) => number;
export const dopiszLogowanieZIp = dopiszLogowanie as unknown as (db: DatabaseSync, dane: {
  login: string; usluga: string; ip?: string | null; wynik: string;
}) => void;
export const straznikZKontami = zbudujStraznika as unknown as (opcje: {
  basicAuth: FastifyInstance['basicAuth']; db: DatabaseSync; nazwaCiasteczka: string;
  konta: { kontoPoLoginie: (login: string) => ReturnType<typeof kontoPoLoginie>;
    czyIstniejeCzynnyAdmin: () => boolean; loginSerwisowy: string };
}) => ReturnType<typeof zbudujStraznika>;
