#!/usr/bin/env node
'use strict';

const VERSION = require(__dirname + '/package.json').version;
const yargs = require('yargs');

const argv = yargs
  .detectLocale(false)
  .usage('$0 [ -c path-to-stormnode.json ]')
  .version(VERSION)
  .help()
  .alias('h', 'help')
  .default('c', './stormnode.json')
  .alias('c', 'config')
  .count('verbose')
  .alias('v', 'verbose')
  .alias('r', 'removelock').describe('r', 'remove lock file and exit')
  .argv;

const VERBOSE_LEVEL = argv.verbose;
const DEBUG = function() { VERBOSE_LEVEL > 0 && console.log.apply(console, arguments); }

DEBUG("ver. " + VERSION);

const path = require('path');
const os = require('os');
const fs = require('fs');
const nodeRSA = require('node-rsa');
const events = require('events');

const lockFilePath = function(nodeId) {
  return [os.tmpdir(), `storm-node-${nodeId}.lock`].join(path.sep);
};

const nodeOptions = requireNodeOptionsOrFail(argv.config);

DEBUG("Node_id: " + nodeOptions.nodeId);

if (argv.r) {
  fs.unlinkSync(lockFilePath(nodeOptions.nodeId));
  console.log('The lock file has been removed. Now you can restart the node');
  process.exit(0);
}

if (fs.existsSync(lockFilePath(nodeOptions.nodeId))) {
  console.log('lock file exists');
  process.exit(1);
}

const mqtt = require('mqtt');
const http = require('http');
const https = require('https');

const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e6;

const ownTopic = `storm.dev/nodes/${nodeOptions.nodeId}/status`;

const node  = mqtt.connect(process.env.STORM_CONNECT_URL || 'mqtts://nodenet.storm.dev:8883', buildConnectOptions(nodeOptions, ownTopic));
let deltaTime = 0;

const eventEmitter = new events.EventEmitter();

// sent by broker on multiple connections from same node_id
node.on('disconnect', function (packet) {
  console.log('new connection from same node_id, closing this one');
  const nodeLockFilePath = lockFilePath(nodeOptions.nodeId);
  fs.writeFile(nodeLockFilePath, process.pid, null, function (err) {
    if (err) {
      throw err;
    }

    console.log(`lock file created at ${nodeLockFilePath}. Node won't restart until lock file exists. Fix problem and run with -r angument for remove lock`);
    node.end();
  });
});

node.on('connect', async function () {
  DEBUG('connected');
  // general topic
  node.subscribe('storm.dev/general');

  // private topic
  node.subscribe(`storm.dev/nodes/${nodeOptions.nodeId}/direct`);

  node.publish(ownTopic, JSON.stringify(helloMessage()));
});

node.on('message', function (topic, message) {
  DEBUG(message.toString());
  let payload;

  try {
    payload = JSON.parse(message.toString());
  } catch (err) {
    payload = null;
  }

  if (!payload) {
    return;
  }

  if (!authorized(payload.authtype, payload.authdata)){
    DEBUG('Command discarded');
    return;
  }

  if (!verifysign(payload.signature)){
    DEBUG('invalid signature');
    return;
  }

  const command = payload.command;

  switch (command) {
    case 'loadtest':
      handleNewLoadtest(payload);
      break;
    case 'manageloadtest':
      handleManageLoadtest(topic, payload);
      break;
    case 'endpointhealth':
      handleEndpointhealth(payload);
      break;
    case 'hostmonitoring':
      handleHostMonitoring(payload);
      break;
    case 'customcommand':
      handleCustomCommand(payload);
      break;
    case 'subscribetopic':
      subscribetopic(payload);
      break;
    case 'unsubscribetopic':
      unsubscribetopic(payload);
      break;
    case 'settime':
      setTime(payload.stormdevtime);
      break;
    case 'execute':
      execute(payload);
      break;
    default:
      break;
  }
});

async function handleNewLoadtest(loadtestConfig) {
  DEBUG('handle loadtest ' + (loadtestConfig.uuid || ''));

  let shouldHaltExecution = false;

  // *** Register an event handler and subscribe to a loadtest-specific topic, used to manage the ongoing test if requested
  const loadtestTopic = `storm.dev/loadtests/${loadtestConfig.uuid}/manage`;

  const eventHandler = function (data) {
    if(data.action) {
      if(data.action === 'halt') {
        shouldHaltExecution = true;
      } else {
        DEBUG(`Loadtest event received with unhandled action ${data.action}, ignoring`);  
      }
    } else {
      DEBUG("Loadtest event received without action, ignoring");
    }
  };

  if(loadtestConfig.uuid) {
    node.subscribe(loadtestTopic);
    eventEmitter.on(loadtestConfig.uuid, eventHandler);
  }
  // ***

  var iterateUntilTs = null;
  if(loadtestConfig.additionalData) {
    iterateUntilTs = loadtestConfig.additionalData.iterateUntilTs;
  }

  do {
    for (const config of loadtestConfig.requests) {
      if(shouldHaltExecution) {
        DEBUG('halting loadtest execution');
        break;
      }

      const result = {
        responsesData: [await doRequest(config)]
      };

      DEBUG(result);
      node.publish(`storm.dev/loadtest/${loadtestConfig.id}/${nodeOptions.nodeId}/results`, JSON.stringify(result));
    }
  } while(
    !shouldHaltExecution
    && iterateUntilTs !== null
    && iterateUntilTs > Math.floor(Date.now() / 1000)
  );

  if(loadtestConfig.uuid) {
    node.unsubscribe(loadtestTopic);
    eventEmitter.off(loadtestConfig.uuid, eventHandler);
  }
}

