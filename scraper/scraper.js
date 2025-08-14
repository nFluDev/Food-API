const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || null;
if (!target) {
  console.error('❌ Lütfen bir market adı parametresi verin. Örn: node scraper.js sok');
  process.exit(1);
}

const configPath = path.join(__dirname, target, 'config.js');
if (!fs.existsSync(configPath)) {
  console.error(`❌ Config dosyası bulunamadı: ${configPath}`);
  process.exit(1);
}

const config = require(configPath);
const outputDir = path.join(__dirname, target, 'data');

const logFilePath = path.join(__dirname, 'logs.txt');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `[${pad(now.getDate())}.${pad(now.getMonth() + 1)}-${now.getFullYear()}.${pad(now.getHours())}.${pad(now.getMinutes())}]`;
}

function log(message) {
  const line = `${getTimestamp()} ${message}`;
  console.log(line);
  logStream.write(line + '\n');
}

function write(message) {
  const line = `${getTimestamp()} ${message}`;
  process.stdout.write(line);
  logStream.write(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

async function scrollTillAllProductsLoaded(page) {
  let previousProductCount = 0;
  let currentProductCount = 0;

  try {
    log('Ürün listesi container\'ı bekleniyor...');
    await page.waitForSelector(config.selectors.productContainer, { timeout: 10000 });
    log('Ürün listesi container\'ı bulundu, kaydırma başlatılıyor...');
  } catch (error) {
    log(`Ürün listesi container bulunamadı, script sonlandırılıyor: ${error.message}`);
    throw error;
  }

  while (true) {
    previousProductCount = await page.evaluate((selector, cardSelector) => {
      const container = document.querySelector(selector);
      return container ? container.querySelectorAll(cardSelector).length : 0;
    }, config.selectors.productContainer, config.selectors.productCard);

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    currentProductCount = await page.evaluate((selector, cardSelector) => {
      const container = document.querySelector(selector);
      return container ? container.querySelectorAll(cardSelector).length : 0;
    }, config.selectors.productContainer, config.selectors.productCard);

    if (currentProductCount <= previousProductCount) {
      write(`Sayfanın en altına ulaşıldı ve tüm ürünler yüklendi. Toplam: ${currentProductCount} ürün.\n`);
      break;
    }

    write(`Yeni ürünler yüklendi. Toplam: ${currentProductCount} ürün.\r`);
  }
}

async function extractProductsFromPage(page) {
  try {
    await page.waitForSelector(config.selectors.productCard, { timeout: 15000 });
  } catch (e) {
    log(`Ürün kartı selector'ı bulunamadı: ${config.selectors.productCard}`);
    return [];
  }

  const items = await page.$$eval(config.selectors.productCard, (cards, selectors, siteUrl) => {
    const parsePrice = (txt) => {
      if (!txt) return null;
      const cleaned = txt.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
      const num = parseFloat(cleaned);
      return Number.isNaN(num) ? null : num;
    };
    
    const extractImageUrl = (card, imgSelector) => {
      const imgEl = card.querySelector(imgSelector);
      return imgEl ? imgEl.src : null;
    };

    return cards.map((card) => {
      const titleEl = card.querySelector(selectors.productTitle);
      const name = titleEl ? titleEl.textContent.trim() : null;

      const brand = name ? name.split(/\s+/)[0].toUpperCase() : null;
      const href = card.querySelector(selectors.productLink)?.getAttribute('href') || null;
      const imageUrl = extractImageUrl(card, selectors.productImage);

      let price = null;
      let discountedPrice = null;

      const discountBox = card.querySelector(selectors.discountedPriceContainer);
      if (discountBox) {
        const originalTxt =
          discountBox.querySelector(selectors.originalPrice)?.textContent ||
          null;

        const discountedTxt =
          discountBox.querySelector(selectors.discountedPrice)?.textContent || null;

        price = parsePrice(originalTxt);
        discountedPrice = parsePrice(discountedTxt);
      } else {
        const originalTxt =
          card.querySelector(selectors.priceContainer)?.textContent ||
          card.querySelector(selectors.originalPrice)?.textContent ||
          null;
        price = parsePrice(originalTxt);
        discountedPrice = null;
      }

      return {
        name,
        brand,
        price,
        discountedPrice,
        imageUrl: imageUrl,
        url: href ? new URL(href, siteUrl).toString() : null,
      };
    });
  }, config.selectors, config.url);

  return items.filter((p) => p.name && p.price !== null);
}

async function scrapeProductDetails(page, productUrl, currentIndex, totalCount) {
  const progress = Math.round((currentIndex / totalCount) * 100);
  const progressBar = '█'.repeat(Math.floor(progress / 5)) + ' '.repeat(20 - Math.floor(progress / 5));
  write(`  🔍 Ürün detay sayfası inceleniyor: ${currentIndex}/${totalCount} [${progressBar}] ${progress}%\r`);

  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let nutritionFacts = null;
  let ingredients = null;

  try {
    const ingredientsEl = await page.evaluateHandle((selectors) => {
      const keyEl = Array.from(document.querySelectorAll(selectors.productDescriptionKey)).find(el => el.textContent.trim() === 'İçindekiler');
      return keyEl ? keyEl.nextElementSibling : null;
    }, config.selectors);
    
    if (ingredientsEl && ingredientsEl.asElement()) {
      ingredients = await ingredientsEl.evaluate(el => el.textContent.trim());
    }
  } catch (e) {
    log(`  ⚠️ Ürün açıklaması veya içindekiler bilgisi çekilemedi: ${e.message}`);
  }

  try {
    const tabExists = await page.evaluate((nutritionTabSelector) => {
      const tab = Array.from(document.querySelectorAll(nutritionTabSelector)).find(el => el.textContent.includes('Enerji ve Besin Öğeleri'));
      return tab ? true : false;
    }, config.selectors.nutritionTab);

    if (tabExists) {
      await page.evaluate((nutritionTabSelector) => {
        const tab = Array.from(document.querySelectorAll(nutritionTabSelector)).find(el => el.textContent.includes('Enerji ve Besin Öğeleri'));
        if (tab) tab.click();
      }, config.selectors.nutritionTab);

      await page.waitForSelector(config.selectors.nutritionTable, { timeout: 10000 });

      nutritionFacts = await page.evaluate((nutritionTableSelector) => {
        const table = document.querySelector(nutritionTableSelector);
        if (!table) return [];

        const rows = table.querySelectorAll('tbody tr');
        const data = [];
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length === 2) {
            data.push({
              name: cells[0].textContent.trim(),
              value: cells[1].textContent.trim()
            });
          }
        });
        return data;
      }, config.selectors.nutritionTable);
    }
  } catch (e) {
    log(`  ⚠️ Besin değerleri çekilemedi veya sekme bulunamadı: ${e.message}`);
  }

  return {
    nutritionFacts,
    ingredients
  };
}

