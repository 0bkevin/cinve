import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { mockFetch, EmptySessionStore } from '../helpers/fixtures.js';
import { ReadContext } from '../../src/http/read-context.js';
import { cinexSessionDetails, parseCinexCinemaShowtimes, parseCinexShowtimes } from '../../src/providers/cinex/public-pages.js';
import { nth } from '../helpers/assert.js';

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

test('Cinex HTML separators do not merge screen number and showtime', async () => {
  const result = await service().query('showtimes', { provider: 'cinex', movie_id: 'pelicula', date: '2026-09-11' });
  assert.equal(nth(result.items, 0).screen, '4'); assert.equal(nth(result.items, 0).time, '11:20');
});

const epoch = (date: string, time = '20:00') => Math.floor((Date.parse(`${date}T${time}:00Z`) + 4 * 3600000) / 1000);
const movie = { kind: 'movie' as const, id: 'm', name: 'KNOWN' };
const context = () => new ReadContext(new HttpClient(async () => new Response('unexpected')));

test('Cinex movie-specific malformed epochs are partial instead of clean empty', () => {
  const c = context();
  const items = parseCinexShowtimes(
    `<h1>Known</h1><button onclick="checkLogin('s1','C')" alt="not-an-epoch"></button>`,
    'm', '2026-09-18', c,
  );
  assert.deepEqual(items, []);
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /malformado|epoch/.test(w)));
});

test('Cinex valid sessions for another date remain a normal clean empty result', () => {
  const c = context();
  const items = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-19')}"></button></div>`,
    [movie], 'C', '2026-09-18', c, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.deepEqual(items, []);
  assert.equal(c.partial, false);
  assert.equal(c.warnings.length, 0);
});

test('Cinex mixed valid and malformed cinema epochs preserve valid sessions and mark partial', () => {
  const c = context();
  const items = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5>
      <button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-18')}"></button>
      <button onclick="checkLogin('s2','C')" alt="not-an-epoch"></button>
    </div>`,
    [movie], 'C', '2026-09-18', c, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.equal(items.length, 1);
  assert.equal(nth(items, 0).id, 's1');
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /epoch|malformada/.test(w)));
});

test('Cinex parser diagnostics stay bounded for large malformed pages and long labels', () => {
  const malformed = Array.from({ length: 2000 }, () =>
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','C')" alt="bad"></button></div>`).join('');
  const malformedContext = context();
  parseCinexCinemaShowtimes(malformed, [movie], 'C', '2026-09-18', malformedContext, 'https://www.cinex.com.ve/cinex-c.html');
  assert.equal(malformedContext.partial, true);
  assert.ok(malformedContext.warnings.length <= 32);
  assert.ok(malformedContext.warnings.join('').length < 8192);
  assert.ok(malformedContext.warnings.some(w => /repeated 2000 times/.test(w)));

  const longTitle = 'T'.repeat(10000);
  const longContext = context();
  parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">${longTitle}</h5><button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-18')}"></button></div>`,
    [movie], 'C', '2026-09-18', longContext, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.ok(longContext.warnings.every(w => w.length <= 512));
  assert.ok(longContext.warnings.join('').length < 8192);
});

test('a Cinex session ID reported with two times or rooms is suppressed, not silently overwritten', () => {
  const c = context();
  const items = parseCinexShowtimes(
    `<h1>Known</h1><button onclick="checkLogin('same','C')" alt="${epoch('2026-09-18', '19:00')}">Sala 1</button>` +
    `<button onclick="checkLogin('same','C')" alt="${epoch('2026-09-18', '20:00')}">Sala 2</button>` +
    `<button onclick="checkLogin('ok','C')" alt="${epoch('2026-09-18', '21:00')}">Sala 3</button>` +
    `<button onclick="checkLogin('ok','C')" alt="${epoch('2026-09-18', '21:00')}">Sala 3</button>`,
    'm', '2026-09-18', c,
  );
  assert.deepEqual(items.map(i => i.id), ['ok'], 'identical repeats are kept once; conflicts are dropped');
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /contradictory times for showtime same/.test(w)), c.warnings.join(' | '));

  const venue = context();
  const venueItems = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('same','C')" alt="${epoch('2026-09-18')}">Sala 1</button>` +
    `<button onclick="checkLogin('same','C')" alt="${epoch('2026-09-18')}">Sala 2</button></div>`,
    [movie], 'C', '2026-09-18', venue, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.deepEqual(venueItems, [], 'a room-only difference is also a conflict');
  assert.equal(venue.partial, true);
});

