const puppeteer = require('puppeteer');
let page;

async function getBrowserPage() {
  const browser = await puppeteer.launch({
    defaultViewport: {
      width: 640,
      height: 361,
      isLandscape: true,
    },
    args: [
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-sandbox',
      '--no-zygote',
      '--single-process',
    ],
  });

  const p = await browser.newPage();
  await p.goto('https://checkweather.sg/#immersive', {
    waitUntil: 'networkidle0',
  });
  await p.waitForFunction("$map.queryRenderedFeatures({layers: ['tempreadings']}).length > 0");
  await p.waitForFunction("$map.queryRenderedFeatures({layers: ['windirections']}).length > 0");

  return Promise.resolve(p);
}

exports.rainshot = async (req, res) => {
  if (!page) page = await getBrowserPage();

  await page.waitForSelector('#datetime:not([hidden]) blink');
  await page.waitForSelector('#loader[hidden]');

  const imageBuffer = await page.screenshot({
    type: 'jpeg',
    quality: 90,
  });
  res.set('Content-Type', 'image/jpeg');
  res.send(imageBuffer);
};