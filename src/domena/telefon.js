import { bladOperatora } from './bledy.js';

// InPost przyjmuje odbiorce WYLACZNIE jako DZIEWIEC CYFR — bez '+', bez zer wiodacych
// kraju, bez odstepow. WooCommerce oddaje numery w roznych ksztaltach (+48600100200,
// 48600100200, 0048600100200, z odstepami i myslnikami) — porownanie zamowienia ze sklepu
// z odpowiadajaca mu przesylka InPostu potwierdzilo na zywym API, ze prefiks trzeba
// zdejmowac samemu (docs/superpowers/notatki/2026-08-01-inpost-shipx-rozpoznanie.md).
//
// To ta sama rodzina bledu co kod pocztowy w DPD ('00-001' -> NONEXISTING_POSTAL_CODE,
// '00001' -> OK) — a tam odrzucenie bylo CICHE: status walidacji, nie wyjatek, wiec
// nikt sie nie zorientowal, dopoki ktos nie policzyl paczek recznie. Tutaj kazdy ksztalt,
// ktorego nie da sie JEDNOZNACZNIE sprowadzic do dziewieciu cyfr, ma rzucac GLOSNO —
// nigdy ciche obciecie, nigdy null.

function bladNumeru(surowy) {
  return bladOperatora(
    `InPost: numer telefonu musi mieć dokładnie dziewięć cyfr (bez prefiksu kraju) — `
    + `dostałem „${surowy ?? ''}”.`,
  );
}

/**
 * Sprowadza dowolny zapis numeru telefonu do dziewieciu cyfr, jakich oczekuje InPost.
 *
 * Rzuca bladem operatora dla wszystkiego, czego nie da sie jednoznacznie sprowadzic do
 * dziewieciu cyfr — pustego wejscia, zlej dlugosci, liter, numeru zagranicznego. Nigdy
 * nie oddaje obcietej wartosci ani null: przesylka bez telefonu albo z siedmioma cyframi
 * to zgloszenie, ktorego InPost i tak nie przyjmie, wiec lepiej odmowic TU, zanim
 * cokolwiek pojedzie do API.
 */
export function naTelefonInPost(surowy) {
  if (surowy == null) throw bladNumeru(surowy);

  // Spacje, myslniki, nawiasy i kropki to wylacznie ozdobniki zapisu (WooCommerce, notatka
  // klienta w uwagach zamowienia...) — nie nosza zadnej informacji o samym numerze.
  const oczyszczony = String(surowy).replace(/[\s\-().]/g, '');
  if (!oczyszczony) throw bladNumeru(surowy);

  let reszta = oczyszczony;
  // '+48' i '0048' sa JEDNOZNACZNE jako prefiks kraju — ani '+', ani podwojne zero na
  // poczatku nie wystepuja w prawdziwym polskim numerze, wiec zdejmujemy je bezwarunkowo.
  if (reszta.startsWith('+48')) reszta = reszta.slice(3);
  else if (reszta.startsWith('0048')) reszta = reszta.slice(4);
  // Golego '48' (bez '+' ani '00') NIE WOLNO zdejmowac bezwarunkowo: '486001002' to
  // prawdziwy dziewieciocyfrowy numer, ktory PRZYPADKIEM zaczyna sie od tych samych
  // dwoch cyfr, co prefiks kraju. Zdejmujemy go WYLACZNIE wtedy, gdy po zdjeciu zostaje
  // dokladnie dziewiec cyfr (czyli caly wpis mial ich jedenascie) — inaczej okaleczylibysmy
  // prawdziwy numer do siedmiu cyfr i nikt by tego nie zauwazyl.
  else if (reszta.startsWith('48') && /^\d{9}$/.test(reszta.slice(2))) reszta = reszta.slice(2);

  if (!/^\d{9}$/.test(reszta)) throw bladNumeru(surowy);
  return reszta;
}
