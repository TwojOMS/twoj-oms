// Sklejenie rejestru miernikow z baza — jedyne miejsce, w ktorym „skad wziac liczbe"
// spotyka sie z I/O. Warstwy jak w reszcie OMS-u: domain/ decyduje, db/ pyta,
// services/ skleja, routes/ renderuje.

import { miernik } from '../../../domena/mierniki-celow.js';
import { sumaZdarzen } from '../../../oms/db/cele.js';

/**
 * Pomiar celu w okresie.
 *
 * @param {object} db
 * @param {{id: number, miernik: string}} cel
 * @param {{od: string|null, do: string|null}} okres
 * @returns {{ile: number, zrodloAt: string|null}|null} `null` = „nie umiem policzyc",
 *   co `postepCelu` zamienia na stan `nieznany`. NIGDY nie oddajemy tu zera zastepczego.
 */
export function zmierz(db, cel, okres) {
  const opis = miernik(cel.miernik);
  // ⚠️ FAIL-CLOSED. Klucz spoza rejestru (miernik wycofany przy refaktorze, literowka
  // w bazie) NIE spada na reczny. Spadek na reczny dalby sume zdarzen — czyli ZERO, bo
  // automat zdarzen nie pisze — i cel wygladalby na ZANIEDBANY zamiast na ZEPSUTY.
  // Roznica jest istotna: pierwsze to zarzut wobec czlowieka, drugie wobec miernika.
  if (!opis) return null;

  if (opis.policz === null) {
    const { ile, ostatniDzien } = sumaZdarzen(db, cel.id, okres);
    // Reczny nie umie byc „nieznany": czlowiek albo klikal, albo nie. Zrodlem jest tabela,
    // ktora zawsze odpowiada, wiec zero jest tu UCZCIWYM zerem.
    return { ile, zrodloAt: ostatniDzien };
  }

  // ⚠️ try/catch NIE JEST tu zamiataniem bledu pod dywan. Jeden zepsuty miernik nie moze
  // zabrac calego ekranu: kafel ma pokazac „nie wiem", a pozostale kafle maja sie
  // wyrenderowac. Ten sam uklad, co przy sekcjach GA4/Meta na zakladce KAMPANIA.
  try {
    const w = opis.policz(db, okres);
    // Smiec z miernika (brak `ile`, `null`, cokolwiek) traktujemy jak brak odpowiedzi.
    if (!w || typeof w.ile !== 'number') return null;
    // `?? null` jest istotne: `undefined` przechodziloby przez `postepCelu` inaczej niz
    // `null` przy porownaniach `=== null`.
    return { ile: w.ile, zrodloAt: w.zrodloAt ?? null };
  } catch {
    return null;
  }
}

/** Prog swiezosci miernika celu; `null` takze dla klucza spoza rejestru. */
export function progCelu(cel) {
  return miernik(cel.miernik)?.progSwiezosciH ?? null;
}
