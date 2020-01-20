const { createServer } = require('http');
const findChrome = require('chrome-finder');
const chrome = require('chrome-aws-lambda');

const isDev = !process.env.NOW_REGION;
let page;

async function getBrowserPage() {
  try {
    const browser = await chrome.puppeteer.launch({
      defaultViewport: {
        width: 400,
        height: 226,
        deviceScaleFactor: 2,
        isLandscape: true,
      },
      ...(isDev ? {
        executablePath: findChrome(),
      } : {
        args: chrome.args,
        executablePath: await chrome.executablePath,
        headless: chrome.headless,
      }),
    });

    const p = await browser.newPage();
    await p.goto('https://checkweather.sg/mini/', {
      waitUntil: 'networkidle0',
    });
    await p.waitForFunction("document.getElementById('rain').classList.contains('loaded')");
    return p;
  } catch (e) {
    console.error(e);
  }
}

function getMinutes(timestamp){
  // Don't care about AM/PM at all
  const [hour, min] = timestamp.split(':');
  return hour * 60 + min;
};

async function handler(req, res) {
  try {
    if (!page) page = await getBrowserPage();

    await page.waitForFunction("document.getElementById('datetime').textContent.trim().length > 0");
    await page.waitForFunction("document.getElementById('obs').children.length > 0");

    const [time, localTime] = await page.evaluate(() => {
      const time = document.getElementById('datetime').textContent.match(/^\d+\:\d\d/i)[0];
      const localTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Singapore' }).match(/^\d+\:\d\d/i)[0];
      return [time, localTime];
    });

    console.log(time, localTime);

    const minutes = getMinutes(time);
    const localMinutes = getMinutes(localTime);
    if (localMinutes - minutes > 10){
      // Reload page if timing is too overly off
      await page.reload({
        waitUntil: 'networkidle0',
      });
      await page.waitForFunction("document.getElementById('rain').classList.contains('loaded')");
      await page.waitForFunction("document.getElementById('datetime').textContent.trim().length > 0");
      await page.waitForFunction("document.getElementById('obs').children.length > 0");
    }

    const imageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90,
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(imageBuffer);
  } catch (e) {
    console.error(e);
  }
};

exports.default = handler;

if (isDev) {
  const PORT = process.env.PORT || 13463;
  const listen = () => console.log(`Listening on ${PORT}...`);
  createServer(handler).listen(PORT, listen);
}