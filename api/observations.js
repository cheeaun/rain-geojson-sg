const got = require('got');

const stationsURL = 'http://www.weather.gov.sg/mobile/json/rest-get-all-climate-stations.json';
let stationsData;
const getStations = async () => {
  if (stationsData) return stationsData;
  console.time('GET STATIONS');
  const { body } = await got(stationsURL, { json: true });
  console.timeEnd('GET STATIONS');
  return body;
};

const dataURL = 'http://www.weather.gov.sg/mobile/json/rest-get-latest-observation-for-all-locs.json';
const observationsCache = new Map();
const numberRegexp = /[\d.]+/;
const getObservations = async () => {
  console.time('GET OBS');
  const [climateStations, { body: observations }] = await Promise.all([
    getStations(),
    got(dataURL, { json: true, cache: observationsCache }),
  ]);
  console.timeEnd('GET OBS');
  stationsData = climateStations;

  const obs = [];
  Object.entries(observations.data.station).forEach(([stationID, obj]) => {
    const { id, long, lat } = climateStations.data.find(
      d => d.id === stationID,
    );
    const values = {};
    for (let k in obj) {
      const v = obj[k];
      if (numberRegexp.test(v)) {
        const val = Number(v);
        if (val) values[k] = val;
      }
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