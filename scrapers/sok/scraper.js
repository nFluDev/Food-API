// scrapers/sok-scraper.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const logFilePath = path.join(__dirname, 'logs.txt');
const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

function log(message) {
    console.log(message);
    logStream.write(message + '\n');
}

function write(message) {
    process.stdout.write(message);
    logStream.write(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

// Sayfanın en altına kadar kaydırma fonksiyonu (infinite scroll)
async function scrollTillAllProductsLoaded(page) {
    let previousProductCount = 0;
    let currentProductCount = 0;
    
    const productListContainerSelector = '[class*="PLPProductListing_PLPCardsWrapper"]';
    
    try {
        log('Ürün listesi container\'ı bekleniyor...');
        await page.waitForSelector(productListContainerSelector, { timeout: 10000 });
        log('Ürün listesi container\'ı bulundu, kaydırma başlatılıyor...');
    } catch (error) {
        log('Ürün listesi container bulunamadı, script sonlandırılıyor.');
        throw error;
    }

    while (true) {
        previousProductCount = await page.evaluate((selector) => {
            const container = document.querySelector(selector);
            return container ? container.querySelectorAll('[class*="PLPProductListing_PLPCardParent"]').length : 0;
        }, productListContainerSelector);

        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });

        await new Promise(resolve => setTimeout(resolve, 2000));
        
        currentProductCount = await page.evaluate((selector) => {
            const container = document.querySelector(selector);
            return container ? container.querySelectorAll('[class*="PLPProductListing_PLPCardParent"]').length : 0;
        }, productListContainerSelector);

        if (currentProductCount <= previousProductCount) {
            write(`Sayfanın en altına ulaşıldı ve tüm ürünler yüklendi. Toplam: ${currentProductCount} ürün.\n`);
            break;
        }
        
        write(`Yeni ürünler yüklendi. Toplam: ${currentProductCount} ürün.\r`);
    }
}

async function extractProductsFromPage(page) {
    const cardSelector = '.PLPProductListing_PLPCardParent__GC2qb';
    
    try {
      await page.waitForSelector(cardSelector, { timeout: 15000 });
    } catch (e) {
      log(`Ürün kartı selector'ı bulunamadı: ${cardSelector}`);
      return [];
    }
  
    const items = await page.$$eval(cardSelector, (cards) => {
      const parsePrice = (txt) => {
        if (!txt) return null;
        const cleaned = txt.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
        const num = parseFloat(cleaned);
        return Number.isNaN(num) ? null : num;
      };
  
      return cards.map((card) => {
        const titleEl = card.querySelector('h2.CProductCard-module_title__u8bMW');
        const name = titleEl ? titleEl.textContent.trim() : null;
  
        const brand = name ? name.split(/\s+/)[0].toUpperCase() : null;
        const href = card.querySelector('a[href]')?.getAttribute('href') || null;
  
        let price = null;
        let discountedPrice = null;
  
        const discountBox = card.querySelector('.CPriceBox-module_discountedPriceContainer__nsaTN');
        if (discountBox) {
          const originalTxt =
            discountBox.querySelector('.CPriceBox-module_price__bYk-c')?.textContent ||
            discountBox.querySelector('.CPriceBox-module_price__bYk-c span')?.textContent ||
            null;
  
          const discountedTxt =
            discountBox.querySelector('.CPriceBox-module_discountedPrice__15Ffw')?.textContent || null;
  
          price = parsePrice(originalTxt);
          discountedPrice = parsePrice(discountedTxt);
        } else {
          const originalTxt =
            card.querySelector('.CPriceBox-module_priceContainer__ZROpc .CPriceBox-module_price__bYk-c')
              ?.textContent ||
            card.querySelector('.CPriceBox-module_price__bYk-c')?.textContent ||
            null;
          price = parsePrice(originalTxt);
          discountedPrice = null;
        }
  
        return {
          name,
          brand,
          price,
          discountedPrice,
          url: href ? new URL(href, 'https://www.sokmarket.com.tr').toString() : null,
        };
      });
    });
  
    return items.filter((p) => p.name && p.price !== null);
}

async function scrapeProductDetails(page, productUrl, currentIndex, totalCount) {
    const progress = Math.round((currentIndex / totalCount) * 100);
    const progressBar = '█'.repeat(Math.floor(progress / 5)) + ' '.repeat(20 - Math.floor(progress / 5));
    write(`  🔍 Ürün detay sayfası inceleniyor: ${currentIndex}/${totalCount} [${progressBar}] ${progress}%\r`);

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const nutritionTabSelector = 'button[class*="CTab-module_tabTitle"]';
    const nutritionTableSelector = 'div[class*="CProductNutritionInfo"] table';

    let nutritionFacts = null;

    try {
        const tabExists = await page.evaluate((selector) => {
            const tab = Array.from(document.querySelectorAll(selector)).find(el => el.textContent.includes('Enerji ve Besin Öğeleri'));
            return tab ? true : false;
        }, nutritionTabSelector);

        if (tabExists) {
            await page.evaluate((selector) => {
                const tab = Array.from(document.querySelectorAll(selector)).find(el => el.textContent.includes('Enerji ve Besin Öğeleri'));
                if (tab) tab.click();
            }, nutritionTabSelector);
            
            await page.waitForSelector(nutritionTableSelector, { timeout: 10000 });

            nutritionFacts = await page.evaluate((selector) => {
                const table = document.querySelector(selector);
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
            }, nutritionTableSelector);
        }
    } catch (e) {
        log(`  ⚠️ Besin değerleri çekilemedi veya sekme bulunamadı: ${e.message}`);
    }

    return nutritionFacts;
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
  
    for (let i = 0; i < products.length; i++) {
        if (products[i].url) {
            const nutritionFacts = await scrapeProductDetails(page, products[i].url, i + 1, products.length);
            products[i].nutritionFacts = nutritionFacts;
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
    const outputDir = './scrapers/sok/output';
    if (!fs.existsSync(outputDir)) {
      log(`${outputDir} klasörü oluşturuluyor.`);
      fs.mkdirSync(outputDir, { recursive: true });
    }

    log('Tarayıcı başlatılıyor...');
    browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 1200 } });
    const page = await browser.newPage();

    log('\n--- Kategori linkleri çekiliyor ---');
    await page.goto('https://www.sokmarket.com.tr', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const menuSelector = '[class*="CategoryList_categories"]';
    await page.waitForSelector(menuSelector, { timeout: 15000 });

    const scrapedLinks = await page.evaluate((selector) => {
        const menuContainer = document.querySelector(selector);
        if (!menuContainer) {
            return [];
        }

        const links = Array.from(menuContainer.querySelectorAll('a[href]'))
                            .map(a => new URL(a.href, window.location.origin).toString());
        
        const filteredLinks = links.filter(link => 
            !link.includes('hafta') && 
            !link.includes('25-tl')
        );

        const temizlikIndex = filteredLinks.findIndex(link => link.includes('temiz'));
        const finalLinks = temizlikIndex !== -1 ? filteredLinks.slice(0, temizlikIndex) : filteredLinks;

        return [...new Set(finalLinks)];
    }, menuSelector);

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