async function scrapeCategory(page, startUrl, outputFilePath) {
  log(`➡️  Kategori sayfası yükleniyor: ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await scrollTillAllProductsLoaded(page);

  let products = [];
  try {
    products = await extractProductsFromPage(page);
  } catch (e) {
    log(`Ürün çekme hatası: ${e.message}`);
  }
  
  const imageUrlSelector = config.selectors.productImage;
  const imageUrls = await page.$$eval(config.selectors.productCard, (cards, imgSelector) => {
    return cards.map(card => {
      const imgEl = card.querySelector(imgSelector);
      return imgEl ? imgEl.src : null;
    });
  }, imageUrlSelector);
  
  products.forEach((product, index) => {
    product.imageUrl = imageUrls[index];
  });

  for (let i = 0; i < products.length; i++) {
    if (products[i].url) {
      const details = await scrapeProductDetails(page, products[i].url, i + 1, products.length);
      
      const tempProduct = {
        name: products[i].name,
        brand: products[i].brand,
        price: products[i].price,
        discountedPrice: products[i].discountedPrice,
        imageUrl: products[i].imageUrl,
        ingredients: details.ingredients,
        nutritionFacts: details.nutritionFacts
      };
      
      products[i] = tempProduct;
      
      delete products[i].url;
    }
  }
  write('\n');

  fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2), 'utf-8');
  log(`Veriler başarıyla ${outputFilePath} dosyasına kaydedildi. Toplam ürün: ${products.length}`);

  return products;
}

(async () => {
  let browser;
  try {
    if (!fs.existsSync(outputDir)) {
      log(`${outputDir} klasörü oluşturuluyor.`);
      fs.mkdirSync(outputDir, { recursive: true });
    }

    log('Tarayıcı başlatılıyor...');
    browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 1200 } });
    const page = await browser.newPage();

    log('\n--- Kategori linkleri çekiliyor ---');
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForSelector(config.selectors.categoryMenu, { timeout: 15000 });

    const scrapedLinks = await page.evaluate((selectors) => {
      const menuContainer = document.querySelector(selectors.categoryMenu);
      if (!menuContainer) {
        return [];
      }

      const links = Array.from(menuContainer.querySelectorAll(selectors.productLink))
        .map(a => a.href);

      const filteredLinks = links.filter(link =>
        !selectors.categoryBlacklist.some(blacklistWord => link.includes(blacklistWord))
      );

      const stopIndex = filteredLinks.findIndex(link => link.includes(selectors.stopCategoryAt));
      const finalLinks = stopIndex !== -1 ? filteredLinks.slice(0, stopIndex) : filteredLinks;

      return [...new Set(finalLinks)];
    }, config.selectors);

    log(`✅ ${scrapedLinks.length} adet kategori linki çekildi:`);
    for (const link of scrapedLinks) {
      log(link);
    }

    log('\n--- Kategori linkleri işleniyor ---');
    for (const link of scrapedLinks) {
      const urlParts = link.split('/');
      const category = urlParts[urlParts.length - 1].replace(/\?.*/, '');
      const outputFileName = `${category}.json`;
      const outputFilePath = path.join(outputDir, outputFileName);

      log(`\n--- ${category} kategorisi için ürünler çekiliyor ---`);
      await scrapeCategory(page, link, outputFilePath);
    }

    log('\n✅ Tüm kategoriler başarıyla işlendi.');

  } catch (err) {
    log(`Bir hata oluştu: ${err.message}`);
    if (browser) await browser.close();
    logStream.end();
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    logStream.end();
  }
})();