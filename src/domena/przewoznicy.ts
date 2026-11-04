import type { OpisPrzewoznika } from '../core/kontrakty.ts';

type OpisPrzewoznikaRejestru = OpisPrzewoznika & {
  kolejnoscSlow: number;
  sledzenieWza?: { carrier: string; kurier: string };
};

/** Oś „kto wiezie”, niezależna od integracji nadania. */
export const OPISY_PRZEWOZNIKOW = {
  dpd: {
    klucz: 'dpd', nazwa: 'DPD', logo: '/public/przewoznicy/dpd.svg',
    sledzenie: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1={numer}',
    kolejnoscSlow: 1, sledzenieWza: { carrier: 'DPD', kurier: 'dpd' },
    rozpoznanie: { kod: ['dpd'], slowa: ['dpd'], metody: ['dpd', 'allegro_dpd'] },
  },
  inpost: {
    klucz: 'inpost', nazwa: 'InPost', logo: '/public/przewoznicy/inpost.svg',
    sledzenie: 'https://inpost.pl/sledzenie-przesylek?number={numer}',
    kolejnoscSlow: 2,
    rozpoznanie: { kod: ['inpost'], carrier: ['INPOST'], slowa: ['inpost'], metody: ['inpost_paczkomat', 'allegro_paczkomat'] },
  },
  dhl: {
    klucz: 'dhl', nazwa: 'DHL', logo: '/public/przewoznicy/dhl.svg',
    sledzenie: 'https://www.dhl.com/pl-pl/home/sledzenie-przesylek.html?tracking-id={numer}',
    kolejnoscSlow: 3,
    rozpoznanie: { slowa: ['dhl'] },
  },
  orlen: {
    klucz: 'orlen', nazwa: 'ORLEN Paczka', logo: '/public/przewoznicy/orlen.svg',
    sledzenie: 'https://www.orlenpaczka.pl/sledz-paczke/?numer={numer}',
    kolejnoscSlow: 4,
    rozpoznanie: { slowa: ['orlen'] },
  },
  'allegro-one': {
    klucz: 'allegro-one', nazwa: 'Allegro One', logo: '/public/przewoznicy/allegro-one.png',
    sledzenie: 'https://allegro.pl/allegrodelivery/sledzenie-paczki?numer={numer}',
    kolejnoscSlow: 5,
    rozpoznanie: { slowa: ['one'], metody: ['allegro_kurier'] },
  },
  packeta: {
    klucz: 'packeta', nazwa: 'Packeta', logo: '/public/przewoznicy/packeta.png',
    sledzenie: 'https://tracking.packeta.com/pl/?id={numer}',
    kolejnoscSlow: 0,
    rozpoznanie: { carrier: ['PACKETA'], slowa: ['packeta'] },
  },
} as const satisfies Readonly<Record<string, OpisPrzewoznikaRejestru>>;

export type KluczPrzewoznika = keyof typeof OPISY_PRZEWOZNIKOW;
