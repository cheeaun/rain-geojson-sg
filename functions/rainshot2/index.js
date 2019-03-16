const puppeteer = require('puppeteer');
let page;

async function getBrowserPage() {
  const browser = await puppeteer.launch({
    defaultViewport: {
      width: 400,
      height: 226,
      deviceScaleFactor: 2,
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
  await p.goto('https://checkweather.sg/mini/', {
    waitUntil: 'networkidle0',
  });
  await p.waitForFunction("document.getElementById('rain').classList.contains('loaded')");

  return Promise.resolve(p);
}

function getMinutes(timestamp){
  // Don't care about AM/PM at all
  const [hour, min] = timestamp.split(':');
  return hour * 60 + min;
};

exports.rainshot2 = async (req, res) => {
  if (!page) page = await getBrowserPage();

  await page.waitForFunction("document.getElementById('datetime').textContent.trim().length > 0");

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
  }

  const imageBuffer = await page.screenshot({
    type: 'jpeg',
    quality: 90,
  });
  res.set('Content-Type', 'image/jpeg');
  res.send(imageBuffer);
};