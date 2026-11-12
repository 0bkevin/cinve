import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivateRead, assertPublicRead } from '../../src/http/allow-list.js';
import { DataError } from '../../src/core.js';

test('Cinex authenticated routes reject extra, duplicate or malformed parameters', () => {
  for (const suffix of ['?cinemaid=TLN&cinemaid=REC', '?cinemaid=TLN&action=buy', '?cinemaid=..%2Fsecret']) {
    assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/concesiones.php' + suffix), DataError);
  }
});

test('public reads are limited to the routes adapters parse, even on allowed hosts', () => {
  for (const ok of [
    'https://www.cinex.com.ve/cines.html', 'https://www.cinex.com.ve/cartelera.html', 'https://www.cinex.com.ve/cinex-tolon.html',
    'https://www.cinex.com.ve/sinopsis-seres.parte1lainvasion.html',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemacitieslist',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemadatafromcinemaid&cinemaid=TLN',
    'https://www.cinesunidos.com/cines?city=Caracas', 'https://www.cinesunidos.com/cartelera?city=M%C3%A9rida',
    'https://gateway.cinesunidos.com/search/cities', 'https://gateway.cinesunidos.com/concessions/www/cinemas/1005/concessions',
    'https://cinepiccandelaria.com/es-AR', 'https://cinepicvip.com/es-AR/compra?cid=123301&fid=3636&pid=206',
    'https://apifront.cinexo.com.ar/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios?idComplejo=123300&fecha=04%2F11%2F2026',
    'https://api.cinexo.com.ar/api/complejo/123300/candy', 'https://api.cinexo.com.ar/api/complejo/123301/configuration',
  ]) assert.doesNotThrow(() => assertPublicRead(ok), ok);
  for (const bad of [
    'https://www.cinex.com.ve/assets/php/prepareconcessionprocess.php?action=buy',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemacitieslist&extra=1',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=preparepricecinema&cinemaid=TLN',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=somethingelse',
    'https://www.cinex.com.ve/cartelera.html?x=1', 'https://www.cinex.com.ve/sinopsis-..%2Fx.html',
    'https://www.cinex.com.ve/boletos.php?cinemaid=TLN&sessionid=1',
    'https://www.cinesunidos.com/cines?city=Caracas&city=Valencia', 'https://www.cinesunidos.com/api/seats?theaterId=1&showTimeId=2',
    'https://gateway.cinesunidos.com/tickets/www/theaters/1/sessions/2/', 'https://cinepicvip.com/es-AR/compra?cid=1&fid=2',
    'https://api.cinexo.com.ar/api/complejo/123300/candy/7/productos', 'https://api.cinexo.com.ar/api/complejo/123300/configuration?x=1',
    'https://evil.test/',
  ]) assert.throws(() => assertPublicRead(bad), DataError, bad);
});

test('gateway search routes are allowed only with a bounded city and exact Title query', () => {
  for (const ok of ['https://gateway.cinesunidos.com/search/cities/Caracas/theaters', 'https://gateway.cinesunidos.com/search/cities/M%C3%A9rida/films',
    'https://gateway.cinesunidos.com/search/cities/Caracas/sessions?Title=Duna+Parte+3']) assert.doesNotThrow(() => assertPublicRead(ok), ok);
  for (const bad of ['https://gateway.cinesunidos.com/search/cities/Caracas/sessions', 'https://gateway.cinesunidos.com/search/cities/Caracas/sessions?Title=a&x=1',
    'https://gateway.cinesunidos.com/search/cities/Caracas/theaters?x=1', 'https://gateway.cinesunidos.com/search/cities/%2F/films',
    'https://gateway.cinesunidos.com/search/cities/%E0%A4%A/films', 'https://gateway.cinesunidos.com/search/cities/Caracas/orders']) assert.throws(() => assertPublicRead(bad), DataError, bad);
});