function handleManageLoadtest(topic, payload) {
  DEBUG('handle manage loadtest');

  const loadtestUuid = topicToLoadtestUuid(topic);
  if(loadtestUuid) {
    eventEmitter.emit(loadtestUuid, {action: payload.action})
  }
}

async function handleEndpointhealth(csData) {
  DEBUG('handle endpoint');
  const responsesData = await doRequest(csData.request);

  const result = {
    responsesData: responsesData
  };

  DEBUG(result);
  node.publish(`storm.dev/endpointhealth/${csData.id}/${nodeOptions.nodeId}/results`, JSON.stringify(result));
}

async function handleHostMonitoring(payload) {
  DEBUG('handle hostmonitoring');
  const hostmonitoring = require(__dirname + '/storm_modules/system/hostmonitoring.js');
  const taskData = await hostmonitoring.run();

  const taskResult = {
    taskData: taskData
  };

  DEBUG(taskResult);
  node.publish(`storm.dev/hostmonitoring/${payload.id}/${nodeOptions.nodeId}/results`, JSON.stringify(taskResult));
}

async function handleCustomCommand(payload) {
  DEBUG('handle customcommand');

  try {
    const customcommand = require(`${__dirname}/storm_modules/custom/${payload.customcommand}`);

    if (typeof customcommand.setNodeOptions === 'function') {
      customcommand.setNodeOptions(nodeOptions);
    }

    if (typeof customcommand.setArguments === 'function') {
      customcommand.setArguments(payload.arguments);
    }

    const taskData = await customcommand.run();

    const taskResult = {
      taskData: taskData
    };

    DEBUG(taskResult);
    node.publish(`storm.dev/customcommand/${payload.id}/${nodeOptions.nodeId}/results`, JSON.stringify(taskResult));
  } catch (err) {
    console.log(err);
  }
}

function doRequest(config) {
  return new Promise(function(resolve, reject) {
    const responseData = {
      requestId: config.id
    };
    const requestFn = config.protocol === 'http:' ? http.request : https.request;
    const timings = newTimings();

    const req = requestFn(config, function(res) {
      res.once('readable', () => {
        timings.firstByteAt = process.hrtime();

        // do not remove this line
        // https://github.com/nodejs/node/issues/21398
        res.once('data', chunk => null);
      });

      res.setEncoding('utf8');

      responseData.httpVersion = res.httpVersion;
      responseData.headers = res.headers;
      responseData.trailers = res.trailers;
      responseData.statusCode = res.statusCode;
      responseData.statusMessage = res.statusMessage;

      const body = [];

      if (config.includeBody) {
        res.on('data', function(chunk) {
          body.push(chunk);
        });
      }

      res.once('end', function() {
	      timings.endAt = process.hrtime();

        if (config.includeBody) {
          responseData.body = body.join('');
        }

        responseData.timings = timingsDone(timings);
        resolve(responseData);
      });
    });

    req.once('error', function (err) {
      responseData.error_message = err.message;
      resolve(responseData);
    });

    req.once('response', function (resp) {
      responseData.localAddress = resp.socket.localAddress;
      responseData.localPort = resp.socket.localPort;
    });

    req.on('socket', socket => {
      socket.on('lookup', () => {
        timings.dnsLookupAt = process.hrtime();
      });
      socket.on('connect', () => {
        timings.tcpConnectionAt = process.hrtime();
      });
      socket.on('secureConnect', () => {
        timings.tlsHandshakeAt = process.hrtime();
      });
    });

    if (config.headers) {
      if (!config.headers['Content-Length']) {
        req.removeHeader('Content-Length');
      }

      if (!config.headers['Content-Type']) {
        req.removeHeader('Content-Type');
      }
    }

    req.end();
  });
}

/**
* Get duration in milliseconds from process.hrtime()
* @function getHrTimeDurationInMs
* @param {Array} startTime - [seconds, nanoseconds]
* @param {Array} endTime - [seconds, nanoseconds]
* @return {Number} durationInMs
* @author https://github.com/RisingStack/example-http-timings/blob/master/app.js
*/
function getHrTimeDurationInMs (startTime, endTime) {
  const secondDiff = endTime[0] - startTime[0];
  const nanoSecondDiff = endTime[1] - startTime[1];
  const diffInNanoSecond = secondDiff * NS_PER_SEC + nanoSecondDiff;
  return diffInNanoSecond / MS_PER_NS;
}

