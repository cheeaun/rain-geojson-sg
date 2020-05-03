const got = require('got');
const PNG = require('pngjs').PNG;

const sgCoverageIndices = require('../sg-coverage-indices.json');
const totalSgCells = sgCoverageIndices.reduce((acc, v) => acc + v.length, 0);

const offset = 8; // Singapore timezone +0800
function datetimeNowStr(customMinutes) {
  // https://stackoverflow.com/a/11124448/20838
  const d = new Date(new Date().getTime() + offset * 3600 * 1000);
  if (customMinutes) d.setUTCMinutes(d.getUTCMinutes() + customMinutes);
  const year = d.getUTCFullYear();
  const month = ('' + (d.getUTCMonth() + 1)).padStart(2, '0');
  const day = ('' + d.getUTCDate()).padStart(2, '0');
  const hour = ('' + d.getUTCHours()).padStart(2, '0');
  const min = ('' + d.getUTCMinutes()).padStart(2, '0');
  return parseInt(year + month + day + hour + min, 10);
}

function datetimeStr(customMinutes) {
  const d = datetimeNowStr(customMinutes);
  return Math.floor(d / 5) * 5;
}

const shortenPercentage = (percentage) => +percentage.toFixed(2);

const fetchRadar = (dt) =>
  new Promise((resolve, reject) => {
    console.log(`Fetch: ${dt}`);
    const url = `http://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`;
    console.log(`➡️  ${url}`);
    console.time('Fetch radar');
    got
      .stream(url, { encoding: null })
      .on('error', (e) => {
        if (e.statusCode == 404) {
          reject(new Error('Page not found'));
        } else {
          console.error(e);
          reject(e);
        }
      })
      .on('request', (req) => (imgReq = req))
      .on('response', (msg) => {
        if (msg.headers['content-type'] !== 'image/png') {
          imgReq && imgReq.abort();
          const e = new Error('Radar image is not a PNG image.');
          console.error(e);
          reject(e);
        }
      })
      .pipe(
        new PNG({
          filterType: 4,
          checkCRC: false,
        }),
      )
      .on('error', (e) => {
        console.error(e);
        reject(e);
      })
      .on('parsed', function () {
        resolve(this);
        console.timeEnd('Fetch radar');
      });
  });

// Color scales
const intensityColors = [
  '#40FFFD',
  '#3BEEEC',
  '#32D0D2',
  '#2CB9BD',
  '#229698',
  '#1C827D',
  '#1B8742',
  '#229F44',
  '#27B240',
  '#2CC53B',
  '#30D43E',
  '#38EF46',
  '#3BFB49',
  '#59FA61',
  '#FEFB63',
  '#FDFA53',
  '#FDEB50',
  '#FDD74A',
  '#FCC344',
  '#FAB03F',
  '#FAA23D',
  '#FB8938',
  '#FB7133',
  '#F94C2D',
  '#F9282A',
  '#DD1423',
  '#BE0F1D',
  '#B21867',
  '#D028A6',
  '#F93DF5',
];
const intensityColorsCount = intensityColors.length;
const nearestColor = require('nearest-color').from(intensityColors);
const getIntensity = (color) => {
  const c = nearestColor(color);
  const index = intensityColors.indexOf(c);
  return Math.ceil(((index + 1) / intensityColorsCount) * 100);
};

const formatAscii = (data) =>
  data
    .map((y) => {
      let text = '';
      y.forEach((x) => {
        text += x ? String.fromCharCode(x + 33) : ' ';
      });
      return text.trimEnd();
    })
    .join('\n');

const convertImageToData = (img) => {
  const intensityData = [];
  let coverageCount = 0;
  let sgCoverageCount = 0;

  const { width, height, data } = img;
  const totalCells = width * height;

  for (let y = 0; y < height; y++) {
    intensityData.push([]);
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      const hasColor = alpha > 0;
      const intensity = hasColor ? getIntensity({ r, g, b }) : 0;
      intensityData[y].push(intensity);
      if (hasColor) {
        if (sgCoverageIndices[y].includes(x)) sgCoverageCount++;
        coverageCount++;
      }
    }
  }

  return {
    coverage_percentage: {
      all: shortenPercentage((coverageCount / totalCells) * 100),
      sg: shortenPercentage((sgCoverageCount / totalSgCells) * 100),
    },
    width,
    height,
    radar: formatAscii(intensityData),
  };
};

const cachedOutput = {};
module.exports = async (req, res) => {
  try {
    console.time('RESPONSE');
    let dt, output;
    const queryDt = req.query.dt;

    if (queryDt) {
      dt = +queryDt;
      const img = await fetchRadar(dt);
      const rainareas = convertImageToData(img);
      output = {
        id: '' + dt,
        dt,
        ...rainareas,
      };
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    } else {
      dt = datetimeStr();
      output = cachedOutput[dt];

      if (!output) {
        let img;
        try {
          img = await fetchRadar(dt);
        } catch (e) {
          // Retry with older radar image
          dt = datetimeStr(-5);
          output = cachedOutput[dt];

          if (!output) {
            img = await fetchRadar(dt);
          }
        }
        if (!output) {
          const rainareas = convertImageToData(img);
          output = cachedOutput[dt] = {
            id: '' + dt,
            dt,
            ...rainareas,
          };
        }
      }
      res.setHeader('cache-control', 'public, max-age=60');
    }

    res.json(output);
    console.timeEnd('RESPONSE');
  } catch (e) {
    res.setHeader('cache-control', 'no-cache');
    res.json({ error: e.stack || e });
  }
};
