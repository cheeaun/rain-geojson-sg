const cors = require('micro-cors')();
const url = require('url');
const got = require('got');
const PNG = require('pngjs').PNG;
const { featureCollection, polygon, multiPolygon, round } = require('@turf/helpers');
const rewind = require('geojson-rewind');
const { union } = require('polygon-clipping');
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
function datetimeNowStr(customMinutes){
  // https://stackoverflow.com/a/11124448/20838
  const d = new Date( new Date().getTime() + offset * 3600 * 1000);
  if (customMinutes) d.setUTCMinutes(d.getUTCMinutes() + customMinutes);
  const year = d.getUTCFullYear();
  const month = ('' + (d.getUTCMonth() + 1)).padStart(2, '0');
  const day = ('' + d.getUTCDate()).padStart(2, '0');
  const hour = ('' + d.getUTCHours()).padStart(2, '0');
  const min = ('' + d.getUTCMinutes()).padStart(2, '0');
  return parseInt(year + month + day + hour + min, 10);
};

function datetimeStr(customMinutes){
  const d = datetimeNowStr(customMinutes);
  return Math.floor(d/5)*5;
};

function convertPNG2GeoJSON(png, id){
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
    const unionP = union(...allP);
    const [r, g, b] = key.split(',').map(Number);
    const mp = multiPolygon(unionP, {
      color: '#' + rgbHex(r, g, b),
      intensity: getIntensity({r, g, b}),
    });
    polygons.push(mp);
  }

  const fc = rewind(featureCollection(polygons, {
    bbox: [lowerLong, lowerLat, upperLong, upperLat],
    id,
  }));
  return fc;
};

const fetchImage2GeoJSON = (dt) => new Promise((resolve, reject) => {
  const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
  console.log(`➡️ ${url}`);
  let imgReq;
  const imgStream = got.stream(url, { encoding: null })
    .on('error', (e) => {
      if (e.statusCode == 404){
        reject(new Error('Page not found'));
      } else {
        console.error(e);
        reject(e);
      }
    })
    .on('request', (req) => imgReq = req)
    .on('response', (msg) => {
      if (msg.headers['content-type'] !== 'image/png'){
        imgReq && imgReq.abort();
        const e = new Error('Radar image is not a PNG image.');
        console.error(e);
        reject(e);
      }
    })
    .pipe(new PNG({
      checkCRC: false,
    }))
    .on('parsed', function(){
      resolve(this);
    });
});

function fetchImage(dt){
  const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
  console.log(`➡️ ${url}`);
  return got(url, { encoding: null });
}

const grabGeoJSON = async (dt) => {
  const data = await fetchImage2GeoJSON(dt);
  const geojson = convertPNG2GeoJSON(data, dt);
  const geojsonStr = JSON.stringify(geojson);
  console.log('GeoJSON generated', dt);
  return geojsonStr;
}

let cachedDt;
let geoJSONCache = '';
const getGeoJSON = async () => {
  let dt = datetimeStr();
  if (dt === cachedDt) return geoJSONCache;

  let data;
  try {
    data = await fetchImage2GeoJSON(dt);
  } catch(e) {
    // Retry with older radar image
    dt = datetimeStr(-5);
    // If older radar image is already cached, return immediately
    if (dt === cachedDt) return geoJSONCache;
    try {
      data = await fetchImage2GeoJSON(dt);
    } catch(e) {
      return geoJSONCache;
    }
  }

  cachedDt = dt;

  const geojson = convertPNG2GeoJSON(data, cachedDt);
  geoJSONCache = JSON.stringify(geojson);
  console.log('GeoJSON cached', dt);
  return geoJSONCache;
};
getGeoJSON();
const geojsonInt = setInterval(getGeoJSON, 30 * 1000); // every half minute
process.on('SIGINT', () => clearInterval(geojsonInt));

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
let lastObservations = {};

const dataURL = 'http://www.weather.gov.sg/mobile/json/rest-get-latest-observation-for-all-locs.json';

module.exports = cors(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  const ageDiff = datetimeNowStr() - cachedDt;
  const proxyMaxAge = Math.max(0, (5 - ageDiff)) * 60;

  switch (pathname) {
    case '/':
      const memoryUsage = process.memoryUsage();
      const used = memoryUsage.heapUsed / 1024 / 1024;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        repo: 'https://github.com/cheeaun/rain-geojson-sg',
        author: 'Lim Chee Aun',
        process: {
          version: process.versions,
          memoryUsageReadable: `${Math.round(used * 100) / 100} MB`,
          memoryUsage,
        },
      }));
      break;
    case '/favicon.ico':
      res.setHeader('content-type', 'image/x-icon');
      res.end();
      break;
    case '/rainarea':
      const { datetime } = query;
      if (/\d{11}[05]/.test(datetime)){
        try {
          const data = await grabGeoJSON(datetime);
          res.setHeader('content-type', 'application/json');
          res.setHeader('content-length', data.length);
          res.setHeader('cache-control', 'public, max-age=31536000'); // 1 year
          res.end(data);
        } catch (e) {
          res.statusCode = 404;
          res.end('Radar image not found.');
        }
      } else {
        res.statusCode = 400;
        res.end('Invalid request. `datetime` query is required as a 12-digit YYYYMMDDHHMM string. Last MM is in 5-minute intervals. Timezone in SGT.');
      }
      break;
    case '/now':
      const data = await getGeoJSON();
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', data.length);
      res.setHeader('cache-control', `public, max-age=60, s-maxage=${proxyMaxAge}`);
      res.end(data);
      break;
    case '/now-id':
      await getGeoJSON();
      res.setHeader('content-type', 'text/plain');
      if (cachedDt){
        res.setHeader('cache-control', `public, max-age=60, s-maxage=${proxyMaxAge}`);
        res.end('' + cachedDt);
      } else {
        res.setHeader('cache-control', `public, no-cache`);
        res.end('');
      }
      break;
    case '/observations':
      const compact = !!query.compact;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'public, max-age=60');
      try {
        const { body, fromCache } = await got(dataURL, { json: true, cache: observationsCache });
        if (!fromCache || !lastObservations[compact]){
          const features = [];
          Object.entries(body.data.station).forEach(([id, values]) => {
            const { name, lat, long } = stations[id];
            const props = {};
            for (let k in values){
              const v = values[k];
              const nv = isNaN(v) ? v : Number(v);
              if (!compact || (compact && /rain|temp|humidity|wind_direction/i.test(k) && nv)){
                props[k] = nv;
              }
            };
            if (!compact){
              features.push({
                type: 'Feature',
                properties: {
                  id,
                  name,
                  ...props,
                },
                geometry: {
                  type: 'Point',
                  coordinates: [long, lat].map(Number),
                },
              });
            } else if (compact && Object.keys(props).length){
              features.push({
                type: 'Feature',
                properties: props,
                geometry: {
                  type: 'Point',
                  coordinates: [long, lat].map(Number),
                },
              });
            }
          });
          lastObservations[compact] = JSON.stringify({
            type: 'FeatureCollection',
            features,
          });
        }
      } catch(e) {}
      res.end(lastObservations[compact] || '');
      break;
    default:
      res.statusCode = 404;
      res.end('404.');
  }
});