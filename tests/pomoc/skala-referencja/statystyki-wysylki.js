// Referencja PRZ-094.13 z 9ccdd75, przed optymalizacją.
import { uslugaDostawy } from '../../../src/domena/wysylka.js';
import {
  terminZamowienia, dniRoboczeDoWysylki, poTerminie, tegoSamegoDnia,
} from '../../../src/domena/termin-wysylki.js';

export const udzialProcent = (ile, zCzego) => (zCzego
  ? Math.round((ile / zCzego) * 1000) / 10
  : null);

export function rozkladUslug(zamowienia) {
  const suma = zamowienia.length;
  const kubelki = new Map();
  for (const z of zamowienia) {
    const etykieta = uslugaDostawy(z);
    kubelki.set(etykieta, (kubelki.get(etykieta) ?? 0) + 1);
  }
  const pozycje = [...kubelki.entries()]
    .map(([etykieta, ile]) => ({ etykieta, ile, udzial: udzialProcent(ile, suma) }))
    .sort((a, b) => (b.ile - a.ile) || a.etykieta.localeCompare(b.etykieta, 'pl'));
  return { pozycje, suma };
}

const KUBELKI_CZASU = ['tego samego dnia', '1 dzień rob.', '2 dni rob.', '3+ dni rob.'];

const kubelekCzasu = (dniRobocze, tenSamDzien) => {
  if (tenSamDzien) return KUBELKI_CZASU[0];
  if (dniRobocze <= 1) return KUBELKI_CZASU[1];
  if (dniRobocze === 2) return KUBELKI_CZASU[2];
  return KUBELKI_CZASU[3];
};

export function terminowosc(zamowienia) {
  const wylaczenia = { niewyslane: 0, przedWplata: 0, bezStartu: 0 };
  const liczniki = new Map(KUBELKI_CZASU.map((k) => [k, 0]));
  let mianownik = 0;
  let wTerminie = 0;
  let tegoDnia = 0;

  for (const z of zamowienia) {
    if (!z.wyslane_at) { wylaczenia.niewyslane += 1; continue; }
    if (!terminZamowienia(z)) { wylaczenia.bezStartu += 1; continue; }
    const dni = dniRoboczeDoWysylki(z);
    if (dni === null) { wylaczenia.przedWplata += 1; continue; }

    mianownik += 1;
    if (poTerminie(z) === false) wTerminie += 1;
    const tenSam = tegoSamegoDnia(z);
    if (tenSam) tegoDnia += 1;
    const kubelek = kubelekCzasu(dni, tenSam);
    liczniki.set(kubelek, liczniki.get(kubelek) + 1);
  }

  return {
    mianownik,
    wTerminie,
    tegoSamegoDnia: tegoDnia,
    procentWTerminie: udzialProcent(wTerminie, mianownik),
    procentTegoSamegoDnia: udzialProcent(tegoDnia, mianownik),
    rozklad: KUBELKI_CZASU.map((etykieta) => ({
      etykieta,
      ile: liczniki.get(etykieta),
      udzial: udzialProcent(liczniki.get(etykieta), mianownik),
    })),
    wylaczenia,
  };
}
