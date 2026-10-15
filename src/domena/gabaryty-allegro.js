import { liczbaDodatnia } from './paczka.js';

const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const DLUGOSCI = Object.freeze({
  [ONE_BOX]: 64,
  '0b257488-c85d-4507-b967-9b45ffbfa2e8': 64,
  '09164667-daa5-42dc-8087-33d7485790ac': 60,
  '0fe5b4af-9f09-443d-9d49-62331a20b5b2': 64,
  '0560b75e-88c3-4b79-bcf7-62331a20b5b2': 64,
  // Allegro Automaty Paczkowe DPD (AD). Limit 59 × 38 × 41 cm, 20 kg zmierzony 01.10.2026
  // w `delivery-proposals` zamowienia #1376; do tego dnia usluga byla na bialej liscie WzA
  // bez profilu, wiec formularz podsuwal paczke domyslna 110 × 75 cm, ktora nie wchodzi do skrytki.
  '09bcdcdb-c62a-41c4-ba42-f2c599280e3c': 59,
});
const WYSOKOSCI = Object.freeze({ S: 8, M: 19, L: 41 });

export function profilGabarytuAllegro(deliveryMethodId) {
  if (!Object.hasOwn(DLUGOSCI, deliveryMethodId)) return null;
  return {
    dlugosc: DLUGOSCI[deliveryMethodId],
    szerokosc: 38,
    gabaryty: WYSOKOSCI,
    domyslnaWaga: deliveryMethodId === ONE_BOX ? 1 : null,
    domyslnyGabaryt: deliveryMethodId === ONE_BOX ? 'S' : null,
  };
}

export function parsujGabarytAllegro(dane, deliveryMethodId) {
  const profil = profilGabarytuAllegro(deliveryMethodId);
  if (!profil || !Object.hasOwn(WYSOKOSCI, dane?.gabaryt)) {
    return { blad: 'Wybierz gabaryt S, M albo L.' };
  }
  const waga = liczbaDodatnia(dane?.waga);
  if (waga === null || waga > 20) return { blad: 'Waga musi być większa od zera i nie większa niż 20 kg.' };
  return {
    paczka: {
      waga,
      dlugosc: profil.dlugosc,
      szerokosc: profil.szerokosc,
      wysokosc: WYSOKOSCI[dane.gabaryt],
      gabaryt: dane.gabaryt,
      oczekiwanyDeliveryMethodId: deliveryMethodId,
    },
  };
}

export function sprawdzLimityGabarytuAllegro(paczka, deliveryOptions) {
  const opcje = Array.isArray(deliveryOptions)
    ? deliveryOptions.filter((opcja) => opcja?.packageType === 'PACKAGE') : [];
  if (!opcje.length) return { blad: 'Allegro nie podało limitu paczki dla tej usługi.' };

  for (const opcja of opcje) {
    for (const [pole, limit, jednostka] of [
      ['dlugosc', opcja?.limits?.dimensions?.length, 'CENTIMETER'],
      ['szerokosc', opcja?.limits?.dimensions?.width, 'CENTIMETER'],
      ['wysokosc', opcja?.limits?.dimensions?.height, 'CENTIMETER'],
      ['waga', opcja?.limits?.weight, 'KILOGRAMS'],
    ]) {
      if (limit?.unit !== jednostka || !Number.isFinite(limit?.value) || limit.value <= 0) {
        return { blad: `Allegro nie podało poprawnego limitu pola ${pole}.` };
      }
      if (paczka[pole] > limit.value) {
        return { blad: `Paczka przekracza limit pola ${pole} dla tej usługi Allegro.` };
      }
    }
  }
  return { paczka };
}
