export function czyPonizejProgu(stan, prog) {
  return prog !== null && stan <= prog;
}

const kryteriaStanu = {
  jest: (stan) => stan > 0,
  niski: czyPonizejProgu,
  brak: (stan) => stan <= 0,
  minus: (stan) => stan < 0,
};

export function czyFiltrStanu(rodzaj) {
  return Object.hasOwn(kryteriaStanu, rodzaj);
}

export function pasujeDoStanu(rodzaj, stan, prog = null) {
  return czyFiltrStanu(rodzaj) && kryteriaStanu[rodzaj](stan, prog);
}

export function klasaStanu(stan, prog) {
  if (stan < 0) return 'minus';
  return czyPonizejProgu(stan, prog) ? 'niski' : 'zwykly';
}
