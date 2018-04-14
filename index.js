const fs = require('fs');
const cors = require('micro-cors')();
const url = require('url');
const got = require('got');
const PNG = require('pngjs').PNG;
const { featureCollection, polygon, multiPolygon, round } = require('@turf/helpers');
const rewind = require('geojson-rewind');
const polygonClipping = require('polygon-clipping');
const zlib = require('zlib');
const rgbHex = require('rgb-hex');

// Rain area center and boundaries
const lowerLat = 1.156, upperLat = 1.475, lowerLong = 103.565, upperLong = 104.130;
const distanceLat = Math.abs(upperLat - lowerLat);
const distanceLong = Math.abs(upperLong - lowerLong);

// Color scales
const intensityColors = ['#40FFFD', '#3BEEEC', '#32D0D2', '#2CB9BD', '#229698', '#1C827D', '#1B8742', '#229F44', '#27B240', '#2CC53B', '#30D43E', '#38EF46', '#3BFB49', '#59FA61', '#FEFB63', '#FDFA53', '#FDEB50', '#FDD74A', '#FCC344', '#FAB03F', '#FAA23D', '#FB8938', '#FB7133', '#F94C2D', '#F9282A', '#DD1423', '#BE0F1D', '#B21867', '#D028A6', '#F93DF5'];
const intensityColorsCount = intensityColors.length;
const nearestColor = require('nearest-color').from(intensityColors);
const getIntensity = (color) => {
  const c = nearestColor(color);
  const index = intensityColors.indexOf(c);
  return Math.ceil((index+1)/intensityColorsCount*100);
};

const offset = 8; // Singapore timezone +0800
function datetimeNowStr(){
  // https://stackoverflow.com/a/11124448/20838
  const d = new Date( new Date().getTime() + offset * 3600 * 1000);
  const year = d.getUTCFullYear();
  const month = ('' + (d.getUTCMonth() + 1)).padStart(2, '0');
  const day = ('' + d.getUTCDate()).padStart(2, '0');
  const hour = ('' + d.getUTCHours()).padStart(2, '0');
  const min = ('' + d.getUTCMinutes()).padStart(2, '0');
  return parseInt(year + month + day + hour + min, 10);
};

function datetimeStr(customMinutes = 0){
  const d = datetimeNowStr() + customMinutes;
  return Math.floor(d/5)*5;
};

function convertPNG2GeoJSON(png){
  const { width, height, data } = png;
  const polygons = [];
  const polygonsByColor = {};

  for (let y=0; y<height; y++) {
    for (let x=0; x<width; x++) {
      const idx = (width * y + x) << 2;
      const alpha = data[idx+3];
      const hasColor = alpha > 0;
      if (hasColor){
        const lLong = round(lowerLong + (x/width*distanceLong), 4);
        const uLong = round(lowerLong + ((x+1)/width*distanceLong), 4);
        const lLat = round(upperLat - (y/height*distanceLat), 4);
        const uLat = round(upperLat - ((y+1)/height*distanceLat), 4);

        const key = data[idx] + ',' + data[idx+1] + ',' + data[idx+2];

        // const p = polygon([[
        //   [lLong, uLat],
        //   [uLong, uLat],
        //   [uLong, lLat],
        //   [lLong, lLat],
        //   [lLong, uLat]
        // ]], {
        //   color,
        //   intensity,
        // });
        const p = [[
          [lLong, uLat],
          [uLong, uLat],
          [uLong, lLat],
          [lLong, lLat],
          [lLong, uLat]
        ]];
        if (!polygonsByColor[key]) polygonsByColor[key] = [];
        polygonsByColor[key].push(p);
        // polygons.push(p);
      }
    }
  }

  for (const key in polygonsByColor){
    const allP = polygonsByColor[key];
    const unionP = polygonClipping.union(...allP);
    const [r, g, b] = key.split(',').map(Number);
    const mp = multiPolygon(unionP, {
      color: '#' + rgbHex(r, g, b),
      intensity: getIntensity({r, g, b}),
    });
    polygons.push(mp);
  }

  const fc = rewind(featureCollection(polygons));
  return fc;
};

function fetchImage(dt){
  const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
  console.log(`➡️ ${url}`);
  return got(url, { encoding: null });
}

const parsePNG = (body) => new Promise((resolve, reject) => {
  new PNG().parse(body, (e, data) => {
    if (e){
      reject(e);
      return;
    }
    resolve(data);
  });
});

let cachedDt;
let geoJSONCache = null;
const getGeoJSON = async () => {
  let dt = datetimeStr();
  if (dt === cachedDt) return;

  let image;
  try {
    image = await fetchImage(dt);
  } catch(e) {
    // Retry with older radar image
    dt = datetimeStr(-5);
    // If older radar image is already cached, return immediately
    if (dt === cachedDt) return geoJSONCache;
    try {
      image = await fetchImage(dt);
    } catch(e) {
      return geoJSONCache;
    }
  }
  cachedDt = dt;
  const { body } = image;

  const data = await parsePNG(body);
  const geojson = convertPNG2GeoJSON(data);
  const geojsonStr = JSON.stringify(geojson);
  geoJSONCache = zlib.gzipSync(geojsonStr);
  console.log('GeoJSON cached', dt);
  return geoJSONCache;
};
getGeoJSON();
setInterval(getGeoJSON, 30 * 1000); // every half minute

const stations = {};
(async () => {
  const stationsURL = 'http://www.weather.gov.sg/mobile/json/rest-get-all-climate-stations.json';
  const { body } = await got(stationsURL, { json: true });
  const stationMaps = {};
  body.data.forEach(d => {
    stations[d.id] = d;
  });
})();
const observationsCache = new Map();

module.exports = cors(async (req, res) => {
  const { pathname } = url.parse(req.url);
  switch (pathname) {
    case '/':
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        repo: 'https://github.com/cheeaun/rain-geojson-sg',
        author: 'Lim Chee Aun',
      }));
      break;
    case '/favicon.ico':
      res.setHeader('content-type', 'image/x-icon');
      res.end();
      break;
    case '/now':
      const ageDiff = datetimeNowStr() - cachedDt;
      const proxyMaxAge = Math.max(0, (5 - ageDiff)) * 60;

      const data = geoJSONCache || await getGeoJSON();
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-length', data.length);
      res.setHeader('cache-control', `public, max-age=60, s-maxage=${proxyMaxAge}`);
      res.setHeader('x-geojson-datetime', cachedDt);
      res.end(data);
      break;
    case '/observations':
      const dataURL = 'http://www.weather.gov.sg/mobile/json/rest-get-latest-observation-for-all-locs.json';
      const { body } = await got(dataURL, { json: true, cache: observationsCache });
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'public, max-age=60');
      res.end(JSON.stringify({
        type: 'FeatureCollection',
        features: Object.entries(body.data.station).map(([id, values]) => {
          const { name, lat, long } = stations[id];
          for (let k in values){
            const v = values[k];
            values[k] = Number(v) || v;
          };
          return {
            type: 'Feature',
            properties: {
              id,
              name,
              ...values,
            },
            geometry: {
              type: 'Point',
              coordinates: [long, lat].map(Number),
            },
          };
        })
      }));
  }
});