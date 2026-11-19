export function czyPonizejProgu(stan, prog) {
  return prog !== null && stan <= prog;
}

export function klasaStanu(stan, prog) {
  if (stan < 0) return 'minus';
  return czyPonizejProgu(stan, prog) ? 'niski' : 'zwykly';
}
