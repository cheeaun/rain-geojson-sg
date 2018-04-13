const fs = require('fs');
const cors = require('micro-cors')();
const url = require('url');
const haversine = require('new-point-haversine');
const got = require('got');
const PNG = require('pngjs').PNG;
const { featureCollection, polygon, multiPolygon, round } = require('@turf/helpers');
const rewind = require('geojson-rewind');
const polygonClipping = require('polygon-clipping');
const zlib = require('zlib');
const rgbHex = require('rgb-hex');

// Rain area center and boundaries
const center = [103.972583, 1.349110];
const { lowerLat, upperLat } = haversine.getLatitudeBounds(center[1], 70, 'km');
const { lowerLong, upperLong } = haversine.getLongitudeBounds(center[1], center[0], 70, 'km');
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

const datetimeStr = (customMinutes) => {
  const d = new Date();
  if (customMinutes) d.setUTCMinutes(d.getUTCMinutes() + customMinutes);
  const year = d.getUTCFullYear();
  const month = ('' + (d.getUTCMonth() + 1)).padStart(2, '0');
  const day = ('' + d.getUTCDate()).padStart(2, '0');
  const hour = ('' + d.getUTCHours()).padStart(2, '0');
  const min = ('' + Math.floor(d.getUTCMinutes()/5) * 5).padStart(2, '0');
  return year + month + day + hour + min;
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

let currentDt;
function fetchImage(){
  let url = `http://cdn.neaaws.com/rain_radar/dpsri_70km_Remove_${currentDt}0000dBR.dpsri.png`;
  return got(url, { encoding: null }).catch((e) => {
    currentDt = datetimeStr(-5);
    console.log('Current rain area fetch fail. Fallback to older one.', currentDt);
    url = `http://cdn.neaaws.com/rain_radar/dpsri_70km_Remove_${currentDt}0000dBR.dpsri.png`;
    return got(url, { encoding: null });
  });
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

let geoJSONCache = null;
const getGeoJSON = async () => {
  const dt = datetimeStr();
  if (dt === currentDt) return;
  currentDt = dt;
  const { body } = await fetchImage();
  const data = await parsePNG(body);
  const geojson = convertPNG2GeoJSON(data);
  const geojsonStr = JSON.stringify(geojson);
  geoJSONCache = zlib.gzipSync(geojsonStr);
  console.log('GeoJSON cached', dt);
  return geoJSONCache;
};
getGeoJSON();
setInterval(getGeoJSON, 2.5 * 60 * 1000); // every 2.5 minutes

const getCachedGeoJSON = async () => {
  if (geoJSONCache){
    return await Promise.resolve(geoJSONCache);
  }
  return await getGeoJSON();
};

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
    case '/now':
      const data = await getCachedGeoJSON();
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-length', data.length);
      res.setHeader('cache-control', 'public, max-age=120');
      res.setHeader('x-geojson-datetime', currentDt);
      res.end(data);
      break;
    case '/favicon.ico':
      res.setHeader('content-type', 'image/x-icon');
      res.end();
      break;
  }
});