test('a Cinex session ID reported on two dates is suppressed even when only one is requested', () => {
  const c = context();
  const items = parseCinexShowtimes(
    `<h1>Known</h1><button onclick="checkLogin('same','C')" alt="${epoch('2026-11-04')}">Sala 1</button>` +
    `<button onclick="checkLogin('same','C')" alt="${epoch('2026-11-05')}">Sala 1</button>` +
    `<button onclick="checkLogin('ok','C')" alt="${epoch('2026-11-04', '21:00')}">Sala 2</button>`,
    'm', '2026-11-04', c,
  );
  assert.deepEqual(items.map(i => [i.id, i.date]), [['ok', '2026-11-04']]);
  assert.equal(c.partial, true);

  const venue = context();
  const venueItems = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('same','C')" alt="${epoch('2026-11-04')}">Sala 1</button></div>` +
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('same','C')" alt="${epoch('2026-11-05')}">Sala 1</button>` +
    `<button onclick="checkLogin('ok','C')" alt="${epoch('2026-11-04', '21:00')}">Sala 2</button></div>`,
    [movie], 'C', '2026-11-04', venue, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.deepEqual(venueItems.map(i => i.id), ['ok']);
  assert.equal(venue.partial, true);
  assert.ok(venue.warnings.some(w => /contradictory times for showtime same/.test(w)), venue.warnings.join(' | '));
  // A session the page reports on another date only is not part of this answer and raises nothing.
  const other = context();
  assert.deepEqual(parseCinexShowtimes(`<h1>Known</h1><button onclick="checkLogin('x','C')" alt="${epoch('2026-11-04')}"></button><button onclick="checkLogin('x','C')" alt="${epoch('2026-11-04')}"></button>`, 'm', '2026-11-06', other), []);
  assert.equal(other.partial, false);
});

test('Cinex movie pages compare named rooms and full start times when suppressing conflicts', () => {
  for (const [label, a, b] of [
    ['named rooms', `alt="${epoch('2026-11-04')}">Sala A`, `alt="${epoch('2026-11-04')}">Sala B`],
    ['seconds apart', `alt="${epoch('2026-11-04')}">Sala 1`, `alt="${Number(epoch('2026-11-04')) + 30}">Sala 1`],
  ] as const) {
    const c = context();
    const items = parseCinexShowtimes(`<h1>Film</h1><button onclick="checkLogin('same','SBC')" ${a}</button><button onclick="checkLogin('same','SBC')" ${b}</button>`, 'm', '2026-11-04', c);
    assert.deepEqual(items, [], label); assert.equal(c.partial, true, label);
  }
  const c = context();
  const vip = nth(parseCinexShowtimes(`<h1>Film</h1><button onclick="checkLogin('v','SBC')" alt="${epoch('2026-11-04')}">Sala VIP</button>`, 'm', '2026-11-04', c), 0);
  assert.equal(vip.screen, 'VIP');
});

test('Cinex session buttons give the room, the subtitled or dubbed version and special formats as the site shows them', () => {
  // Button markup as served by cinex-tolon.html on 2026-11-05.
  const button = (id: string, icon: string, room: string, time: string) => `<div onclick="javascript:checkLogin('${id}','TLN');" alt="${epoch('2026-11-04')}" class="cinemasessionpos"><button type="button" class="btnprog"><img src="https://www.cinex.com.ve/assets/images/${icon}.png.pagespeed.ic.2lrEiVxHrh.webp" class="icoIdioma"><br>${room}<br>${time}<br><div id="loader${id}" style="display:none"></div></button></div>`;
  const items = parseCinexShowtimes(`<h1>Film</h1>${button('1', 'xsub', 'VIP (Piso 5)', '08:00 pm')}${button('2', 'xes', 'Sala 3', '08:00 pm')}${button('3', 'x4DX', 'Sala 4DX', '08:00 pm')}`, 'm', '2026-11-04', context());
  const byId = Object.fromEntries(items.map(i => [i.id, [i.screen, i.language, i.format]]));
  assert.deepEqual(byId, { '1': ['VIP (Piso 5)', 'subtitulada', undefined], '2': ['3', 'es', undefined], '3': ['4DX', undefined, '4DX'] });
  assert.deepEqual(cinexSessionDetails('Sala 7\n06:40 pm', 'https://www.cinex.com.ve/assets/images/xsub.png'), { screen: '7', language: 'subtitulada' });
  assert.deepEqual(cinexSessionDetails('06:40 pm', undefined), { screen: undefined }, 'no room line means no room');
});

