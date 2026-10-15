import type { StronaZamowien } from '../core/kontrakty.ts';
import type { utworzHttp } from '../core/http.ts';
import type { createAllegroClient } from '../oms/allegro/client.js';

export type OpcjeTransportu = { http?: ReturnType<typeof utworzHttp>; fetchImpl?: typeof fetch };
export type NadawcaKuriera = {
  nazwa: string; ulica: string; kod: string; miasto: string; kraj?: string;
  phone?: string; email?: string;
};
export type OpcjeDpd = OpcjeTransportu & {
  url: string; login: string; haslo: string; fid: string;
  infoUrl: string; channel: string; nadawca: NadawcaKuriera;
};
export type OpcjeInpost = OpcjeTransportu & {
  url: string; token: string; organizacja: string | number; nadawca: NadawcaKuriera;
  paczkomatNadawczy?: string | null;
};
export type OpcjeWza = {
  allegroDla: (zamowienie: Readonly<Record<string, unknown>>) => ReturnType<typeof createAllegroClient> | null;
  metodaZywa: (zamowienie: Readonly<Record<string, unknown>>) => string | null | Promise<string | null>;
  pobranieNadawca?: { nazwa?: string; rachunek?: string };
  odstepMs?: number; maksProb?: number;
};
export type OpcjeAdapteraWoo = {
  woo: { pobierzZamowienia: (o: { modifiedAfter: string | null; page: number }) => Promise<StronaZamowien> };
  mapowanie: unknown;
};
export type OpcjeAdapteraAllegro = {
  klient: { pobierzZamowienia: (o: { od: string | null; kursor: string | null; strona: number }) => Promise<StronaZamowien> };
};
