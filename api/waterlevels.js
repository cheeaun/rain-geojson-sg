const got = require('got');

const drainColor = {
  0: 'green',
  1: 'yellow',
  2: 'red',
};
const flagState = {
  0: 'Drain 0-75% full',
  1: 'Drain 75%-90% full',
  2: 'Drain 90%-100% full',
  3: 'Station under maintenance',
  4: 'Station under maintenance',
};

const getWaterLevels = async () => {
  const url =
    'https://app.pub.gov.sg/waterlevel/pages/GetWLInfo.aspx?par=JJD5yyjrbKsdwpb29Pa+F3VyBuLegVkfVakRk8CLu+tBwoQePlabYKYcuYR1HW0K7zMC5jEG4Rhz2DZp9XTMQAXTeSCeh+AHfq4uKZEbtLo=';
  console.log(`Fetching ${url}`);
  const { body } = await got(url, {
    retry: 2,
    maxRedirects: 1,
    headers: { 'user-agent': undefined },
  });
  const json = body
    .split('$@$')
    .filter((l) => !!l)
    .map((l) => {
      const [id, name, lng, lat, waterLevel, flag, observationTime] = l
        .trim()
        .split('$#$');
      return {
        id,
        name,
        lng: parseFloat(lng, 10),
        lat: parseFloat(lat, 10),
        waterLevel: parseFloat(waterLevel, 10),
        flag: parseInt(flag, 10),
        drainColor: drainColor[flag] || null,
        flagState: flagState[flag],
        observationTime,
      };
    });

  return json;
};

module.exports = async (req, res) => {
  try {
    res.setHeader('cache-control', 'public, max-age=30, must-revalidate');
    res.json(await getWaterLevels());
  } catch (e) {
    res.setHeader('cache-control', 'no-cache');
    res.json({ error: e.stack || e });
  }
};
