#!/usr/bin/env node
// stdout is deliberately ONLY the value, suitable for a secret manager.
const { randomBytes } = require('node:crypto');
process.stdout.write(randomBytes(32).toString('hex') + '\n');
