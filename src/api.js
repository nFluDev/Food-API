const { spawn } = require('child_process');
const path = require('path');

const market = 'sok';

const scraperPath = path.join(__dirname, '../scraper/scraper.js');

console.log(`🚀 Test başlatılıyor: ${market} için scraper çalıştırılıyor...\n`);

const scraper = spawn('node', [scraperPath, market], { stdio: 'inherit' });

scraper.on('error', (err) => {
    console.error(`❌ Scraper başlatılamadı: ${err.message}`);
});

scraper.on('close', (code) => {
    if (code === 0) {
        console.log(`\n✅ Test başarıyla tamamlandı. Market: ${market}`);
    } else {
        console.error(`\n❌ Scraper hata ile sonlandı. Çıkış kodu: ${code}`);
    }
});