test('Cinex showtimes carry the age rating the venue and synopsis pages show', () => {
  // Markup as served on 2026-11-05 by cinex-tolon.html and sinopsis-clayface.html.
  const session = `<div onclick="javascript:checkLogin('7','TLN');" alt="${epoch('2026-11-04')}" class="cinemasessionpos"><button><img src="https://www.cinex.com.ve/assets/images/xsub.png" class="icoIdioma"><br>Sala 2<br>08:00 pm<br></button></div>`;
  const venue = parseCinexCinemaShowtimes(`<div class='container sessionslist'><h5 class='title'>CLAYFACE</h5><div class='movieinforow1'>Genero: <b>Terror</b><br></div><div class='movieinforow3'>Censura: <b>C</b><br></div>${session}</div>`,
    [{ kind: 'movie', id: 'clayface', name: 'CLAYFACE' }], 'TLN', '2026-11-04', context(), 'https://www.cinex.com.ve/cinex-tolon.html');
  assert.deepEqual(venue.map(i => [i.id, i.rating, i.screen, i.language]), [['7', 'C', '2', 'subtitulada']]);
  const synopsis = parseCinexShowtimes(`<h1>CLAYFACE</h1><ul><li><strong>Director: </strong>James Watkins</li><li><strong>Censura: </strong>C</li></ul>${session}`, 'clayface', '2026-11-04', context());
  assert.equal(nth(synopsis, 0).rating, 'C');
});

// Markup as served on 2026-11-12 by cinex-plazamayor.html, a venue that sells
// only at the box office: no checkLogin, epoch or session ID, and date tabs
// that skip days, so page 1 is not the day after page 0.
const boxOfficeSession = (room: string, time: string, icon = 'xsub') => `<div style='display: inline-block;margin: 5px;' onclick='javascript:void(0);' title='Función venta solo por taquilla' alt='Función venta solo por taquilla' class='cinemasessionpos'> <button type='button' class='btnprog indicadorfuncionagotada cursornoclick'><img src='assets/images/${icon}.png' class='icoIdioma'>${room ? `<br>${room}` : ''}<br>${time}</button> </div>`;
const boxOfficePage = (first = '2026-12-31') => `<div id='fecha' name='fecha' style='display:none;'>${first}</div>
  <div id='divdate0' class='carousel-cell'><div class='fecha1'>Jueves <br/> 31 <br/> Diciembre</div></div>
  <div id='divdate1' class='carousel-cell'><div class='fecha1'>Sábado <br/> 2 <br/> Enero</div></div>
  <div id='pagedate0'><div class='container sessionslist'><h5 class='title'>EBENEZER</h5><div class='movieinforow3'>Censura: <b>A</b><br></div>${boxOfficeSession('02', '04:35 pm')}${boxOfficeSession('02', '12:10 am')}</div></div>
  <div id='pagedate1'><div class='container sessionslist'><h5 class='title'>EBENEZER</h5>${boxOfficeSession('03', '07:00 pm')}</div></div>`;
const ebenezer = [{ kind: 'movie' as const, id: 'ebenezer', name: 'EBENEZER' }];

test('Cinex box-office-only functions are listed with the date of their tab and a computed id', () => {
  const c = context();
  const items = parseCinexCinemaShowtimes(boxOfficePage(), ebenezer, '30', '2026-12-31', c, 'https://www.cinex.com.ve/cinex-plazamayor.html', 'PLAZA MAYOR');
  assert.deepEqual(items.map(i => [i.date, i.time, i.starts_at, i.screen, i.language, i.rating, i.movie_id]).sort(), [
    // After midnight the tab's business date may be the previous calendar day: no starts_at.
    ['2026-12-31', '00:10', undefined, '02', 'subtitulada', 'A', 'ebenezer'],
    ['2026-12-31', '16:35', '2026-12-31T16:35:00-04:00', '02', 'subtitulada', 'A', 'ebenezer'],
  ]);
  assert.ok(items.every(i => /^taquilla-[0-9a-f]{20}$/.test(i.id)));
  // The same listing gets the same id on every read.
  assert.deepEqual(parseCinexCinemaShowtimes(boxOfficePage(), ebenezer, '30', '2026-12-31', context(), 'https://www.cinex.com.ve/cinex-plazamayor.html').map(i => i.id).sort(), items.map(i => i.id).sort());
  assert.equal(c.partial, false);
  assert.ok(c.warnings.some(w => /box office/.test(w) && /cannot be used for prices or seats/.test(w)), c.warnings.join(' | '));
  assert.ok(!c.warnings.some(w => /no showtimes/.test(w)));
  assert.ok(c.warnings.some(w => /after-midnight ones starts_at is omitted/.test(w)), c.warnings.join(' | '));
  // A dubbed and a subtitled function at the same time, without a room, are two showtimes.
  const twin = boxOfficePage().replace(boxOfficeSession('02', '12:10 am'), `${boxOfficeSession('', '07:00 pm', 'xes')}${boxOfficeSession('', '07:00 pm')}`);
  assert.deepEqual(parseCinexCinemaShowtimes(twin, ebenezer, '30', '2026-12-31', context(), 'https://www.cinex.com.ve/cinex-plazamayor.html')
    .filter(i => i.time === '19:00').map(i => i.language).sort(), ['es', 'subtitulada']);
  // The second tab is 2 January of the next year, not 1 January.
  assert.deepEqual(parseCinexCinemaShowtimes(boxOfficePage(), ebenezer, '30', '2027-01-01', context(), 'https://www.cinex.com.ve/cinex-plazamayor.html'), []);
  assert.deepEqual(parseCinexCinemaShowtimes(boxOfficePage(), ebenezer, '30', '2027-01-02', context(), 'https://www.cinex.com.ve/cinex-plazamayor.html').map(i => [i.date, i.time, i.screen]), [['2027-01-02', '19:00', '03']]);
});

