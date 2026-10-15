import type { AdresOdbiorcyKuriera, Kurier, PaczkaKuriera, WynikNadania, ZamowienieDoWysylki } from '../../core/kontrakty.ts';
import type { createWooClient } from '../../oms/woo/client.js';
import type { pobierzZamowienie } from '../../oms/db/zamowienia.js';
import type { MapaKurierow } from './kurierzy.ts';

export type KurierNadania = Omit<Kurier, 'sprawdzPrzesylke' | 'statusPrzesylki'> & {
  sprawdzPrzesylke?: (id: string, zamowienie?: Pick<ZamowienieDoWysylki, 'sklep'>) => Promise<WynikNadania>;
  statusPrzesylki?: (numer: string, kontekst?: { kanal?: string; carrier?: string }) => Promise<unknown>;
  bezSledzenia?: boolean;
};
export type KurierSledzenia = {
  nadaj?: never; sprawdzPrzesylke?: never;
  statusPrzesylki: (numer: string, kontekst?: { kanal?: string; carrier?: string }) => Promise<unknown>;
  bezSledzenia?: boolean;
};
export type ZamowienieNadania = ZamowienieDoWysylki & { pochodzenie?: string };
export type OpcjeNadania = {
  db: Parameters<typeof pobierzZamowienie>[0];
  kurierzy: MapaKurierow;
  klienci?: Record<string, Pick<ReturnType<typeof createWooClient>, 'dodajNotatke'>>;
  katalogEtykiet: string;
  paczkaDomyslna?: PaczkaKuriera;
};
export type OpcjePaczkiNadania = {
  kolejnosc?: number; komentarz?: string | null;
  adres?: AdresOdbiorcyKuriera; punktOdbioru?: string | null;
  kwotaPobrania?: string | null; kurierWybrany?: string;
  pobranieNaTejPaczce?: boolean; drukowac?: boolean;
};
/** Metadane wyjątków rzucanych przez rzeczywiste adaptery kurierskie. */
export type BladNadania = Error & {
  pobranieNiepotwierdzone?: boolean; numerListu?: string | null;
  shipmentId?: string | number | null; surowa?: string | null;
};
export type ZapisPrzesylki = {
  numerListu?: string | null; etykietaSciezka?: string | null;
  etykietaZplSciezka?: string | null; surowa?: string | null;
  adresUzyty?: string | null; idPrzesylkiKuriera?: string | number | null;
  opis?: string | null;
};
