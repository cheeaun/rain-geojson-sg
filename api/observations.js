const got = require('got');

const stationsURL =
  'http://www.weather.gov.sg/mobile/json/rest-get-all-climate-stations.json';
let stationsData;
const getStations = async () => {
  console.log('GET STATIONS start');
  console.time('GET STATIONS');
  if (stationsData) {
    console.timeEnd('GET STATIONS');
    return stationsData;
  }
  const { body } = await got(stationsURL, {
    responseType: 'json',
    timeout: 3 * 1000,
    headers: { 'user-agent': undefined },
  });
  console.timeEnd('GET STATIONS');
  stationsData = body;
  return body;
};

const dataURL =
  'http://www.weather.gov.sg/mobile/json/rest-get-latest-observation-for-all-locs.json';
const observationsCache = new Map();
const numberRegexp = /[\d.]+/;
const getObservations = async () => {
  console.log('GET OBS start');
  console.time('GET OBS');
  const [climateStations, { body: observations }] = await Promise.all([
    getStations(),
    got(dataURL, {
      responseType: 'json',
      timeout: 3 * 1000,
      retry: 3,
      cache: observationsCache,
      headers: { 'user-agent': undefined },
    }).then((res) => {
      console.timeEnd('GET OBS');
      return res;
    }),
  ]);

  const obs = [];
  Object.entries(observations.data.station).forEach(([stationID, obj]) => {
    const { id, long, lat } = climateStations.data.find(
      (d) => d.id === stationID,
    );
    const values = {};
    for (let k in obj) {
      const v = obj[k];
      if (numberRegexp.test(v)) {
        const val = Number(v);
        if (val) values[k] = val;
      }
    }

    // Special case for S121 overlapping with S23
    if (id === 'S121') {
      delete values.temp_celcius;
      delete values.relative_humidity;
    }

    if (Object.keys(values).length) {
      obs.push({
        id,
        lng: +(+long).toFixed(4),
        lat: +(+lat).toFixed(4),
        ...values,
      });
    }
  });

  return obs;
};

module.exports = async (req, res) => {
  try {
    res.setHeader('cache-control', 'public, max-age=120, s-maxage=120');
    res.json(await getObservations());
  } catch (e) {
    res.send(e.stack || e);
  }
};
