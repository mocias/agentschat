'use strict';
// This owned utility process runs the installed host with its original resource
// root. The installation and its code are never modified or redistributed.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const resources = process.env.AGENT_ROOM_ZCODE_RESOURCES;
if (!resources || !path.isAbsolute(resources)) throw new Error('Missing ZCode resources');
Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
import(pathToFileURL(path.join(resources, 'app.asar', 'out', 'host', 'index.js')).href)
  .then(() => process.parentPort.postMessage({ type: 'agentschat-host-ready' }))
  .catch(() => { process.parentPort.postMessage({ type: 'agentschat-host-error' }); process.exitCode = 1; });