test('Cinex box-office functions without a confirmed date are omitted as partial, not dated by guess', () => {
  const c = context();
  const undated = boxOfficePage().replace(/<div id='fecha'[^]*?<\/div>/, '');
  assert.deepEqual(parseCinexCinemaShowtimes(undated, ebenezer, '30', '2026-12-31', c, 'https://www.cinex.com.ve/cinex-plazamayor.html'), []);
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /date could not be confirmed/.test(w)));
});

test('Cinex tab dates accept the spellings Cinex may use and refuse a calendar that contradicts its first date', () => {
  const url = 'https://www.cinex.com.ve/cinex-plazamayor.html';
  const dated = (page: string, date: string) => { const c = context(); return { items: parseCinexCinemaShowtimes(page, ebenezer, '30', date, c, url), c }; };
  const variants = [
    boxOfficePage().replace('>2026-12-31<', '>2026-12-31 00:00:00<'),
    boxOfficePage().replace('Diciembre', 'Dic').replace('Enero', 'Ene.'),
    boxOfficePage().replace('Diciembre', 'Diciembre 2026').replace('Enero', 'Enero 2027'),
  ];
  for (const page of variants) {
    assert.equal(dated(page, '2027-01-02').items.length, 1, page.slice(0, 400));
    assert.equal(dated(page, '2026-12-31').items.length, 2);
  }
  const september = boxOfficePage('2026-09-30').replace('Jueves <br/> 31 <br/> Diciembre', 'Miercoles <br/> 30 <br/> Setiembre').replace('Sábado <br/> 2 <br/> Enero', 'Viernes <br/> 2 <br/> Octubre');
  assert.deepEqual(dated(september, '2026-10-02').items.map(i => i.date), ['2026-10-02']);
  // A tab Cinex left from an earlier year takes the year its weekday names, so it
  // is neither offered as next year's date nor makes the page partial.
  const stale = boxOfficePage().replace("<div id='pagedate1'>", `<div id='divdate2' class='carousel-cell'><div class='fecha1'>Miercoles <br/> 29 <br/> Octubre</div></div><div id='pagedate2'><div class='container sessionslist'><h5 class='title'>EBENEZER</h5>${boxOfficeSession('04', '05:00 pm')}</div></div><div id='pagedate1'>`);
  for (const date of ['2026-12-31', '2027-10-29']) {
    const { c } = dated(stale, date);
    assert.equal(c.partial, false, date);
  }
  assert.equal(dated(stale, '2027-10-29').items.length, 0);
  assert.equal(dated(stale, '2025-10-29').items.length, 1);
  // A first tab that is not #fecha, or a weekday that fits no year, dates nothing: partial, not a guessed day.
  for (const page of [boxOfficePage('2026-12-30'), boxOfficePage().replace('2 <br/> Enero', '30 <br/> Diciembre')]) {
    const { items, c } = dated(page, page.includes('2026-12-30') ? '2026-12-31' : '2026-12-30');
    assert.deepEqual(items, []);
    assert.equal(c.partial, true);
  }
});

test('Cinex prices and seats for a box-office function say so without reading the site or asking for a login', async () => {
  const { cinex } = await import('../../src/providers/cinex/adapter.js');
  const { getSeatMap } = await import('../../src/seats/seat-map.js');
  let fetched = 0;
  const http = new HttpClient(async () => { fetched++; return new Response('unexpected'); }, 15000, new EmptySessionStore());
  await assert.rejects(cinex('prices', { provider: 'cinex', cinema_id: '30', session_id: 'taquilla-0123456789abcdef0123' }, new ReadContext(http)), /only at the venue's box office/);
  const seats = await getSeatMap(http, { provider: 'cinex', cinema_id: '30', session_id: 'taquilla-0123456789abcdef0123' });
  assert.equal(seats.status, 'unavailable');
  assert.ok(seats.warnings.some(w => /only at the venue's box office/.test(w)), seats.warnings.join(' | '));
  assert.equal(fetched, 0);
});
