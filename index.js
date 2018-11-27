const cors = require('micro-cors')();
const url = require('url');
const got = require('got');
const PNG = require('pngjs').PNG;
const area = require('@turf/area').default;
const intersect = require('@turf/intersect').default;
const { featureCollection, polygon, multiPolygon, round } = require('@turf/helpers');
const rewind = require('geojson-rewind');
const { union } = require('polygon-clipping');
const rgbHex = require('rgb-hex');
const { Feed } = require('feed');

const boundaryFeature = JSON.parse(require('fs').readFileSync('./sg-region-boundary.json'));

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

function getDateFromStr(str){
  const dateNums = `${str}`.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/).slice(1).map(Number);
  const [year, month, ...rest] = dateNums;
  return new Date(year, month-1, ...rest);
};

let coverage = 0;
let sgCoverage = 0;
function convertPNG2GeoJSON(png, id){
  const { width, height, data } = png;
  const polygons = [];
  const polygonsByColor = {};
  let colorsCount = 0;
  const dataCache = { id, data: [] };

  for (let y=0; y<height; y++) {
    dataCache.data.push([]);
    for (let x=0; x<width; x++) {
      const idx = (width * y + x) << 2;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      const alpha = data[idx+3];
      const hasColor = alpha > 0;
      if (hasColor){
        const lLong = round(lowerLong + (x/width*distanceLong), 4);
        const uLong = round(lowerLong + ((x+1)/width*distanceLong), 4);
        const lLat = round(upperLat - (y/height*distanceLat), 4);
        const uLat = round(upperLat - ((y+1)/height*distanceLat), 4);

        const key = `${r},${g},${b}`;

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

        colorsCount++;
      }

      dataCache.data[y].push(hasColor ? getIntensity({r, g, b}) : 0);
    }
  }

  coverage = (colorsCount / (width * height)) * 100;

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

  const oneWholePolygon = multiPolygon(polygons.length ? union(...polygons.map(p => p.geometry.coordinates)) : []);
  let boundaryArea = 0, sgArea = 0;
  boundaryFeature.features.forEach(feature => {
    boundaryArea += area(feature);
    const intersectArea = intersect(feature, oneWholePolygon);
    if (intersectArea) sgArea += area(intersectArea);
    // const { name } = feature.properties;
    // if (intersectArea) {
    //   console.log(name, area(intersectArea)/area(feature)*100, '%');
    // } else {
    //   console.log(name, 'NOT INTERSECTING');
    // }
  });
  sgCoverage = sgArea/boundaryArea*100;
  console.log(`Coverage: ${sgCoverage.toFixed(2)}% / ${coverage.toFixed(2)}%`);

  return [fc, dataCache];
};

let prevURL = '';
const fetchImage = (dt) => new Promise((resolve, reject) => {
  const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
  console.log(url !== prevURL ? `➡️  ${url}` : '♻️');
  prevURL = url;
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
    .on('error', (e) => {
      console.error(e);
      reject(e);
    })
    .on('parsed', function(){
      resolve(this);
    });
});

// function fetchImage(dt){
//   const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
//   console.log(`➡️ ${url}`);
//   return got(url, { encoding: null });
// }

const grabGeoJSON = async (dt) => {
  if (dt === cachedDt) return geoJSONCache;
  const img = await fetchImage(dt);
  const [ geojson, data ] = convertPNG2GeoJSON(img, dt);
  const geojsonStr = JSON.stringify(geojson);
  const dataStr = JSON.stringify(data);
  console.log('GeoJSON generated', dt);
  return [geojsonStr, dataStr];
}

let cachedDt;
let geoJSONCache = '';
let dataCache = {};
const getGeoJSON = async () => {
  let dt = datetimeStr();
  if (dt === cachedDt) return [geoJSONCache, dataCache];

  let img;
  try {
    img = await fetchImage(dt);
  } catch(e) {
    // Retry with older radar image
    dt = datetimeStr(-5);
    // If older radar image is already cached, return immediately
    if (dt === cachedDt) return [geoJSONCache, dataCache];
    try {
      img = await fetchImage(dt);
    } catch(e) {
      return [geoJSONCache, dataCache];
    }
  }

  cachedDt = dt;

  const [ geojson, data ] = convertPNG2GeoJSON(img, cachedDt);
  geoJSONCache = JSON.stringify(geojson);
  dataCache = data;
  console.log('GeoJSON cached', dt);

  return [geoJSONCache, dataCache];
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

const formatAscii = ({ id, data }) => {
  return id + '\n' + data.map(y => {
    let text = '';
    y.forEach(x => {
      text += x ? String.fromCharCode(x+33) : ' ';
    });
    return text.trimEnd();
  }).join('\n');
};

module.exports = cors(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  const ageDiff = datetimeNowStr() - cachedDt;
  const proxyMaxAge = Math.max(0, (5 - ageDiff)) * 60;

  const { json, ascii } = query;

  switch (pathname) {
    case '/':
      const memoryUsage = process.memoryUsage();
      const used = memoryUsage.heapUsed / 1024 / 1024;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        repo: 'https://github.com/cheeaun/rain-geojson-sg',
        author: 'Lim Chee Aun',
        data: {
          datetime: cachedDt,
        },
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
    case '/rainarea': {
      const { datetime } = query;
      if (/\d{11}[05]/.test(datetime)){
        try {
          const [geojson, data] = await grabGeoJSON(datetime);
          const response = !ascii ? (!!json ? JSON.stringify(data) : geojson) : formatAscii(data);
          res.setHeader('content-type', !ascii ? 'application/json' : 'text/plain');
          res.setHeader('content-length', response.length);
          res.setHeader('cache-control', 'public, max-age=31536000'); // 1 year
          res.end(response);
        } catch (e) {
          res.statusCode = 404;
          res.end('Radar image not found.');
        }
      } else {
        res.statusCode = 400;
        res.end('Invalid request. `datetime` query is required as a 12-digit YYYYMMDDHHMM string. Last MM is in 5-minute intervals. Timezone in SGT.');
      }
      break;
    }
    case '/now': {
      const [geojson, data] = await getGeoJSON();
      const response = !ascii ? (!!json ? JSON.stringify(data) : geojson) : formatAscii(data);
      res.setHeader('content-type', !ascii ? 'application/json' : 'text/plain');
      res.setHeader('content-length', response.length);
      res.setHeader('cache-control', `public, max-age=60, s-maxage=${proxyMaxAge}`);
      res.end(response);
      break;
    }
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
    case '/feed':
      console.log(`Feed request from: ${req.headers['user-agent']}`);
      const date = getDateFromStr(cachedDt);
      const feed = new Feed({
        title: 'Rain GeoJSON SG',
        id: 'rain-geojson-sg',
        updated: date,
      });
      if (sgCoverage > 5 && cachedDt){
        feed.addItem({
          title: `${'🌧'.repeat(Math.ceil(coverage/20))} Rain coverage: ${coverage.toFixed(2)}%`,
          description: `Rain coverage over Singapore: ${sgCoverage.toFixed(2)}%`,
          id: cachedDt,
          link: 'https://checkweather.sg',
          date,
        });
      }
      res.setHeader('content-type', 'application/atom+xml');
      res.setHeader('cache-control', 'public, max-age=120');
      res.end(feed.atom1());
      break;
    default:
      res.statusCode = 404;
      res.end('404.');
  }
});