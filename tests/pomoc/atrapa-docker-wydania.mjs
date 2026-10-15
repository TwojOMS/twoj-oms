// Atrapa docker/docker-compose dla testów runnera wydania OMS (PRZ-042b).
// Wykonuje NAPRAWDĘ skrypty, które runner uruchamia w kontenerze narzędziowym
// (git clone paczki, manifest źródeł), tylko z mapowaniem wolumenów na katalogi
// hosta. Obrazy, tagi i kontenery żyją w pliku stanu TEST_STATE.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const stanPlik = process.env.TEST_STATE;
const stan = JSON.parse(readFileSync(natywna(stanPlik), 'utf8'));
const zapiszStan = () => writeFileSync(natywna(stanPlik), JSON.stringify(stan, null, 2));
const log = (wpis) => appendFileSync(natywna(process.env.TEST_LOG), `${wpis}\n`);

function natywna(sciezka) {
  return process.platform === 'win32' ? sciezka.replace(/^\/([a-z])\//, '$1:/') : sciezka;
}

function obraz(ref) {
  if (stan.images[ref]) return ref;
  if (stan.tags[ref]) return stan.tags[ref];
  return null;
}

function zakoncz(status, stderr = '') {
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exit(status);
}

function wolumeny(args) {
  const mapa = [];
  const reszta = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-v') {
      const [host, kontener] = args[i + 1].split(':');
      mapa.push([kontener, host]);
      i += 1;
    } else {
      reszta.push(args[i]);
    }
  }
  return { mapa: mapa.sort((a, b) => b[0].length - a[0].length), reszta };
}

// Jedno przejście: wstawiona ścieżka hosta nie jest mapowana drugi raz.
function mapuj(tekst, mapa) {
  if (!mapa.length) return tekst;
  const wzorzec = new RegExp(mapa.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return tekst.replace(wzorzec, (trafienie) => mapa.find(([k]) => k === trafienie)[1]);
}

function run(args) {
  const { mapa, reszta } = wolumeny(args.filter((a) => a !== '--rm'));
  const e = reszta.indexOf('--entrypoint');
  const entrypoint = reszta[e + 1];
  const ref = reszta[e + 2];
  const parametry = reszta.slice(e + 3);
  const id = obraz(ref);
  if (!id) zakoncz(125, `Unable to find image '${ref}'`);
  if (entrypoint === '/bin/sh') {
    const [flaga, skrypt, ...pozostale] = parametry;
    // Kontener narzędziowy nie ma globalnej konfiguracji Git; laptop ma autocrlf=true,
    // co zmieniłoby bajty `git archive` względem NAS-a.
    const env = {
      ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false',
    };
    delete env.MSYS_NO_PATHCONV;
    const wynik = spawnSync(BASH, [flaga, mapuj(skrypt, mapa), ...pozostale], { stdio: 'inherit', env });
    zakoncz(wynik.status ?? 1);
  }
  if (entrypoint === 'node') {
    const zawartosc = stan.images[id].content;
    const mapaObrazu = zawartosc ? [...mapa, ['/app', zawartosc]] : mapa;
    const argumenty = parametry.map((p) => natywna(mapuj(p, mapaObrazu)));
    const wynik = spawnSync(process.execPath, argumenty, { stdio: 'inherit' });
    zakoncz(wynik.status ?? 1);
  }
  zakoncz(97, `ATRAPA: nieobsługiwany entrypoint ${entrypoint}`);
}

function inspect(args) {
  const format = args[args.indexOf('--format') + 1];
  const ref = args.at(-1);
  if (format === '{{.Image}}') {
    if (!stan.containers[ref]) zakoncz(1, `No such container: ${ref}`);
    process.stdout.write(`${stan.containers[ref]}\n`);
    return;
  }
  zakoncz(98, `ATRAPA: nieobsługiwany inspect ${args.join(' ')}`);
}

function image([pod, ...args]) {
  if (pod === 'inspect') {
    const id = obraz(args.at(-1));
    if (!id) zakoncz(1, `No such image: ${args.at(-1)}`);
    const f = args.indexOf('--format');
    if (f === -1) return;
    const format = args[f + 1];
    if (format === '{{.Id}}') process.stdout.write(`${id}\n`);
    else if (format.includes('org.opencontainers.image.revision')) process.stdout.write(`${stan.images[id].revision}\n`);
    else zakoncz(98, `ATRAPA: nieobsługiwany format ${format}`);
    return;
  }
  if (pod === 'tag') {
    const id = obraz(args[0]);
    if (!id) zakoncz(1, `No such image: ${args[0]}`);
    stan.tags[args[1]] = id;
    zapiszStan();
    log(`tag:${args[1]}`);
    return;
  }
  zakoncz(98, `ATRAPA: nieobsługiwane image ${pod}`);
}

function build(args) {
  const rewizja = args[args.indexOf('--build-arg') + 1].replace(/^APP_REVISION=/, '');
  const tag = args[args.indexOf('--tag') + 1];
  const kontekst = args.at(-1);
  const id = `sha256:${createHash('sha256').update(`${rewizja}|${tag}|${kontekst}`).digest('hex')}`;
  stan.images[id] = { revision: rewizja, content: kontekst };
  stan.tags[tag] = id;
  zapiszStan();
  log(`build:${rewizja}`);
}

function exec(args) {
  const [kontener, ...polecenie] = args;
  if (polecenie.includes('/app/scripts/backup-db.mjs')) log(`backup:${kontener}`);
  else log(`health:${kontener}`);
}

function compose() {
  const id = obraz(process.env.OMS_IMAGE ?? '');
  if (!id) zakoncz(1, `ATRAPA compose: brak obrazu ${process.env.OMS_IMAGE}`);
  stan.containers['panel-oms'] = id;
  stan.containers['panel-oms-backup'] = id;
  zapiszStan();
  log(`compose:${process.env.OMS_IMAGE}`);
}

const [tryb, polecenie, ...args] = process.argv.slice(2);
if (tryb === 'compose') compose();
else if (polecenie === 'run') run(args);
else if (polecenie === 'inspect') inspect(args);
else if (polecenie === 'image') image(args);
else if (polecenie === 'build') build(args);
else if (polecenie === 'exec') exec(args);
else zakoncz(99, `ATRAPA: nieobsługiwane polecenie ${polecenie}`);
