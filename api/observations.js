const got = require('got');
const { DateTime } = require('luxon');

// Have to be X minutes in the past, else it's too recent and lack of data
const datetime = () =>
  DateTime.local()
    .minus({ minutes: 10 })
    .set({ second: 0 })
    .setZone('Asia/Singapore')
    .toISO()
    .replace(/\..*$/, ''); // Remove the mili-seconds from the ISO-8601 timestamp

const apiURLs = {
  temp_celcius: 'https://api.data.gov.sg/v1/environment/air-temperature',
  rain_mm: 'https://api.data.gov.sg/v1/environment/rainfall',
  relative_humidity: 'https://api.data.gov.sg/v1/environment/relative-humidity',
  wind_direction: 'https://api.data.gov.sg/v1/environment/wind-direction',
  wind_speed: 'https://api.data.gov.sg/v1/environment/wind-speed',
};
const apiKeys = Object.keys(apiURLs);

const fetch = (url) => {
  const u = `${url}?date_time=${datetime()}`;
  console.log(`Fetching ${u}`);
  return got(u, {
    responseType: 'json',
    timeout: 2 * 1000,
    retry: 2,
    maxRedirects: 1,
    calculateDelay: () => 1000,
    headers: { 'user-agent': undefined },
  });
};

// id, lng, lat, temp_celcius, relative_humidity, rain_mm, wind_direction, wind_speed

const getObservations = async () => {
  const climateStations = {};
  const observations = {};
  const apiFetches = Object.values(apiURLs).map((url) => fetch(url));
  const results = await Promise.allSettled(apiFetches);
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') {
      console.log('API fetch failed:', apiKeys[i]);
      return;
    }
    const { body } = result.value;
    body.metadata.stations.forEach((station) => {
      climateStations[station.id] = {
        lng: station.location.longitude,
        lat: station.location.latitude,
      };
    });
    body.items.forEach((item) => {
      item.readings.forEach((reading) => {
        if (!reading.value) return;
        const roundedValue = Number(reading.value.toFixed(1));
        if (observations[reading.station_id]) {
          observations[reading.station_id][apiKeys[i]] = roundedValue;
        } else {
          observations[reading.station_id] = {
            [apiKeys[i]]: roundedValue,
          };
        }
      });
    });
  });

  const obs = Object.entries(observations).map(([stationID, observation]) => {
    return {
      id: stationID,
      lng: +climateStations[stationID].lng.toFixed(4),
      lat: +climateStations[stationID].lat.toFixed(4),
      ...observation,
    };
  });

  return obs;
};

module.exports = async (req, res) => {
  try {
    res.setHeader('cache-control', 'public, max-age=120, s-maxage=120');
    res.json(await getObservations());
  } catch (e) {
    res.setHeader('cache-control', 'no-cache');
    res.json({ error: e.stack || e });
  }
};