function newTimings() {
  return {
    startAt: process.hrtime(),
    startAtMs: new Date().getTime(),
    dnsLookupAt: null,
    tcpConnectionAt: null,
    tlsHandshakeAt: null,
    firstByteAt: null,
    endAt: null
  };
}

function timingsDone(timings) {
  const tlsHandshake = timings.tlsHandshakeAt !== null ? timings.tcpConnectionAt - timings.tlsHandshakeAt : null;

  return {
    startAtMs: timings.startAtMs,
    dnsLookup: timings.dnsLookupAt !== null ? getHrTimeDurationInMs(timings.startAt, timings.dnsLookupAt) : null,
    tcpConnection: getHrTimeDurationInMs(timings.dnsLookupAt || timings.startAt, timings.tcpConnectionAt),
    tlsHandshake: timings.tlsHandshakeAt !== null ? getHrTimeDurationInMs(timings.tcpConnectionAt, timings.tlsHandshakeAt) : null,
    firstByte: getHrTimeDurationInMs((timings.tlsHandshakeAt || timings.tcpConnectionAt), timings.firstByteAt),
    contentTransfer: getHrTimeDurationInMs(timings.firstByteAt, timings.endAt),
    total: getHrTimeDurationInMs(timings.startAt, timings.endAt)
  };
}

function buildConnectOptions(nodeOptions, ownTopic) {
  return {
    username: nodeOptions.username,
    password: nodeOptions.password,
    clientId: process.env.STORM_NODEID || nodeOptions.nodeId
  };
}

function helloMessage() {
  return {
    command: 'hello',
    version: VERSION,
  };
}

function requireNodeOptionsOrFail(config) {
  const pathResolve = path.resolve;

  try {
    return require(pathResolve(config));
  } catch (e) {
    yargs.showHelp();
    process.exit(1);
  }
}

function subscribetopic(payload){
  node.subscribe('storm.dev/'+payload.newtopic+'/#', function (err) {
    if (err){
      console.log('Error could not subscribe in '+payload.newtopic+': '+ err.toString());
    }
  });
}

function unsubscribetopic(payload){
  node.unsubscribe('storm.dev/'+payload.newtopic+'/#', function (err) {
    if (err){
      console.log('Error could not unsubscribe '+payload.newtopic+': '+ err.toString());
    }
  });
}

function authorized(authtype, authdata) {
  let auth = false;

  switch (authtype) {
    case 'randomselect':
      const randresult = Math.floor(Math.random() * (1000) + 1);

      if (randresult <= authdata) {
        auth = true;
      }

      break;
    case 'all':
      auth = true;
      break;
    default:
      break;
  }

  return auth;
}

const stormdev_public_key =
  '-----BEGIN PUBLIC KEY-----\n'+
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCfZKVjkyQKoZtj2jvsvHtoyLCc\n'+
  'w5EzO+LTrurzOpdjd1jgKLSR3wukzImNSGe+RV5kQ/adiaCbbu9oIIOgkKwI1a7E\n'+
  '+UPrgl6135KmlhEVG6oc2MysBLuheOJ3WaLGO22KYC/GYImm6AbYW1PNHv97Qjmz\n'+
  'i3+x54GsIT8V56acIwIDAQAB\n'+
  '-----END PUBLIC KEY-----';
const RSAKey = new nodeRSA(stormdev_public_key);

function verifysign(signature) {
  const decrypted_sign = RSAKey.decryptPublic(signature, 'utf8');
  const decrypted_sign_split = decrypted_sign.split('|');
  const now = Date.now();

  if (Math.abs(now - deltaTime - decrypted_sign_split[1]) > 1800000) {
    return false;
  }

  return true;
}

function setTime(time) {
  deltaTime = Date.now() - time;
}

async function execute(payload) {
  const module_path = payload.modulepath;
  const module = require(getStormModuleDir(module_path));

  if (typeof module.setNodeOptions === 'function') {
    module.setNodeOptions(nodeOptions);
  }

  if (typeof module.setArguments === 'function') {
    module.setArguments(payload.arguments);
  }

  const module_return = await module.run();
  const result = {
    nodeId: nodeOptions.nodeId,
    modulepath: module_path,
    return: module_return
  };
  DEBUG(result);

  if (payload.channel) {
    node.publish(`storm.dev/execute/${payload.channel}/${nodeOptions.nodeId}/results`, JSON.stringify(result));
  }
}

function getStormModuleDir(module_path) {
  const moduleDir = module_path.startsWith('custom/') ? 'custom' : 'system';
  return path.join(__dirname, 'storm_modules', moduleDir, path.basename(module_path));
}

function topicToLoadtestUuid(topic) {
  return topic.match(/storm\.dev\/loadtests\/([-_a-z0-9]+)\/manage/)[1];
}